import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { DemoDeliveryOutcome, InboxSnapshot, PrepareInboxReply, SendInboxReply } from '../shared/inbox.ts';
import type { ExecutionAdapter } from '../shared/types.ts';
import { InboxService } from '../server/inbox.ts';
import type { MockInboxSender } from '../server/inbox.ts';
import { InboxStore } from '../server/inbox-store.ts';
import type { InboxPersistence, StoredInbox } from '../server/inbox-store.ts';
import { SessionStore } from '../server/store.ts';
import { createApp } from '../server/app.ts';

async function fixture(t: TestContext, options: { delayMs?: number; sender?: MockInboxSender; store?: InboxPersistence; dbPath?: string } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'relaydesk-inbox-'));
  const dbPath = options.dbPath ?? join(directory, 'inbox.sqlite');
  const service = new InboxService(dbPath, { delayMs: 2, ...options });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return { service, dbPath, directory };
}
function input(snapshot: InboxSnapshot, outcome: DemoDeliveryOutcome = 'succeeded'): PrepareInboxReply {
  const thread = snapshot.threads[0];
  return { threadId: thread.id, sourceMessageId: thread.messages[0].id, content: '收到，待核对后再沟通。', idempotencyKey: randomUUID(), demoOutcome: outcome };
}
async function terminal(service: InboxService, id: string) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const reply = service.snapshot().replies.find(candidate => candidate.id === id)!;
    if (reply.status !== 'sending' && reply.status !== 'draft') return reply;
    await sleep(2);
  }
  assert.fail('Timed out waiting for mock delivery');
}

test('inbox begins empty and repeated synthetic seeding preserves stable identities, source evidence, and replies', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.service.snapshot(), { mode: 'mock', projects: [], threads: [], replies: [] });
  const first = f.service.seed();
  assert.equal(first.projects.length, 2); assert.equal(first.threads.length, 3);
  const sameNamed = first.threads.filter(thread => thread.title === first.threads[0].title);
  assert.equal(sameNamed.length, 2);
  assert.notEqual(sameNamed[0].id, sameNamed[1].id);
  assert.notEqual(sameNamed[0].externalThreadId, sameNamed[1].externalThreadId);
  const multiProjectThread = first.threads.find(thread => thread.projectIds.length > 1)!;
  assert.ok(multiProjectThread, 'one synthetic conversation covers multiple projects');
  assert.ok(multiProjectThread.messages.some(message => message.projectIds.length > 1), 'a source can be associated with multiple projects');
  for (const projectId of multiProjectThread.projectIds) {
    assert.ok(multiProjectThread.messages.some(message => message.projectIds.length === 1 && message.projectIds[0] === projectId), 'separate sources in the same conversation can belong to different projects');
  }
  const allMessages = first.threads.flatMap(thread => thread.messages);
  const knownProjects = new Set(first.projects.map(project => project.id));
  for (const thread of first.threads) {
    assert.deepEqual([...thread.projectIds].sort(), [...new Set(thread.messages.flatMap(message => message.projectIds))].sort());
    for (const message of thread.messages) {
      assert.ok(message.projectIds.every(id => knownProjects.has(id)));
      assert.equal(message.threadId, thread.id);
    }
  }
  for (const project of first.projects) {
    assert.equal(project.summaryKind, 'deterministic-demo');
    assert.ok(project.todos.length > 0);
    const sources = new Set(allMessages.filter(message => message.projectIds.includes(project.id)).map(message => message.id));
    for (const entry of [...project.requirements, ...project.deadlines, ...project.questions, ...project.todos]) assert.ok(sources.has(entry.sourceMessageId), `project evidence must be associated with ${project.id}`);
  }
  assert.ok(first.threads.flatMap(thread => thread.messages).every(message => message.trust === 'untrusted'));
  assert.deepEqual(f.service.seed(), first);
  const draft = f.service.prepare(input(first)).reply;
  const again = f.service.seed();
  assert.equal(again.replies[0].id, draft.id);
  assert.equal(again.threads.length, 3);
  assert.equal(f.service.deliveryCount, 0);
});

