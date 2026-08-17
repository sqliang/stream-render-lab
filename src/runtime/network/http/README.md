# HTTP 模块

`src/runtime/network/http` 是项目中面向 **JSON HTTP API** 的轻量传输层。它基于原生 `fetch`，统一提供：

- `baseUrl` 与默认请求头；
- 超时和调用方取消；
- 受总时间预算约束的有界自动重试，并支持 `Retry-After`；
- 请求/响应钩子；
- 统一的 HTTP、网络、超时与 JSON 协议错误；
- 空响应体的 JSON 处理。

它不负责领域接口定义、服务端状态缓存、鉴权刷新、文件传输或 SSE/WebSocket。上层应通过领域 API 调用它，而不是把业务逻辑放进 HTTP 钩子。

## 最常用的调用方式

从模块统一出口导入 `requestJson`。它使用全应用共享的 `defaultClient`，适合调用同源 JSON API。

```ts
import { requestJson } from '@/runtime/network/http';

interface ConversationSnapshot {
  id: string;
  title: string;
}

const snapshot = await requestJson<ConversationSnapshot>(
  '/api/conversations/conversation-1',
);
if (snapshot === null) {
  throw new Error('Snapshot 接口不应返回空响应');
}
```

`requestJson<T>` 返回 `T | null`。空响应体（例如 `204 No Content`）会显式返回 `null`；调用方必须先判断，不能将它当作 `T` 使用。

```ts
await requestJson<void>('/api/runs/run-1/cancel', { method: 'POST' });
```

请求体、请求头及其余原生 `RequestInit` 参数原样传入：

```ts
await requestJson<{ id: string }>('/api/messages', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ conversationId: 'conversation-1', text: '你好' }),
  // 写请求默认不会自动重试。
});
```

## 客户端配置

需要不同服务地址、默认头或测试替身时，创建独立的 `HttpClient`：

```ts
import { HttpClient } from '@/runtime/network/http';

const apiClient = new HttpClient({
  baseUrl: '/api',
  headers: { 'X-Client': 'stream-render-lab' },
  timeoutMs: 5_000,
  retry: {
    retries: 1,
    baseDelayMs: 200,
    maxDelayMs: 1_000,
    maxRetryAfterMs: 10_000,
  },
});

const run = await apiClient.requestJson<{ id: string }>('/runs/run-1');
if (run === null) {
  throw new Error('Run 接口不应返回空响应');
}
```

配置优先级：单次请求配置高于客户端配置；请求头按 `Accept: application/json` → 客户端默认头 → 单次请求头合并，后面的同名字段覆盖前面。

客户端构造和每次请求都会校验超时、重试次数及退避参数：超时必须是有限且不小于 0 的数字，`retries` 必须是非负整数，`baseDelayMs` 不能大于 `maxDelayMs`。不合法配置会立即抛出 `TypeError`。

`baseUrl` 只会拼接相对路径；`https://...`、`http://...` 和 `//...` 开头的绝对地址保持不变。

## 超时、取消与重试

默认单次尝试超时为 10 秒，可在单次请求中覆盖。`totalTimeoutMs` 是包含退避与重试的总时间预算；超时会抛出 `TimeoutError`，其 `scope` 为 `attempt` 或 `total`：

```ts
await requestJson<Data>('/api/slow-endpoint', {
  timeoutMs: 10_000,
  totalTimeoutMs: 15_000,
});
```

使用 `AbortController` 可主动取消请求。主动取消会保留浏览器原生的 `AbortError`，不会包装成网络错误：

```ts
const controller = new AbortController();
const pending = requestJson<Data>('/api/search?q=runtime', {
  signal: controller.signal,
});

controller.abort();
await pending;
```

默认重试策略为“额外重试 2 次，首次等待最多 300ms、后续指数退避并封顶 3 秒，带随机抖动”。只有 `GET` 和 `HEAD` 会默认应用自动重试，且只重试：

- `408`、`429` 和 `5xx` 响应；
- `TimeoutError`；
- `NetworkError`。

`POST`、`PUT`、`PATCH`、`DELETE` 默认只尝试一次。只有调用方已经确认服务端保证幂等（例如使用稳定的 `Idempotency-Key`）时，才能传入 `idempotent: true` 开启其自动重试：

```ts
await requestJson<SendMessageResponse>('/api/messages', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Idempotency-Key': stableKey },
  body: JSON.stringify(payload),
  idempotent: true,
});
```

对于 `408`、`429` 或 `5xx` 的可重试响应，若带有合法的 `Retry-After`，模块会优先使用它；该头支持秒数和 HTTP 日期，等待时间受 `maxRetryAfterMs`（默认 60 秒）限制。可为单次请求关闭 GET/HEAD 重试：

```ts
await requestJson<Data>('/api/live-status', { retry: false });
```

## 钩子

