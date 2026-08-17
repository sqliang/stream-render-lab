/**
 * @file Runtime 投影与 SSE 游标的 IndexedDB 原子持久化边界。
 */

import type { PersistedRuntimeState } from '../core/types';

const DATABASE_NAME = 'agent-runtime-demo';
const DATABASE_VERSION = 2;
const PROJECTION_STORE = 'runtime_projection';
const CHECKPOINT_STORE = 'sync_checkpoints';
const WORKSPACE_STORE = 'workspace';

type StoredProjection = { key: string; snapshot: PersistedRuntimeState['snapshot']; savedAt: number };
type StoredWorkspace = { key: string; workspace: PersistedRuntimeState['workspace']; savedAt: number };
type StoredCheckpoints = { key: string; checkpoints: PersistedRuntimeState['checkpoints']; savedAt: number };

/**
 * Runtime Core 的浏览器持久化边界。
 *
 * 选择 IndexedDB 而不是 localStorage：Runtime 实体会增长，且同一事务可同时提交投影和 SSE 游标。
 * 提交前崩溃时服务端会重放事件；提交后崩溃时事实与游标保持一致，因此两种情况都可恢复。
 */
export class RuntimeIndexedDb {
  private dbPromise: Promise<IDBDatabase> | null = null;

  /**
   * @param scopeKey - 认证用户与租户隔离后的持久化作用域键。
   */
  constructor(private readonly scopeKey: string) {}

  /**
   * 原子读取投影、工作区状态与 SSE 检查点。
   *
   * @returns 仅当核心记录完整时返回可恢复状态，否则返回 `null`。
   */
  async restore(): Promise<PersistedRuntimeState | null> {
    if (!this.isAvailable()) {
      return null;
    }
    const db = await this.open();
    const transaction = db.transaction([PROJECTION_STORE, CHECKPOINT_STORE, WORKSPACE_STORE], 'readonly');
    const done = transactionDone(transaction);
    // 在 await 前登记全部读取请求，保证事务在不同浏览器中都持续有效。
    const projectionRequest = request<StoredProjection | undefined>(transaction.objectStore(PROJECTION_STORE).get(this.scopeKey));
    const workspaceRequest = request<StoredWorkspace | undefined>(transaction.objectStore(WORKSPACE_STORE).get(this.scopeKey));
    const checkpointsRequest = request<StoredCheckpoints | undefined>(transaction.objectStore(CHECKPOINT_STORE).get(this.scopeKey));
    const [projection, workspace, checkpoints] = await Promise.all([projectionRequest, workspaceRequest, checkpointsRequest]);
    await done;

    // 部分记录不可被信任；正常 `save` 会原子写入三张表，出现它只可能源自手动 DevTools 修改或旧版本数据。
    if (!projection || !workspace) {
      return null;
    }
    return {
      snapshot: projection.snapshot,
      workspace: workspace.workspace,
      checkpoints: checkpoints?.checkpoints ?? {},
      savedAt: projection.savedAt,
    };
  }

  /**
   * 在同一读写事务内保存投影、工作区状态和事件检查点。
   *
   * 原子提交使游标永远对应已保存的实体事实，避免刷新后跳过尚未落盘的事件。
   *
   * @param state - 要替换到当前用户作用域的完整持久化状态。
   */
  async save(state: PersistedRuntimeState) {
    if (!this.isAvailable()) {
      return;
    }
    const db = await this.open();
    const transaction = db.transaction([PROJECTION_STORE, CHECKPOINT_STORE, WORKSPACE_STORE], 'readwrite');
    transaction.objectStore(PROJECTION_STORE).put({ key: this.scopeKey, snapshot: state.snapshot, savedAt: state.savedAt } satisfies StoredProjection);
    transaction.objectStore(WORKSPACE_STORE).put({ key: this.scopeKey, workspace: state.workspace, savedAt: state.savedAt } satisfies StoredWorkspace);

    // 每个作用域只写一条记录，替换操作可保持原子性，也避免写事务中间异步读取导致 IndexedDB 自动关闭。
    transaction.objectStore(CHECKPOINT_STORE).put({ key: this.scopeKey, checkpoints: state.checkpoints, savedAt: state.savedAt } satisfies StoredCheckpoints);
    await transactionDone(transaction);
  }

  /**
   * 检查当前运行环境是否提供 IndexedDB。
   *
   * @returns 浏览器可用时为 `true`。
   */
  private isAvailable() {
    return typeof indexedDB !== 'undefined';
  }

  /**
   * 打开并缓存数据库连接，升级时补齐所需对象仓库。
   *
   * @returns 可复用的 IndexedDB 连接 Promise。
   */
  private open() {
    if (this.dbPromise) {
      return this.dbPromise;
    }
    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(PROJECTION_STORE)) {
          db.createObjectStore(PROJECTION_STORE, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(WORKSPACE_STORE)) {
          db.createObjectStore(WORKSPACE_STORE, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(CHECKPOINT_STORE)) {
          db.createObjectStore(CHECKPOINT_STORE, { keyPath: 'key' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Unable to open Runtime IndexedDB'));
    });
    return this.dbPromise;
  }
}

/**
 * 将 IndexedDB 的单次请求转换为 Promise。
 *
 * @param idbRequest - 需要等待的原生 IndexedDB 请求。
 * @returns 请求结果的 Promise。
 */
function request<T>(idbRequest: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    idbRequest.onsuccess = () => resolve(idbRequest.result);
    idbRequest.onerror = () => reject(idbRequest.error ?? new Error('IndexedDB request failed'));
  });
}

/**
 * 等待 IndexedDB 事务完成，失败或中止时保留原始事务错误。
 *
 * @param transaction - 需要等待的数据库事务。
 * @returns 事务提交完成的 Promise。
 */
function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
  });
}