test('drafts bind stable source and target server-side, reject mismatched same-name threads, and never send', async t => {
  const f = await fixture(t);
  const seeded = f.service.seed();
  const data = input(seeded);
  const other = seeded.threads.find(thread => thread.title === seeded.threads[0].title && thread.id !== data.threadId)!;
  assert.throws(() => f.service.prepare({ ...data, sourceMessageId: other.messages[0].id }), /不属于/);
  assert.throws(() => f.service.prepare({ ...data, threadId: 'not-a-thread' }), /不存在/);
  const exactContent = '  收到，稍后核对。\n';
  const draft = f.service.prepare({ ...data, content: exactContent }).reply;
  assert.equal(draft.content, exactContent);
  assert.equal(draft.accountId, seeded.threads[0].accountId);
  assert.equal(draft.externalThreadId, seeded.threads[0].externalThreadId);
  assert.equal(draft.targetTitle, seeded.threads[0].title);
  draft.content = 'client mutation'; draft.externalThreadId = other.externalThreadId;
  assert.equal(f.service.snapshot().replies[0].content, exactContent);
  assert.equal(f.service.deliveryCount, 0);
});

test('prepare validates content, outcomes and idempotency key syntax', async t => {
  const f = await fixture(t); const data = input(f.service.seed());
  for (const content of ['', '  ', 'x'.repeat(4001)]) assert.throws(() => f.service.prepare({ ...data, content }), /1–4000/);
  for (const idempotencyKey of ['short', 'x'.repeat(101), 'unsafe key with spaces', '________________/']) assert.throws(() => f.service.prepare({ ...data, idempotencyKey }), /幂等键/);
  assert.throws(() => f.service.prepare({ ...data, demoOutcome: 'external-send' as DemoDeliveryOutcome }), /模拟投递结果/);
  assert.equal(f.service.deliveryCount, 0);
});

test('idempotency and payload dedup survive restart, while conflicting payloads reject changed keys or outcomes', async t => {
  const f = await fixture(t); const data = input(f.service.seed());
  const first = f.service.prepare(data);
  assert.equal(first.created, true);
  assert.deepEqual(f.service.prepare(data), { reply: first.reply, created: false });
  const alias = randomUUID();
  const duplicate = f.service.prepare({ ...data, idempotencyKey: alias });
  assert.equal(duplicate.created, false); assert.equal(duplicate.reply.id, first.reply.id);
  assert.equal(f.service.snapshot().replies.length, 1);
  assert.throws(() => f.service.prepare({ ...data, content: 'different' }), /已绑定/);
  assert.throws(() => f.service.prepare({ ...data, idempotencyKey: alias, demoOutcome: 'unknown' }), /已绑定/);
  await f.service.close();
  const restored = await fixture(t, { dbPath: f.dbPath });
  assert.equal(restored.service.prepare({ ...data, idempotencyKey: alias }).reply.id, first.reply.id);
  assert.throws(() => restored.service.prepare({ ...data, content: 'changed after restart' }), /已绑定/);
  assert.equal(restored.service.deliveryCount, 0);
  await restored.service.close();
});

test('explicit send intent persists an immutable authorization before the sole local mock call', async t => {
  let calls = 0;
  let persisted: StoredInbox | undefined;
  const f = await fixture(t, { store: {
    load: () => persisted,
    save: state => { persisted = structuredClone(state); },
    close() {},
  }, sender: {
    kind: 'mock',
    async send(delivery) {
      calls++;
      const durableReply = persisted!.snapshot.replies.find(reply => reply.id === delivery.replyId)!;
      assert.equal(durableReply.status, 'sending');
      assert.deepEqual(persisted!.authorizations[delivery.replyId], {
        replyId: delivery.replyId, sourceMessageId: delivery.sourceMessageId, externalSourceMessageId: delivery.externalSourceMessageId,
        accountId: delivery.accountId, externalThreadId: delivery.externalThreadId, threadId: delivery.threadId,
        targetTitle: delivery.targetTitle, content: delivery.content, intent: 'send-reply', confirmReview: false, authorizedAt: delivery.authorizedAt,
      });
      assert.ok(Object.isFrozen(delivery));
      return { status: 'succeeded', receiptId: 'mock-local-receipt' };
    },
  } });
  const data = input(f.service.seed()); const draft = f.service.prepare(data).reply;
  assert.equal(calls, 0);
  assert.throws(() => f.service.send(draft.id, {} as SendInboxReply), /明确提供/);
  assert.throws(() => f.service.send(draft.id, { intent: 'draft-only' } as unknown as SendInboxReply), /明确提供/);
  const started = f.service.send(draft.id, { intent: 'send-reply' });
  assert.equal(started.started, true); assert.equal(started.reply.status, 'sending');
  assert.equal(f.service.send(draft.id, { intent: 'send-reply' }).started, false);
  const completed = await terminal(f.service, draft.id);
  assert.equal(completed.status, 'succeeded'); assert.equal(completed.receiptId, 'mock-local-receipt');
  assert.equal(completed.content, data.content);
  assert.equal(f.service.send(draft.id, { intent: 'send-reply' }).reply.status, 'succeeded');
  assert.equal(calls, 1); assert.equal(f.service.deliveryCount, 1);
});

