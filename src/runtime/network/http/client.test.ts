/**
 * @file HTTP 客户端的超时、重试、错误映射与钩子行为测试。
 */

import { describe, expect, it, vi } from 'vitest';

import { HttpClient } from './client';
import { HttpError, ResponseParseError, TimeoutError } from './errors';

describe('HttpClient', () => {
  it('空响应显式返回 null，避免伪装成泛型 T', async () => {
    const client = new HttpClient({ fetchFn: vi.fn().mockResolvedValue(new Response(null, { status: 204 })) });

    await expect(client.requestJson<{ id: string }>('/empty')).resolves.toBeNull();
  });

  it('保留非 2xx 响应的 Retry-After 与诊断元数据', async () => {
    const client = new HttpClient({
      retry: false,
      fetchFn: vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ code: 'RATE_LIMITED' }), {
        status: 429,
        statusText: 'Too Many Requests',
        headers: { 'Content-Type': 'application/json', 'Retry-After': '5' },
      }))),
    });

    await expect(client.requestJson('/limited')).rejects.toMatchObject({
      status: 429,
      body: { code: 'RATE_LIMITED' },
      url: '/limited',
      statusText: 'Too Many Requests',
    });

    try {
      await client.requestJson('/limited');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).headers.get('Retry-After')).toBe('5');
    }
  });

  it('优先使用 Retry-After: 0 后立即重试 GET', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'Retry-After': '0' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const client = new HttpClient({
      fetchFn,
      retry: { retries: 1, baseDelayMs: 10_000, maxDelayMs: 10_000 },
    });

    await expect(client.requestJson<{ ok: boolean }>('/status')).resolves.toEqual({ ok: true });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('默认不重试 PUT，只有显式确认幂等后才重试', async () => {
    const defaultFetch = vi.fn().mockRejectedValue(new TypeError('connection reset'));
    const defaultClient = new HttpClient({
      fetchFn: defaultFetch,
      retry: { retries: 1, baseDelayMs: 0, maxDelayMs: 0 },
    });
    await expect(defaultClient.requestJson('/resource/1', { method: 'PUT' })).rejects.toThrow('Network request failed');
    expect(defaultFetch).toHaveBeenCalledTimes(1);

    const idempotentFetch = vi.fn()
      .mockRejectedValueOnce(new TypeError('connection reset'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));
    const idempotentClient = new HttpClient({
      fetchFn: idempotentFetch,
      retry: { retries: 1, baseDelayMs: 0, maxDelayMs: 0 },
    });
    await expect(idempotentClient.requestJson<{ ok: boolean }>('/resource/1', {
      method: 'PUT',
      idempotent: true,
    })).resolves.toEqual({ ok: true });
    expect(idempotentFetch).toHaveBeenCalledTimes(2);
  });

  it('总时间预算可在单次请求超时之前终止整个逻辑请求', async () => {
    const fetchFn = vi.fn((_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    const client = new HttpClient({ fetchFn, timeoutMs: 1_000, retry: false });

    await expect(client.requestJson('/slow', { totalTimeoutMs: 10 })).rejects.toMatchObject({
      scope: 'total',
    } satisfies Partial<TimeoutError>);
  });

  it('将成功但非法 JSON 的响应标记为协议错误', async () => {
    const client = new HttpClient({
      retry: false,
      fetchFn: vi.fn().mockResolvedValue(new Response('<html>gateway error</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      })),
    });

    await expect(client.requestJson('/invalid-json')).rejects.toBeInstanceOf(ResponseParseError);
  });

  it('在调用边界拒绝非法的重试与超时配置', async () => {
    const client = new HttpClient({ fetchFn: vi.fn() });

    await expect(client.requestJson('/data', { timeoutMs: -1 })).rejects.toThrow('timeoutMs must be a finite number');
    await expect(client.requestJson('/data', {
      retry: { retries: -1, baseDelayMs: 0, maxDelayMs: 0 },
    })).rejects.toThrow('retry.retries must be a non-negative integer');
  });
});
