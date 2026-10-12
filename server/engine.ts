import { randomUUID } from 'node:crypto';
import type { AdapterId, ExecutionAdapter, Message, Session, SessionSummary, Task, TaskMode, TaskStatus } from '../shared/types.ts';
import { createAdapterRegistry, pause } from './adapters.ts';
import { SessionStore } from './store.ts';
import { CodexStopUnconfirmedError } from './codex-adapter.ts';

const active = new Set<TaskStatus>(['queued', 'running', 'awaiting_approval', 'cancelling']);
const now = () => new Date().toISOString();
const interruptedReason = '存在未确认结束的真实 CLI 任务，真实适配器已暂停；请先检查本地进程，再由本机操作员确认。';
const storageReason = '本地存储写入失败；本次状态未确认保存，已请求停止执行。请检查磁盘后重启服务。';
const isReal = (task: Task) => task.adapterId === 'codex' || task.adapterId === 'claude';
interface EngineOptions {
  acknowledgeInterruptedCodex?: boolean;
  /** Internal fault-injection seam; never accepted over HTTP. */
  store?: Pick<SessionStore, 'all' | 'save' | 'close'>;
}
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export class TaskEngine {
  private store: Pick<SessionStore, 'all' | 'save' | 'close'>;
  private sessions: Map<string, Session>;
  private controllers = new Map<string, AbortController>();
  private jobs = new Set<Promise<void>>();
  private closed = false;
  private delayMs: number;
  private registry: ReturnType<typeof createAdapterRegistry>;
  private realPaused = false;
  private storageFailure?: HttpError;
  onChange: (session: Session) => void = () => {};

  constructor(dbPath: string, delayMs = 65, codex?: ExecutionAdapter, options: EngineOptions = {}) {
    this.delayMs = delayMs;
    this.store = options.store ?? new SessionStore(dbPath);
    this.sessions = new Map(this.store.all().map(session => [session.id, session]));
    this.registry = createAdapterRegistry(delayMs, codex);
    for (const session of this.sessions.values()) {
      let changed = false;
      for (const task of session.tasks) {
        const interrupted = task.status === 'queued' || task.status === 'running' || task.status === 'cancelling';
        if (interrupted) {
          task.error = isReal(task)
            ? options.acknowledgeInterruptedCodex
              ? '本地服务已重启，之前的任务无法恢复；本机操作员已确认相关 CLI 进程状态。'
              : '本地服务已重启，无法恢复或确认之前的执行状态；请先检查本地 CLI 进程。'
            : '本地服务已重启，之前的模拟执行已中断；请重新提交。';
          this.transition(task, 'failed', task.error);
          changed = true;
        }
        if (isReal(task) && (interrupted || task.stopUnconfirmed)) {
          if (options.acknowledgeInterruptedCodex) {
            delete task.stopUnconfirmed;
            this.transition(task, task.status, '本机操作员已确认此前 CLI 进程状态，解除启动隔离。');
            changed = true;
          } else {
            if (!task.stopUnconfirmed) changed = true;
            task.stopUnconfirmed = true;
            this.pauseRealAdapters();
          }
        }
      }
      if (changed) {
        try { this.save(session); } catch (error) { this.store.close(); throw error; }
      }
    }
  }

  private transition(task: Task, status: TaskStatus, detail: string) {
    task.status = status;
    task.updatedAt = now();
    task.events.push({ status, at: task.updatedAt, detail });
  }

  private save(session: Session) {
    this.requireWritable();
    session.updatedAt = now();
    try { this.store.save(session); }
    catch { this.failStorage(session); throw this.storageFailure; }
    this.publish(session);
  }

  private publish(session: Session) {
    // A disconnected subscriber or UI callback must never take down background execution.
    try { this.onChange(structuredClone(session)); } catch { /* A fresh GET/SSE reconnect can recover. */ }
  }

  private requireWritable() {
    if (this.storageFailure) throw this.storageFailure;
  }

  private pauseRealAdapters() {
    this.realPaused = true;
    for (const info of this.registry.catalog) {
      if (info.kind === 'cli') { info.available = false; info.reason = interruptedReason; }
    }
  }

  private failStorage(failedSession: Session) {
    if (this.storageFailure) return;
    this.storageFailure = new HttpError(503, storageReason);
    for (const info of this.registry.catalog) { info.available = false; info.reason = storageReason; }
    for (const session of this.sessions.values()) {
      let changed = false;
      for (const task of session.tasks) {
        if (active.has(task.status) || (session === failedSession && task === session.tasks.at(-1))) {
          task.error = `${storageReason} 此状态仅保留在当前服务内存中。`;
          if (isReal(task)) task.stopUnconfirmed = true;
          this.transition(task, 'failed', task.error);
          changed = true;
        }
      }
      if (changed) { session.updatedAt = now(); this.publish(session); }
    }
    // No retry writes here: disk failures may be persistent, and the previous durable
    // running snapshot will require explicit process acknowledgement after restart.
    for (const controller of this.controllers.values()) controller.abort();
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

  catalog() { return structuredClone(this.registry.catalog); }

  create(adapterId: string, title?: string): Session {
    this.requireWritable();
    const adapter = this.registry.catalog.find(candidate => candidate.id === adapterId);
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
    this.requireWritable();
    const session = this.requireSession(sessionId);
    const adapter = this.registry.adapters.get(session.adapterId);
    if (!adapter) throw new HttpError(409, '此会话的执行适配器当前未启用，请检查本地配置。');
    if (adapter.info.kind === 'cli' && this.realPaused) throw new HttpError(409, interruptedReason);
    if (mode === 'approval-demo' && adapter.info.kind !== 'mock') throw new HttpError(400, '真实 Codex 仅支持聊天，不支持模拟审批任务。');
    if (session.tasks.some(task => active.has(task.status))) throw new HttpError(409, '当前会话已有进行中的任务，请完成或取消后再提交。');
    const timestamp = now();
    const task: Task = {
      id: randomUUID(), sessionId, adapterId: session.adapterId, prompt, mode, status: 'queued',
      createdAt: timestamp, updatedAt: timestamp, events: [{ status: 'queued', at: timestamp, detail: adapter.info.kind === 'mock' ? '本地模拟任务已排队。' : 'Codex CLI 对话任务已排队。' }],
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
    this.requireWritable();
    const { session, task } = this.requireTask(id);
    if (!active.has(task.status)) throw new HttpError(409, '任务已经结束，无法再次取消。');
    if (task.status === 'cancelling') throw new HttpError(409, '正在等待执行进程停止。');
    const waitForExit = task.status === 'running' && this.registry.adapters.get(task.adapterId)?.info.kind === 'cli';
    this.transition(task, waitForExit ? 'cancelling' : 'cancelled', waitForExit ? '正在停止 Codex 进程，等待确认退出。' : '用户已取消；停止后续执行与输出。');
    this.controllers.get(id)?.abort();
    this.save(session);
    return structuredClone(task);
  }

  approve(id: string): Task {
    this.requireWritable();
    const { session, task } = this.requireTask(id);
    if (this.registry.adapters.get(task.adapterId)?.info.kind !== 'mock') throw new HttpError(400, '真实执行适配器不支持模拟审批。');
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
    const job = this.run(session, task, approved, controller).catch(() => {
      controller.abort();
      this.failStorage(session);
    });
    this.jobs.add(job);
    void job.then(() => {
      this.jobs.delete(job);
      if (this.controllers.get(task.id) === controller) this.controllers.delete(task.id);
    });
  }

  private finishCancellation(session: Session, task: Task, error?: unknown) {
    if (error instanceof CodexStopUnconfirmedError) {
      task.stopUnconfirmed = true;
      this.pauseRealAdapters();
      task.error = error.message;
      this.transition(task, 'failed', error.message);
    } else this.transition(task, 'cancelled', '已确认 Codex 执行结束，任务已取消。');
    this.save(session);
  }

  private async run(session: Session, task: Task, approved: boolean, controller: AbortController) {
    const { signal } = controller;
    try {
      // Yield first so the queued snapshot is observable and cancellation can win before execution.
      await pause(this.delayMs, signal);
      if (this.closed || signal.aborted || task.status !== 'queued') return;
      const adapter = this.registry.adapters.get(task.adapterId);
      if (!adapter) throw new Error('执行适配器不可用。');
      this.transition(task, 'running', adapter.info.kind === 'mock' ? '开始本地模拟执行。' : '通过官方 Codex CLI 执行受限只读对话。');
      this.save(session);
      if (task.mode === 'approval-demo' && !approved) {
        await pause(this.delayMs, signal);
        if (this.closed || signal.aborted) return;
        task.approval = { title: '批准本地模拟计划', description: '批准后仅生成一段模拟结果并写入本会话；不会执行命令、联网或发送消息。' };
        this.transition(task, 'awaiting_approval', '本地模拟计划已准备好，等待用户批准或取消。');
        this.save(session);
        return;
      }
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
      if (this.closed) return;
      if (signal.aborted) {
        if ((task.status as TaskStatus) === 'cancelling') this.finishCancellation(session, task);
        return;
      }
      this.transition(task, 'completed', adapter.info.kind === 'mock' ? '本地模拟任务完成。' : 'Codex CLI 对话完成。');
      this.save(session);
    } catch (error) {
      if (this.closed || this.storageFailure) return;
      if (task.status === 'cancelling') { this.finishCancellation(session, task, error); return; }
      if (signal.aborted || !active.has(task.status)) return;
      task.error = error instanceof Error ? error.message : '执行失败。';
      if (error instanceof CodexStopUnconfirmedError) {
        task.stopUnconfirmed = true;
        this.pauseRealAdapters();
      }
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