test('high-risk sources and simple sensitive reply rules require confirmation tied to the immutable draft', async t => {
  const f = await fixture(t); const seeded = f.service.seed(); const base = input(seeded);
  const riskyThread = seeded.threads.find(thread => thread.messages.some(message => message.risk === 'high-impact'))!;
  const source = riskyThread.messages.find(message => message.risk === 'high-impact')!;
  for (const data of [
    { ...base, threadId: riskyThread.id, sourceMessageId: source.id, idempotencyKey: randomUUID() },
    { ...base, content: '我承诺明天支付费用。', idempotencyKey: randomUUID() },
    { ...base, content: '临时 password 为合成演示。', idempotencyKey: randomUUID() },
  ]) {
    const draft = f.service.prepare(data).reply;
    assert.equal(draft.reviewRequired, true);
    assert.throws(() => f.service.send(draft.id, { intent: 'send-reply' }), /需要人工核对/);
    assert.throws(() => f.service.send(draft.id, { intent: 'send-reply', confirmReview: false }), /需要人工核对/);
    assert.equal(f.service.send(draft.id, { intent: 'send-reply', confirmReview: true }).started, true);
    assert.equal((await terminal(f.service, draft.id)).status, 'succeeded');
  }
});

test('sending and unknown states block other drafts for the same source, including changed content and keys', async t => {
  const f = await fixture(t, { delayMs: 60 }); const base = input(f.service.seed(), 'unknown');
  const first = f.service.prepare(base).reply;
  const second = f.service.prepare({ ...base, content: 'another draft', idempotencyKey: randomUUID(), demoOutcome: 'succeeded' }).reply;
  f.service.send(first.id, { intent: 'send-reply' });
  assert.throws(() => f.service.send(second.id, { intent: 'send-reply' }), /发送锁/);
  const unknown = await terminal(f.service, first.id);
  assert.equal(unknown.status, 'unknown');
  assert.equal(f.service.send(first.id, { intent: 'send-reply' }).started, false);
  const third = f.service.prepare({ ...base, content: 'try another key and content', idempotencyKey: randomUUID() }).reply;
  assert.throws(() => f.service.send(third.id, { intent: 'send-reply' }), /发送锁/);
  assert.equal(f.service.deliveryCount, 1);
  await f.service.close();
  const restored = await fixture(t, { dbPath: f.dbPath });
  assert.equal(restored.service.send(first.id, { intent: 'send-reply' }).reply.status, 'unknown');
  assert.throws(() => restored.service.send(second.id, { intent: 'send-reply' }), /发送锁/);
  assert.equal(restored.service.deliveryCount, 0);
  await restored.service.close();
});

test('known failed outcomes are not retried on duplicate send', async t => {
  const f = await fixture(t); const draft = f.service.prepare(input(f.service.seed(), 'failed')).reply;
  f.service.send(draft.id, { intent: 'send-reply' });
  assert.equal((await terminal(f.service, draft.id)).status, 'failed');
  for (let n = 0; n < 4; n++) assert.equal(f.service.send(draft.id, { intent: 'send-reply' }).started, false);
  assert.equal(f.service.deliveryCount, 1);
});

test('shutdown drains in-flight work and restart converts durable sending to unknown without resending', async t => {
  const f = await fixture(t, { delayMs: 5000 }); const draft = f.service.prepare(input(f.service.seed())).reply;
  f.service.send(draft.id, { intent: 'send-reply' });
  await f.service.close();
  const durable = new InboxStore(f.dbPath);
  assert.equal(durable.load()!.snapshot.replies[0].status, 'sending');
  assert.equal(durable.load()!.authorizations[draft.id].intent, 'send-reply');
  durable.close();
  const restored = await fixture(t, { dbPath: f.dbPath });
  assert.equal(restored.service.snapshot().replies[0].status, 'unknown');
  assert.equal(restored.service.send(draft.id, { intent: 'send-reply' }).started, false);
  assert.equal(restored.service.deliveryCount, 0);
  await restored.service.close();
});

