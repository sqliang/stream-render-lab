/**
 * @file Runtime 归一化投影 Store：唯一接收 Snapshot 与 SSE 事件的写入边界。
 */

import type {
  Artifact,
  Asset,
  ContentBlock,
  Conversation,
  Message,
  Run,
  RunStep,
  RuntimeEvent,
  RuntimeSnapshot,
  RuntimeState,
  RuntimeWorkspaceState,
  PersistedRuntimeState,
  SendMessageCommand,
  StreamState,
  UiDataItem,
  UiSchema,
} from './types';

/**
 * 创建没有服务端事实的初始 Runtime 状态。
 *
 * 空状态只用于 Store 构造阶段；随后必须先恢复本地投影，再由权威 Snapshot 覆盖服务端实体。
 *
 * @returns 可安全作为 Store 初始值的完整状态结构。
 */
const emptyState = (): RuntimeState => ({
  entities: {
    conversationsById: {}, 
    messagesById: {}, 
    runsById: {}, 
    runStepsById: {}, 
    blocksById: {},
    assetsById: {}, 
    artifactsById: {}, 
    uiSchemasById: {}, 
    uiDataBySchemaId: {},
  },
  indexes: {
    messageIdsByConversationId: {}, 
    runIdsByConversationId: {}, 
    stepIdsByRunId: {},
    blockIdsByMessageId: {}, 
    artifactIdsByBlockId: {},
  },
  streamsByRunId: {},
  workspace: {
    draftsByConversationId: {},
    viewStateByConversationId: {},
    preferences: { typingSpeed: 24, reduceMotion: false },
    outboxById: {},
  },
});

/**
 * 将子实体标识以不可变且去重的方式写入所属索引。
 *
 * @param index - 现有的所属关系索引。
 * @param ownerId - 父实体标识。
 * @param childId - 子实体标识。
 * @returns 新索引；重复标识时保留原引用，避免无效通知。
 */
function addId(index: Record<string, string[]>, ownerId: string, childId: string) {
  const current = index[ownerId] ?? [];
  if (current.includes(childId)) {
    return index;
  }
  return { ...index, [ownerId]: [...current, childId] };
}

/**
 * 与框架无关的 Runtime 投影 Store。
 *
 * 该类持有服务端事实和需要跨刷新保存的少量工作区事实。React 组件状态与渲染动画缓冲
 * 刻意留在类外；草稿、视图偏好及 Outbox 命令则必须由此处管理，才能在刷新后恢复。
 */
export class RuntimeCoreStore {
  private state: RuntimeState = emptyState();
  private listeners = new Set<() => void>();

  /**
   * 返回当前不可变投影的引用。
   *
   * 调用方只可读取，所有写入必须经由 Store 方法，避免绕过事件幂等与订阅通知边界。
   *
   * @returns 当前 Runtime 投影状态。
   */
  getState = () => this.state;

  /**
   * 订阅下一次投影变更。
   *
   * @param listener - 状态变更后同步调用的监听函数。
   * @returns 取消订阅函数。
   */
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /**
   * Snapshot 是首次加载和游标失效恢复时的权威来源。
   *
   * 随后覆盖尚未被服务端接收的本地排队消息，避免远端 Snapshot 让离线用户的气泡消失。
   */
  applySnapshot(snapshot: RuntimeSnapshot) {
    let entities = snapshot.entities;
    let indexes = snapshot.indexes;
    for (const command of Object.values(this.state.workspace.outboxById)) {
      const localMessage = this.state.entities.messagesById[command.localMessageId];
      const localBlock = this.state.entities.blocksById[command.localBlockId];
      if (!localMessage || !localBlock) {
        continue;
      }
      entities = {
        ...entities,
        messagesById: { ...entities.messagesById, [localMessage.id]: localMessage },
        blocksById: { ...entities.blocksById, [localBlock.id]: localBlock },
      };
      indexes = {
        ...indexes,
        messageIdsByConversationId: addId(indexes.messageIdsByConversationId, localMessage.conversationId, localMessage.id),
        blockIdsByMessageId: addId(indexes.blockIdsByMessageId, localMessage.id, localBlock.id),
      };
    }
    this.state = { ...this.state, entities, indexes };
    this.emit();
  }

