/**
 * @file HTTP 客户端的公开类型契约。
 *
 * 本文件只包含类型定义，不包含任何运行时代码：
 * - {@link RetryOptions}：重试策略参数；
 * - {@link HttpClientOptions}：构造 `HttpClient` 时的客户端级配置；
 * - {@link RequestOptions}：单次请求级配置（在 `RequestInit` 之上扩展）；
 * - {@link RequestHook} / {@link ResponseHook}：拦截器（钩子）函数签名。
 */

/** 重试策略。默认用于 GET/HEAD；其他方法须在请求中显式确认语义幂等，见 `retry.ts`。 */
export interface RetryOptions {
  /** 首次失败后允许的额外尝试次数。总请求次数 = 1 + retries。 */
  retries: number;
  /** 首次退避等待时长（毫秒）；之后每次尝试按指数翻倍。 */
  baseDelayMs: number;
  /** 退避等待时长的上限（毫秒），在叠加随机抖动之前截断。 */
  maxDelayMs: number;
  /**
   * 服务端通过 `Retry-After` 指定的等待时间上限（毫秒）。
   *
   * 该字段用于防止异常响应把客户端无限期挂起；未指定时使用模块默认上限。
   */
  maxRetryAfterMs?: number;
}

/** `HttpClient` 构造配置：作用于该客户端实例发出的所有请求。 */
export interface HttpClientOptions {
  /**
   * 请求路径前缀，例如 `/api`。
   * 仅当请求路径不是绝对 URL（`http://`、`https://`、`//` 开头）时才会拼接。
   */
  baseUrl?: string;
  /** 随每个请求发送的默认请求头；单次请求传入的同名请求头优先级更高。 */
  headers?: HeadersInit;
  /**
   * 默认的单次请求超时时间（毫秒），缺省为 10 秒。
   * 原生 `fetch` 本身没有超时概念（会一直挂到 TCP 层放弃），必须由客户端补齐。
   */
  timeoutMs?: number;
  /** 默认重试策略；传 `false` 表示该客户端完全禁用重试。 */
  retry?: RetryOptions | false;
  /**
   * 可注入的 `fetch` 实现，缺省使用全局 `fetch`。
   * 用于单元测试（注入 mock）或非浏览器运行时（注入 node-fetch 等）。
   */
  fetchFn?: typeof fetch;
}

/**
 * 单次请求的配置：完整的 `RequestInit` 能力，外加传输层扩展项。
 * 请求级配置优先于客户端级默认配置。
 */
export interface RequestOptions extends RequestInit {
  /** 覆盖客户端默认超时时间（毫秒）。 */
  timeoutMs?: number;
  /** 覆盖客户端默认重试策略；传 `false` 表示本次请求禁用重试。 */
  retry?: RetryOptions | false;
  /**
   * 整个逻辑请求的总时间预算（毫秒），包含退避等待与所有重试尝试。
   *
   * `timeoutMs` 限制单次尝试；`totalTimeoutMs` 限制调用方等待本次请求的总时长。
   */
  totalTimeoutMs?: number;
  /**
   * 调用方对本次请求语义幂等性的显式确认。
   *
   * 默认只有 GET/HEAD 自动重试。对于 PUT、DELETE 或服务端使用幂等键保证的 POST，
   * 调用方确认 `true` 后，才会在配置的重试策略下自动重试。
   */
  idempotent?: boolean;
}

/**
 * 请求钩子（拦截器）：在每一次实际发送之前执行（包括每次重试）。
 *
 * 允许直接修改 `init`（例如注入鉴权 Token、链路追踪 ID 等请求头）。
 * 多个钩子按注册顺序依次执行；异步钩子会被等待。
 *
 * @param context.url 本次请求的完整 URL（已拼接 baseUrl）。
 * @param context.init 即将发送的请求配置（已合并默认请求头与超时 signal）。
 * @param context.attempt 当前实际发送次数，从 0 开始计数。
 */
export type RequestHook = (context: { url: string; init: RequestInit; attempt: number }) => void | Promise<void>;

/**
 * 响应钩子（拦截器）：每收到一个 HTTP 响应都会执行，
 * 包括即将被判定重试的非 2xx 响应。
 *
 * 注意：不要在此消费 `response.body`，否则后续 JSON 解析将拿不到内容；
 * 如需读取请先 `response.clone()`。
 *
 * @param context.url 本次请求的完整 URL。
 * @param context.response 原始 `Response` 对象（可能为错误状态码）。
 * @param context.attempt 当前实际发送次数，从 0 开始计数。
 */
export type ResponseHook = (context: { url: string; response: Response; attempt: number }) => void | Promise<void>;
