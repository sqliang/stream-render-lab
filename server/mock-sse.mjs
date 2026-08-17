/**
 * @file 用于验证 Snapshot、SSE 重放、幂等命令与取消语义的本地 Mock 服务。
 */

import { createServer } from 'node:http';

const serverOrigin = 'http://localhost:8787';
let sequence = 1;
// 真实服务端使用可持久化事件标识和保留策略；此 Mock 重启时会重建流，
// 因此暴露代际，让客户端拒绝旧内存序列所属的游标。
const streamEpoch = `mock-${Date.now()}`;
const streamsByRunId = new Map();
const materializedEventKeys = new Set();
const activeTimersByRunId = new Map();
const agentTimersByRunId = new Map();
const activeResponsesByRunId = new Map();
const cancelledRunIds = new Set();
// Mock 对齐生产命令契约：一个幂等键只映射一个已接收的用户消息和 Run。
// 离线 Outbox 在响应丢失后重试时，这一约束至关重要。
const acceptedCommandsByIdempotencyKey = new Map();

const snapshot = {
  entities: {
    conversationsById: {
      demo: { id: 'demo', agentName: 'Tokyo Planner', title: '东京五天旅行方案', activeRunId: 'run_demo_01', status: 'active', revision: 1 },
    },
    messagesById: {
      message_user_01: { id: 'message_user_01', conversationId: 'demo', runId: null, role: 'user', status: 'completed', revision: 1 },
    },
    runsById: {
      run_demo_01: { id: 'run_demo_01', conversationId: 'demo', inputMessageId: 'message_user_01', outputMessageId: 'message_assistant_01', status: 'queued', currentStepId: null, revision: 1 },
    },
    runStepsById: {},
    blocksById: {
      block_user_01: { id: 'block_user_01', messageId: 'message_user_01', type: 'markdown', sourceContent: '帮我制定东京五天旅行方案', lastSeq: 0, status: 'completed', revision: 1 },
    },
    assetsById: {}, artifactsById: {}, uiSchemasById: {}, uiDataBySchemaId: {},
  },
  indexes: {
    messageIdsByConversationId: { demo: ['message_user_01'] },
    runIdsByConversationId: { demo: ['run_demo_01'] },
    stepIdsByRunId: {},
    blockIdsByMessageId: { message_user_01: ['block_user_01'] },
    artifactIdsByBlockId: {},
  },
};

/**
 * 构造带当前事件流代际的权威 Snapshot。
 *
 * @returns 可供客户端恢复投影与判定游标有效性的 Snapshot。
 */
function snapshotWithStreamEpoch() {
  return {
    ...snapshot,
    streamEpochByRunId: Object.fromEntries(
      Object.keys(snapshot.entities.runsById).map((runId) => [runId, streamEpoch]),
    ),
  };
}

/**
 * 以去重方式维护 Mock 投影的父子实体索引。
 *
 * @param index - 需要写入的索引表。
 * @param ownerId - 父实体标识。
 * @param childId - 子实体标识。
 */
function addId(index, ownerId, childId) {
  const ids = index[ownerId] ?? (index[ownerId] = []);
  if (!ids.includes(childId)) {
    ids.push(childId);
  }
}

/**
 * 生产服务端会在发出事件前持久化权威 Conversation / Run 投影。
 * 此 Mock 在内存中遵循同一顺序，因此刷新后的 Snapshot 不会丢失已经观察到的回答。
 */
/**
 * 先将事件物化到权威内存投影，再允许 SSE 订阅者收到该事件。
 *
 * 此顺序模拟生产服务端的“先提交事实，后发布事件”约束，避免刷新 Snapshot 丢失已观察结果。
 *
 * @param runId - 事件所属 Run 标识。
 * @param eventIndex - Run 内单调递增的事件序号。
 * @param type - Runtime 事件类型。
 * @param payload - 事件负载。
 */