  /**
   * 在首次请求 Snapshot 前恢复最近一次持久化投影。
   *
   * @param persisted - 已原子保存的投影、游标与工作区状态。
   */
  restorePersisted(persisted: PersistedRuntimeState) {
    const streamsByRunId: Record<string, StreamState> = {};
    for (const checkpoint of Object.values(persisted.checkpoints)) {
      streamsByRunId[checkpoint.runId] = {
        runId: checkpoint.runId,
        streamEpoch: checkpoint.streamEpoch ?? null,
        connection: 'idle',
        lastEventId: checkpoint.lastEventId,
        reconnectAttempt: 0,
        lastError: null,
      };
    }
    this.state = {
      entities: persisted.snapshot.entities,
      indexes: persisted.snapshot.indexes,
      streamsByRunId,
      workspace: persisted.workspace,
    };
    this.emit();
  }

  /**
   * 生成适合持久化的视图，并刻意排除瞬态传输连接状态。
   *
   * @returns 可被 IndexedDB 原子保存的运行时状态。
   */
  toPersistedState(): PersistedRuntimeState {
    const checkpoints = Object.fromEntries(
      Object.values(this.state.streamsByRunId)
        .filter((stream) => stream.lastEventId)
        .map((stream) => [stream.runId, {
          runId: stream.runId,
          lastEventId: stream.lastEventId!,
          streamEpoch: stream.streamEpoch,
          updatedAt: Date.now(),
        }]),
    );
    return {
      snapshot: { entities: this.state.entities, indexes: this.state.indexes },
      checkpoints,
      workspace: this.state.workspace,
      savedAt: Date.now(),
    };
  }

  /**
   * 保存或清除会话草稿。
   *
   * 空文本会删除草稿记录，避免把“用户已清空输入框”错误恢复为旧内容。
   *
   * @param conversationId - 草稿所属会话标识。
   * @param text - 当前受控输入框文本。
   */
  setDraft(conversationId: string, text: string) {
    const draftsByConversationId = { ...this.state.workspace.draftsByConversationId };
    if (text) {
      draftsByConversationId[conversationId] = { conversationId, text, updatedAt: Date.now() };
    } else {
      delete draftsByConversationId[conversationId];
    }
    this.state = { ...this.state, workspace: { ...this.state.workspace, draftsByConversationId } };
    this.emit();
  }

  /**
   * 合并客户端拥有的工作区状态。
   *
   * 此入口不得用于服务端实体，避免草稿、视图设置等本地事实污染 Snapshot 权威边界。
   *
   * @param patch - 需要合并的工作区状态片段。
   */
  setWorkspace(patch: Partial<RuntimeWorkspaceState>) {
    this.state = { ...this.state, workspace: { ...this.state.workspace, ...patch } };
    this.emit();
  }

  /**
   * 立即投影离线用户消息，并交由 Outbox 在后续送达。
   *
   * @param command - 含本地稳定消息与 Block 标识的发送命令。
   */
  enqueueSendCommand(command: SendMessageCommand) {
    const message: Message = {
      id: command.localMessageId, conversationId: command.conversationId, runId: null,
      role: 'user', status: 'completed', revision: 1, clientCommandId: command.id,
    };
    const block: ContentBlock = {
      id: command.localBlockId, messageId: command.localMessageId, type: 'markdown',
      sourceContent: command.text, lastSeq: 0, status: 'completed', revision: 1,
    };
    this.state = {
      ...this.state,
      entities: {
        ...this.state.entities,
        messagesById: { ...this.state.entities.messagesById, [message.id]: message },
        blocksById: { ...this.state.entities.blocksById, [block.id]: block },
      },
      indexes: {
        ...this.state.indexes,
        messageIdsByConversationId: addId(this.state.indexes.messageIdsByConversationId, message.conversationId, message.id),
        blockIdsByMessageId: addId(this.state.indexes.blockIdsByMessageId, message.id, block.id),
      },
      workspace: { ...this.state.workspace, outboxById: { ...this.state.workspace.outboxById, [command.id]: command } },
    };
    this.emit();
  }

