/**
 * @file 会话输入与发送/取消操作组件。
 */

/**
 * 渲染当前草稿，并将提交与取消意图交给 Runtime Facade。
 * 组件只表达交互状态，不直接发起网络请求或修改 Store 实体。
 */
/**
 * 渲染可编辑草稿，并将提交和取消意图交给 Runtime Facade。
 *
 * @param props - 受控草稿值与由页面提供的交互回调。
 * @returns 会话输入表单。
 */
export function Composer({
  value, onChange, onSubmit, isStreaming, onCancel,
}: {
  value: string;
  onChange(value: string): void;
  onSubmit(): void;
  isStreaming: boolean;
  onCancel(): void;
}) {
  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (!isStreaming) {
          onSubmit();
        }
      }}
    >
      <textarea value={value} rows={2} onChange={(event) => onChange(event.target.value)} aria-label="会话输入" />
      <div className="composer-bottom">
        <span>{isStreaming ? 'Agent 正在生成结果' : 'Mock SSE · 创建新问题与新 Run'}</span>
        {isStreaming ? (
          <button className="cancel" type="button" onClick={onCancel}><i />取消生成</button>
        ) : (
          <button type="submit">发送 <b>↵</b></button>
        )}
      </div>
    </form>
  );
}
