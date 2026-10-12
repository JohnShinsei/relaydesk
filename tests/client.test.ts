import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import App from '../client/App.tsx';
import type { AdapterId, Bootstrap, Session, Task, TaskStatus } from '../shared/types.ts';

const timestamp = '2026-10-12T12:00:00.000Z';
const bootstrap: Bootstrap = {
  adapters: [
    { id: 'mock-codex', name: 'Codex 模拟适配器', description: '本地模拟', available: true, kind: 'mock' },
    { id: 'mock-claude', name: 'Claude 模拟适配器', description: '本地模拟', available: true, kind: 'mock' },
    { id: 'codex', name: 'Codex CLI', description: '未接入', available: false, kind: 'cli', reason: '尚未连接真实 CLI' },
    { id: 'claude', name: 'Claude Code', description: '未安装', available: false, kind: 'cli', reason: 'Claude Code CLI 未安装' },
  ],
  channels: [{ id: 'web', name: '本地网页', status: 'local', description: '仅本机访问' }],
  runtime: { mode: 'local', agent: 'test', gateway: 'local', version: '0.1.0' },
};

function makeSession(id: string, title = id, adapterId: AdapterId = 'mock-codex'): Session {
  return { id, title, adapterId, createdAt: timestamp, updatedAt: timestamp, messages: [], tasks: [] };
}

