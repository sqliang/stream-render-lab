/**
 * @file 重试策略的纯函数实现：判定"能不能重试"与计算"等多久再试"。
 *
 * 设计原则：
 * 1. 默认只有 GET/HEAD 自动重试；其他方法须由调用方确认语义幂等后才允许重试；
 * 2. 只有"可能是瞬时故障"的错误才重试（408、429、5xx、超时、网络错误），
 *    其余响应（4xx）是服务器的权威答复，重试无意义；
 * 3. 退避采用指数增长 + full jitter，避免大量客户端在同一时刻同步重试，
 *    对正在恢复中的服务端造成"惊群"冲击。
 */

import { HttpError, NetworkError, TimeoutError } from './errors';
import type { RetryOptions } from './types';

/** 默认重试策略：最多额外尝试 2 次，退避从 300ms 起、封顶 3s。 */
export const DEFAULT_RETRY: RetryOptions = {
  retries: 2,
  baseDelayMs: 300,
  maxDelayMs: 3_000,
  maxRetryAfterMs: 60_000,
};

/** 传输层默认认定可安全自动重试的读取方法。 */
const DEFAULT_RETRYABLE_METHODS = new Set(['GET', 'HEAD']);

/**
 * 判断指定请求是否允许传输层自动重试。
 *
 * 非读取请求自动重试可能导致操作被执行两次（如下单两次）。即使 HTTP 语义将
 * PUT/DELETE 定义为幂等，项目中的具体接口仍须由调用方确认。若需要重发，通常
 * 应由业务层携带稳定幂等键（Idempotency-Key）并显式传入 `idempotent: true`。
 *
 * @param method HTTP 方法；缺省按 `GET` 处理（与 fetch 默认行为一致）。
 * @returns 是否允许自动重试。
 */
export function canAutoRetry(method: string | undefined, idempotent: boolean | undefined): boolean {
  // 默认只放行不会改变资源状态的读取请求。即使 HTTP 规范将 PUT/DELETE 定义为幂等，
  // 也要求调用方明确确认后才重试，避免项目中不符合规范的接口被误重放。
  if (idempotent === true) {
    return true;
  }
  if (idempotent === false) {
    return false;
  }
  const normalizedMethod = (method ?? 'GET').toUpperCase();
  return DEFAULT_RETRYABLE_METHODS.has(normalizedMethod);
}

/**
 * 判断某个 HTTP 状态码是否值得重试。
 *
 * 408（请求超时）、429（限流）与 5xx（服务端故障）通常是瞬时的；其余 4xx 是服务器
 * 明确拒绝请求的权威答复，原样重发不会改变结果。
 *
 * @param status HTTP 状态码。
 * @returns 是否为可重试的瞬时状态。
 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * 判断某个传输层异常是否值得重试。
 *
 * 注意：调用方主动取消产生的 `AbortError`（DOMException）是有意行为，
 * 永远不参与重试，因此这里只认 {@link TimeoutError} 与 {@link NetworkError}。
 *
 * @param error 请求过程中捕获的异常。
 * @returns 是否为可重试的瞬时故障。
 */
export function isRetryableError(error: unknown): boolean {
  return error instanceof TimeoutError || error instanceof NetworkError;
}

/**
 * 计算第 `attempt` 次重试前的退避等待时长（full jitter 算法）。
 *
 * 先按 2^attempt 指数增长并以 maxDelayMs 封顶，再在 [0, 上限] 区间内取随机值。
 * 随机抖动是关键：它把并发客户端的重试时刻打散，避免服务端刚恢复
 * 就被整齐划一的第二波请求再次压垮。
 *
 * @param attempt 当前是第几次重试（从 0 开始计数）。
 * @param options 重试策略参数。
 * @returns 实际应等待的毫秒数。
 */
export function backoffDelay(attempt: number, options: RetryOptions): number {
  const exponential = Math.min(options.baseDelayMs * 2 ** attempt, options.maxDelayMs);
  return Math.random() * exponential;
}

/**
 * 从服务端限流/维护响应中读取建议等待时间。
 *
 * `Retry-After` 同时支持秒数与 HTTP 日期。即使服务端给出异常大的时间，
 * 也必须限制在客户端策略的上限内，避免单个响应无限期阻塞用户操作。
 */
export function retryAfterDelay(error: HttpError, options: RetryOptions): number | null {
  const retryAfter = error.headers.get('Retry-After');
  if (!retryAfter) {
    return null;
  }

  const seconds = Number(retryAfter);
  let requestedDelay: number;
  if (Number.isFinite(seconds) && seconds >= 0) {
    requestedDelay = seconds * 1_000;
  } else {
    requestedDelay = Date.parse(retryAfter) - Date.now();
  }

  if (!Number.isFinite(requestedDelay)) {
    return null;
  }
  const maxRetryAfterMs = options.maxRetryAfterMs ?? DEFAULT_RETRY.maxRetryAfterMs ?? 60_000;
  return Math.min(Math.max(0, requestedDelay), maxRetryAfterMs);
}

/**
 * 可被 AbortSignal 中断的延时等待。
 *
 * 退避等待期间如果调用方取消了请求，必须立即放弃等待并向上传播取消，
 * 而不是继续 sleep 到结束再发一个注定要被丢弃的请求。
 *
 * @param ms 等待时长（毫秒）。
 * @param signal 可选的中断信号。
 * @returns 等待完成的 Promise；被中断时以 signal.reason（或 AbortError）reject。
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    // 防御信号在进入 sleep 前就已经处于 aborted 状态的竞态。
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
