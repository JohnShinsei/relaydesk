import { createHash } from 'node:crypto';
import type { Session, Task, TaskActivity, TaskActivityKind, TaskActivityPage, TaskFeedItem, TaskFeedPage, TaskFeedScope, TaskStatus } from '../shared/types.ts';
import { isDriverAdapterId } from './execution.ts';

export const activityLimit = 200;
export const activityLabels: Record<TaskActivityKind, string> = {
  queued: '任务已排队', running: '正在启动原生任务', connecting: '正在连接本地执行器',
  'thread-ready': '原生会话已就绪', 'turn-started': '执行器已开始本回合',
  reasoning: '正在处理请求', answering: '正在生成回复', command: '原生命令活动', 'file-change': '原生文件修改活动',
  awaiting_approval: '等待单次人工审批', 'approval-resolved': '审批状态已更新',
  cancelling: '已请求取消，等待原生确认', completed: '原生任务已完成', cancelled: '已确认任务取消',
  failed: '任务失败', unknown: '结果未知，需要核验原生回合', recovery: '正在只读核验原生回合',
};
const currentStatuses = new Set<TaskStatus>(['queued', 'running', 'awaiting_approval', 'cancelling', 'unknown']);
const statuses = new Set<TaskStatus>([...currentStatuses, 'completed', 'cancelled', 'failed']);
export class FeedInputError extends Error {}
const validSeq = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const safeKind = (value: unknown): value is TaskActivityKind => typeof value === 'string' && Object.hasOwn(activityLabels, value);
const isoTime = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const safeTime = (value: unknown) => isoTime(value) ? value : '1970-01-01T00:00:00.000Z';
const timestamp = (task: Task) => isoTime(task.updatedAt) ? task.updatedAt : safeTime(task.createdAt);

/** Coalesce consecutive categories while keeping the latest real activity timestamp. */
export function recordActivity(task: Task, kind: TaskActivityKind, at = new Date().toISOString()) {
  if (!isDriverAdapterId(task.adapterId)) return;
  if (!safeKind(kind)) throw new FeedInputError('不支持此任务活动类型。');
  task.updatedAt = at;
  task.lastActivityAt = at;
  task.activity ??= [];
  const last = task.activity.at(-1);
  if (last?.kind === kind) { last.at = at; last.label = activityLabels[kind]; return; }
  task.activitySeq = (task.activitySeq ?? last?.seq ?? 0) + 1;
  task.activity.push({ seq: task.activitySeq, at, kind, label: activityLabels[kind] });
  if (task.activity.length > activityLimit) task.activity.splice(0, task.activity.length - activityLimit);
}

