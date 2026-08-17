/**
 * @file Runtime 投影的持久化协调器。
 */

import { RuntimeCoreStore } from '../core/store';
import type { PersistedRuntimeState } from '../core/types';
import { RuntimeIndexedDb } from './indexed-db';

/**
 * 将高频流式更新串行、批量写入 IndexedDB，并确保投影与游标来自同一时刻。
 */
export class RuntimePersistenceCoordinator {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private saving: Promise<void> = Promise.resolve();
  private unsubscribe: (() => void) | null = null;

  /**
   * @param store - 提供投影快照与变更订阅的 Runtime Store。
   * @param database - 执行原子读写的 IndexedDB 边界。
   * @param debounceMs - 高频流式事件合并写入的等待时间。
   */
  constructor(
    private readonly store: RuntimeCoreStore,
    private readonly database: RuntimeIndexedDb,
    private readonly debounceMs = 120,
  ) {}

  /**
   * 读取最近一次完整持久化状态。
   *
   * @returns 已保存状态；无缓存或浏览器不支持时返回 `null`。
   */
  async restore() {
    return this.database.restore();
  }

  /**
   * 恢复完成后才开始订阅 Store，避免空 Store 覆盖有效缓存。
   */
  start() {
    if (this.started) {
      return;
    }
    this.started = true;
    this.unsubscribe = this.store.subscribe(() => this.schedule());
  }

  /**
   * 安排一次防抖持久化，合并连续 SSE 更新以降低 IndexedDB 写入频率。
   */
  schedule() {
    if (!this.started || this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flushNow();
    }, this.debounceMs);
  }

  /**
   * 立即保存当前投影，用于 Outbox 入队与 Run 终态等不能只依赖防抖的边界。
   */
  flushNow() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const captured: PersistedRuntimeState = this.store.toPersistedState();
    // 串行化写入，避免更早但更慢的 IndexedDB 事务覆盖较新的事实。
    this.saving = this.saving.then(() => this.database.save(captured)).catch((error) => {
      // 持久化失败不能中断活跃 Agent 会话；下一次 Store 变更会重新尝试。
      console.warn('Runtime local persistence failed', error);
    });
    return this.saving;
  }

  /**
   * 取消 Store 订阅，并在释放前保存最后一份投影。
   *
   * @returns 最终持久化任务。
   */
  dispose() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    return this.flushNow();
  }
}
