/**
 * @file HTTP 错误类型定义。
 *
 * 将一次请求可能失败的方式划分为三类，使调用方可以精确地区分处理：
 * - {@link HttpError}：服务器返回了非 2xx 响应（业务/协议层失败）；
 * - {@link TimeoutError}：在约定时间内没有收到任何响应（可能是慢服务或假死连接）；
 * - {@link NetworkError}：请求根本没有拿到 HTTP 响应（DNS 失败、断网、连接重置等）；
 * - {@link ResponseParseError}：服务端成功响应，但响应体不符合本模块的 JSON 契约。
 *
 * 注意：调用方通过 `AbortSignal` 主动取消请求不属于以上任何一类，
 * 此时会原样抛出 DOM 标准的 `AbortError`（DOMException），不做二次包装。
 */

/**
 * 服务器已响应，但状态码为非 2xx。
 *
 * 这是"协议层面成功、业务层面失败"的错误：响应体 `body` 中通常携带
 * 服务器返回的结构化错误信息（若响应体为合法 JSON，则已被解析）。
 */
export class HttpError extends Error {
  /**
   * @param status HTTP 状态码，如 400 / 404 / 503。
   * @param body 已解析的响应体（JSON 对象）；响应体为空或非 JSON 时为 `null`。
   * @param context 用于诊断和重试决策的响应元数据。
   */
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    public readonly context: {
      url: string;
      statusText: string;
      headers: Headers;
    },
  ) {
    super(`HTTP ${status}`);
    // 显式设置 name：Error 子类经编译/压缩后 constructor.name 可能丢失，
    // 依赖 e.name 做日志分类时才能保证稳定输出。
    this.name = 'HttpError';
  }

  /** 请求的完整 URL，作为常用诊断字段的便捷访问方式保留。 */
  get url(): string {
    return this.context.url;
  }

  /** 服务端返回的状态文本。 */
  get statusText(): string {
    return this.context.statusText;
  }

  /** 响应头副本；例如重试逻辑会读取 `Retry-After`。 */
  get headers(): Headers {
    return this.context.headers;
  }
}

/**
 * 在配置的超时时间内未收到任何响应。
 *
 * 与调用方主动取消（AbortError）严格区分：超时意味着"服务器可能已收到请求
 * 但响应丢失或尚未产生"，因此重试非幂等请求时必须由业务层携带幂等键决策，
 * 传输层只负责如实上报。
 */
export class TimeoutError extends Error {
  /**
   * @param url 请求的完整 URL。
   * @param timeoutMs 触发本次超时的阈值（毫秒），用于诊断信息。
   */
  constructor(
    public readonly url: string,
    public readonly timeoutMs: number,
    /** `attempt` 表示单次尝试超时，`total` 表示整个逻辑请求超过总预算。 */
    public readonly scope: 'attempt' | 'total' = 'attempt',
  ) {
    super(createTimeoutMessage(scope, timeoutMs));
    this.name = 'TimeoutError';
  }
}

/** 根据超时范围生成面向日志与用户提示的明确错误信息。 */
function createTimeoutMessage(scope: 'attempt' | 'total', timeoutMs: number): string {
  if (scope === 'total') {
    return `Request deadline exceeded after ${timeoutMs}ms`;
  }
  return `Request timed out after ${timeoutMs}ms`;
}

/**
 * HTTP 状态码为 2xx，但响应体无法按 JSON API 契约解析。
 *
 * 这通常意味着网关配置错误、服务端返回了 HTML，或前后端协议发生漂移；
 * 它不是网络层失败，因此不能被网络重试策略静默吞掉。
 */
export class ResponseParseError extends Error {
  constructor(
    public readonly url: string,
    public readonly status: number,
    public readonly contentType: string | null,
    options?: { cause?: unknown },
  ) {
    super(`Invalid JSON response from ${url}`, options);
    this.name = 'ResponseParseError';
  }
}

/**
 * 请求未能到达 HTTP 响应阶段：DNS 解析失败、TCP 连接被重置、浏览器离线等。
 *
 * 原始异常通过标准的 `cause` 属性链保留，便于排查底层原因。
 */
export class NetworkError extends Error {
  /**
   * @param url 请求的完整 URL。
   * @param options 透传给 `Error` 构造器的选项，`cause` 为底层原始异常。
   */
  constructor(
    public readonly url: string,
    options?: { cause?: unknown },
  ) {
    super('Network request failed', options);
    this.name = 'NetworkError';
  }
}
