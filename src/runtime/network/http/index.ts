/**
 * @file HTTP 模块的统一出口。
 *
 * 对外提供三样东西：
 * - `defaultClient`：全应用共享的客户端实例（同源 JSON API 使用）；
 * - `requestJson`：面向简单调用点的便捷函数，委托给 `defaultClient`；
 * - 全部错误类型、配置类型与 `HttpClient` 类本身的再导出。
 *
 * 需要统一注入鉴权 Token、链路追踪 ID 时，在 `defaultClient` 上注册
 * `onRequest` 钩子即可，各调用点无需改动。
 */

import { HttpClient } from './client';
import type { RequestOptions } from './types';

/**
 * 应用内同源 JSON API 的共享客户端实例；鉴权、追踪等横切钩子统一注册在这里。
 */
export const defaultClient = new HttpClient();

/**
 * 便捷函数：使用共享客户端发起 JSON 请求。
 *
 * 适用于不需要独立客户端配置的普通调用点。
 *
 * @typeParam T 期望的响应体类型。
 * @param url 请求路径（如 `/api/conversations/...`）或绝对 URL。
 * @param init 请求配置，支持 `RequestInit` 及超时、总预算、重试等扩展项。
 * @returns 解析后的 JSON 响应体；空响应体返回 `null`。
 */
export function requestJson<T>(url: string, init: RequestOptions = {}): Promise<T | null> {
  return defaultClient.requestJson<T>(url, init);
}

export { HttpClient } from './client';
export { HttpError, NetworkError, ResponseParseError, TimeoutError } from './errors';
export { DEFAULT_RETRY } from './retry';
export type { HttpClientOptions, RequestHook, RequestOptions, ResponseHook, RetryOptions } from './types';
