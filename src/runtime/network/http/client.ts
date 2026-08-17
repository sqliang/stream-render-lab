/**
 * @file HTTP 客户端核心实现。
 *
 * 在原生 `fetch` 之上补齐生产环境必需、而 `fetch` 本身缺失的能力：
 * - 超时控制：`fetch` 默认永不超时，这里用 AbortSignal 实现硬性截止；
 * - 有界重试：仅对幂等请求，指数退避 + 随机抖动（策略见 `retry.ts`）；
 * - 错误分类：HttpError / TimeoutError / NetworkError / ResponseParseError（见 `errors.ts`）；
 * - 拦截器：请求/响应钩子，用于统一注入鉴权头、链路追踪、监控上报等；
 * - 统一的 baseUrl 与默认请求头管理。
 */

import { HttpError, NetworkError, ResponseParseError, TimeoutError } from './errors';
import { backoffDelay, canAutoRetry, DEFAULT_RETRY, isRetryableError, isRetryableStatus, retryAfterDelay, sleep } from './retry';
import type { HttpClientOptions, RequestHook, RequestOptions, ResponseHook, RetryOptions } from './types';

/** 默认超时时间：10 秒。覆盖绝大多数 JSON API 的合理响应时长。 */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * 面向 JSON API 的 HTTP 客户端。
 *
 * 为 Snapshot 拉取与命令下发等场景提供一致的请求/响应处理。
 * 使用方式：通常共享 `index.ts` 中的 `defaultClient` 实例；
 * 需要独立配置（不同 baseUrl、鉴权方式）时才自行 `new HttpClient(...)`。
 */
export class HttpClient {
  private readonly baseUrl: string;
  private readonly defaultHeaders?: HeadersInit;
  private readonly timeoutMs: number;
  private readonly retry: RetryOptions | false;
  private readonly fetchFn: typeof fetch;
  private readonly requestHooks: RequestHook[] = [];
  private readonly responseHooks: ResponseHook[] = [];

  /**
   * @param options 客户端级默认配置，各字段含义见 {@link HttpClientOptions}。
   */
  constructor(options: HttpClientOptions = {}) {
    if (options.timeoutMs !== undefined) {
      validateTimeout('timeoutMs', options.timeoutMs);
    }
    if (options.retry) {
      validateRetryOptions(options.retry);
    }
    this.baseUrl = options.baseUrl ?? '';
    this.defaultHeaders = options.headers;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // 注意区别于 `?? false`：未显式传 retry 时启用默认策略，传 false 才是禁用。
    this.retry = options.retry ?? DEFAULT_RETRY;
    // 绑定 globalThis，避免 fetch 被摘出来调用时丢失 this 上下文（部分浏览器要求）。
    this.fetchFn = options.fetchFn ?? fetch.bind(globalThis);
  }

  /**
   * 注册请求钩子（每次实际发送前执行，含重试）。
   * @param hook 见 {@link RequestHook}。
   * @returns 注销函数，调用后移除该钩子。
   */
  onRequest(hook: RequestHook): () => void {
    this.requestHooks.push(hook);
    return () => this.removeHook(this.requestHooks, hook);
  }

  /**
   * 注册响应钩子（每收到一个 HTTP 响应都会执行，含将被重试的错误响应）。
   * @param hook 见 {@link ResponseHook}。
   * @returns 注销函数，调用后移除该钩子。
   */
  onResponse(hook: ResponseHook): () => void {
    this.responseHooks.push(hook);
    return () => this.removeHook(this.responseHooks, hook);
  }