  /**
   * 更新待发送命令的传输状态。
   *
   * 命令不存在时保持幂等返回：异步响应可能晚于服务端确认或页面恢复后的命令清理。
   *
   * @param commandId - 需要更新的 Outbox 命令标识。
   * @param patch - 要覆盖的命令字段。
   */
  updateSendCommand(commandId: string, patch: Partial<SendMessageCommand>) {
    const command = this.state.workspace.outboxById[commandId];
    if (!command) {
      return;
    }
    this.state = {
      ...this.state,
      workspace: {
        ...this.state.workspace,
        outboxById: {
          ...this.state.workspace.outboxById,
          [commandId]: { ...command, ...patch, updatedAt: Date.now() },
        },
      },
    };
    this.emit();
  }

  /**
   * 以服务端接收结果确认乐观消息，仅删除对应命令。
   *
   * 乐观消息与服务端消息使用同一标识，因此确认时可原地更新而不会产生重复气泡。
   */
  completeSendCommand(commandId: string, confirmedMessage: Message) {
    const { [commandId]: _completed, ...outboxById } = this.state.workspace.outboxById;
    // 乐观消息故意沿用服务端接受的客户端标识，确认时只替换元数据，避免第二个重复气泡。
    const { clientCommandId: _localOnly, ...serverMessage } = confirmedMessage;
    this.state = {
      ...this.state,
      entities: {
        ...this.state.entities,
        messagesById: { ...this.state.entities.messagesById, [confirmedMessage.id]: serverMessage },
      },
      workspace: { ...this.state.workspace, outboxById },
    };
    this.emit();
  }

  /**
   * 合并指定 Run 的本地传输状态。
   *
   * 流状态是客户端派生信息，不能写入服务端 Snapshot；保留已有游标可让重连从最后已消费事件继续。
   *
   * @param runId - 目标 Run 标识。
   * @param patch - 需要更新的连接、游标或错误字段。
   */
  setStream(runId: string, patch: Partial<StreamState>) {
    const previous = this.state.streamsByRunId[runId] ?? {
      runId, streamEpoch: null, connection: 'idle', lastEventId: null, reconnectAttempt: 0, lastError: null,
    };
    this.state = {
      ...this.state,
      streamsByRunId: { ...this.state.streamsByRunId, [runId]: { ...previous, ...patch } },
    };
    this.emit();
  }

  /**
   * 清除指定 Run 的本地流状态，让新的权威 Snapshot 开始新的事件消费代际。
   *
   * @param runId - 需要重置流状态的 Run 标识。
   */
  resetStream(runId: string) {
    const { [runId]: _discarded, ...rest } = this.state.streamsByRunId;
    this.state = { ...this.state, streamsByRunId: rest };
    this.emit();
  }

