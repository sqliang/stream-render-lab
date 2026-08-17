/**
 * @file 面向页面的 Runtime Facade，协调 Snapshot、SSE、Outbox、取消与持久化。
 */

import { requestJson } from '../network/http';
import { subscribeToSse } from '../network/sse';
import { RuntimePersistenceCoordinator } from '../persistence/coordinator';
import { RuntimeIndexedDb } from '../persistence/indexed-db';
import { RuntimeCoreStore } from './store';
import type { ConversationViewState, Message, RuntimeSnapshot, SendMessageCommand } from './types';

type SendMessageResponse = {
  streamEpoch: string;
  conversation: { id: string; agentName: string; title: string; activeRunId: string; status: 'active'; revision: number };
  run: { id: string; conversationId: string; inputMessageId: string; outputMessageId: string; status: 'queued'; currentStepId: null; revision: number };
  message: { id: string; conversationId: string; runId: null; role: 'user'; status: 'completed'; revision: number };
  block: { id: string; messageId: string; type: 'markdown'; sourceContent: string; lastSeq: number; status: 'completed'; revision: number };
};

type CancelRunResponse = {
  run: { id: string; conversationId: string; inputMessageId: string; outputMessageId: string | null; status: 'cancelled'; currentStepId: string | null; revision: number };
  message: { id: string; conversationId: string; runId: string; role: 'assistant'; status: 'cancelled'; revision: number } | null;
};

/**
 * 面向业务页面的 Runtime 入口。
 *
 * 页面只能通过此类发起操作，不能直接修改 Store 实体，借此保留 Snapshot、SSE、Outbox
 * 与持久化之间的权威边界。
 */
export class RuntimeFacade {
  readonly store = new RuntimeCoreStore();
  private stopByRunId = new Map<string, () => void>();
  private readonly persistence = new RuntimePersistenceCoordinator(
    this.store,
    // 生产环境必须由认证会话生成 `${tenantId}:${accountId}`，绝不能使用全局键，
    // 否则登出或切换账号时可能暴露其他用户的缓存。
    new RuntimeIndexedDb('demo-user:default'),
  );
  private hydration: Promise<void> | null = null;
  private flushingOutbox: Promise<void> | null = null;
  private missingOutputRepairTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private cursorRecoveryByRunId = new Map<string, Promise<void>>();
  /**
   * 在浏览器恢复联网时触发 Outbox 补偿投递。
   */
  private readonly onOnline = () => {
    void this.flushOutbox();
  };

