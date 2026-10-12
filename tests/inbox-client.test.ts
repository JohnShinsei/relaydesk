import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import Inbox from '../client/Inbox.tsx';
import type { InboxReply, InboxSnapshot, PrepareInboxReply } from '../shared/inbox.ts';

const timestamp = '2026-10-12T12:00:00.000Z';
const fixture: InboxSnapshot = {
  mode: 'mock',
  projects: [
    {
      id: 'project-design', name: '演示设计项目', summaryKind: 'deterministic-demo',
      requirements: [{ text: '提供手机版布局', sourceMessageId: 'message-design-first' }],
      deadlines: [{ text: '周五前确认', sourceMessageId: 'message-design-latest' }],
      questions: [], todos: [],
    },
    {
      id: 'project-purchase', name: '演示采购项目', summaryKind: 'deterministic-demo',
      requirements: [], deadlines: [],
      questions: [{ text: '是否批准付款？', sourceMessageId: 'message-purchase' }],
      todos: [],
    },
  ],
  threads: [
    {
      id: 'thread-design', channelId: 'mock-wechat', accountId: 'demo-work-wechat',
      externalThreadId: 'synthetic-design-group', title: '演示设计讨论组', projectIds: ['project-design', 'project-purchase'],
      messages: [
        { id: 'message-design-first', externalId: 'synthetic-message-1', threadId: 'thread-design', projectIds: ['project-design'], sender: '演示同事甲', text: '请提供手机版布局。<img src=x onerror="alert(1)">', receivedAt: timestamp, trust: 'untrusted', risk: 'normal' },
        { id: 'message-design-latest', externalId: 'synthetic-message-2', threadId: 'thread-design', projectIds: ['project-design', 'project-purchase'], sender: '演示同事乙', text: '周五前确认。', receivedAt: timestamp, trust: 'untrusted', risk: 'normal' },
      ],
    },
    {
      id: 'thread-purchase', channelId: 'mock-wechat', accountId: 'demo-work-wechat',
      externalThreadId: 'synthetic-purchase-group', title: '演示采购讨论组', projectIds: ['project-purchase'],
      messages: [
        { id: 'message-purchase', externalId: 'synthetic-message-3', threadId: 'thread-purchase', projectIds: ['project-purchase'], sender: '演示同事丙', text: '是否批准付款？', receivedAt: timestamp, trust: 'untrusted', risk: 'high-impact' },
      ],
    },
  ],
  replies: [],
};

type RecordedRequest = { path: string; method: string; body: Record<string, unknown> };

