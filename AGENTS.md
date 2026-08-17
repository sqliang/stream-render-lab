# Repository Guidelines

## Project Structure & Module Organization

- `src/runtime/core`: normalized entities, store, and orchestration.
- `src/runtime/network`: JSON HTTP and SSE transport; HTTP is in `network/http`.
- `src/runtime/persistence`: IndexedDB recovery; `src/runtime/react` and `src/ui` adapt/render state.
- `server/mock-sse.mjs` is the local API/SSE server; tests sit beside code, e.g. `network/http/client.test.ts`.

## Build, Test, and Development Commands

- `pnpm install`: install dependencies; do not edit `pnpm-lock.yaml` by hand.
- `pnpm dev`: start Vite and the mock API/SSE server.
- `pnpm test`: run Vitest tests.
- `pnpm build`: run TypeScript validation and create the Vite production bundle.

After HTTP or type changes, run `pnpm test && pnpm build`.

## Coding Style & Naming Conventions

Use strict TypeScript. Use `PascalCase` for classes/types and `camelCase` for values/functions. Avoid `any`, unsafe assertions, magic numbers, and ambiguous booleans.

### Control Flow

Always use braces for `if`, `else if`, `else`, loops, `try`, `catch`, and `finally`, even for one statement. Do not use compact conditions, comma expressions, or non-trivial expression-bodied callbacks. Prefer intermediate variables over nested ternaries. Validate inputs early and make errors explicit.

### Comments and Documentation

Source-code comments must be Chinese and use TypeScript/JSDoc. Put a multi-line file header at byte zero—even for one sentence—using `/**`, one `*`-prefixed description line, and `*/` on separate lines. Every function, method, constructor, class, hook, and exported type must have a multi-line `/** ... */` block; add `@param`, `@returns`, and `@throws` where applicable. In core Runtime files, document state ownership, invariants, ordering, idempotency, recovery, and failure behavior—not obvious syntax—and update comments and README examples with behavior changes.

### General Practices

Favor pure helpers. Keep side effects at boundaries, preserve error causes, and clean up timers/listeners in `finally`. Add deterministic tests for failure and cancellation branches. Before public API changes, search callers, handle `null`, and document behavior.

## Architecture & HTTP Rules

Snapshot is server authority: apply it before SSE deltas. Preserve normalized stable IDs and `Message.blocks` order. Keep Core independent from React; do not parse SSE or mutate Runtime entities directly in UI code.

Use `requestJson<T>()` or `HttpClient` for JSON APIs. It returns `Promise<T | null>`; callers must handle `null`. Keep GET/HEAD retry behavior, total deadlines, error classes, and `Retry-After` support intact. Non-read retries require explicit `idempotent: true` and server-side idempotency.

## Testing, Commits, and Pull Requests

Add deterministic tests for new HTTP/Runtime behavior; inject `fetchFn` instead of using real network calls. Update the HTTP README whenever its public behavior changes.

Git history is unavailable, so no commit convention is asserted. Use concise imperative commits. PRs should describe behavior, tests, linked issues, and relevant UI screenshots.
