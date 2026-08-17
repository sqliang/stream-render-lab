/**
 * @file 独立渲染 Run 的执行步骤，避免过程数据混入最终消息。
 */

import { useRun, useRunStep, useRunStepIds } from '../runtime/react/runtime-react';

/**
 * 将单个运行步骤渲染为过程时间线节点。
 *
 * @param props - 需要读取的步骤标识。
 * @returns 对应的步骤节点；步骤不存在时返回空。
 */
function Step({ stepId }: { stepId: string }) {
  const step = useRunStep(stepId);
  if (!step) {
    return null;
  }
  let stepTypeLabel = '生成';
  if (step.type === 'reasoning') {
    stepTypeLabel = '分析';
  } else if (step.type === 'tool') {
    stepTypeLabel = '工具';
  }

  return (
    <div className={`step step-${step.status}`}>
      <span className="step-point" />
      <div>
        <p>{stepTypeLabel}</p>
        <h3>{step.title}</h3>
        {step.summary && <small>{step.summary}</small>}
      </div>
    </div>
  );
}

/**
 * 渲染指定 Run 的过程步骤，避免执行过程与最终会话消息混在同一内容流中。
 *
 * @param props - 需要展示的 Run 标识。
 * @returns 运行状态和按顺序排列的步骤时间线。
 */
export function RunTimeline({ runId }: { runId: string }) {
  const run = useRun(runId);
  const stepIds = useRunStepIds(runId);
  let statusLabel = '已完成';
  if (run?.status === 'running') {
    statusLabel = '运行中';
  } else if (run?.status === 'cancelled') {
    statusLabel = '已取消';
  }

  return (
    <div className="timeline">
      <div className="run-status">{statusLabel}</div>
      {stepIds.map((id) => (
        <Step key={id} stepId={id} />
      ))}
    </div>
  );
}