function materializeEvent(runId, eventIndex, type, payload) {
  const key = `${runId}:${eventIndex}`;
  if (materializedEventKeys.has(key)) {
    return;
  }
  materializedEventKeys.add(key);
  const { entities, indexes } = snapshot;

  switch (type) {
    case 'run.updated': {
      const run = payload.run;
      entities.runsById[run.id] = run;
      addId(indexes.runIdsByConversationId, run.conversationId, run.id);
      break;
    }
    case 'run_step.updated': {
      const step = payload.step;
      entities.runStepsById[step.id] = step;
      addId(indexes.stepIdsByRunId, step.runId, step.id);
      break;
    }
    case 'message.created': {
      const message = payload.message;
      entities.messagesById[message.id] = message;
      addId(indexes.messageIdsByConversationId, message.conversationId, message.id);
      break;
    }
    case 'message.updated':
      entities.messagesById[payload.message.id] = payload.message;
      break;
    case 'block.created': {
      const block = payload.block;
      entities.blocksById[block.id] = block;
      addId(indexes.blockIdsByMessageId, block.messageId, block.id);
      break;
    }
    case 'markdown.delta': {
      const block = entities.blocksById[payload.blockId];
      if (block && block.type === 'markdown' && payload.seq > block.lastSeq) {
        entities.blocksById[payload.blockId] = {
          ...block,
          sourceContent: block.sourceContent + payload.text,
          lastSeq: payload.seq,
          revision: block.revision + 1,
        };
      }
      break;
    }
    case 'block.completed': {
      const block = entities.blocksById[payload.blockId];
      if (block) {
        entities.blocksById[payload.blockId] = { ...block, status: 'completed', revision: block.revision + 1 };
      }
      break;
    }
    case 'asset.created':
      entities.assetsById[payload.asset.id] = payload.asset;
      break;
    case 'ui_schema.created':
      entities.uiSchemasById[payload.schema.id] = payload.schema;
      break;
    case 'ui_data.append': {
      const previous = entities.uiDataBySchemaId[payload.schemaId] ?? { schemaId: payload.schemaId, items: [], status: 'empty', version: 0 };
      if (!previous.items.some((item) => item.id === payload.item.id)) {
        entities.uiDataBySchemaId[payload.schemaId] = {
          ...previous,
          items: [...previous.items, payload.item],
          status: 'streaming',
          version: previous.version + 1,
        };
      }
      break;
    }
    case 'artifact.created':
      entities.artifactsById[payload.artifact.id] = payload.artifact;
      addId(indexes.artifactIdsByBlockId, payload.blockId, payload.artifact.id);
      break;
  }
}

/**
 * 创建 Mock Run 实体。
 */
function createRun(runId, inputMessageId, outputMessageId, status, currentStepId, revision) {
  return { id: runId, conversationId: 'demo', inputMessageId, outputMessageId, status, currentStepId, revision };
}

/**
 * 创建 Mock Run 步骤实体。
 */
function createStep(runId, id, type, title, summary, status, revision) {
  return { id, runId, type, title, summary, toolName: type === 'tool' ? 'travel_search' : null, status, revision };
}

/**
 * 创建演示会话首次打开时可重放的事件序列。
 *
 * @returns 按服务端发生顺序排列的初始事件。
 */
