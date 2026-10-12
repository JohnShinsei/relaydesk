import { randomUUID } from 'node:crypto';
import type { AdapterId, Message, Session, SessionSummary, Task, TaskMode, TaskStatus } from '../shared/types.ts';
import { adapterCatalog, createMockAdapters, pause } from './adapters.ts';
import { SessionStore } from './store.ts';

const active = new Set<TaskStatus>(['queued', 'running', 'awaiting_approval']);
const now = () => new Date().toISOString();
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export class TaskEngine {
  private store: SessionStore;
  private sessions: Map<string, Session>;
  private controllers = new Map<string, AbortController>();
  private jobs = new Set<Promise<void>>();
  private closed = false;
  private delayMs: number;
  private adapters: ReturnType<typeof createMockAdapters>;
  onChange: (session: Session) => void = () => {};

  constructor(dbPath: string, delayMs = 65) {
    this.delayMs = delayMs;
    this.store = new SessionStore(dbPath);
    this.sessions = new Map(this.store.all().map(session => [session.id, session]));
    this.adapters = createMockAdapters(delayMs);
    for (const session of this.sessions.values()) {
      let interrupted = false;
      for (const task of session.tasks) {
        if (task.status === 'queued' || task.status === 'running') {
          task.error = '本地服务已重启，之前的执行已中断；请重新提交。';
          this.transition(task, 'failed', task.error);
          interrupted = true;
        }
      }
      if (interrupted) this.save(session);
    }
  }

  private transition(task: Task, status: TaskStatus, detail: string) {
    task.status = status;
    task.updatedAt = now();
    task.events.push({ status, at: task.updatedAt, detail });
  }

  private save(session: Session) {
    session.updatedAt = now();
    this.store.save(session);
    this.onChange(structuredClone(session));
  }

  private requireSession(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new HttpError(404, '会话不存在。');
    return session;
  }

  private requireTask(id: string): { session: Session; task: Task } {
    for (const session of this.sessions.values()) {
      const task = session.tasks.find(candidate => candidate.id === id);
      if (task) return { session, task };
    }
    throw new HttpError(404, '任务不存在。');
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(session => ({
      id: session.id, title: session.title, adapterId: session.adapterId, createdAt: session.createdAt,
      updatedAt: session.updatedAt, lastMessage: session.messages.at(-1)?.content ?? '',
      status: session.tasks.at(-1)?.status ?? 'idle',
    }));
  }

  get(id: string): Session { return structuredClone(this.requireSession(id)); }

  create(adapterId: string, title?: string): Session {
    const adapter = adapterCatalog.find(candidate => candidate.id === adapterId);
    if (!adapter) throw new HttpError(400, '未知的执行适配器。');
    if (!adapter.available) throw new HttpError(409, adapter.reason ?? '执行适配器尚未接入。');
    const timestamp = now();
    const session: Session = {
      id: randomUUID(), title: title ?? '新会话', adapterId: adapterId as AdapterId,
      createdAt: timestamp, updatedAt: timestamp, messages: [], tasks: [],
    };
    this.sessions.set(session.id, session);
    this.save(session);
    return structuredClone(session);
  }

  submit(sessionId: string, prompt: string, mode: TaskMode): Task {
    const session = this.requireSession(sessionId);
    if (session.tasks.some(task => active.has(task.status))) throw new HttpError(409, '当前会话已有进行中的任务，请完成或取消后再提交。');
    const timestamp = now();
    const task: Task = {
      id: randomUUID(), sessionId, adapterId: session.adapterId, prompt, mode, status: 'queued',
      createdAt: timestamp, updatedAt: timestamp, events: [{ status: 'queued', at: timestamp, detail: '本地模拟任务已排队。' }],
    };
    session.tasks.push(task);
    session.messages.push({ id: randomUUID(), role: 'user', content: prompt, taskId: task.id, createdAt: timestamp });
    if (session.title === '新会话' && session.tasks.length === 1) session.title = Array.from(prompt).slice(0, 28).join('');
    this.save(session);
    const snapshot = structuredClone(task);
    this.schedule(session, task, false);
    return snapshot;
  }

  cancel(id: string): Task {
    const { session, task } = this.requireTask(id);
    if (!active.has(task.status)) throw new HttpError(409, '任务已经结束，无法再次取消。');
    this.transition(task, 'cancelled', '用户已取消；停止后续模拟输出。');
    this.controllers.get(id)?.abort();
    this.save(session);
    return structuredClone(task);
  }

  approve(id: string): Task {
    const { session, task } = this.requireTask(id);
    if (task.status !== 'awaiting_approval') throw new HttpError(409, '该任务当前没有等待批准的操作。');
    this.transition(task, 'queued', '用户已批准本地模拟计划，等待继续执行。');
    this.save(session);
    const snapshot = structuredClone(task);
    this.schedule(session, task, true);
    return snapshot;
  }

  private schedule(session: Session, task: Task, approved: boolean) {
    const controller = new AbortController();
    this.controllers.set(task.id, controller);
    const job = this.run(session, task, approved, controller);
    this.jobs.add(job);
    void job.finally(() => {
      this.jobs.delete(job);
      if (this.controllers.get(task.id) === controller) this.controllers.delete(task.id);
    });
  }

  private async run(session: Session, task: Task, approved: boolean, controller: AbortController) {
    const { signal } = controller;
    try {
      // Yield first so the queued snapshot is observable and cancellation can win before execution.
      await pause(this.delayMs, signal);
      if (this.closed || signal.aborted || task.status !== 'queued') return;
      this.transition(task, 'running', '开始本地模拟执行。');
      this.save(session);
      if (task.mode === 'approval-demo' && !approved) {
        await pause(this.delayMs, signal);
        if (this.closed || signal.aborted) return;
        task.approval = { title: '批准本地模拟计划', description: '批准后仅生成一段模拟结果并写入本会话；不会执行命令、联网或发送消息。' };
        this.transition(task, 'awaiting_approval', '本地模拟计划已准备好，等待用户批准或取消。');
        this.save(session);
        return;
      }
      const adapter = this.adapters.get(task.adapterId);
      if (!adapter) throw new Error('执行适配器不可用。');
      let reply: Message | undefined;
      await adapter.execute({
        task: structuredClone(task), history: structuredClone(session.messages), signal,
        emit: chunk => {
          if (this.closed || signal.aborted || task.status !== 'running') return;
          if (!reply) {
            reply = { id: randomUUID(), role: 'assistant', content: '', createdAt: now(), taskId: task.id };
            session.messages.push(reply);
          }
          reply.content += chunk;
          task.updatedAt = now();
          this.save(session);
        },
      });
      if (this.closed || signal.aborted) return;
      this.transition(task, 'completed', '本地模拟任务完成。');
      this.save(session);
    } catch (error) {
      if (this.closed || signal.aborted || !active.has(task.status)) return;
      task.error = error instanceof Error ? error.message : '本地模拟执行失败。';
      this.transition(task, 'failed', task.error);
      this.save(session);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled(this.jobs);
    // Preserve interrupted statuses so the next process can report a restart honestly.
    this.store.close();
  }
}