  /**
   * 发起一次 JSON 请求并返回解析后的响应体。
   *
   * 重试编排：GET/HEAD 默认应用重试策略；其他方法须由调用方显式确认语义幂等；
   * 每次失败后先按退避策略等待（等待可被调用方的 AbortSignal 打断），再进入下一次尝试。
   *
   * @typeParam T 期望的响应体类型（仅编译期约束，不做运行时校验）。
   * @param path 请求路径；非绝对 URL 时会拼接客户端的 baseUrl。
   * @param options 请求配置，`RequestInit` 之外支持超时、总预算与重试覆盖项。
   * @returns 解析后的 JSON 响应体；空响应（如 204）返回 `null`。
   * @throws {HttpError} 服务器返回非 2xx 状态码。
   * @throws {TimeoutError} 超过 timeoutMs 未收到响应。
   * @throws {NetworkError} 请求未到达响应阶段（断网、连接重置等）。
   * @throws {DOMException} 调用方主动取消时为 name 为 `AbortError` 的 DOMException。
   */
  async requestJson<T>(path: string, options: RequestOptions = {}): Promise<T | null> {
    const {
      timeoutMs = this.timeoutMs,
      totalTimeoutMs,
      retry = this.retry,
      idempotent,
      ...init
    } = options;
    const url = this.resolveUrl(path);
    let policy: RetryOptions | null;
    if (retry === false) {
      policy = null;
    } else {
      policy = retry;
    }
    validateTimeout('timeoutMs', timeoutMs);
    if (totalTimeoutMs !== undefined) {
      validateTimeout('totalTimeoutMs', totalTimeoutMs);
    }
    if (policy) {
      validateRetryOptions(policy);
    }

    // GET/HEAD 默认具备重试资格；其他方法必须由调用方显式确认语义幂等，
    // 例如服务端已通过 Idempotency-Key 对 POST 做去重后才可传入 `idempotent: true`。
    let maxAttempts = 1;
    if (policy && canAutoRetry(init.method, idempotent)) {
      maxAttempts = 1 + policy.retries;
    }

    let deadline: AbortScope | null = null;
    if (totalTimeoutMs !== undefined) {
      deadline = createDeadline(totalTimeoutMs);
    }
    let lastError: unknown = undefined;

    try {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        // 重试前先退避等待。整个等待同样受总预算和调用方取消约束，
        // 不能在调用方已经放弃请求后继续等待并发送下一次尝试。
        if (attempt > 0 && policy) {
          const delay = this.retryDelayFor(lastError, attempt - 1, policy);
          await this.waitBeforeRetry(delay, init.signal, deadline, url);
        }

        try {
          return await this.attempt<T>(url, init, timeoutMs, deadline, attempt);
        } catch (error) {
          let retryable: boolean;
          if (error instanceof HttpError) {
            retryable = isRetryableStatus(error.status);
          } 
          else {
            retryable = isRetryableError(error);
          }
          // 不可重试的错误（普通 4xx、协议错误、调用方取消）或次数已用尽：如实向上抛出。
          if (!retryable || attempt + 1 >= maxAttempts) {
            throw error;
          }
          lastError = error;
        }
      }
    } finally {
      // 总预算定时器在请求提前完成或失败时必须清理，避免留下无意义的异步中止。
      deadline?.dispose();
    }
    // 不可达分支：循环体要么 return 要么 throw；此处仅为满足 TypeScript 的返回路径检查。
    throw new NetworkError(url);
  }

  /**
   * 执行单次尝试：组装请求、应用钩子、发送、解析响应。
   * 
   * 本方法不感知重试，失败时直接抛出已分类的异常，由 {@link requestJson} 决定是否再试。
   */
  private async attempt<T>(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    deadline: AbortScope | null,
    attempt: number,
  ): Promise<T | null> {
    // 单次尝试和整个逻辑请求各有独立超时来源。二者合并为一个 fetch signal，
    // 但仍保留来源信息，以便向上层报告“单次慢”还是“总预算耗尽”。
    const scope = createAbortScope(timeoutMs, [init.signal, deadline?.signal]);
    try {
      const finalInit: RequestInit = { ...init, headers: this.mergeHeaders(init.headers), signal: scope.signal };
      for (const hook of this.requestHooks) {
        await hook({ url, init: finalInit, attempt });
      }
      // 钩子可以补充 headers 等请求元数据，但不能覆盖模块创建的取消/超时边界。
      finalInit.signal = scope.signal;

      let response: Response;
      
      try {
        response = await this.fetchFn(url, finalInit);
      } 
      catch (error) {
        this.throwTransportError(error, url, timeoutMs, init.signal, scope, deadline);
      }

      for (const hook of this.responseHooks) {
        await hook({ url, response, attempt });
      }

      // 先按文本读取再解析，可以区分"空响应体"（204、HEAD 等合法情况）与"JSON 格式错误"。
      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        this.throwTransportError(error, url, timeoutMs, init.signal, scope, deadline);
      }
      // 有些运行时在响应已缓冲完成后不会因 signal 中止 text()；
      // 此处再次检查，确保总预算和单次超时仍是返回数据前的硬边界。
      if (deadline?.timedOut()) {
        throw new TimeoutError(url, deadline.timeoutMs ?? 0, 'total');
      }
      if (scope.timedOut()) {
        throw new TimeoutError(url, timeoutMs, 'attempt');
      }

      let body: unknown = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch (cause) {
          // 2xx 却返回了非法 JSON 属于协议破坏，必须显式报错；
          // 非 2xx 的非法响应体（如网关返回的 HTML 错误页）则吞掉，
          // 由下面的 HttpError 携带 status 与 null body 如实上报。
          if (response.ok) {
            throw new ResponseParseError(url, response.status, response.headers.get('Content-Type'), { cause });
          }
        }
      }
      if (!response.ok) {
        throw new HttpError(response.status, body, {
          url,
          statusText: response.statusText,
          // Response 对象会被本方法消费；复制 headers 让错误对象在上层仍可安全读取。
          headers: new Headers(response.headers),
        });
      }
      return body as T;
    } finally {
      // 无论成功、网络失败还是钩子异常，都必须释放单次超时监听和定时器。
      scope.dispose();
    }
  }

  /** 根据上一次失败决定下一次等待时间，优先服从服务端的 Retry-After 指示。 */
  private retryDelayFor(error: unknown, retryAttempt: number, policy: RetryOptions): number {
    if (error instanceof HttpError) {
      const serverDelay = retryAfterDelay(error, policy);
      if (serverDelay !== null) {
        return serverDelay;
      }
    }
    return backoffDelay(retryAttempt, policy);
  }

  /** 在退避阶段把用户取消与总请求截止合并，确保等待不会越过总预算。 */
  private async waitBeforeRetry(
    delayMs: number,
    userSignal: AbortSignal | null | undefined,
    deadline: AbortScope | null,
    url: string,
  ): Promise<void> {
    const scope = createAbortScope(undefined, [userSignal, deadline?.signal]);
    try {
      await sleep(delayMs, scope.signal);
    } catch (error) {
      this.throwTransportError(error, url, 0, userSignal, scope, deadline);
    } finally {
      scope.dispose();
    }
  }

  /**
   * 统一还原传输中止原因。
   *
   * 先判定总预算，再判定单次尝试超时，最后才保留调用方主动取消；
   * 这是为了让上层能根据真实语义决定重试、提示或静默忽略。
   */
  private throwTransportError(
    error: unknown,
    url: string,
    timeoutMs: number,
    userSignal: AbortSignal | null | undefined,
    scope: AbortScope,
    deadline: AbortScope | null,
  ): never {
    
    if (deadline?.timedOut()) {
      throw new TimeoutError(url, deadline.timeoutMs ?? 0, 'total');
    }
    
    if (scope.timedOut()) {
      throw new TimeoutError(url, timeoutMs, 'attempt');
    }
    
    if (userSignal?.aborted) {
      throw error;
    }
    
    throw new NetworkError(url, { cause: error });
  }

  /**
   * 按优先级合并请求头（后者覆盖前者）：
   * `Accept: application/json` 默认值 < 客户端默认请求头 < 单次请求请求头。
   */
  private mergeHeaders(requestHeaders?: HeadersInit): Headers {
    const headers = new Headers({ Accept: 'application/json' });
    new Headers(this.defaultHeaders).forEach((value, key) => headers.set(key, value));
    new Headers(requestHeaders).forEach((value, key) => headers.set(key, value));
    return headers;
  }

  /**
   * 将请求路径解析为完整 URL。
   * 绝对地址（`http(s)://` 或协议相对 `//`）原样使用，否则拼上 baseUrl。
   */
  private resolveUrl(path: string): string {
    if (/^(https?:)?\/\//i.test(path)) {
      return path;
    }
    const baseUrl = this.baseUrl.replace(/\/+$/, '');
    let normalizedPath: string;
    if (path.startsWith('/')) {
      normalizedPath = path;
    } else {
      normalizedPath = `/${path}`;
    }
    return `${baseUrl}${normalizedPath}`;
  }

  /** 从钩子数组中移除指定钩子（注册函数返回的注销闭包使用）。 */
  private removeHook<T>(hooks: T[], hook: T): void {
    const index = hooks.indexOf(hook);
    if (index >= 0) {
      hooks.splice(index, 1);
    }
  }
}