function createInitialEvents() {
  const runId = 'run_demo_01';
  const outputMessageId = 'message_assistant_01';
  const run = (status, currentStepId, revision) => createRun(runId, 'message_user_01', outputMessageId, status, currentStepId, revision);
  const assistant = (status, revision) => ({ id: outputMessageId, conversationId: 'demo', runId, role: 'assistant', status, revision });
  return [
    ['run.updated', { runId, run: run('running', 'step_01', 2) }],
    ['run_step.updated', { runId, step: createStep(runId, 'step_01', 'reasoning', '正在分析旅行偏好', '识别出五天行程、城市漫游与轻量节奏。', 'running', 1) }],
    ['run_step.updated', { runId, step: createStep(runId, 'step_01', 'reasoning', '正在分析旅行偏好', '已完成行程偏好分析。', 'completed', 2) }],
    ['run_step.updated', { runId, step: createStep(runId, 'step_02', 'tool', '正在查询地点与酒店', '已找到适合五天路线的住宿与城市节点。', 'running', 1) }],
    ['message.created', { runId, message: assistant('streaming', 1) }],
    ['block.created', { runId, block: { id: 'block_md_01', messageId: outputMessageId, type: 'markdown', sourceContent: '', lastSeq: 0, status: 'streaming', revision: 1 } }],
    ['markdown.delta', { runId, blockId: 'block_md_01', seq: 1, text: '### 旅行节奏\n\n先把城市放慢。前两天住在浅草与上野之间，留出 **步行和临时停靠** 的空间。' }],
    ['block.completed', { runId, blockId: 'block_md_01' }],
    ['asset.created', { runId, asset: { id: 'asset_tokyo_01', kind: 'image', url: '/tokyo-plan.svg', alt: '东京五天慢旅行路线图', width: 1200, height: 600, mimeType: 'image/svg+xml' } }],
    ['block.created', { runId, block: { id: 'block_img_01', messageId: outputMessageId, type: 'image', assetId: 'asset_tokyo_01', status: 'completed', revision: 1 } }],
    ['ui_schema.created', { runId, schema: { id: 'schema_stay_01', version: 1, definition: { type: 'recommendation_list', title: '住宿候选', subtitle: 'Schema 已就绪，数据将逐条补入。' } } }],
    ['block.created', { runId, block: { id: 'block_ui_01', messageId: outputMessageId, type: 'ui_schema', schemaId: 'schema_stay_01', dataStatus: 'empty', status: 'completed', revision: 1 } }],
    ['ui_data.append', { runId, schemaId: 'schema_stay_01', item: { id: 'stay_01', title: '浅草 · 河畔安静房', description: '适合第一、二天步行探索与早市。', meta: '¥980 / 晚' } }],
    ['ui_data.append', { runId, schemaId: 'schema_stay_01', item: { id: 'stay_02', title: '代官山 · 小型设计酒店', description: '靠近第五天的咖啡与书店路线。', meta: '¥1280 / 晚' } }],
    ['block.created', { runId, block: { id: 'block_md_02', messageId: outputMessageId, type: 'markdown', sourceContent: '', lastSeq: 0, status: 'streaming', revision: 1 } }],
    ['markdown.delta', { runId, blockId: 'block_md_02', seq: 1, text: '### 推荐安排\n\n第 3 天游览清澄白河，第 4 天留给神乐坂。每天下午只安排一个核心目的地。' }],
    ['ui_data.append', { runId, schemaId: 'schema_stay_01', item: { id: 'stay_03', title: '上野 · 公园边公寓', description: '空间更大，适合携带儿童或多人出行。', meta: '¥1100 / 晚' } }],
    ['asset.created', { runId, asset: { id: 'asset_pdf_01', kind: 'file', url: `${serverOrigin}/tokyo-plan.pdf`, mimeType: 'application/pdf' } }],
    ['block.created', { runId, block: { id: 'block_artifact_01', messageId: outputMessageId, type: 'artifacts', status: 'completed', revision: 1 } }],
    ['artifact.created', { runId, blockId: 'block_artifact_01', artifact: { id: 'artifact_01', name: '东京五天行程.pdf', mimeType: 'application/pdf', assetId: 'asset_pdf_01' } }],
    ['run_step.updated', { runId, step: createStep(runId, 'step_02', 'tool', '正在查询地点与酒店', '住宿与路线检索完成。', 'completed', 2) }],
    ['run_step.updated', { runId, step: createStep(runId, 'step_03', 'generation', '正在生成行程结果', '已完成混排结果和产物整理。', 'completed', 1) }],
    ['message.updated', { runId, message: assistant('completed', 2) }],
    ['run.updated', { runId, run: run('completed', 'step_03', 3) }],
  ];
}

/**
 * 为新用户消息创建包含 Markdown、图片、富 UI 与产物的混合内容事件序列。
 *
 * @param runId - 新建 Run 标识。
 * @param outputMessageId - Agent 输出消息标识。
 * @param inputMessageId - 用户输入消息标识。
 * @param prompt - 用户提交的文本。
 * @returns 按原始 Block 顺序发生的事件。
 */