async function mount(options: { empty?: boolean; deferPrepare?: boolean; failSendTransport?: boolean; rejectPrepare?: boolean } = {}) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://127.0.0.1:4317/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  let snapshot: InboxSnapshot = structuredClone(options.empty ? { mode: 'mock', projects: [], threads: [], replies: [] } : fixture);
  const requests: RecordedRequest[] = [];
  const timers = new Map<number, () => void>();
  let timerId = 0;
  let replyId = 0;
  let deferred: { resolve: (response: Response) => void; reply: InboxReply } | undefined;
  let root: Root | undefined;
  const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  const setInterval = (callback: () => void) => { timers.set(++timerId, callback); return timerId; };
  const clearInterval = (id: number) => { timers.delete(id); };
  const globals: Record<string, unknown> = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true, setInterval, clearInterval,
    fetch: async (input: string, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      requests.push({ path, method, body });
      if (path === '/api/inbox' && method === 'GET') return response({ inbox: snapshot });
      if (path === '/api/inbox/demo' && method === 'POST') {
        snapshot = structuredClone(fixture);
        return response({ inbox: snapshot });
      }
      if (path === '/api/inbox/replies' && method === 'POST') {
        if (options.rejectPrepare) return response({ error: '测试中的明确拒绝。' }, 400);
        const prepared = body as unknown as PrepareInboxReply;
        const thread = snapshot.threads.find((item) => item.id === prepared.threadId);
        const message = thread?.messages.find((item) => item.id === prepared.sourceMessageId);
        if (!thread || !message) return response({ error: '测试来源消息不存在。' }, 400);
        const reply: InboxReply = {
          id: `reply-${++replyId}`, ...prepared,
          accountId: thread.accountId, externalThreadId: thread.externalThreadId, targetTitle: thread.title,
          reviewRequired: message.risk !== 'normal',
          ...(message.risk !== 'normal' ? { reviewReason: '此来源涉及付款，需再次人工核对。' } : {}),
          status: 'draft', createdAt: timestamp, updatedAt: timestamp,
        };
        snapshot.replies.push(reply);
        if (options.deferPrepare) return new Promise<Response>((resolve) => { deferred = { resolve, reply }; });
        return response({ reply }, 201);
      }
      const send = /^\/api\/inbox\/replies\/([^/]+)\/send$/.exec(path);
      if (send && method === 'POST') {
        const reply = snapshot.replies.find((item) => item.id === send[1]);
        if (!reply) return response({ error: '测试回复不存在。' }, 404);
        if (reply.reviewRequired && body.confirmReview !== true) return response({ error: '需要人工核对。' }, 409);
        reply.status = options.failSendTransport ? 'unknown' : reply.demoOutcome;
        if (reply.status === 'succeeded') reply.receiptId = `synthetic-receipt-${reply.id}`;
        if (options.failSendTransport) throw new TypeError('Synthetic connection closed after delivery was attempted');
        return response({ reply });
      }
      return response({ error: `未配置的测试请求 ${method} ${path}` }, 404);
    },
  };
  for (const [key, value] of Object.entries(globals)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  Object.defineProperty(dom.window, 'setInterval', { value: setInterval });
  Object.defineProperty(dom.window, 'clearInterval', { value: clearInterval });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollIntoView', { value() {} });
  const flush = async () => { await act(async () => { await new Promise<void>((resolve) => setImmediate(resolve)); }); };
  await act(async () => {
    const { createRoot } = await import('react-dom/client');
    root = createRoot(dom.window.document.getElementById('root')!);
    root.render(createElement(Inbox));
  });
  await flush();
  const query = <T extends Element = HTMLElement>(selector: string) => {
    const node = dom.window.document.querySelector<T>(selector);
    assert.ok(node, `Expected DOM element: ${selector}`);
    return node;
  };
  const click = async (selector: string) => {
    await act(async () => query<HTMLElement>(selector).click());
    await flush();
  };
  const type = async (value: string) => {
    await act(async () => {
      const field = query<HTMLTextAreaElement>('[data-testid="inbox-reply-input"]');
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value);
      field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await flush();
  };
  return {
    dom, requests, query, click, type, flush,
    snapshot: () => snapshot,
    async outcome(value: string) {
      await act(async () => {
        const field = query<HTMLSelectElement>('[data-testid="inbox-outcome"]');
        field.value = value;
        field.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      });
      await flush();
    },
    async poll() { await act(async () => { for (const callback of timers.values()) callback(); }); await flush(); },
    async resolvePrepare() {
      assert.ok(deferred, 'Expected a pending preview request');
      await act(async () => deferred?.resolve(response({ reply: deferred.reply }, 201)));
      await flush();
    },
    async cleanup() {
      await act(async () => root?.unmount());
      const remainingTimers = timers.size;
      dom.window.close();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      assert.equal(remainingTimers, 0, 'Inbox polling should stop on unmount');
    },
  };
}

test('Inbox DOM: load synthetic messages, preview the chosen source and explicitly send to its original target', async () => {
  const ui = await mount({ empty: true });
  try {
    await ui.click('[data-testid="inbox-load-demo"]');
    assert.equal(ui.requests.filter((request) => request.path === '/api/inbox/demo' && request.method === 'POST').length, 1);
    await ui.click('[data-testid="inbox-thread"][data-thread-id="thread-design"]');
    await ui.click('[data-testid="inbox-source"][data-message-id="message-design-first"]');
    const text = '  收到，先整理手机版布局。<img src=x onerror="alert(1)">\n';
    assert.equal(ui.query<HTMLTextAreaElement>('[data-testid="inbox-reply-input"]').maxLength, 4000);
    await ui.type(text);
    await ui.click('[data-testid="inbox-preview"]');
    const prepared = ui.requests.find((request) => request.path === '/api/inbox/replies' && request.method === 'POST');
    assert.ok(prepared);
    assert.equal(prepared.body.threadId, 'thread-design');
    assert.equal(prepared.body.sourceMessageId, 'message-design-first');
    assert.equal(prepared.body.content, text);
    assert.equal(typeof prepared.body.idempotencyKey, 'string');
    assert.ok(String(prepared.body.idempotencyKey).length > 0);
    assert.equal(ui.requests.filter((request) => request.path.endsWith('/send')).length, 0);
    assert.equal(ui.query('[data-testid="inbox-reply-preview"] .inbox-preview-target strong').textContent, '演示设计讨论组');
    assert.deepEqual([...ui.dom.window.document.querySelectorAll('.inbox-preview-target code')].map((node) => node.textContent), ['demo-work-wechat', 'synthetic-design-group']);
    assert.equal(ui.query('[data-testid="inbox-reply-preview"] .inbox-preview-source blockquote').textContent, fixture.threads[0].messages[0].text);
    assert.equal(ui.query('[data-testid="inbox-reply-preview"] .inbox-preview-content p').textContent, text);
    assert.equal(ui.dom.window.document.querySelector('img'), null);
    await ui.click('[data-testid="inbox-send"]');
    const sent = ui.requests.filter((request) => request.path.endsWith('/send'));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].path, '/api/inbox/replies/reply-1/send');
    assert.equal(sent[0].body.intent, 'send-reply');
    const reply = ui.snapshot().replies[0];
    assert.equal(reply.status, 'succeeded');
    assert.equal(reply.externalThreadId, 'synthetic-design-group');
    assert.equal(reply.sourceMessageId, 'message-design-first');
    assert.match(ui.query('[data-testid="inbox-reply-status"]').textContent ?? '', /成功|已发送/);
  } finally { await ui.cleanup(); }
});

