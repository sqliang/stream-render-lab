/**
 * @file Runtime 的 SSE 传输边界。
 *
 * 负责连接、取消、退避重连与事件帧交付；游标事实始终由 Runtime Core Store 持有。
 */

import { fetchEventSource } from '@microsoft/fetch-event-source';
import type { RuntimeEvent } from '../core/types';

export type SseCallbacks = {
  /** 将已完成解析与校验边界内的事件写入 Runtime Core。 */
  onEvent(event: RuntimeEvent): void;
  /** 向 Store 同步连接状态与可诊断错误。 */
  onState(state: 'connecting' | 'streaming' | 'reconnecting' | 'closed' | 'error', error?: Error): void;
  /** 在每次连接前读取最新已持久化事件游标。 */
  getLastEventId(): string | null;
  /** 读取当前游标所属的服务端事件日志代际。 */
  getStreamEpoch(): string | null;
  /** 判断当前 Run 是否仍需通过重连补齐后续事件。 */
  shouldReconnect(): boolean;
  /** 当服务端明确拒绝当前游标或事件流代际时，要求 Facade 用 Snapshot 恢复。 */
  onCursorInvalid(): void;
};

/**
 * 建立一个可恢复的 Run SSE 订阅。
 *
 * 每次重连前都会向 Core 读取最新游标，因此 Runtime 先持久化事件、再推进游标时，
 * 刷新页面也能从最后已处理事件继续。关闭连接仅停止本地读取；业务取消仍由 Facade
 * 通过服务端命令完成，避免把网络连接状态误认为 Run 的权威状态。
 *
 * @param url Run 的事件流地址。
 * @param callbacks Core 提供的游标读取、事件写入与连接状态回调。
 * @returns 停止函数；调用后不会再发起重连。
 */
export function subscribeToSse(url: string, callbacks: SseCallbacks) {
  const controller = new AbortController();
  let stopped = false;

  /**
   * 执行一个可取消的连接与退避重连循环。
   *
   * 每轮开始前重新读取游标，确保重连不会使用已经被 Store 推进或重置的旧值。
   *
   * @returns 连接正常关闭、显式停止或发生不可继续错误后的 Promise。
   */
  const connect = async () => {
    let attempt = 0;
    while (!stopped) {
      let connectionState: 'connecting' | 'reconnecting' = 'reconnecting';
      if (attempt === 0) {
        connectionState = 'connecting';
      }
      callbacks.onState(connectionState);
      const lastEventId = callbacks.getLastEventId();
      const streamEpoch = callbacks.getStreamEpoch();
      const headers: Record<string, string> = {};
      if (lastEventId) {
        headers['Last-Event-ID'] = lastEventId;
      }
      if (streamEpoch) {
        headers['X-Stream-Epoch'] = streamEpoch;
      }

      try {
        await fetchEventSource(url, {
          signal: controller.signal,
          headers,

          async onopen(response) {
            if (response.status === 409 && response.headers.get('x-sse-reset') === 'stream-epoch') {
              callbacks.onCursorInvalid();
              throw new Error('SSE cursor is invalid for the current stream epoch');
            }
            if (!response.ok) {
              throw new Error(`SSE request failed: ${response.status}`);
            }
            const contentType = response.headers.get('content-type');
            if (!contentType?.startsWith('text/event-stream')) {
              throw new Error(`Expected SSE response but received ${contentType ?? 'an empty Content-Type header'}`);
            }

            callbacks.onState('streaming');
          },

          onmessage(message) {
            if (!message.data || message.event === 'ping') {
              return;
            }
            // JSON 解析失败会进入 fetch-event-source 的错误处理并触发重连；
            // 不把损坏帧写进 Core，避免它污染已经归一化的权威投影。
            const payload = JSON.parse(message.data) as Record<string, unknown>;
            if (message.event === 'stream.cursor_invalid') {
              callbacks.onCursorInvalid();
              throw new Error('SSE cursor is ahead of the server event stream');
            }
            // 服务端对已追平且终态的 Run 发送控制帧，避免客户端只看到注释与关闭，
            // 从而无法判断应停止订阅还是恢复权威 Snapshot。
            if (message.event === 'stream.completed') {
              callbacks.onEvent({
                id: message.id,
                type: 'run.updated',
                payload,
              });
              return;
            }
            const eventType = message.event || 'message';
            callbacks.onEvent({ id: message.id, type: eventType, payload });
          },

          onclose() {
            if (stopped) {
              return;
            }
            // 服务端会在 Run 进入终态后主动结束有限事件流。此时关闭是完成信号，
            // 若仍抛错并重试，就会形成“200 + : connected” 的无意义循环请求。
            if (!callbacks.shouldReconnect()) {
              callbacks.onState('closed');
              return;
            }
            // 未终态时关闭意味着可能丢失后续事件，交给统一退避路径恢复。
            throw new Error('SSE connection closed before the Run reached a terminal state');
          },

          onerror(error) {
            throw error;
          },
        });
        // 连接正常结束且未显式停止时，不隐式循环重连，交由上层按业务状态决定是否重新订阅。
        if (!stopped) {
          return;
        }
      } catch (error) {
        // 显式停止后不进行重连。
        if (stopped || controller.signal.aborted) {
          return;
        }

        let normalizedError: Error;
        if (error instanceof Error) {
          normalizedError = error;
        } else {
          normalizedError = new Error('Unknown SSE error');
        }
        callbacks.onState('error', normalizedError);
        attempt += 1;

        await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** attempt, 8000)));
      }
    }
  };

  void connect();

  /**
   * 显式停止本地连接循环，并通知 Core 流已关闭。
   */
  return () => {
    stopped = true;
    controller.abort();
    callbacks.onState('closed');
  };
}