function createFollowUpEvents(runId, outputMessageId, inputMessageId, prompt) {
  // 每个标识都限定在 Run 内。若复用初始响应标识，归一化 Runtime Store 会正确视为已有实体，
  // 但会掩盖该后续夹具用来验证的混合 Block 行为。
  const ids = {
    firstMarkdown: `block_md_intro_${runId}`,
    imageAsset: `asset_image_${runId}`,
    imageBlock: `block_image_${runId}`,
    schema: `schema_choices_${runId}`,
    uiBlock: `block_ui_${runId}`,
    secondMarkdown: `block_md_plan_${runId}`,
    fileAsset: `asset_file_${runId}`,
    artifactBlock: `block_artifacts_${runId}`,
    artifact: `artifact_${runId}`,
    generationStep: `step_generation_${runId}`,
  };
  const run = (status, currentStepId, revision) => createRun(runId, inputMessageId, outputMessageId, status, currentStepId, revision);
  const assistant = (status, revision) => ({ id: outputMessageId, conversationId: 'demo', runId, role: 'assistant', status, revision });
  return [
    ['run.updated', { runId, run: run('running', ids.generationStep, 2) }],
    ['run_step.updated', { runId, step: createStep(runId, ids.generationStep, 'generation', '正在生成混排回答', '先建立文本结果，再逐步补入图片、结构化数据和产物。', 'running', 1) }],
    ['message.created', { runId, message: assistant('streaming', 1) }],
    // 1. Markdown 先出现，并刻意拆分为两个分片，以验证流式拼接。
    ['block.created', { runId, block: { id: ids.firstMarkdown, messageId: outputMessageId, type: 'markdown', sourceContent: '', lastSeq: 0, status: 'streaming', revision: 1 } }],
    ['markdown.delta', { runId, blockId: ids.firstMarkdown, seq: 1, text: `### 针对新问题的建议\n\n你刚刚询问：**${prompt}**。` }],
    ['markdown.delta', { runId, blockId: ids.firstMarkdown, seq: 2, text: '\n\n我把它拆成可执行的选择、路线说明和一份可下载产物。' }],
    ['block.completed', { runId, blockId: ids.firstMarkdown }],
    // 2. 图片是独立 Block 而非 Markdown 图片语法，验证 Asset 到 Block 的关联。
    ['asset.created', { runId, asset: { id: ids.imageAsset, kind: 'image', url: '/tokyo-plan.svg', alt: '根据新问题生成的路线示意图', width: 1200, height: 600, mimeType: 'image/svg+xml' } }],
    ['block.created', { runId, block: { id: ids.imageBlock, messageId: outputMessageId, type: 'image', assetId: ids.imageAsset, status: 'completed', revision: 1 } }],
    // 3. Schema 先立即渲染骨架，数据再作为三个独立分片抵达。
    ['ui_schema.created', { runId, schema: { id: ids.schema, version: 1, definition: { type: 'recommendation_list', title: '可选方案', subtitle: 'Schema 已先到达，候选项正在流式补充。' } } }],
    ['block.created', { runId, block: { id: ids.uiBlock, messageId: outputMessageId, type: 'ui_schema', schemaId: ids.schema, dataStatus: 'empty', status: 'completed', revision: 1 } }],
    ['ui_data.append', { runId, schemaId: ids.schema, item: { id: `choice_01_${runId}`, title: '轻量探索方案', description: '减少跨区移动，把重点留给一个核心区域。', meta: '推荐' } }],
    ['ui_data.append', { runId, schemaId: ids.schema, item: { id: `choice_02_${runId}`, title: '平衡节奏方案', description: '上午安排地标，下午保留弹性停留时间。', meta: '约 6 小时' } }],
    // 4. 第二个 Markdown Block 证明顺序由 `message.blockIds` 决定，而非渲染器类型。
    ['block.created', { runId, block: { id: ids.secondMarkdown, messageId: outputMessageId, type: 'markdown', sourceContent: '', lastSeq: 0, status: 'streaming', revision: 1 } }],
    ['markdown.delta', { runId, blockId: ids.secondMarkdown, seq: 1, text: '### 执行建议\n\n先选定一项方案，再把交通和预约集中在同一个时间窗口完成。' }],
    ['block.completed', { runId, blockId: ids.secondMarkdown }],
    ['ui_data.append', { runId, schemaId: ids.schema, item: { id: `choice_03_${runId}`, title: '深度主题方案', description: '围绕建筑、咖啡或展览只保留一个主题。', meta: '更从容' } }],
    // 5. 产物保持独立分组，并通过 Artifact 到 Asset 关联解析，绝不嵌入文本。
    ['asset.created', { runId, asset: { id: ids.fileAsset, kind: 'file', url: `${serverOrigin}/tokyo-plan.pdf`, mimeType: 'application/pdf' } }],
    ['block.created', { runId, block: { id: ids.artifactBlock, messageId: outputMessageId, type: 'artifacts', status: 'completed', revision: 1 } }],
    ['artifact.created', { runId, blockId: ids.artifactBlock, artifact: { id: ids.artifact, name: '新问题执行清单.pdf', mimeType: 'application/pdf', assetId: ids.fileAsset } }],
    ['message.updated', { runId, message: assistant('completed', 2) }],
    ['run_step.updated', { runId, step: createStep(runId, ids.generationStep, 'generation', '正在生成混排回答', '混排结果、结构化选择和产物均已完成。', 'completed', 2) }],
    ['run.updated', { runId, run: run('completed', ids.generationStep, 3) }],
  ];
}

streamsByRunId.set('run_demo_01', createInitialEvents());