  /**
   * 创建 Runtime 依赖并注册浏览器在线事件。
   *
   * 在线事件只触发补偿；是否真正可发送仍由 HTTP 请求结果判定。
   */
  constructor() {
    // Outbox 离线时只保留持久化命令；网络恢复后由 Runtime 主动补偿，不能依赖 React 组件仍然挂载。
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.onOnline);
    }
  }

  /**
   * 在请求网络 Snapshot 前恢复本地事实，使刷新立即展示上次会话。
   * 随后的 Snapshot 仍然优先，因为服务端才是权威来源。
   */
  async hydrate() {
    if (this.hydration) {
      return this.hydration;
    }
    this.hydration = (async () => {
      const persisted = await this.persistence.restore();
      if (persisted) {
        this.store.restorePersisted(persisted);
      }
      // 恢复后才开始持久化，避免空 Store 覆盖既有 IndexedDB 投影。
      this.persistence.start();
      await this.flushOutbox();
    })();
    return this.hydration;
  }

  /**
   * 加载权威会话 Snapshot，并按需订阅其中未结束的 Run。
   *
   * @param conversationId - 要打开的会话标识。
   * @param options - 是否建立 Run SSE 订阅，默认建立。
   */
  async openConversation(conversationId: string, options: { subscribe?: boolean } = { subscribe: true }) {
    await this.hydrate();
    try {
      const snapshot = await requestJson<RuntimeSnapshot>(`/api/conversations/${conversationId}/snapshot`);
      // Snapshot 是 Runtime 的权威状态，空响应不能被误当成可应用的状态。
      if (snapshot === null) {
        throw new Error('Snapshot endpoint returned an empty response');
      }
      this.applySnapshot(snapshot);
    } catch (error) {
      // 首次离线打开仍可展示持久化投影并保留 Outbox；浏览器恢复联网后会补发命令。
      console.warn('Snapshot unavailable; using local Runtime projection', error);
      return;
    }
    // 标签页可能在接收用户命令与订阅新 Run 之间关闭，因此恢复该会话全部未结束 Run，
    // 而不是只恢复 `activeRunId`，以便孤立回答仍能重放到正确的历史消息气泡。
    const runIds = this.store.getState().indexes.runIdsByConversationId[conversationId] ?? [];
    if (options.subscribe) {
      for (const runId of runIds) {
        const run = this.store.getState().entities.runsById[runId];
        if (run && !['completed', 'failed', 'cancelled'].includes(run.status)) {
          this.subscribeRun(run.id);
        }
      }
    }
  }

  /**
   * 启动或恢复一个 Run 的事件流；重复调用会安全替换旧订阅。
   *
   * @param runId - 要订阅的 Run 标识。
   * @param streamEpoch - 服务端事件日志代际，用于判定游标是否可复用。
   */
  subscribeRun(runId: string, streamEpoch?: string) {
    this.unsubscribeRun(runId);
    this.store.setStream(runId, {
      connection: 'connecting',
      lastError: null,
      streamEpoch: streamEpoch ?? this.store.getState().streamsByRunId[runId]?.streamEpoch ?? null,
    });
    const stop = subscribeToSse(`/api/runs/${runId}/events`, {
      getLastEventId: () => this.store.getState().streamsByRunId[runId]?.lastEventId ?? null,
      getStreamEpoch: () => this.store.getState().streamsByRunId[runId]?.streamEpoch ?? null,
      shouldReconnect: () => {
        const run = this.store.getState().entities.runsById[runId];
        if (!run) {
          return false;
        }
        return !['completed', 'failed', 'cancelled'].includes(run.status);
      },
      onCursorInvalid: () => {
        // 先停止携带错误游标的读取器，避免恢复 Snapshot 的异步窗口再次发出旧游标请求。
        this.unsubscribeRun(runId);
        void this.recoverInvalidStreamCursor(runId);
      },
      onEvent: (event) => {
        this.store.applyEvent(event);
        if (event.type === 'message.created') {
          this.clearMissingOutputRepair(runId);
        }
        let nextRun: { status?: string } | undefined;
        if (event.type === 'run.updated') {
          nextRun = event.payload.run as { status?: string };
        }
        if (nextRun && ['completed', 'failed', 'cancelled'].includes(nextRun.status ?? '')) {
          // 终态 Run 是停止传输消费的业务信号。
          void this.persistence.flushNow();
          queueMicrotask(() => this.unsubscribeRun(runId));
        }
      },
      onState: (connection, error) => this.store.setStream(runId, { connection, lastError: error?.message ?? null }),
    });
    this.stopByRunId.set(runId, stop);
    this.scheduleMissingOutputRepair(runId);
  }

  /**
   * 停止本地 SSE 读取器。
   *
   * 业务取消必须使用 `cancelRun`，因为它还会向服务端发送终止 Agent 工作的命令。
   */
  unsubscribeRun(runId: string) {
    this.stopByRunId.get(runId)?.();
    this.stopByRunId.delete(runId);
  }

  /**
   * SSE 是低延迟路径，Snapshot 仍是恢复权威。代理、标签页生命周期变化或临时传输故障若丢失早期帧，
   * 最关键的是 `message.created`：缺少它，后续 Block 没有可渲染的归属消息。
   *
   * 此逻辑刻意保持条件触发。健康流会快速创建输出消息并清除定时器，因此正常渲染完全依赖 SSE，而非轮询。
   */
  private scheduleMissingOutputRepair(runId: string) {
    this.clearMissingOutputRepair(runId);
    const timer = setTimeout(() => {
      this.missingOutputRepairTimers.delete(runId);
      void this.repairMissingOutputMessage(runId);
    }, 1_500);
    this.missingOutputRepairTimers.set(runId, timer);
  }

  /**
   * 取消指定 Run 尚未触发的 Snapshot 修复计时器。
   *
   * @param runId - 已收到输出消息或不再需要修复的 Run 标识。
   */
  private clearMissingOutputRepair(runId: string) {
    const timer = this.missingOutputRepairTimers.get(runId);
    if (timer) {
      clearTimeout(timer);
    }
    this.missingOutputRepairTimers.delete(runId);
  }

  /**
   * 在服务端拒绝游标或发现游标超前时，用权威 Snapshot 重建该 Run 的消费位置。
   *
   * 这不是普通网络重连：旧游标可能属于另一个 Mock 进程或事件日志代际，继续携带它只会重复
   * 请求一个已经没有可重放事件的流。先应用 Snapshot 会重置不匹配的游标，再按最新 Run 状态订阅。
   *
   * @param runId - 服务端判定游标无效的 Run 标识。
   * @returns 恢复完成后的 Promise；失败时保留原投影并由后续订阅策略重试。
   */
  private recoverInvalidStreamCursor(runId: string): Promise<void> {
    const existingRecovery = this.cursorRecoveryByRunId.get(runId);
    if (existingRecovery) {
      return existingRecovery;
    }

    const recovery = this.doRecoverInvalidStreamCursor(runId);
    this.cursorRecoveryByRunId.set(runId, recovery);
    void recovery.finally(() => {
      this.cursorRecoveryByRunId.delete(runId);
    });
    return recovery;
  }

  /**
   * 执行一次游标失效恢复；该方法只能由带去重保护的 `recoverInvalidStreamCursor` 调用。
   *
   * @param runId - 需要从权威 Snapshot 恢复的 Run 标识。
   * @returns 单次恢复任务。
   */
  private async doRecoverInvalidStreamCursor(runId: string) {
    const run = this.store.getState().entities.runsById[runId];
    if (!run) {
      this.unsubscribeRun(runId);
      return;
    }
    try {
      // `stream.cursor_invalid` 已明确说明本地游标不可用；即使 streamEpoch 恰好相同，
      // 也必须丢弃它。否则 Snapshot 完成后仍会携带同一游标再次触发恢复风暴。
      this.store.resetStream(runId);
      this.clearMissingOutputRepair(runId);
      const snapshot = await requestJson<RuntimeSnapshot>(`/api/conversations/${run.conversationId}/snapshot`);
      if (snapshot === null) {
        throw new Error('Snapshot recovery endpoint returned an empty response');
      }
      this.applySnapshot(snapshot);
      const recoveredRun = this.store.getState().entities.runsById[runId];
      if (!recoveredRun || ['completed', 'failed', 'cancelled'].includes(recoveredRun.status)) {
        this.unsubscribeRun(runId);
        return;
      }
      this.subscribeRun(runId);
    } catch (error) {
      console.warn(`Unable to recover invalid SSE cursor for ${runId}`, error);
    }
  }

  /**
   * 通过权威 Snapshot 补齐早期 SSE 帧丢失时缺少的输出消息。
   *
   * @param runId - 需要检查输出消息完整性的 Run 标识。
   * @returns 修复请求完成后的 Promise；临时网络失败只记录诊断信息。
   */
  private async repairMissingOutputMessage(runId: string) {
    const before = this.store.getState().entities.runsById[runId];
    // 已有输出消息，或该 Run 不再属于当前 Runtime 时均不需要修复。
    if (!before?.outputMessageId || this.store.getState().entities.messagesById[before.outputMessageId]) {
      return;
    }
    try {
      const snapshot = await requestJson<RuntimeSnapshot>(`/api/conversations/${before.conversationId}/snapshot`);
      // 修复路径与首次加载遵守相同的 Snapshot 契约：必须拿到完整状态才能应用。
      if (snapshot === null) {
        throw new Error('Snapshot repair endpoint returned an empty response');
      }
      this.applySnapshot(snapshot);
    } catch (error) {
      // 流自身重连策略仍会继续；Snapshot 修复只是安全网，临时断网不能清空用户可见本地消息。
      console.warn(`Unable to repair missing output message for ${runId}`, error);
    }
  }

  /**
   * 先将用户消息作为持久化命令提交，再尝试投递。
   * 无网络时本地消息仍立即可见；相同的消息与 Block 标识会交给服务端，让幂等重试原地确认。
   */
  async sendMessage(conversationId: string, text: string) {
    await this.hydrate();
    const commandId = createId('cmd');
    const now = Date.now();
    const command: SendMessageCommand = {
      id: commandId,
      type: 'send_message',
      idempotencyKey: createId('idem'),
      conversationId,
      text,
      localMessageId: `message_local_${commandId}`,
      localBlockId: `block_local_${commandId}`,
      status: 'queued',
      attempts: 0,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.enqueueSendCommand(command);
    // 用户命令不能依赖防抖保存；此刻就必须落盘，才能承受标签页崩溃。
    await this.persistence.flushNow();
    await this.flushOutbox();
  }

  /**
   * 按创建顺序重试全部持久化发送命令，并合并并发调用以维持消息顺序。
   *
   * @returns 当前或新建的 Outbox 投递任务。
   */
  async flushOutbox() {
    if (this.flushingOutbox) {
      return this.flushingOutbox;
    }
    this.flushingOutbox = this.doFlushOutbox().finally(() => {
      this.flushingOutbox = null;
    });
    return this.flushingOutbox;
  }

  /**
   * 顺序执行一次 Outbox 投递循环。
   *
   * 顺序保证用户发送顺序不会因异步 HTTP 竞争而颠倒；离线检测只节省无效请求，不能替代服务端结果。
   *
   * @returns 全部当前命令处理结束后的 Promise。
   */
  private async doFlushOutbox() {
    // `navigator.onLine` 仅用于快速判定离线；实际 HTTP 成功结果仍是权威依据。
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      return;
    }
    const commands = Object.values(this.store.getState().workspace.outboxById)
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const command of commands) {
      await this.deliverSendCommand(command);
    }
  }

  /**
   * 投递一条持久化发送命令，并将服务端确认原地合并到乐观消息。
   *
   * 保留原幂等键是关键：超时并不等于服务端未接收，换键会造成重复消息和重复 Run。
   *
   * @param command - 要投递的稳定 Outbox 命令。
   * @returns 本次投递处理完成后的 Promise；失败时命令仍保留为可重试状态。
   */
  private async deliverSendCommand(command: SendMessageCommand) {
    this.store.updateSendCommand(command.id, {
      status: 'sending',
      attempts: command.attempts + 1,
      lastError: null,
    });
    await this.persistence.flushNow();
    try {
      const accepted = await requestJson<SendMessageResponse>(`/api/conversations/${command.conversationId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': command.idempotencyKey,
        },
        body: JSON.stringify({
          text: command.text,
          clientMessageId: command.localMessageId,
          clientBlockId: command.localBlockId,
        }),
      });
      // 发送命令必须返回已接受的 Run、Message 与 Block；空响应无法确认 Outbox 命令。
      if (accepted === null) {
        throw new Error('Send message endpoint returned an empty response');
      }
      this.store.applyEvent({
        id: `local-conversation-${accepted.run.id}`,
        type: 'conversation.updated',
        payload: { conversation: accepted.conversation },
      });
      this.store.applyEvent({
        id: `local-run-${accepted.run.id}`,
        type: 'run.updated',
        payload: { run: accepted.run },
      });
      this.store.applyEvent({
        id: `local-message-${accepted.message.id}`,
        type: 'message.created',
        payload: { message: accepted.message },
      });
      this.store.applyEvent({
        id: `local-block-${accepted.block.id}`,
        type: 'block.created',
        payload: { block: accepted.block },
      });
      this.store.completeSendCommand(command.id, accepted.message as Message);
      await this.persistence.flushNow();
      this.subscribeRun(accepted.run.id, accepted.streamEpoch);
    } catch (error) {
      // 必须保留原命令和幂等键：超时可能表示服务端已接收但响应丢失，换键重试会制造重复会话轮次。
      this.store.updateSendCommand(command.id, {
        status: 'queued',
        lastError: error instanceof Error ? error.message : '发送失败，等待网络恢复后重试',
      });
      await this.persistence.flushNow();
    }
  }

  /**
   * 委托 Store 保存会话草稿。
   *
   * @param conversationId - 草稿所属会话标识。
   * @param text - 当前输入文本。
   */
  setDraft(conversationId: string, text: string) {
    this.store.setDraft(conversationId, text);
  }

  /**
   * Snapshot 指出游标所属的事件日志代际。不同代际的持久化游标比没有游标更危险，
   * 因为它可能跳过消息或 Block 创建事件。必须在应用新 Snapshot 前重置它，并从事件零开始订阅替代流。
   */
  private applySnapshot(snapshot: RuntimeSnapshot) {
    for (const [runId, epoch] of Object.entries(snapshot.streamEpochByRunId ?? {})) {
      const localStream = this.store.getState().streamsByRunId[runId];
      if (localStream?.lastEventId && localStream.streamEpoch !== epoch) {
        this.store.resetStream(runId);
      }
    }
    this.store.applySnapshot(snapshot);
    for (const [runId, epoch] of Object.entries(snapshot.streamEpochByRunId ?? {})) {
      this.store.setStream(runId, { streamEpoch: epoch });
    }
  }

  /**
   * 保存会话阅读位置与展开状态等本地视图信息。
   *
   * @param conversationId - 视图状态所属会话标识。
   * @param patch - 要合并的局部视图状态。
   */
  setConversationViewState(conversationId: string, patch: Partial<ConversationViewState>) {
    const previous = this.store.getState().workspace.viewStateByConversationId[conversationId] ?? {
      conversationId, lastReadMessageId: null, expandedRunStepIds: [], updatedAt: 0,
    };
    this.store.setWorkspace({
      viewStateByConversationId: {
        ...this.store.getState().workspace.viewStateByConversationId,
        [conversationId]: { ...previous, ...patch, conversationId, updatedAt: Date.now() },
      },
    });
  }

  /**
   * 取消刻意被建模为服务端命令，而不是仅调用 `AbortController.abort()`。
   * 服务端先修改权威 Run 状态并终止 Agent 工作，客户端随后才关闭本地 SSE 读取器；
   * 响应也会立即关闭当前 Message 游标。
   */
  async cancelRun(runId: string) {
    try {
      const result = await requestJson<CancelRunResponse>(`/api/runs/${runId}/cancel`, { method: 'POST' });
      // 取消命令需要服务端返回最终 Run 状态，避免本地自行猜测取消是否生效。
      if (result === null) {
        throw new Error('Cancel run endpoint returned an empty response');
      }
      this.store.applyEvent({ id: `cancel-run-${runId}`, type: 'run.updated', payload: { run: result.run } });
      if (result.message) {
        this.store.applyEvent({ id: `cancel-message-${result.message.id}`, type: 'message.updated', payload: { message: result.message } });
      }
    } finally {
      // 即使取消请求失败，也必须停止本地网络消费。
      this.unsubscribeRun(runId);
      this.clearMissingOutputRepair(runId);
      void this.persistence.flushNow();
    }
  }

  /**
   * 释放所有流订阅、修复定时器、浏览器监听器，并尽力落盘最终投影。
   */
  dispose() {
    for (const stop of this.stopByRunId.values()) {
      stop();
    }
    this.stopByRunId.clear();
    for (const timer of this.missingOutputRepairTimers.values()) {
      clearTimeout(timer);
    }
    this.missingOutputRepairTimers.clear();
    this.cursorRecoveryByRunId.clear();
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.onOnline);
    }
    void this.persistence.dispose();
  }
}

/**
 * 创建用于命令、幂等键和本地实体的客户端标识。
 *
 * @param prefix - 便于日志与数据归类的标识前缀。
 * @returns 带前缀且近似全局唯一的客户端标识。
 */
function createId(prefix: string) {
  // 支持的浏览器使用 `crypto.randomUUID`；回退方案让旧 WebView 仍可运行，且客户端标识仍近似唯一。
  let suffix: string;
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    suffix = crypto.randomUUID();
  } else {
    suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  return `${prefix}_${suffix}`;
}