钩子注册在客户端实例上。请求钩子在每一次实际发送前执行，因此重试时也会再次执行；响应钩子会收到每一个 HTTP 响应，包括后续将被重试的非 2xx 响应。

```ts
import { defaultClient } from '@/runtime/network/http';

const removeRequestHook = defaultClient.onRequest(({ init, attempt }) => {
  const headers = new Headers(init.headers);
  headers.set('X-Request-Source', 'web');
  headers.set('X-Attempt', String(attempt));
  init.headers = headers;
});

const removeResponseHook = defaultClient.onResponse(({ url, response, attempt }) => {
  console.info('HTTP response', { url, status: response.status, attempt });
});

// 不再需要时移除，避免重复注册。
removeRequestHook();
removeResponseHook();
```

响应钩子不能直接消费 `response.body`；如需读取内容，请使用 `response.clone()`，否则后续 JSON 解析会失败。

请求钩子可以补充 URL 以外的请求配置（常见是 headers），但模块会在钩子执行后重新写入自己的 `signal`，因此钩子不能替换超时和取消边界。任一请求或响应钩子抛出异常时，本次请求会立即失败，并且该异常不会被自动重试。

## 错误处理

模块导出四种可判断的错误类型：

```ts
import {
  HttpError,
  NetworkError,
  ResponseParseError,
  TimeoutError,
  requestJson,
} from '@/runtime/network/http';

try {
  await requestJson<Data>('/api/data');
} catch (error) {
  if (error instanceof HttpError) {
    // 服务端已响应，但状态码不是 2xx。
    console.error(error.status, error.body, error.url, error.headers.get('Retry-After'));
  } 
  else if (error instanceof TimeoutError) {
    console.error(error.scope, error.timeoutMs, error.url);
  } 
  else if (error instanceof NetworkError) {
    // 没有获得 HTTP 响应；底层异常在 error.cause。
    console.error(error.url, error.cause);
  } 
  else if (error instanceof ResponseParseError) {
    // 接口成功响应，但响应体不是本模块要求的 JSON。
    console.error(error.status, error.contentType, error.url);
  }
  else if (error instanceof DOMException && error.name === 'AbortError') {
    // 调用方主动取消，通常无需报错提示。
  } 
  else {
    // 例如 2xx 响应却不是合法 JSON。
    throw error;
  }
}
```

所有响应都会先被读为文本再尝试 JSON 解析：

- 非 `2xx`：抛出 `HttpError`；若响应体是合法 JSON，内容在 `error.body`，否则为 `null`。
- `2xx` + 空响应体：返回 `null`。
- `2xx` + 非法 JSON：抛出 `ResponseParseError`，携带 URL、状态码和 Content-Type。

## 请求执行顺序

```text
requestJson
  → requestJson 的重试与总预算编排
  → attempt（合并 headers、创建取消/超时 signal、运行请求钩子）
  → fetchFn(url, finalInit)  ← 实际发送 HTTP 请求
  → 响应钩子
  → 读取并解析 JSON / 返回数据或抛出标准错误
```

`fetchFn` 默认是浏览器全局 `fetch` 的绑定版本；单元测试或非浏览器运行时可在创建 `HttpClient` 时注入替代实现。

## 当前边界与注意事项

- `T` 只提供 TypeScript 编译期提示，不会校验响应数据的实际结构。
- 相对路径会与 `baseUrl` 规范化拼接；绝对 URL 保持原样。不要将不可信输入直接作为 URL 传入，尤其是客户端默认头中包含敏感凭据时。
- 模块默认只声明 `Accept: application/json`，不会自动为请求体添加 `Content-Type`；发送 JSON 时由调用方显式设置。
- 读取响应体后才返回数据，因此不适合下载、流式响应或需要读取原始 `Response` 的场景。
- 不内置 Token 获取/刷新、CSRF、缓存、请求去重、离线队列或埋点；这些能力应由项目其他层按实际需求组合。
- 此模块仅服务普通 HTTP JSON 请求；SSE 由相邻的 `src/runtime/network/sse.ts` 处理。

## 对外 API

| 导出项 | 用途 |
| --- | --- |
| `requestJson<T>(url, init?)` | 使用共享 `defaultClient` 发起 JSON 请求。 |
| `defaultClient` | 同源 API 的共享 `HttpClient`，可在应用初始化处注册钩子。 |
| `HttpClient` | 创建带独立默认配置的客户端。 |
| `HttpError` / `TimeoutError` / `NetworkError` / `ResponseParseError` | 区分服务端响应、超时、网络失败与 JSON 协议错误。 |
| `DEFAULT_RETRY` | 默认重试参数。 |
| `HttpClientOptions` / `RequestOptions` / `RetryOptions` | 客户端与请求配置类型。 |
| `RequestHook` / `ResponseHook` | 钩子类型。 |