test('Inbox DOM: a high-impact source requires a second explicit review before sending', async () => {
  const ui = await mount();
  try {
    await ui.click('[data-testid="inbox-thread"][data-thread-id="thread-purchase"]');
    await ui.click('[data-testid="inbox-source"][data-message-id="message-purchase"]');
    await ui.type('请先提供审批依据。');
    await ui.click('[data-testid="inbox-preview"]');
    assert.ok(ui.query<HTMLButtonElement>('[data-testid="inbox-send"]').disabled);
    await ui.click('[data-testid="inbox-send"]');
    assert.equal(ui.requests.filter((request) => request.path.endsWith('/send')).length, 0);
    const review = ui.query<HTMLInputElement>('[data-testid="inbox-review"]');
    assert.equal(review.checked, false);
    await ui.click('[data-testid="inbox-review"]');
    assert.equal(review.checked, true);
    assert.equal(ui.query<HTMLButtonElement>('[data-testid="inbox-send"]').disabled, false);
    await ui.click('[data-testid="inbox-send"]');
    const sent = ui.requests.find((request) => request.path.endsWith('/send'));
    assert.ok(sent);
    assert.deepEqual(sent.body, { intent: 'send-reply', confirmReview: true });
  } finally { await ui.cleanup(); }
});

test('Inbox DOM: switching threads ignores a late prepare response and keeps the new source', async () => {
  const ui = await mount({ deferPrepare: true });
  try {
    await ui.click('[data-testid="inbox-thread"][data-thread-id="thread-design"]');
    await ui.click('[data-testid="inbox-source"][data-message-id="message-design-first"]');
    await ui.type('这个旧预览不能出现在采购会话。');
    await ui.click('[data-testid="inbox-preview"]');
    await ui.click('[data-testid="inbox-thread"][data-thread-id="thread-purchase"]');
    await ui.resolvePrepare();
    assert.equal(ui.dom.window.document.querySelector('[data-testid="inbox-send"]'), null);
    assert.equal(ui.query<HTMLTextAreaElement>('[data-testid="inbox-reply-input"]').value, '');
    assert.doesNotMatch(ui.dom.window.document.body.textContent ?? '', /这个旧预览不能出现在采购会话/);
    await ui.click('[data-testid="inbox-source"][data-message-id="message-purchase"]');
    await ui.type('当前采购问题的回复。');
    await ui.click('[data-testid="inbox-preview"]');
    const prepared = ui.requests.filter((request) => request.path === '/api/inbox/replies').at(-1)!;
    assert.equal(prepared.body.threadId, 'thread-purchase');
    assert.equal(prepared.body.sourceMessageId, 'message-purchase');
    await ui.resolvePrepare();
    assert.equal(ui.requests.filter((request) => request.path.endsWith('/send')).length, 0);
  } finally { await ui.cleanup(); }
});