function safeActivities(task: Task): TaskActivity[] {
  return (task.activity ?? []).filter(item => validSeq(item.seq) && safeKind(item.kind) && isoTime(item.at))
    .slice(-activityLimit).map(item => ({ seq: item.seq, at: item.at, kind: item.kind, label: activityLabels[item.kind] }));
}
function taskItem(session: Session, task: Task, at: number): TaskFeedItem {
  const status = statuses.has(task.status) ? task.status : 'unknown';
  const activities = safeActivities(task);
  const lastActivityAt = isoTime(task.lastActivityAt) ? task.lastActivityAt : timestamp(task);
  const start = isoTime(task.startedAt) ? task.startedAt : safeTime(task.createdAt);
  const end = isoTime(task.endedAt) ? task.endedAt : currentStatuses.has(status) ? undefined : timestamp(task);
  const pending = (task.nativeApprovals ?? []).filter(item => item.status === 'pending' || item.status === 'responding');
  if (!isDriverAdapterId(task.adapterId)) throw new FeedInputError('此任务没有执行器活动记录。');
  const provider = task.adapterId === 'hermes' ? 'Hermes' : task.adapterId === 'claude' ? 'Claude' : 'Codex';
  const label = provider === 'Claude' ? 'Claude Agent' : provider;
  const binding = session.engineBinding;
  return {
    id: task.id, sessionId: session.id, adapterId: task.adapterId, provider, title: `${label} 任务 ${task.id.slice(0, 8)}`,
    project: binding && 'workspace' in binding && task.adapterId === binding.driverId ? { id: `workspace-${createHash('sha256').update(binding.workspace).digest('hex').slice(0, 16)}`, label: `${label} 本地工作区` } : null,
    status, createdAt: safeTime(task.createdAt), ...(isoTime(task.startedAt) ? { startedAt: task.startedAt } : {}), ...(end ? { endedAt: end } : {}),
    elapsedMs: Math.max(0, (end ? Date.parse(end) : at) - Date.parse(start)), lastActivityAt,
    currentActivity: activities.at(-1) ?? { seq: 0, at: lastActivityAt, kind: status, label: activityLabels[status] },
    stopUnconfirmed: task.stopUnconfirmed === true, pendingApprovalCount: pending.length,
    pendingApprovals: pending.slice(0, 10).map(item => ({ id: item.id, kind: item.kind, status: item.status as 'pending' | 'responding', createdAt: safeTime(item.createdAt), expiresAt: safeTime(item.expiresAt) })),
  };
}
export interface FeedQuery { scope?: TaskFeedScope; limit?: number; cursor?: string }
export function makeTaskFeed(sessions: Iterable<Session>, revision: string, query: FeedQuery = {}): TaskFeedPage {
  const { scope = 'active', limit = 30, cursor } = query;
  if (!['active', 'history', 'all'].includes(scope) || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new FeedInputError('任务列表筛选或页大小无效。');
  const all = [...sessions].flatMap(session => session.tasks.filter(task => isDriverAdapterId(task.adapterId)).map(task => ({ session, task })));
  const activeCount = all.filter(({ task }) => currentStatuses.has(task.status)).length;
  const matching = all.filter(({ task }) => scope === 'all' || (scope === 'active') === currentStatuses.has(task.status))
    .sort((a, b) => b.task.createdAt.localeCompare(a.task.createdAt) || b.task.id.localeCompare(a.task.id));
  let rows = matching;
  if (cursor !== undefined) {
    if (typeof cursor !== 'string' || cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new FeedInputError('任务列表游标无效。');
    let decoded: unknown;
    try { decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { throw new FeedInputError('任务列表游标无效。'); }
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new FeedInputError('任务列表游标无效。');
    const value = decoded as Record<string, unknown>;
    if (JSON.stringify(Object.keys(value)) !== JSON.stringify(['v', 'scope', 'createdAt', 'id']) || value.v !== 1 || value.scope !== scope || typeof value.createdAt !== 'string' || typeof value.id !== 'string' || Buffer.from(JSON.stringify(value)).toString('base64url') !== cursor || !all.some(({ task }) => task.id === value.id && task.createdAt === value.createdAt)) throw new FeedInputError('任务列表游标与筛选不匹配。');
    rows = matching.filter(({ task }) => task.createdAt < (value.createdAt as string) || (task.createdAt === value.createdAt && task.id.localeCompare(value.id as string) < 0));
  }
  const selected = rows.slice(0, limit);
  const last = selected.at(-1)?.task;
  const nextCursor = rows.length > limit && last ? Buffer.from(JSON.stringify({ v: 1, scope, createdAt: last.createdAt, id: last.id })).toString('base64url') : null;
  const generatedAt = new Date().toISOString();
  return { items: selected.map(({ session, task }) => taskItem(session, task, Date.parse(generatedAt))), scope, total: matching.length, activeCount, historyCount: all.length - activeCount, truncated: rows.length > limit, nextCursor, generatedAt, revision };
}
export function makeTaskActivity(task: Task, query: { before?: number; limit?: number } = {}): TaskActivityPage {
  const { before, limit = 50 } = query;
  const activities = safeActivities(task);
  const latestSeq = Math.max(task.activitySeq ?? 0, activities.at(-1)?.seq ?? 0);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (before !== undefined && (!validSeq(before) || before > latestSeq + 1))) throw new FeedInputError('活动页大小或序号无效。');
  const available = activities.filter(item => before === undefined || item.seq < before).reverse();
  const items = available.slice(0, limit);
  const retainedFrom = activities[0]?.seq ?? null;
  return { taskId: task.id, items, nextBefore: available.length > limit ? items.at(-1)!.seq : null, retainedFrom, latestSeq, truncated: retainedFrom !== null && retainedFrom > 1, generatedAt: new Date().toISOString() };
}