/**
 * Agent 执行独立于 SSE 投递。生产环境中用户标签页关闭后，Agent 仍写入持久化 Run 事实和事件；
 * 后续 SSE 订阅只负责重放。此 Mock 显式保留该边界，避免遗漏浏览器订阅使 Run 永远停留在排队状态。
 */
/**
 * 模拟独立于浏览器 SSE 订阅的 Agent 执行。
 *
 * @param runId - 需要执行并物化事件的 Run 标识。
 */
function startAgentRun(runId) {
  const events = streamsByRunId.get(runId);
  if (!events || agentTimersByRunId.has(runId)) {
    return;
  }
  const timers = new Set();
  agentTimersByRunId.set(runId, timers);
  events.forEach(([type, payload], index) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (cancelledRunIds.has(runId)) {
        return;
      }
      materializeEvent(runId, index + 1, type, payload);
      if (index + 1 === events.length) {
        agentTimersByRunId.delete(runId);
      }
    }, 180 + index * 300);
    timers.add(timer);
  });
}

startAgentRun('run_demo_01');

/**
 * 读取并解析 JSON 请求体。
 *
 * @param req - Node HTTP 入站请求。
 * @returns JSON 请求体 Promise。
 */
function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
  });
}

/**
 * 以 JSON 响应结束 HTTP 请求。
 *
 * @param res - Node HTTP 响应对象。
 * @param body - 需要序列化的响应体。
 * @param status - HTTP 状态码。
 */