/** 由客户端管理的中止范围；相比直接依赖 AbortSignal 静态方法，能够及时清理定时器和监听器。 */
interface AbortScope {
  signal: AbortSignal;
  timeoutMs?: number;
  timedOut: () => boolean;
  dispose: () => void;
}

/** 创建整个逻辑请求的总时间预算。 */
function createDeadline(totalTimeoutMs: number): AbortScope {
  return createAbortScope(totalTimeoutMs, []);
}

/**
 * 合并多个取消来源，并可选地附加一个模块管理的超时来源。
 *
 * 手动管理监听器的目的并非替代浏览器原生能力，而是保证请求已完成时立即清理 timer，
 * 同时兼容不支持 AbortSignal.timeout()/any() 的运行环境。
 */
function createAbortScope(timeoutMs: number | undefined, signals: Array<AbortSignal | null | undefined>): AbortScope {
  const controller = new AbortController();
  let timeoutTriggered = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners: Array<{ signal: AbortSignal; onAbort: () => void }> = [];

  const abortFrom = (signal: AbortSignal) => controller.abort(signal.reason);
  for (const source of signals) {
    if (!source) {
      continue;
    }
    if (source.aborted) {
      abortFrom(source);
      break;
    }
    const onAbort = () => abortFrom(source);
    source.addEventListener('abort', onAbort, { once: true });
    listeners.push({ signal: source, onAbort });
  }

  if (!controller.signal.aborted && timeoutMs !== undefined) {
    timer = setTimeout(() => {
      timeoutTriggered = true;
      controller.abort(new DOMException('Timed out', 'TimeoutError'));
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    timeoutMs,
    timedOut: () => timeoutTriggered,
    dispose: () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      for (const { signal, onAbort } of listeners) {
        signal.removeEventListener('abort', onAbort);
      }
    },
  };
}

/** 在构造与调用边界尽早拒绝非法超时，避免错误在浏览器内部以不透明方式出现。 */
function validateTimeout(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a finite number greater than or equal to 0`);
  }
}

/** 校验重试策略的数值不变量，避免负重试次数或反向退避导致不可预测行为。 */
function validateRetryOptions(options: RetryOptions): void {
  if (!Number.isInteger(options.retries) || options.retries < 0) {
    throw new TypeError('retry.retries must be a non-negative integer');
  }
  validateTimeout('retry.baseDelayMs', options.baseDelayMs);
  validateTimeout('retry.maxDelayMs', options.maxDelayMs);
  if (options.baseDelayMs > options.maxDelayMs) {
    throw new TypeError('retry.baseDelayMs must not exceed retry.maxDelayMs');
  }
  if (options.maxRetryAfterMs !== undefined) {
    validateTimeout('retry.maxRetryAfterMs', options.maxRetryAfterMs);
  }
}