  /**
   * SSE 事件唯一写入入口；每种事件只更新受影响的最小实体范围。
   * 重放 Markdown 分片通过 `lastSeq` 去重，实体创建事件保持幂等。
   */
  applyEvent(event: RuntimeEvent) {
    const p = event.payload;
    const e = this.state.entities;
    const i = this.state.indexes;
    let next = this.state;

    switch (event.type) {
      case 'conversation.updated': {
        const conversation = p.conversation as Conversation;
        next = { ...next, entities: { ...e, conversationsById: { ...e.conversationsById, [conversation.id]: conversation } } };
        break;
      }
      case 'run.updated': {
        const run = p.run as Run;
        next = {
          ...next,
          entities: { ...e, runsById: { ...e.runsById, [run.id]: run } },
          indexes: { ...i, runIdsByConversationId: addId(i.runIdsByConversationId, run.conversationId, run.id) },
        };
        break;
      }
      case 'run_step.updated': {
        const step = p.step as RunStep;
        next = {
          ...next,
          entities: { ...e, runStepsById: { ...e.runStepsById, [step.id]: step } },
          indexes: { ...i, stepIdsByRunId: addId(i.stepIdsByRunId, step.runId, step.id) },
        };
        break;
      }
      case 'message.created': {
        const message = p.message as Message;
        // Snapshot 修复或 SSE 重放可能再次携带此创建事件。
        if (e.messagesById[message.id]) {
          return;
        }
        next = {
          ...next,
          entities: { ...e, messagesById: { ...e.messagesById, [message.id]: message } },
          indexes: { ...i, messageIdsByConversationId: addId(i.messageIdsByConversationId, message.conversationId, message.id) },
        };
        break;
      }
      case 'message.updated': {
        const message = p.message as Message;
        next = { ...next, entities: { ...e, messagesById: { ...e.messagesById, [message.id]: message } } };
        break;
      }
      case 'block.created': {
        const block = p.block as ContentBlock;
        // 不能用重放的空起始 Block 覆盖 Snapshot 已累计的 Markdown。
        if (e.blocksById[block.id]) {
          return;
        }
        next = {
          ...next,
          entities: { ...e, blocksById: { ...e.blocksById, [block.id]: block } },
          indexes: { ...i, blockIdsByMessageId: addId(i.blockIdsByMessageId, block.messageId, block.id) },
        };
        break;
      }
      case 'markdown.delta': {
        const blockId = p.blockId as string;
        const seq = p.seq as number;
        const text = p.text as string;
        const block = e.blocksById[blockId];
        if (!block || block.type !== 'markdown' || seq <= block.lastSeq) {
          return;
        }
        next = {
          ...next,
          entities: {
            ...e,
            blocksById: {
              ...e.blocksById,
              [blockId]: { ...block, sourceContent: block.sourceContent + text, lastSeq: seq, revision: block.revision + 1 },
            },
          },
        };
        break;
      }
      case 'block.completed': {
        const blockId = p.blockId as string;
        const block = e.blocksById[blockId];
        if (!block) {
          return;
        }
        next = {
          ...next,
          entities: { ...e, blocksById: { ...e.blocksById, [blockId]: { ...block, status: 'completed', revision: block.revision + 1 } } },
        };
        break;
      }
      case 'asset.created': {
        const asset = p.asset as Asset;
        next = { ...next, entities: { ...e, assetsById: { ...e.assetsById, [asset.id]: asset } } };
        break;
      }
      case 'ui_schema.created': {
        const schema = p.schema as UiSchema;
        next = { ...next, entities: { ...e, uiSchemasById: { ...e.uiSchemasById, [schema.id]: schema } } };
        break;
      }
      case 'ui_data.append': {
        const schemaId = p.schemaId as string;
        const item = p.item as UiDataItem;
        const previous = e.uiDataBySchemaId[schemaId] ?? { schemaId, items: [], status: 'empty' as const, version: 0 };
        if (previous.items.some((entry) => entry.id === item.id)) {
          return;
        }
        next = {
          ...next,
          entities: {
            ...e,
            uiDataBySchemaId: {
              ...e.uiDataBySchemaId,
              [schemaId]: { ...previous, items: [...previous.items, item], status: 'streaming', version: previous.version + 1 },
            },
          },
        };
        break;
      }
      case 'artifact.created': {
        const artifact = p.artifact as Artifact;
        const blockId = p.blockId as string;
        next = {
          ...next,
          entities: { ...e, artifactsById: { ...e.artifactsById, [artifact.id]: artifact } },
          indexes: { ...i, artifactIdsByBlockId: addId(i.artifactIdsByBlockId, blockId, artifact.id) },
        };
        break;
      }
      default:
        return;
    }

    const runId = p.runId as string | undefined;
    if (runId) {
      const previousStream = next.streamsByRunId[runId] ?? {
        runId,
        streamEpoch: null,
        connection: 'streaming',
        reconnectAttempt: 0,
        lastError: null,
      };
      this.state = {
        ...next,
        streamsByRunId: {
          ...next.streamsByRunId,
          [runId]: {
            ...previousStream,
            lastEventId: event.id,
          },
        },
      };
    } else {
      this.state = next;
    }
    this.emit();
  }

  /**
   * 同步通知全部订阅者读取新的不可变状态引用。
   *
   * Store 先完成完整状态替换再通知，因此 React selector 不会读到半更新的实体或索引。
   */
  private emit() {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