function sendJson(res, body, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

/**
 * 在服务端权威投影中取消 Run，并停止后续 Agent 定时任务和 SSE 响应。
 *
 * @param runId - 要取消的 Run 标识。
 * @returns 已更新的 Run 与当前输出消息。
 */
function cancelServerRun(runId) {
  cancelledRunIds.add(runId);
  for (const timer of agentTimersByRunId.get(runId) ?? []) {
    clearTimeout(timer);
  }
  agentTimersByRunId.delete(runId);
  for (const timer of activeTimersByRunId.get(runId) ?? []) {
    clearTimeout(timer);
  }
  activeTimersByRunId.delete(runId);
  for (const response of activeResponsesByRunId.get(runId) ?? []) {
    if (!response.writableEnded) {
      response.end();
    }
  }
  activeResponsesByRunId.delete(runId);

  const run = snapshot.entities.runsById[runId];
  if (!run) {
    return { run: null, message: null };
  }
  const cancelledRun = { ...run, status: 'cancelled', revision: run.revision + 1 };
  snapshot.entities.runsById[runId] = cancelledRun;

  const message = run.outputMessageId ? snapshot.entities.messagesById[run.outputMessageId] : null;
  const cancelledMessage = message && message.status === 'streaming'
    ? { ...message, status: 'cancelled', revision: message.revision + 1 }
    : message;
  if (cancelledMessage) {
    snapshot.entities.messagesById[cancelledMessage.id] = cancelledMessage;
  }

  // 保留已接收内容，但将未完成 Block 标记为已取消，使投影进入终态。
  for (const blockId of indexesForMessage(message?.id)) {
    const block = snapshot.entities.blocksById[blockId];
    if (block?.status === 'streaming') {
      snapshot.entities.blocksById[blockId] = { ...block, status: 'cancelled', revision: block.revision + 1 };
    }
  }
  return { run: cancelledRun, message: cancelledMessage };
}

/**
 * 获取消息按原始顺序关联的 Block 标识。
 *
 * @param messageId - 目标消息标识。
 * @returns Block 标识数组；消息不存在时返回空数组。
 */
function indexesForMessage(messageId) {
  if (!messageId) {
    return [];
  }
  return snapshot.indexes.blockIdsByMessageId[messageId] ?? [];
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/api/conversations/demo/snapshot') {
    return sendJson(res, snapshotWithStreamEpoch());
  }

  if (req.method === 'POST' && req.url === '/api/conversations/demo/messages') {
    const idempotencyKey = req.headers['idempotency-key'];
    if (typeof idempotencyKey === 'string' && acceptedCommandsByIdempotencyKey.has(idempotencyKey)) {
      return sendJson(res, acceptedCommandsByIdempotencyKey.get(idempotencyKey), 201);
    }

    const { text, clientMessageId, clientBlockId } = JSON.parse(await readBody(req));
    const suffix = String(++sequence);
    // 客户端在联网前就创建这些标识。复用它们可让 UI 原地升级乐观气泡，避免 Outbox 重试成功后出现重复内容。
    const messageId = typeof clientMessageId === 'string' ? clientMessageId : `message_user_${suffix}`;
    const blockId = typeof clientBlockId === 'string' ? clientBlockId : `block_user_${suffix}`;
    const runId = `run_demo_${suffix}`;
    const outputMessageId = `message_assistant_${suffix}`;
    const conversation = { ...snapshot.entities.conversationsById.demo, activeRunId: runId, revision: snapshot.entities.conversationsById.demo.revision + 1 };
    const message = { id: messageId, conversationId: 'demo', runId: null, role: 'user', status: 'completed', revision: 1 };
    const block = { id: blockId, messageId, type: 'markdown', sourceContent: String(text), lastSeq: 0, status: 'completed', revision: 1 };
    const run = createRun(runId, messageId, outputMessageId, 'queued', null, 1);

    snapshot.entities.conversationsById.demo = conversation;
    snapshot.entities.messagesById[messageId] = message;
    snapshot.entities.blocksById[blockId] = block;
    snapshot.entities.runsById[runId] = run;
    snapshot.indexes.messageIdsByConversationId.demo.push(messageId);
    snapshot.indexes.blockIdsByMessageId[messageId] = [blockId];
    snapshot.indexes.runIdsByConversationId.demo.push(runId);
    streamsByRunId.set(runId, createFollowUpEvents(runId, outputMessageId, messageId, String(text)));
    startAgentRun(runId);
    const accepted = { streamEpoch, conversation, run, message, block };
    if (typeof idempotencyKey === 'string') {
      acceptedCommandsByIdempotencyKey.set(idempotencyKey, accepted);
    }
    return sendJson(res, accepted, 201);
  }

  const cancelMatch = req.method === 'POST' && req.url?.match(/^\/api\/runs\/([^/]+)\/cancel$/);
  if (cancelMatch) {
    const result = cancelServerRun(cancelMatch[1]);
    if (!result.run) {
      return sendJson(res, { error: 'Unknown run' }, 404);
    }
    return sendJson(res, result);
  }

  const streamMatch = req.method === 'GET' && req.url?.match(/^\/api\/runs\/([^/]+)\/events$/);
  if (streamMatch) {
    const runId = streamMatch[1];
    const events = streamsByRunId.get(runId);
    if (!events) {
      return sendJson(res, { error: 'Unknown run' }, 404);
    }
    if (cancelledRunIds.has(runId)) {
      return sendJson(res, { error: 'Run cancelled' }, 409);
    }
    const requestedEpoch = req.headers['x-stream-epoch'];
    if (typeof requestedEpoch === 'string' && requestedEpoch !== streamEpoch) {
      res.writeHead(409, { 'X-SSE-Reset': 'stream-epoch' });
      return res.end(JSON.stringify({ error: 'Stale stream epoch', streamEpoch }));
    }
    const lastId = Number(req.headers['last-event-id'] ?? 0);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    if (lastId >= events.length) {
      const run = snapshot.entities.runsById[runId];
      const terminal = run && ['completed', 'failed', 'cancelled'].includes(run.status);
      if (terminal) {
        res.write(`id: ${events.length}\nevent: stream.completed\ndata: ${JSON.stringify({ runId, run })}\n\n`);
      } else {
        res.write(`event: stream.cursor_invalid\ndata: ${JSON.stringify({ runId, streamEpoch })}\n\n`);
      }
      return setTimeout(() => {
        res.end();
      }, 80);
    }
    const timers = activeTimersByRunId.get(runId) ?? new Set();
    const responses = activeResponsesByRunId.get(runId) ?? new Set();
    activeTimersByRunId.set(runId, timers);
    activeResponsesByRunId.set(runId, responses);
    responses.add(res);
    events.slice(lastId).forEach(([type, payload], index) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (cancelledRunIds.has(runId)) {
          return;
        }
        materializeEvent(streamMatch[1], lastId + index + 1, type, payload);
        if (!res.writableEnded) {
          res.write(`id: ${lastId + index + 1}\nevent: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
        }
        if (lastId + index + 1 === events.length) {
          setTimeout(() => {
            res.end();
          }, 260);
        }
      }, 180 + index * 300);
      timers.add(timer);
    });
    req.on('close', () => responses.delete(res));
    return;
  }

  if (req.method === 'GET' && req.url === '/tokyo-plan.pdf') {
    res.writeHead(200, { 'Content-Type': 'application/pdf' });
    return res.end('%PDF-1.4\n% Mock artifact; open in a real product.');
  }
  res.writeHead(404); res.end('Not found');
});

server.listen(8787, () => console.log('Mock SSE server listening on http://localhost:8787'));
