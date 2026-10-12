import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { DemoDeliveryOutcome, InboxReply, InboxSnapshot, PrepareInboxReply, SendInboxReply } from '../shared/inbox.ts';
import { HttpError } from './engine.ts';
import { createDemoInbox } from './inbox-fixtures.ts';
import { InboxStore } from './inbox-store.ts';
import type { InboxAuthorization, InboxPersistence, StoredInbox } from './inbox-store.ts';

export interface MockInboxDelivery extends InboxAuthorization { demoOutcome: DemoDeliveryOutcome }
export interface MockInboxSender {
  kind: 'mock';
  send(delivery: Readonly<MockInboxDelivery>, signal: AbortSignal): Promise<{ status: DemoDeliveryOutcome; receiptId?: string }>;
}
export function createMockInboxSender(delayMs = 120): MockInboxSender {
  return {
    kind: 'mock',
    async send(delivery, signal) {
      await delay(delayMs, undefined, { signal });
      return { status: delivery.demoOutcome, ...(delivery.demoOutcome === 'succeeded' ? { receiptId: `mock-receipt-${randomUUID()}` } : {}) };
    },
  };
}

const empty = (): StoredInbox => ({ snapshot: { mode: 'mock', projects: [], threads: [], replies: [] }, keys: {}, authorizations: {} });
const sameSource = (a: InboxReply, b: InboxReply) => a.accountId === b.accountId && a.externalThreadId === b.externalThreadId && a.sourceMessageId === b.sourceMessageId;
const fingerprint = (reply: Pick<InboxReply, 'accountId' | 'externalThreadId' | 'sourceMessageId' | 'content' | 'demoOutcome'>) =>
  createHash('sha256').update(JSON.stringify([reply.accountId, reply.externalThreadId, reply.sourceMessageId, reply.content, reply.demoOutcome])).digest('hex');
const riskyContent = /付款|支付|转账|汇款|打款|承诺|保证|密码|口令|验证码|身份证|银行卡|保密|合同|签约|删除|删库|执行|password|token|secret|api[_ -]?key|transfer|payment|guarantee/i;
const storageError = '合成收件箱保存失败，已暂停写入；发送结果未确认保存时按未知处理，请检查本地存储。';

/** Synthetic data and local sender only; no execution adapter or external connector is referenced. */
export class InboxService {
  private state: StoredInbox;
  private store: InboxPersistence;
  private sender: MockInboxSender;
  private failed = false;
  private closing = false;
  private closePromise?: Promise<void>;
  private jobs = new Set<Promise<void>>();
  private controllers = new Set<AbortController>();
  deliveryCount = 0;

  constructor(dbPath: string, options: { store?: InboxPersistence; sender?: MockInboxSender; delayMs?: number } = {}) {
    this.store = options.store ?? new InboxStore(dbPath);
    this.sender = options.sender ?? createMockInboxSender(options.delayMs);
    if (this.sender.kind !== 'mock') throw new Error('Only the local mock inbox sender is supported.');
    this.state = this.store.load() ?? empty();
    const interrupted = this.state.snapshot.replies.some(reply => reply.status === 'sending');
    if (interrupted) {
      try {
        this.commit(next => {
          for (const reply of next.snapshot.replies) if (reply.status === 'sending') {
            reply.status = 'unknown'; reply.updatedAt = new Date().toISOString();
            reply.error = '服务已重启，无法确认此前模拟投递结果；本版本禁止重试或解除此来源的发送锁。';
          }
        });
      } catch (error) { this.store.close(); throw error; }
    }
  }

  private writable() {
    if (this.failed) throw new HttpError(503, storageError);
    if (this.closing) throw new HttpError(503, '合成收件箱正在关闭。');
  }
  private storageFailed() {
    this.failed = true;
    for (const reply of this.state.snapshot.replies) if (reply.status === 'sending') {
      reply.status = 'unknown'; reply.updatedAt = new Date().toISOString();
      reply.error = `${storageError} 此状态仅保留在当前服务内存中。`;
      delete reply.receiptId;
    }
    for (const controller of this.controllers) controller.abort();
  }
  private commit(change: (next: StoredInbox) => void) {
    this.writable();
    const next = structuredClone(this.state);
    change(next);
    try { this.store.save(next); }
    catch { this.storageFailed(); throw new HttpError(503, storageError); }
    this.state = next;
  }
  snapshot(): InboxSnapshot { return structuredClone(this.state.snapshot); }

  seed(): InboxSnapshot {
    this.writable();
    if (this.state.snapshot.threads.length) return this.snapshot();
    this.commit(next => { next.snapshot = createDemoInbox(); });
    return this.snapshot();
  }

