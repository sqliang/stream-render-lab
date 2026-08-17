# Stream Render Lab

一个研究流式响应与增量渲染的长期实验工程（React 19 + Vite 8，数据全部 Mock），数据流如下：

```text
Mock SSE → Runtime Core Store → runtime-react Adapter → 混排会话 UI
```

## 启动

```bash
pnpm install
pnpm dev
```

浏览器打开 Vite 输出的地址（默认配置为 `http://localhost:5175`）。

## 演示内容

- `fetch-event-source` 建立 SSE 订阅，携带 `Last-Event-ID` 续传游标；
- Snapshot 先写入 Core Store，随后 SSE 只写入局部实体；
- Conversation、Run、RunStep、Message、ContentBlock、Asset、Artifact、UI Schema / Data 全部按 ID 归一化；
- Markdown、图片、Schema + 流式数据、最终产物按 Block 顺序混排；
- `runtime-react` 以 selector 订阅，Markdown delta 只更新 Markdown Block，UI data 只更新富 UI；
- RunStep 在右侧单独渲染，避免与最终消息混在一起；
- 输入框的“发送”会重新加载 Snapshot 并重放 Mock 流，方便反复观察运行过程。

## 目录

```text
server/mock-sse.mjs          Mock HTTP Snapshot + SSE 服务
src/runtime/network          HTTP 与 fetch-event-source transport
src/runtime/core             实体类型、归一化 Store、Facade
src/runtime/react            React Provider、selector hooks
src/ui                       Agent 会话、RunStep、混排 Block Renderer
```

## 验证

```bash
pnpm build
```

构建会运行 TypeScript 校验并使用 Vite 产出生产包。
