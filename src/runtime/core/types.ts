/**
 * @file Runtime 归一化实体、事件、投影与持久化契约。
 */

export type EntityMap<T extends { id: string }> = Record<string, T>;

export type MessageStatus = 'streaming' | 'completed' | 'failed' | 'cancelled';
export type RunStatus = 'queued' | 'running' | 'waiting_input' | 'completed' | 'failed' | 'cancelled';
export type StepStatus = 'queued' | 'running' | 'completed' | 'failed';

export type Conversation = {
  id: string;
  agentName: string;
  title: string;
  activeRunId: string | null;
  status: 'active' | 'archived';
  revision: number;
};

export type Message = {
  id: string;
  conversationId: string;
  runId: string | null;
  role: 'user' | 'assistant';
  status: MessageStatus;
  revision: number;
  /** 仅本地发送 Outbox 尚未确认的用户消息会携带此命令标识。 */
  clientCommandId?: string;
};

export type Run = {
  id: string;
  conversationId: string;
  inputMessageId: string;
  outputMessageId: string | null;
  status: RunStatus;
  currentStepId: string | null;
  revision: number;
};

export type RunStep = {
  id: string;
  runId: string;
  type: 'reasoning' | 'tool' | 'generation';
  title: string;
  summary: string | null;
  toolName: string | null;
  status: StepStatus;
  revision: number;
};

export type Asset = {
  id: string;
  kind: 'image' | 'audio' | 'file';
  url: string;
  alt?: string;
  width?: number;
  height?: number;
  mimeType: string;
};

export type Artifact = {
  id: string;
  name: string;
  mimeType: string;
  assetId: string;
};

export type UiSchema = {
  id: string;
  version: number;
  definition: {
    type: 'recommendation_list';
    title: string;
    subtitle: string;
  };
};

export type UiDataItem = {
  id: string;
  title: string;
  description: string;
  meta: string;
};

/**
 * 单个 Schema 最多拥有六个数据分片；将它们集中保存，可让完整 Schema 与数据快照直接恢复。
 */
export type UiDataState = {
  schemaId: string;
  items: UiDataItem[];
  status: 'empty' | 'streaming' | 'completed';
  version: number;
};

type BaseBlock = {
  id: string;
  messageId: string;
  status: MessageStatus;
  revision: number;
};

export type MarkdownBlock = BaseBlock & {
  type: 'markdown';
  sourceContent: string;
  lastSeq: number;
};

export type ImageBlock = BaseBlock & {
  type: 'image';
  assetId: string;
};

export type UiSchemaBlock = BaseBlock & {
  type: 'ui_schema';
  schemaId: string;
  dataStatus: UiDataState['status'];
};

export type ArtifactGroupBlock = BaseBlock & {
  type: 'artifacts';
};

export type ContentBlock = MarkdownBlock | ImageBlock | UiSchemaBlock | ArtifactGroupBlock;

export type StreamState = {
  runId: string;
  /** 游标只在服务端事件保留代际内有效。 */
  streamEpoch: string | null;
  connection: 'idle' | 'connecting' | 'streaming' | 'reconnecting' | 'closed' | 'error';
  lastEventId: string | null;
  reconnectAttempt: number;
  lastError: string | null;
};

/**
 * 持久化的 SSE 检查点刻意与连接状态分离：`connection` 只属于当前浏览器标签页，
 * 而事件游标必须跨刷新存活，以便下一次订阅请求服务端重放。
 */
export type StreamCheckpoint = {
  runId: string;
  lastEventId: string;
  streamEpoch: string | null;
  updatedAt: number;
};

export type ConversationDraft = {
  conversationId: string;
  text: string;
  updatedAt: number;
};

export type ConversationViewState = {
  conversationId: string;
  /** 语义化阅读标记比原始像素 `scrollTop` 更适合跨内容变化恢复。 */
  lastReadMessageId: string | null;
  expandedRunStepIds: string[];
  updatedAt: number;
};

export type RuntimePreferences = {
  typingSpeed: number;
  reduceMotion: boolean;
};

/**
 * 可离线恢复的命令。幂等键会发送到服务端，因此网络结果不明确时重试，
 * 最多只会创建一个真实用户消息和 Run。
 */
export type SendMessageCommand = {
  id: string;
  type: 'send_message';
  idempotencyKey: string;
  conversationId: string;
  text: string;
  localMessageId: string;
  localBlockId: string;
  status: 'queued' | 'sending' | 'failed';
  attempts: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
};

export type RuntimeWorkspaceState = {
  draftsByConversationId: Record<string, ConversationDraft>;
  viewStateByConversationId: Record<string, ConversationViewState>;
  preferences: RuntimePreferences;
  outboxById: Record<string, SendMessageCommand>;
};

export type RuntimeState = {
  entities: {
    conversationsById: EntityMap<Conversation>;
    messagesById: EntityMap<Message>;
    runsById: EntityMap<Run>;
    runStepsById: EntityMap<RunStep>;
    blocksById: EntityMap<ContentBlock>;
    assetsById: EntityMap<Asset>;
    artifactsById: EntityMap<Artifact>;
    uiSchemasById: EntityMap<UiSchema>;
    uiDataBySchemaId: Record<string, UiDataState>;
  };
  indexes: {
    messageIdsByConversationId: Record<string, string[]>;
    runIdsByConversationId: Record<string, string[]>;
    stepIdsByRunId: Record<string, string[]>;
    blockIdsByMessageId: Record<string, string[]>;
    artifactIdsByBlockId: Record<string, string[]>;
  };
  streamsByRunId: Record<string, StreamState>;
  /** 客户端拥有的状态，不会出现在服务端 Snapshot 中。 */
  workspace: RuntimeWorkspaceState;
};

export type RuntimeSnapshot = Pick<RuntimeState, 'entities' | 'indexes'> & {
  /**
   * 服务端提供的事件日志代际。代际变化后，旧 `Last-Event-ID` 不得用于替代流，
   * 例如服务端重置事件保留策略之后。
   */
  streamEpochByRunId?: Record<string, string>;
};

/**
 * 持久化层唯一写入的数据；不包含实时连接状态。
 */
export type PersistedRuntimeState = {
  snapshot: RuntimeSnapshot;
  checkpoints: Record<string, StreamCheckpoint>;
  workspace: RuntimeWorkspaceState;
  savedAt: number;
};

export type RuntimeEvent = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
};
