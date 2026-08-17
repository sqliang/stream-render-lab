/**
 * @file 按消息与 Block 原始顺序渲染会话气泡。
 */

import { useBlockIds, useMessage } from '../runtime/react/runtime-react';
import { BlockRenderer } from './blocks';

/**
 * 按 `Message.blocks` 的稳定顺序渲染一个会话气泡。
 *
 * @param props - 需要展示的消息标识。
 * @returns 用户或 Agent 消息气泡；消息不存在时返回空。
 */
export function MessageBubble({ messageId }: { messageId: string }) {
  const message = useMessage(messageId);
  const blockIds = useBlockIds(messageId);
  if (!message) {
    return null;
  }
  const isUser = message.role === 'user';

  return (
    <article className={`message ${isUser ? 'message-user' : 'message-agent'}`}>
      <div className="message-label">{isUser ? '你' : 'TOKYO PLANNER'}</div>
      <div className="message-content">
        {blockIds.map((id) => (
          <BlockRenderer key={id} blockId={id} />
        ))}
        {!isUser && message.status === 'streaming' && <span className="flow-cursor" />}
      </div>
    </article>
  );
}
