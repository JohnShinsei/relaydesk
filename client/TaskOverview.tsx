import type { Task, TaskStatus } from '../shared/types.ts';

const labels: Record<TaskStatus, string> = {
  queued: '等待执行', running: '正在执行', awaiting_approval: '等待你的审批',
  cancelling: '正在停止', completed: '已完成', cancelled: '已停止', failed: '执行失败', unknown: '结果待确认',
};
const steps: Record<TaskStatus, string> = {
  queued: '等待执行器接收任务。', running: '等待结果，必要时可请求停止。',
  awaiting_approval: '核对下方具体操作，再决定批准或拒绝。',
  cancelling: '等待执行器确认结束；请勿重复提交。', completed: '查看下方完整结果，或开始下一个任务。',
  cancelled: '检查已经产生的结果；停止不会撤销已发生的操作。',
  failed: '查看失败原因，确认执行结果后再决定下一步。', unknown: '查询原任务回执；不会自动重做。',
};

/** Task, state, result and next step remain visible outside the mobile drawer. */
export default function TaskOverview({ task, result, connected }: { task?: Task; result?: string; connected: boolean }) {
  if (!task) return null;
  const uncertain = task.stopUnconfirmed || task.status === 'unknown';
  return <section className="task-overview" aria-label="当前任务摘要" data-testid="task-overview">
    <div className="task-overview-heading"><strong title={task.prompt}>{task.prompt}</strong><span data-testid="task-overview-status">{!connected ? '记录尚未同步' : uncertain ? '结果待确认' : labels[task.status]}</span></div>
    <p><b>结果</b><span>{task.error || (task.status === 'completed' ? result?.slice(0, 180) || '执行器已确认完成；未返回文字结果。' : task.status === 'cancelled' ? '执行器已确认停止。' : '等待执行器的最终回执。')}</span></p>
    <p><b>下一步</b><span>{!connected ? '恢复连接后读取状态；任务可能仍在执行。' : uncertain ? steps.unknown : steps[task.status]}</span></p>
  </section>;
}