async function mount(options: { sessions?: Session[]; selected?: string; deferredId?: string; bootstrap?: Bootstrap } = {}) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://127.0.0.1:4317/' });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const globals: Record<string, unknown> = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const sessions = new Map((options.sessions ?? []).map((session) => [session.id, structuredClone(session)]));
  const requests: { path: string; method: string; body: Record<string, unknown> }[] = [];
  const sources: FakeEventSource[] = [];
  let resolveDeferred: ((response: Response) => void) | undefined;
  let root: Root | undefined;
  let taskCounter = 0;
  const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

  class FakeEventSource {
    url: string;
    closed = false;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    listeners = new Map<string, (event: { data: string }) => void>();
    constructor(url: string) {
      this.url = url;
      sources.push(this);
      queueMicrotask(() => {
        if (this.closed) return;
        this.onopen?.();
        const session = sessions.get(url.split('/')[3]);
        if (session) this.snapshot(session);
      });
    }
    addEventListener(name: string, handler: (event: { data: string }) => void) { this.listeners.set(name, handler); }
    close() { this.closed = true; }
    // Can deliberately deliver after close to exercise the client's stale-response guard.
    snapshot(session: Session) { this.listeners.get('snapshot')?.({ data: JSON.stringify({ session }) }); }
  }

  function publish(session: Session) {
    for (const source of sources) if (!source.closed && source.url.includes(`/sessions/${session.id}/`)) source.snapshot(session);
  }
  function transition(task: Task, status: TaskStatus) {
    task.status = status;
    task.events.push({ status, at: timestamp, detail: '测试适配器状态事件' });
  }
  globals.EventSource = FakeEventSource;
  globals.fetch = async (input: string, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    requests.push({ path, method, body });
    if (path === '/api/bootstrap') return response(options.bootstrap ?? bootstrap);
    if (path === '/api/sessions' && method === 'GET') return response({ sessions: [...sessions.values()].map((session) => ({ ...session, lastMessage: session.messages.at(-1)?.content ?? '', status: session.tasks.at(-1)?.status ?? 'idle' })) });
    if (path === '/api/sessions' && method === 'POST') {
      const session = makeSession(`created-${sessions.size}`, '新会话', body.adapterId as AdapterId);
      sessions.set(session.id, session);
      return response({ session }, 201);
    }
    const match = /^\/api\/sessions\/([^/]+)(\/tasks)?$/.exec(path);
    if (match) {
      if (method === 'GET' && match[1] === options.deferredId) {
        return new Promise<Response>((resolve) => { resolveDeferred = resolve; });
      }
      const session = sessions.get(match[1]);
      if (!session) return response({ error: '会话不存在。' }, 404);
      if (method === 'GET') return response({ session });
      if (match[2] && method === 'POST') {
        const task: Task = { id: `task-${++taskCounter}`, sessionId: session.id, adapterId: session.adapterId, prompt: String(body.prompt), mode: body.mode === 'approval-demo' ? 'approval-demo' : 'chat', status: 'queued', createdAt: timestamp, updatedAt: timestamp, events: [{ status: 'queued', at: timestamp, detail: '测试排队' }] };
        session.tasks.push(task);
        session.messages.push({ id: `message-${taskCounter}`, role: 'user', content: task.prompt, createdAt: timestamp, taskId: task.id });
        session.title = task.prompt;
        publish(session);
        return response({ task }, 202);
      }
    }
    const action = /^\/api\/tasks\/([^/]+)\/(approve|cancel)$/.exec(path);
    if (action) {
      for (const session of sessions.values()) {
        const task = session.tasks.find((item) => item.id === action[1]);
        if (task) { transition(task, action[2] === 'approve' ? 'running' : 'cancelled'); publish(session); return response({ task }); }
      }
    }
    return response({ error: `未配置的测试请求 ${method} ${path}` }, 404);
  };
  for (const [key, value] of Object.entries(globals)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollIntoView', { value() {} });
  Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: true }) });
  if (options.selected) dom.window.localStorage.setItem('relaydesk.selected-session', options.selected);
  const flush = async () => { await act(async () => { await new Promise<void>((resolve) => setImmediate(resolve)); }); };
  await act(async () => {
    const { createRoot } = await import('react-dom/client');
    root = createRoot(dom.window.document.getElementById('root')!);
    root.render(createElement(App));
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
      const field = query<HTMLTextAreaElement>('#message-input');
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value);
      field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  };
  return {
    dom, sessions, sources, requests, query, click, type, flush,
    async publish(session: Session) { await act(async () => publish(session)); await flush(); },
    async finish(session: Session, content = '模拟回复完成') {
      const task = session.tasks.at(-1)!;
      transition(task, 'completed');
      session.messages.push({ id: `${task.id}-reply`, role: 'assistant', content, createdAt: timestamp, taskId: task.id });
      await act(async () => publish(session)); await flush();
    },
    async resolveGet(session: Session) { await act(async () => resolveDeferred?.(response({ session }))); await flush(); },
    async cleanup() {
      await act(async () => root?.unmount());
      dom.window.close();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test('React DOM: choose mock provider, submit, stream completion and render text safely', async () => {
  const ui = await mount();
  try {
    assert.match(ui.dom.window.document.body.textContent ?? '', /模拟体验/);
    await ui.click('[data-adapter-id="mock-claude"]');
    await ui.type('帮我整理一个想法');
    await ui.click('[data-testid="send-message"]');
    const created = [...ui.sessions.values()][0];
    assert.equal(created.adapterId, 'mock-claude');
    assert.equal(created.tasks[0].prompt, '帮我整理一个想法');
    assert.equal(ui.query<HTMLTextAreaElement>('#message-input').disabled, true);
    const content = '第一行\n<img src=x onerror="alert(1)">';
    await ui.finish(created, content);
    assert.equal(ui.query('.message-assistant .message-content').textContent, content);
    assert.equal(ui.dom.window.document.querySelector('.message-content img'), null);
    assert.equal(ui.query<HTMLTextAreaElement>('#message-input').disabled, false);
    assert.equal(ui.query('[data-testid="task-status"]').getAttribute('data-status'), 'completed');
    assert.equal(ui.dom.window.localStorage.getItem('relaydesk.selected-session'), created.id);
  } finally { await ui.cleanup(); }
});

test('React DOM: discoverable approval demo pauses, approves and permits cancellation', async () => {
  const ui = await mount();
  try {
    await ui.click('.starter-card:nth-child(2)');
    assert.equal(ui.query('[data-testid="approval-demo"]').getAttribute('aria-pressed'), 'true');
    await ui.click('[data-testid="send-message"]');
    const session = [...ui.sessions.values()][0];
    const task = session.tasks[0];
    assert.equal(task.mode, 'approval-demo');
    task.status = 'awaiting_approval';
    task.approval = { title: '本地模拟计划', description: '批准后只继续本地演示。' };
    await ui.publish(session);
    assert.ok(ui.query('[aria-label="待审批任务"]'));
    await ui.click('[data-testid="approve-task"]');
    assert.equal(task.status, 'running');
    assert.ok(ui.requests.some((request) => request.path === `/api/tasks/${task.id}/approve`));
    await ui.click('.composer [data-testid="cancel-task"]');
    assert.equal(task.status, 'cancelled');
    assert.equal(ui.query('[data-testid="task-status"]').getAttribute('data-status'), 'cancelled');
    assert.equal(ui.query<HTMLTextAreaElement>('#message-input').disabled, false);
  } finally { await ui.cleanup(); }
});

test('React DOM: switching sessions closes old stream and ignores late snapshot', async () => {
  const a = makeSession('a', '会话 A');
  const b = makeSession('b', '会话 B', 'mock-claude');
  const ui = await mount({ sessions: [a, b], selected: 'a' });
  try {
    assert.equal(ui.query('.chat-heading h1').textContent, '会话 A');
    const oldStream = ui.sources[0];
    await ui.click('[data-testid="session-item"][data-session-id="b"]');
    assert.equal(oldStream.closed, true);
    await act(async () => oldStream.snapshot({ ...a, title: '不应该覆盖当前会话' }));
    await ui.flush();
    assert.equal(ui.query('.chat-heading h1').textContent, '会话 B');
    assert.equal(ui.query('[data-testid="active-stream-state"]').getAttribute('data-session-id'), 'b');
    const stream = ui.sources.at(-1)!;
    await act(async () => stream.onerror?.());
    assert.match(ui.dom.window.document.body.textContent ?? '', /正在重新连接/);
    await act(async () => { stream.onopen?.(); stream.snapshot({ ...b, title: '会话 B 已恢复' }); });
    assert.equal(ui.query('.chat-heading h1').textContent, '会话 B 已恢复');
    assert.equal(ui.query('[data-testid="active-stream-state"]').getAttribute('data-stream-state'), 'connected');
  } finally { await ui.cleanup(); }
});

test('React DOM: switching while initial GET is pending ignores its eventual response', async () => {
  const a = makeSession('a', '慢速会话 A');
  const b = makeSession('b', '当前会话 B');
  const ui = await mount({ sessions: [a, b], selected: 'a', deferredId: 'a' });
  try {
    await ui.click('[data-testid="session-item"][data-session-id="b"]');
    await ui.resolveGet(a);
    assert.equal(ui.query('.chat-heading h1').textContent, '当前会话 B');
    assert.equal(ui.sources.filter((source) => source.url.includes('/sessions/a/')).length, 0);
    assert.equal(ui.dom.window.localStorage.getItem('relaydesk.selected-session'), 'b');
  } finally { await ui.cleanup(); }
});

test('React DOM: unavailable saved session displays recovery and permits a new conversation', async () => {
  const ui = await mount({ selected: 'missing' });
  try {
    assert.match(ui.query('.session-error').textContent ?? '', /会话不存在/);
    assert.ok(ui.query<HTMLButtonElement>('[data-testid="send-message"]').disabled);
    await ui.click('.session-error .secondary-button');
    assert.equal(ui.requests.filter((request) => request.path === '/api/sessions/missing').length, 2);
    await ui.click('.session-error .text-button');
    assert.equal(ui.dom.window.localStorage.getItem('relaydesk.selected-session'), null);
    assert.equal(ui.dom.window.document.querySelector('.session-error'), null);
    await ui.type('新会话可以继续');
    await ui.click('[data-testid="send-message"]');
    assert.equal([...ui.sessions.values()][0].tasks[0].prompt, '新会话可以继续');
  } finally { await ui.cleanup(); }
});

test('React DOM: configured real Codex selects CLI, blocks approval demo and waits for cancellation', async () => {
  const configured: Bootstrap = {
    ...bootstrap,
    adapters: bootstrap.adapters.map((adapter) => adapter.id === 'codex'
      ? { ...adapter, available: true, reason: undefined, description: '官方 CLI 已配置，调用结果以任务状态为准。' }
      : adapter),
  };
  const ui = await mount({ bootstrap: configured });
  try {
    await ui.click('[data-testid="approval-demo"]');
    assert.equal(ui.query('[data-testid="approval-demo"]').getAttribute('aria-pressed'), 'true');
    await ui.click('[data-adapter-id="codex"]');
    assert.match(ui.query('[data-adapter-id="codex"]').textContent ?? '', /Codex · CLI/);
    assert.equal(ui.query('[data-testid="adapter-mode"]').textContent, '真实 · 只读');
    assert.equal(ui.dom.window.document.querySelector('[data-testid="approval-demo"]'), null);
    assert.equal(ui.dom.window.document.querySelectorAll('.starter-card').length, 1);
    assert.match(ui.query('[data-testid="adapter-notice"]').textContent ?? '', /本会话历史发送到官方 Codex/);
    assert.match(ui.query('[data-testid="adapter-notice"]').textContent ?? '', /按当前账户规则计费或计入额度/);
    assert.doesNotMatch(ui.query('[data-testid="adapter-notice"]').textContent ?? '', /不会调用真实 AI/);
    assert.match(ui.query('.execution-boundary').textContent ?? '', /不等同于完整的系统隔离/);
    await ui.type('请解释这个设计');
    await ui.click('[data-testid="send-message"]');
    const session = [...ui.sessions.values()][0];
    assert.equal(session.adapterId, 'codex');
    assert.equal(session.tasks[0].mode, 'chat');
    session.tasks[0].status = 'cancelling';
    await ui.publish(session);
    assert.equal(ui.query('[data-testid="task-status"]').getAttribute('data-status'), 'cancelling');
    assert.match(ui.query('.task-state p').textContent ?? '', /等待执行进程退出/);
    assert.ok(ui.query<HTMLButtonElement>('.composer [data-testid="cancel-task"]').disabled);
    assert.ok(ui.query<HTMLTextAreaElement>('#message-input').disabled);
    await ui.finish(session, '测试夹具中的真实模式结果；不代表真实连接已验证。');
    assert.equal(ui.query('.message-real').textContent, '真实 · 只读');
    assert.match(ui.query('.adapter-route').textContent ?? '', /Codex · CLI/);
    await ui.click('.nav-item:nth-child(2)');
    const codexCard = [...ui.dom.window.document.querySelectorAll('.integration-card')]
      .find((card) => card.querySelector('h3')?.textContent === 'Codex CLI');
    assert.equal(codexCard?.querySelector('.badge')?.textContent, '已配置 · CLI');
    assert.match(codexCard?.textContent ?? '', /不代表本轮调用已成功/);
  } finally { await ui.cleanup(); }
});

test('React DOM: disabled historical Codex retains real labels and cannot send', async () => {
  const history = makeSession('real-history', '历史 Codex 会话', 'codex');
  history.messages.push({ id: 'old-reply', role: 'assistant', content: '此前的回复', createdAt: timestamp, taskId: 'old-task' });
  const ui = await mount({ sessions: [history], selected: history.id });
  try {
    assert.equal(ui.query('[data-testid="adapter-mode"]').textContent, '真实 · 只读');
    assert.equal(ui.query('.message-real').textContent, '真实 · 只读');
    assert.equal(ui.dom.window.document.querySelector('[data-testid="approval-demo"]'), null);
    assert.match(ui.query('.composer-area .connection-notice').textContent ?? '', /尚未连接真实 CLI/);
    await ui.type('当前不应发送');
    assert.ok(ui.query<HTMLButtonElement>('[data-testid="send-message"]').disabled);
    await ui.click('[data-testid="send-message"]');
    assert.equal(ui.requests.filter((request) => request.method === 'POST').length, 0);
    await ui.click('[data-testid="new-session"]');
    assert.equal(ui.query('[data-testid="adapter-mode"]').textContent, '模拟');
    assert.ok(ui.query('[data-testid="approval-demo"]'));
    assert.ok(ui.query<HTMLButtonElement>('[data-adapter-id="codex"]').disabled);
    assert.ok(ui.query<HTMLButtonElement>('[data-adapter-id="claude"]').disabled);
    assert.match(ui.query('[data-adapter-id="claude"]').textContent ?? '', /Claude Code CLI 未安装/);
  } finally { await ui.cleanup(); }
});