test('Inbox DOM: an unknown receipt is checked with GET and never automatically resent', async () => {
  const ui = await mount();
  try {
    await ui.click('[data-testid="inbox-thread"][data-thread-id="thread-design"]');
    await ui.click('[data-testid="inbox-source"][data-message-id="message-design-first"]');
    await ui.type('测试未知回执。');
    await ui.outcome('unknown');
    await ui.click('[data-testid="inbox-preview"]');
    await ui.click('[data-testid="inbox-send"]');
    assert.equal(ui.snapshot().replies[0].status, 'unknown');
    assert.match(ui.query('[data-testid="inbox-reply-status"]').textContent ?? '', /未知/);
    const before = ui.requests.length;
    await ui.click('[data-testid="inbox-refresh-status"]');
    await ui.poll();
    const following = ui.requests.slice(before);
    assert.ok(following.length >= 2, 'Manual refresh and mounted polling should each read the inbox');
    assert.ok(following.every((request) => request.method === 'GET' && request.path === '/api/inbox'));
    assert.equal(ui.requests.filter((request) => request.path.endsWith('/send')).length, 1);
    const sendButton = ui.dom.window.document.querySelector<HTMLButtonElement>('[data-testid="inbox-send"]');
    assert.ok(!sendButton || sendButton.disabled);
  } finally { await ui.cleanup(); }
});

test('Inbox DOM: a send transport failure queries persisted status without repeating the send', async () => {
  const ui = await mount({ failSendTransport: true });
  try {
    await ui.click('[data-testid="inbox-thread"][data-thread-id="thread-design"]');
    await ui.click('[data-testid="inbox-source"][data-message-id="message-design-first"]');
    await ui.type('网络断开后的结果需要核验。');
    await ui.click('[data-testid="inbox-preview"]');
    await ui.click('[data-testid="inbox-send"]');
    assert.equal(ui.requests.filter((request) => request.path.endsWith('/send')).length, 1);
    const afterFailure = ui.dom.window.document.querySelector<HTMLButtonElement>('[data-testid="inbox-send"]');
    assert.ok(!afterFailure || afterFailure.disabled, 'A lost response must not leave an enabled send action');
    const before = ui.requests.length;
    await ui.click('[data-testid="inbox-refresh-status"]');
    await ui.poll();
    assert.ok(ui.requests.slice(before).every((request) => request.method === 'GET' && request.path === '/api/inbox'));
    assert.equal(ui.snapshot().replies[0].status, 'unknown');
    assert.match(ui.query('[data-testid="inbox-reply-status"]').textContent ?? '', /未知/);
    assert.equal(ui.requests.filter((request) => request.path.endsWith('/send')).length, 1);
    const sendButton = ui.dom.window.document.querySelector<HTMLButtonElement>('[data-testid="inbox-send"]');
    assert.ok(!sendButton || sendButton.disabled);
  } finally { await ui.cleanup(); }
});

test('Inbox DOM: an explicit preview rejection keeps the original text editable', async () => {
  const ui = await mount({ rejectPrepare: true });
  try {
    await ui.click('[data-testid="inbox-source"][data-message-id="message-design-first"]');
    await ui.type('  这条草稿保留原样。\n');
    await ui.click('[data-testid="inbox-preview"]');
    const field = ui.query<HTMLTextAreaElement>('[data-testid="inbox-reply-input"]');
    assert.equal(field.value, '  这条草稿保留原样。\n');
    assert.equal(field.disabled, false);
    assert.match(ui.dom.window.document.body.textContent ?? '', /预览未创建/);
    assert.equal(ui.dom.window.document.querySelector('[data-testid="inbox-refresh-status"]'), null);
    await ui.type('修改后的内容。');
    assert.equal(ui.query<HTMLButtonElement>('[data-testid="inbox-preview"]').disabled, false);
    assert.equal(ui.requests.filter((request) => request.path.endsWith('/send')).length, 0);
  } finally { await ui.cleanup(); }
});
