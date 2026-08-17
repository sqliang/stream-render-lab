/**
 * @file 会话页面：只订阅 Runtime 投影并渲染，不直接处理网络或持久化。
 */

import * as Avatar from '@radix-ui/react-avatar';
import * as ScrollArea from '@radix-ui/react-scroll-area';
import * as Tooltip from '@radix-ui/react-tooltip';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Composer } from './Composer';
import { MessageBubble } from './MessageBubble';
import { RunTimeline } from './RunTimeline';
import { useConversation, useDraft, useMessageIds, useRuntime, useStream } from '../runtime/react/runtime-react';

/**
 * 显示当前活跃 Run 的 SSE 连接状态。
 *
 * @returns 当前连接状态标签。
 */
function StatusPill() {
  const conversation = useConversation('demo');
  const stream = useStream(conversation?.activeRunId ?? 'run_demo_01');
  const labels = {
    connecting: '连接中',
    streaming: '实时接收',
    reconnecting: '重连中',
    closed: '已关闭',
    error: '连接异常',
    idle: '待连接',
  } as const;
  const connection = stream?.connection ?? 'idle';

  return (
    <span className="status-pill">
      <i />
      {labels[connection]}
    </span>
  );
}

/**
 * 渲染会话主界面；页面只读取 Runtime 投影，将命令意图交由 Facade 处理。
 *
 * @returns 会话、输入区和 Run 过程面板。
 */
export function App() {
  const conversation = useConversation('demo');
  const messageIds = useMessageIds('demo');
  const runtime = useRuntime();
  const draft = useDraft('demo');
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // 默认跟随最新内容；只有用户主动滚动到历史区域才停止自动跟随。
  const shouldFollowLatestRef = useRef(true);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const stream = useStream(conversation?.activeRunId ?? 'run_demo_01');
  const isStreaming = stream?.connection === 'connecting' || stream?.connection === 'streaming' || stream?.connection === 'reconnecting';

  const scrollToBottom = (behavior: ScrollBehavior = 'auto') => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    viewport.scrollTo({ top: viewport.scrollHeight, behavior });
    setIsAtBottom(true);
  };

  const handleMessageScroll = () => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    const distanceToBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    if (isStreaming && distanceToBottom > 2) {
      // 流式生成期间优先保证最新结果可见，避免输出落在用户不可见区域。
      scrollToBottom();
      return;
    }
    const nearBottom = distanceToBottom < 48;
    shouldFollowLatestRef.current = nearBottom;
    setIsAtBottom(nearBottom);
  };

  // Snapshot、用户新消息和 SSE 增量都应保持最新结果可见，直到用户主动查看历史消息。
  useLayoutEffect(() => {
    if (isStreaming || shouldFollowLatestRef.current) {
      requestAnimationFrame(() => {
        scrollToBottom();
      });
    }
  }, [isStreaming, messageIds, stream?.lastEventId]);

  // 图片和富 UI 可能在消息提交后继续撑高内容区，因此监听真实高度而非只监听事件次数。
  useEffect(() => {
    const content = contentRef.current;
    if (!content || (!isStreaming && !shouldFollowLatestRef.current)) {
      return;
    }
    const observer = new ResizeObserver(() => {
      if (isStreaming || shouldFollowLatestRef.current) {
        scrollToBottom();
      }
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [isStreaming]);

  // 持久化消息 ID 而不是像素滚动位置，避免内容高度变化或消息淘汰后恢复到错误位置。
  useEffect(() => {
    const lastMessageId = messageIds.at(-1) ?? null;
    if (isAtBottom && lastMessageId) {
      runtime.setConversationViewState('demo', { lastReadMessageId: lastMessageId });
    }
  }, [isAtBottom, messageIds, runtime]);

  return (
    <Tooltip.Provider delayDuration={250}>
      <main className="app-shell">
        <aside className="rail">
          <div className="brand-mark">R</div>
          <div className="rail-line" />
          <Tooltip.Root>
            <Tooltip.Trigger asChild>
              <button className="rail-button active" aria-label="会话">✦</button>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content className="tooltip" side="right">会话运行时</Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>
          <Tooltip.Root>
            <Tooltip.Trigger asChild>
              <button className="rail-button" aria-label="产物">⌁</button>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content className="tooltip" side="right">生成产物</Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>
        </aside>

        <section className="conversation-panel">
          <header className="topbar">
            <div>
              <p className="eyebrow">AGENT RUNTIME / DEMO</p>
              <h1>{conversation?.title ?? '加载会话中…'}</h1>
            </div>
            <StatusPill />
          </header>

          <ScrollArea.Root className="messages-scroll">
            <ScrollArea.Viewport className="messages-viewport" ref={viewportRef} onScroll={handleMessageScroll}>
              <div className="messages-stack" ref={contentRef}>
                {messageIds.map((id) => (
                  <MessageBubble key={id} messageId={id} />
                ))}
              </div>
            </ScrollArea.Viewport>
            <ScrollArea.Scrollbar className="scrollbar" orientation="vertical">
              <ScrollArea.Thumb className="scroll-thumb" />
            </ScrollArea.Scrollbar>
            {!isStreaming && !isAtBottom && (
              <button className="jump-to-latest" type="button" onClick={() => {
                shouldFollowLatestRef.current = true;
                scrollToBottom('smooth');
              }}>
                <span>↓</span> 回到最新消息
              </button>
            )}
          </ScrollArea.Root>

          <Composer
            value={draft?.text ?? ''}
            onChange={(text) => runtime.setDraft('demo', text)}
            isStreaming={isStreaming}
            onCancel={() => {
              if (conversation?.activeRunId) {
                void runtime.cancelRun(conversation.activeRunId);
              }
            }}
            onSubmit={() => {
              const text = (draft?.text ?? '').trim();
              if (!text) {
                return;
              }
              shouldFollowLatestRef.current = true;
              setIsAtBottom(true);
              void runtime.sendMessage('demo', text);
              // Outbox 已保留可恢复命令；此处只清空可编辑草稿，不能删除待发送事实。
              runtime.setDraft('demo', '');
            }}
          />
        </section>

        <aside className="run-panel">
          <div className="run-head">
            <div>
              <p className="eyebrow">LIVE RUN</p>
              <h2>执行轨迹</h2>
            </div>
            <Avatar.Root className="agent-avatar">
              <Avatar.Fallback>AI</Avatar.Fallback>
            </Avatar.Root>
          </div>
          {conversation?.activeRunId && <RunTimeline runId={conversation.activeRunId} />}
          <div className="legend">
            <span />
            <p>过程数据与会话结果分离保存；每个 SSE 事件只更新对应实体。</p>
          </div>
        </aside>
      </main>
    </Tooltip.Provider>
  );
}
