import { randomUUID } from 'node:crypto';
import type { AdapterId, EngineDriver, ExecutionAdapter, Message, NativeApprovalDecision, Session, SessionSummary, Task, TaskMode, TaskStatus } from '../shared/types.ts';
import { createAdapterRegistry, pause } from './adapters.ts';
import { SessionStore } from './store.ts';
import { CodexStopUnconfirmedError } from './codex-adapter.ts';
import { NativeOutcomeUnknownError } from './codex-app-server.ts';

const active = new Set<TaskStatus>(['queued', 'running', 'awaiting_approval', 'cancelling']);
const now = () => new Date().toISOString();
const interruptedReason = '存在未确认结束的真实 CLI 任务，真实适配器已暂停；请先检查本地进程，再由本机操作员确认。';
const storageReason = '本地存储写入失败；本次状态未确认保存，已请求停止执行。请检查磁盘后重启服务。';
const isReal = (task: Task) => task.adapterId === 'codex' || task.adapterId === 'claude' || task.adapterId === 'codex-app-server';
interface EngineOptions {
  nativeDriver?: EngineDriver;
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
  private nativeDriver?: EngineDriver;
  private recovering = new Set<string>();
  onChange: (session: Session) => void = () => {};

  constructor(dbPath: string, delayMs = 65, codex?: ExecutionAdapter, options: EngineOptions = {}) {
    this.delayMs = delayMs;
    this.store = options.store ?? new SessionStore(dbPath);
    this.sessions = new Map(this.store.all().map(session => [session.id, session]));
    this.nativeDriver = options.nativeDriver;
    this.registry = createAdapterRegistry(delayMs, codex, options.nativeDriver);
    for (const session of this.sessions.values()) {
      let changed = false;
      for (const task of session.tasks) {
        if (task.adapterId === 'codex-app-server') {
          if (active.has(task.status) || task.stopUnconfirmed) {
            task.error = '本地服务已重启，原生执行结果待核验；恢复只读取原生线程，不会重新发送消息。';
            task.stopUnconfirmed = true;
            for (const approval of task.nativeApprovals ?? []) {
              if (approval.status === 'pending' || approval.status === 'responding') approval.status = 'unknown';
            }
            this.transition(task, 'unknown', task.error);
            changed = true;
          }
          continue;
        }
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
    if (this.recovering.has(session.id) || session.tasks.some(task => task.status === 'unknown' || task.stopUnconfirmed)) throw new HttpError(409, '此会话有结果未知的执行，请先核验原生线程；不会自动重发。');
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
    const waitForExit = (task.status === 'running' || (task.adapterId === 'codex-app-server' && task.status === 'awaiting_approval')) && this.registry.adapters.get(task.adapterId)?.info.kind === 'cli';
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

  async decideNativeApproval(id: string, approvalId: string, decision: NativeApprovalDecision): Promise<Session> {
    this.requireWritable();
    const { session, task } = this.requireTask(id);
    const driver = this.nativeDriver;
    if (!driver || task.adapterId !== 'codex-app-server') throw new HttpError(400, '此任务没有原生审批接口。');
    const approval = task.nativeApprovals?.find(item => item.id === approvalId);
    if (!approval || approval.status !== 'pending' || task.status !== 'awaiting_approval' || task.stopUnconfirmed) throw new HttpError(409, '审批已失效或执行状态未知；请刷新核验。');
    if (approval.threadId !== session.engineBinding?.threadId || approval.turnId !== task.nativeTurnId) throw new HttpError(409, '审批不属于当前原生执行。');
    if (Date.parse(approval.expiresAt) <= Date.now()) {
      approval.status = 'expired'; this.save(session);
      this.cancel(id);
      throw new HttpError(409, '审批已过期，已请求停止；不会发送批准。');
    }
    if (!approval.allowedDecisions.includes(decision)) throw new HttpError(400, '此审批不允许该决定。');
    // Commit intent before writing to the protocol. An uncertain write is never retried.
    approval.status = 'responding'; approval.decision = decision; approval.decidedAt = now();
    this.transition(task, 'awaiting_approval', `本机操作员提交单次审批决定：${decision}。`);
    this.save(session);
    try { await driver.decideApproval(approvalId, decision); }
    catch {
      approval.status = 'unknown';
      task.error = '审批响应是否送达未知；不会自动重发，请核验原生线程。';
      task.stopUnconfirmed = true;
      this.transition(task, 'unknown', task.error);
      this.save(session);
      this.controllers.get(id)?.abort();
      throw new HttpError(409, task.error);
    }
    approval.status = decision === 'accept' ? 'accepted' : decision === 'decline' ? 'declined' : 'cancelled';
    if (task.status === 'awaiting_approval' && !task.nativeApprovals?.some(item => item.status === 'pending' || item.status === 'responding')) {
      this.transition(task, 'running', '单次审批决定已交给原生执行器，等待执行结果。');
    }
    this.save(session);
    return structuredClone(session);
  }

  async recover(sessionId: string): Promise<Session> {
    this.requireWritable();
    const session = this.requireSession(sessionId);
    if (!this.nativeDriver || session.adapterId !== 'codex-app-server' || !session.engineBinding) throw new HttpError(409, '没有可核验的原生线程绑定。');
    const task = [...session.tasks].reverse().find(item => item.status === 'unknown' || item.stopUnconfirmed);
    if (!task || session.tasks.some(item => active.has(item.status)) || this.controllers.has(task.id) || this.recovering.has(sessionId)) throw new HttpError(409, '当前没有可核验的中断任务，或执行器仍在停止。');
    this.recovering.add(sessionId);
    try {
      const evidence = await this.nativeDriver.recover(session.engineBinding, task.nativeTurnId);
      if (evidence.turnId && evidence.turnId !== task.nativeTurnId) throw new Error('Native turn mismatch.');
      for (const message of evidence.messages) this.upsertNativeMessage(session, task, message.itemId, message.text);
      if (evidence.status === 'completed' || evidence.status === 'cancelled' || evidence.status === 'failed') {
        delete task.stopUnconfirmed;
        task.error = evidence.error;
        this.transition(task, evidence.status, '已从原生持久线程核验终态；未重新发送消息。');
      } else {
        task.stopUnconfirmed = true;
        task.error = evidence.error ?? '原生线程尚未提供可确认的终态；保持隔离，不重新发送。';
        this.transition(task, 'unknown', task.error);
      }
      this.save(session);
      return structuredClone(session);
    } catch (error) {
      task.error = error instanceof Error ? error.message : '无法核验原生线程。';
      this.save(session);
      throw new HttpError(409, '原生线程核验未完成；执行结果仍未知，不会重试原消息。');
    } finally { this.recovering.delete(sessionId); }
  }

  private upsertNativeMessage(session: Session, task: Task, itemId: string, text: string) {
    let message = session.messages.find(item => item.taskId === task.id && item.nativeItemId === itemId);
    if (!message) {
      message = { id: randomUUID(), taskId: task.id, nativeItemId: itemId, role: 'assistant', createdAt: now(), content: text };
      session.messages.push(message);
    } else message.content = text;
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
    if (error instanceof NativeOutcomeUnknownError) {
      task.stopUnconfirmed = true; task.error = error.message;
      this.transition(task, 'unknown', error.message);
    } else if (error instanceof CodexStopUnconfirmedError) {
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
      this.transition(task, 'running', adapter.info.kind === 'mock' ? '开始本地模拟执行。' : task.adapterId === 'codex-app-server' ? '通过原生 App Server 执行；按原生事件确认状态。' : '通过官方 Codex CLI 执行受限只读对话。');
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
      let nativeTerminal: { status: 'completed' | 'cancelled' | 'failed'; error?: string } | undefined;
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
        native: task.adapterId === 'codex-app-server' ? {
          binding: structuredClone(session.engineBinding),
          onBinding: binding => { session.engineBinding = structuredClone(binding); this.save(session); },
          onTurn: turnId => { task.nativeTurnId = turnId; this.save(session); },
          upsertMessage: (itemId, text) => {
            if (this.closed || task.status === 'unknown') return;
            this.upsertNativeMessage(session, task, itemId, text); this.save(session);
          },
          onApproval: approval => {
            if (this.closed || signal.aborted || !active.has(task.status)) throw new Error('Task cannot accept approval.');
            if (approval.threadId !== session.engineBinding?.threadId || approval.turnId !== task.nativeTurnId) throw new Error('Native approval binding mismatch.');
            task.nativeApprovals ??= [];
            if (!task.nativeApprovals.some(item => item.id === approval.id)) task.nativeApprovals.push(structuredClone(approval));
            this.transition(task, 'awaiting_approval', '原生执行器请求单次审批；等待本机操作员决定。');
            this.save(session);
          },
          onApprovalResolved: approvalId => {
            const approval = task.nativeApprovals?.find(item => item.id === approvalId);
            if (approval?.status === 'pending') approval.status = 'resolved';
            if (task.status === 'awaiting_approval' && !task.nativeApprovals?.some(item => item.status === 'pending' || item.status === 'responding')) this.transition(task, 'running', '原生审批请求已撤下，等待终态。');
            this.save(session);
          },
          onTerminal: (status, error) => { nativeTerminal = { status, error }; },
        } : undefined,
      });
      if (this.closed) return;
      if ((task.status as TaskStatus) === 'unknown') return;
      if (nativeTerminal) {
        task.error = nativeTerminal.error;
        delete task.stopUnconfirmed;
        for (const approval of task.nativeApprovals ?? []) {
          if (approval.status === 'pending' || approval.status === 'responding') approval.status = 'resolved';
        }
        this.transition(task, nativeTerminal.status, '原生执行器已确认终态。');
        this.save(session);
        return;
      }
      if (task.adapterId === 'codex-app-server') throw new NativeOutcomeUnknownError('原生驱动未提供可核验终态；保持结果未知，不会自动重发。');
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
      if (error instanceof NativeOutcomeUnknownError) {
        task.stopUnconfirmed = true;
        this.transition(task, 'unknown', task.error);
        this.save(session);
        return;
      }
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
    await this.nativeDriver?.close();
    // Preserve interrupted statuses so the next process can report a restart honestly.
    this.store.close();
  }
}