  prepare(input: PrepareInboxReply): { reply: InboxReply; created: boolean } {
    this.writable();
    if (typeof input.threadId !== 'string' || typeof input.sourceMessageId !== 'string') throw new HttpError(400, '必须提供稳定会话与来源消息 ID。');
    if (typeof input.content !== 'string' || !input.content.trim() || input.content.length > 4000) throw new HttpError(400, '回复内容必须为 1–4000 个字符。');
    if (typeof input.idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(input.idempotencyKey)) throw new HttpError(400, '幂等键必须为 16–100 个字母、数字、下划线或连字符。');
    if (!['succeeded', 'failed', 'unknown'].includes(input.demoOutcome)) throw new HttpError(400, '请选择支持的模拟投递结果。');
    const thread = this.state.snapshot.threads.find(candidate => candidate.id === input.threadId);
    if (!thread) throw new HttpError(404, '合成会话不存在。');
    const source = thread.messages.find(message => message.id === input.sourceMessageId && message.threadId === thread.id);
    if (!source) throw new HttpError(400, '来源消息不属于所选稳定会话，无法准备回复。');
    const bound = { accountId: thread.accountId, externalThreadId: thread.externalThreadId, sourceMessageId: source.id, content: input.content, demoOutcome: input.demoOutcome };
    const hash = fingerprint(bound);
    const priorKey = Object.hasOwn(this.state.keys, input.idempotencyKey) ? this.state.keys[input.idempotencyKey] : undefined;
    if (priorKey) {
      if (priorKey.fingerprint !== hash) throw new HttpError(409, '同一幂等键已绑定其他回复内容、来源或模拟结果。');
      const reply = this.state.snapshot.replies.find(candidate => candidate.id === priorKey.replyId)!;
      return { reply: structuredClone(reply), created: false };
    }
    const duplicate = this.state.snapshot.replies.find(reply => fingerprint(reply) === hash);
    if (duplicate) {
      this.commit(next => { next.keys[input.idempotencyKey] = { fingerprint: hash, replyId: duplicate.id }; });
      return { reply: structuredClone(duplicate), created: false };
    }
    const reviewRequired = source.risk !== 'normal' || riskyContent.test(input.content);
    const timestamp = new Date().toISOString();
    const reply: InboxReply = {
      id: randomUUID(), threadId: thread.id, sourceMessageId: source.id,
      accountId: thread.accountId, externalThreadId: thread.externalThreadId, targetTitle: thread.title,
      content: input.content, idempotencyKey: input.idempotencyKey, demoOutcome: input.demoOutcome,
      reviewRequired, ...(reviewRequired ? { reviewReason: '来源风险标记或演示关键词规则命中；请人工核对目标、内容与影响。此规则并非完整风险检测。' } : {}),
      status: 'draft', createdAt: timestamp, updatedAt: timestamp,
    };
    this.commit(next => {
      next.snapshot.replies.push(reply);
      next.keys[input.idempotencyKey] = { fingerprint: hash, replyId: reply.id };
    });
    return { reply: structuredClone(reply), created: true };
  }

  send(id: string, input: SendInboxReply): { reply: InboxReply; started: boolean } {
    this.writable();
    if (input.intent !== 'send-reply') throw new HttpError(400, '必须明确提供 send-reply 发送意图。');
    if (input.confirmReview !== undefined && typeof input.confirmReview !== 'boolean') throw new HttpError(400, '人工核对确认必须为布尔值。');
    const reply = this.state.snapshot.replies.find(candidate => candidate.id === id);
    if (!reply) throw new HttpError(404, '回复草稿不存在。');
    if (reply.status !== 'draft') return { reply: structuredClone(reply), started: false };
    if (reply.reviewRequired && input.confirmReview !== true) throw new HttpError(409, '此草稿需要人工核对，请明确确认后再进行模拟发送。');
    if (this.state.snapshot.replies.some(other => other.id !== id && sameSource(other, reply) && (other.status === 'sending' || other.status === 'unknown'))) {
      throw new HttpError(409, '此来源已有发送中或结果未知的回复；更换内容或幂等键不能绕过发送锁。');
    }
    const thread = this.state.snapshot.threads.find(candidate => candidate.id === reply.threadId)!;
    const source = thread.messages.find(message => message.id === reply.sourceMessageId)!;
    const authorization: InboxAuthorization = {
      replyId: reply.id, sourceMessageId: source.id, externalSourceMessageId: source.externalId,
      accountId: reply.accountId, externalThreadId: reply.externalThreadId, threadId: reply.threadId,
      targetTitle: reply.targetTitle, content: reply.content, intent: 'send-reply', confirmReview: input.confirmReview === true,
      authorizedAt: new Date().toISOString(),
    };
    this.commit(next => {
      const target = next.snapshot.replies.find(candidate => candidate.id === id)!;
      target.status = 'sending'; target.updatedAt = authorization.authorizedAt;
      next.authorizations[id] = authorization;
    });
    const response = structuredClone(this.state.snapshot.replies.find(candidate => candidate.id === id)!);
    this.schedule(Object.freeze({ ...authorization, demoOutcome: reply.demoOutcome }));
    return { reply: response, started: true };
  }

  private schedule(delivery: Readonly<MockInboxDelivery>) {
    const controller = new AbortController();
    this.controllers.add(controller);
    const job = this.deliver(delivery, controller.signal).catch(() => { this.storageFailed(); });
    this.jobs.add(job);
    void job.then(() => { this.jobs.delete(job); this.controllers.delete(controller); });
  }
  private async deliver(delivery: Readonly<MockInboxDelivery>, signal: AbortSignal) {
    let outcome: { status: DemoDeliveryOutcome; receiptId?: string };
    try {
      this.deliveryCount++;
      outcome = await this.sender.send(delivery, signal);
      if (!['succeeded', 'failed', 'unknown'].includes(outcome.status)) outcome = { status: 'unknown' };
    } catch { outcome = { status: 'unknown' }; }
    if (this.closing || this.failed || signal.aborted) return;
    this.commit(next => {
      const reply = next.snapshot.replies.find(candidate => candidate.id === delivery.replyId)!;
      reply.status = outcome.status; reply.updatedAt = new Date().toISOString();
      if (outcome.status === 'succeeded') reply.receiptId = outcome.receiptId?.startsWith('mock-') ? outcome.receiptId : `mock-receipt-${randomUUID()}`;
      else reply.error = outcome.status === 'failed' ? '模拟发送已明确失败；没有向真实渠道发送。' : '模拟投递结果未知；本版本不会重试，也不提供解除此来源发送锁的接口。';
    });
  }

  close(): Promise<void> {
    this.closePromise ??= (async () => {
      this.closing = true;
      for (const controller of this.controllers) controller.abort();
      await Promise.allSettled(this.jobs);
      this.store.close();
    })();
    return this.closePromise;
  }
}
