/**
 * @file 将 Runtime Core Store 安全映射为 React Context 与 selector hooks。
 */

import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useSyncExternalStoreWithSelector } from 'use-sync-external-store/shim/with-selector';
import { RuntimeFacade } from '../core/runtime';
import type { ContentBlock, RuntimeState } from '../core/types';

const RuntimeContext = createContext<RuntimeFacade | null>(null);

/**
 * 将唯一 Runtime Facade 注入 React 子树，并负责页面卸载时释放其资源。
 *
 * @param props - Runtime 实例与需要读取该实例的 React 子节点。
 * @returns 提供 Runtime Context 的 React 元素。
 */
export function RuntimeProvider({ runtime, children }: { runtime: RuntimeFacade; children: ReactNode }) {
  useEffect(() => {
    void runtime.openConversation('demo');
    return () => runtime.dispose();
  }, [runtime]);
  return <RuntimeContext.Provider value={runtime}>{children}</RuntimeContext.Provider>;
}

/**
 * 读取当前 React 子树中的 Runtime Facade。
 *
 * @returns 已由 `RuntimeProvider` 注入的 Runtime Facade。
 * @throws 未包裹在 `RuntimeProvider` 中时抛出配置错误。
 */
export function useRuntime() {
  const runtime = useContext(RuntimeContext);
  if (!runtime) {
    throw new Error('RuntimeProvider is required');
  }
  return runtime;
}

/**
 * 订阅 Runtime 的一个稳定投影，避免无关 Store 更新触发组件重渲染。
 *
 * @param selector - 从完整运行时状态提取所需投影的选择器。
 * @param isEqual - 判断前后投影是否相等的比较函数。
 * @returns 当前选择器结果。
 */
export function useRuntimeSelector<T>(selector: (state: RuntimeState) => T, isEqual: (a: T, b: T) => boolean = Object.is) {
  const { store } = useRuntime();
  return useSyncExternalStoreWithSelector(store.subscribe, store.getState, store.getState, selector, isEqual);
}

const EMPTY_IDS: string[] = [];
/**
 * 读取指定会话实体。
 */
export function useConversation(id: string) {
  return useRuntimeSelector((state) => state.entities.conversationsById[id]);
}

/**
 * 按持久化顺序读取指定会话的消息标识。
 */
export function useMessageIds(conversationId: string) {
  return useRuntimeSelector((state) => state.indexes.messageIdsByConversationId[conversationId] ?? EMPTY_IDS);
}

/**
 * 读取指定消息实体。
 */
export function useMessage(id: string) {
  return useRuntimeSelector((state) => state.entities.messagesById[id]);
}

/**
 * 按原始内容顺序读取指定消息的 Block 标识。
 */
export function useBlockIds(messageId: string) {
  return useRuntimeSelector((state) => state.indexes.blockIdsByMessageId[messageId] ?? EMPTY_IDS);
}

/**
 * 读取指定内容 Block。
 */
export function useBlock(id: string) {
  return useRuntimeSelector((state) => state.entities.blocksById[id] as ContentBlock | undefined);
}

/**
 * 读取指定资源实体。
 */
export function useAsset(id: string) {
  return useRuntimeSelector((state) => state.entities.assetsById[id]);
}

/**
 * 读取指定富 UI Schema。
 */
export function useSchema(id: string) {
  return useRuntimeSelector((state) => state.entities.uiSchemasById[id]);
}

/**
 * 读取指定富 UI Schema 的流式数据。
 */
export function useUiData(schemaId: string) {
  return useRuntimeSelector((state) => state.entities.uiDataBySchemaId[schemaId]);
}

/**
 * 按原始顺序读取指定产物组的产物标识。
 */
export function useArtifactIds(blockId: string) {
  return useRuntimeSelector((state) => state.indexes.artifactIdsByBlockId[blockId] ?? EMPTY_IDS);
}

/**
 * 读取指定产物实体。
 */
export function useArtifact(id: string) {
  return useRuntimeSelector((state) => state.entities.artifactsById[id]);
}

/**
 * 读取指定 Run 实体。
 */
export function useRun(id: string) {
  return useRuntimeSelector((state) => state.entities.runsById[id]);
}

/**
 * 按原始顺序读取指定 Run 的步骤标识。
 */
export function useRunStepIds(runId: string) {
  return useRuntimeSelector((state) => state.indexes.stepIdsByRunId[runId] ?? EMPTY_IDS);
}

/**
 * 读取指定 Run 步骤实体。
 */
export function useRunStep(id: string) {
  return useRuntimeSelector((state) => state.entities.runStepsById[id]);
}

/**
 * 读取指定 Run 的传输状态。
 */
export function useStream(runId: string) {
  return useRuntimeSelector((state) => state.streamsByRunId[runId]);
}
/**
 * 工作区 selector 与领域实体共用同一订阅桥接层；React 只读取稳定投影，不能直接访问 IndexedDB。
 */
/**
 * 读取指定会话的持久化草稿。
 */
export function useDraft(conversationId: string) {
  return useRuntimeSelector((state) => state.workspace.draftsByConversationId[conversationId]);
}

/**
 * 读取指定会话的持久化视图状态。
 */
export function useConversationViewState(conversationId: string) {
  return useRuntimeSelector((state) => state.workspace.viewStateByConversationId[conversationId]);
}

/**
 * 读取当前 Runtime 偏好设置。
 */
export function useRuntimePreferences() {
  return useRuntimeSelector((state) => state.workspace.preferences);
}