test('storage failure before sending prevents delivery; failed result persistence never reports success', async t => {
  for (const failAt of ['sending', 'succeeded']) {
    let durable: StoredInbox | undefined;
    let failedWrites = 0;
    const f = await fixture(t, { store: {
      load: () => durable,
      save(state) {
        if (state.snapshot.replies.some(reply => reply.status === failAt)) { failedWrites++; throw new Error('SECRET disk path'); }
        durable = structuredClone(state);
      },
      close() {},
    } });
    const draft = f.service.prepare(input(f.service.seed())).reply;
    if (failAt === 'sending') {
      assert.throws(() => f.service.send(draft.id, { intent: 'send-reply' }), /保存失败/);
      assert.equal(f.service.deliveryCount, 0);
      assert.equal(durable!.snapshot.replies[0].status, 'draft');
    } else {
      f.service.send(draft.id, { intent: 'send-reply' });
      const unknown = await terminal(f.service, draft.id);
      assert.equal(unknown.status, 'unknown'); assert.equal(unknown.receiptId, undefined);
      assert.match(unknown.error!, /未确认保存/); assert.ok(!unknown.error!.includes('SECRET'));
      assert.equal(durable!.snapshot.replies[0].status, 'sending');
      assert.equal(f.service.deliveryCount, 1);
    }
    assert.equal(failedWrites, 1);
    assert.throws(() => f.service.prepare({ ...input(f.service.snapshot()), idempotencyKey: randomUUID() }), /保存失败/);
    await f.service.close();
  }
});

test('inbox tables never replace or mutate existing AI session snapshots', async t => {
  const f = await fixture(t);
  const sessions = new SessionStore(f.dbPath);
  const original = { id: 'existing-ai-session', title: 'untouched', adapterId: 'mock-codex' as const, createdAt: '2026-01-01', updatedAt: '2026-01-01', messages: [], tasks: [] };
  sessions.save(original);
  f.service.seed();
  const draft = f.service.prepare(input(f.service.snapshot())).reply;
  f.service.send(draft.id, { intent: 'send-reply' });
  await terminal(f.service, draft.id);
  assert.deepEqual(sessions.all(), [original]); sessions.close();
});

test('inbox HTTP routes share origin/JSON validation and never turn untrusted source text into AI execution', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'relaydesk-inbox-http-'));
  let providerCalls = 0;
  const codex: ExecutionAdapter = { info: { id: 'codex', kind: 'cli', available: true, name: 'test', description: 'test' }, async execute() { providerCalls++; } };
  const app = createApp({ dbPath: join(directory, 'app.sqlite'), delayMs: 2, codex });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  async function post(path: string, data: unknown, headers: Record<string, string> = {}) {
    return fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) });
  }
  assert.equal((await (await fetch(url + '/api/inbox')).json()).inbox.threads.length, 0);
  assert.equal((await post('/api/inbox/demo', {}, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/api/inbox/demo', {}, { 'Content-Type': 'text/plain' })).status, 415);
  const seeded: InboxSnapshot = (await (await post('/api/inbox/demo', {})).json()).inbox;
  assert.equal((await post('/api/inbox/demo', { trust: 'trusted' })).status, 400);
  const data = input(seeded);
  assert.equal((await post('/api/inbox/replies', { ...data, targetTitle: 'client-controlled target' })).status, 400);
  assert.equal((await post('/api/inbox/replies', { ...data, accountId: 'other-account' })).status, 400);
  const prepared = await post('/api/inbox/replies', data);
  assert.equal(prepared.status, 201);
  const draft = (await prepared.json()).reply;
  assert.equal((await post('/api/inbox/replies', data)).status, 200);
  assert.equal((await post(`/api/inbox/replies/${draft.id}/send`, { intent: 'send-reply', content: 'changed' })).status, 400);
  assert.equal((await post(`/api/inbox/replies/${draft.id}/send`, {})).status, 400);
  assert.equal((await post(`/api/inbox/replies/${draft.id}/send`, { intent: 'send-reply' })).status, 202);
  assert.equal((await post(`/api/inbox/replies/${draft.id}/send`, { intent: 'send-reply' })).status, 200);
  assert.equal((await post('/api/inbox/replies/no-such/send', { intent: 'send-reply' })).status, 404);
  assert.deepEqual((await (await fetch(url + '/api/sessions')).json()).sessions, []);
  assert.equal(providerCalls, 0);
});
