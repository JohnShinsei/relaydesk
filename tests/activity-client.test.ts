import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import TaskActivity from '../client/TaskActivity.tsx';
import type { TaskActivity as ActivityRecord, TaskActivityPage, TaskFeedItem, TaskFeedPage, TaskFeedScope } from '../shared/types.ts';

const timestamp = '2026-10-12T12:00:00.000Z';
function item(id: string, overrides: Partial<TaskFeedItem> = {}): TaskFeedItem {
  return {
    id, sessionId: `session-${id}`, adapterId: 'codex-app-server', provider: 'Codex', title: `任务 ${id}`, project: null,
    status: 'running', createdAt: timestamp, startedAt: timestamp, elapsedMs: 1500, lastActivityAt: timestamp,
    currentActivity: { seq: 1, at: timestamp, kind: 'reasoning', label: '正在分析' }, stopUnconfirmed: false,
    pendingApprovalCount: 0, pendingApprovals: [], ...overrides,
  };
}
function feed(scope: TaskFeedScope, items: TaskFeedItem[], overrides: Partial<TaskFeedPage> = {}): TaskFeedPage {
  return {
    scope, items, total: items.length, activeCount: scope === 'active' ? items.length : 0, historyCount: scope === 'history' ? items.length : 0,
    truncated: false, nextCursor: null, generatedAt: timestamp, revision: 'test-epoch:1', ...overrides,
  };
}
function activity(taskId: string, seqs: number[], overrides: Partial<TaskActivityPage> = {}): TaskActivityPage {
  const items: ActivityRecord[] = seqs.map((seq) => ({ seq, at: timestamp, kind: 'reasoning', label: '正在分析' }));
  return { taskId, items, nextBefore: null, retainedFrom: Math.min(...seqs), latestSeq: Math.max(...seqs), truncated: false, generatedAt: timestamp, ...overrides };
}

async function mount(options: {
  feeds?: TaskFeedPage[]; activities?: TaskActivityPage[];
  defer?: (url: URL) => boolean;
} = {}) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://127.0.0.1:4317/' });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const requests: { url: URL; path: string; method: string }[] = [];
  const pending: { url: URL; resolve: (response: Response) => void; resolved: boolean }[] = [];
  const opened: { sessionId: string; taskId: string }[] = [];
  const sources: FakeEventSource[] = [];
  const feeds = new Map((options.feeds ?? []).map((page) => [`${page.scope}/`, page]));
  const activities = new Map((options.activities ?? []).map((page) => [`${page.taskId}/`, page]));
  const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  const payload = (page: TaskFeedPage | TaskActivityPage) => 'scope' in page ? { feed: page } : { activity: page };
  let root: Root | undefined;

  class FakeEventSource {
    url: string;
    closed = false;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    listeners = new Map<string, (event: { data: string }) => void>();
    constructor(url: string) {
      this.url = url;
      sources.push(this);
      queueMicrotask(() => { if (!this.closed) this.onopen?.(); });
    }
    addEventListener(name: string, handler: (event: { data: string }) => void) { this.listeners.set(name, handler); }
    close() { this.closed = true; }
    // Ignore closed deliberately: consumers must reject stale queued events themselves.
    snapshot(page: TaskFeedPage) { this.listeners.get('snapshot')?.({ data: JSON.stringify({ feed: page }) }); }
  }

  const globals: Record<string, unknown> = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, EventSource: FakeEventSource, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (input: string, init?: RequestInit) => {
      const path = String(input);
      const url = new URL(path, dom.window.location.href);
      const method = init?.method ?? 'GET';
      requests.push({ path, url, method });
      if (method !== 'GET') return response({ error: '动态面板只应读取状态' }, 405);
      if (options.defer?.(url)) return new Promise<Response>((resolve) => pending.push({ url, resolve, resolved: false }));
      if (url.pathname === '/api/task-feed') {
        const scope = url.searchParams.get('scope') ?? 'active';
        const page = feeds.get(`${scope}/${url.searchParams.get('cursor') ?? ''}`);
        return response({ feed: page ?? feed(scope as TaskFeedScope, []) });
      }
      const match = /^\/api\/task-feed\/([^/]+)\/activity$/.exec(url.pathname);
      if (match) {
        const page = activities.get(`${decodeURIComponent(match[1])}/${url.searchParams.get('before') ?? ''}`);
        if (page) return response({ activity: page });
      }
      return response({ error: `未配置的测试请求 ${method} ${path}` }, 404);
    },
  };
  for (const [key, value] of Object.entries(globals)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollIntoView', { value() {} });
  const flush = async () => { await act(async () => { await new Promise<void>((resolve) => setImmediate(resolve)); }); };
  await act(async () => {
    const { createRoot } = await import('react-dom/client');
    root = createRoot(dom.window.document.getElementById('root')!);
    root.render(createElement(TaskActivity, { online: true, onOpenSession: (sessionId: string, taskId: string) => opened.push({ sessionId, taskId }) }));
  });
  await flush();
  const query = <T extends Element = HTMLElement>(selector: string) => {
    const node = dom.window.document.querySelector<T>(selector);
    assert.ok(node, `Expected DOM element: ${selector}`);
    return node;
  };
  const click = async (selector: string) => { await act(async () => query<HTMLElement>(selector).click()); await flush(); };
  return {
    dom, requests, sources, opened, query, click, flush,
    taskIds() { return [...dom.window.document.querySelectorAll('[data-testid="feed-task"]')].map((card) => card.getAttribute('data-task-id')); },
    logSeqs() { return [...dom.window.document.querySelectorAll('[data-testid="activity-log"] [data-activity-seq]')].map((row) => Number(row.getAttribute('data-activity-seq'))); },
    setFeed(page: TaskFeedPage, cursor = '') { feeds.set(`${page.scope}/${cursor}`, page); },
    setActivity(page: TaskActivityPage, before = '') { activities.set(`${page.taskId}/${before}`, page); },
    async selectProject(value: string) {
      await act(async () => {
        const select = query<HTMLSelectElement>('[data-testid="feed-project-filter"]');
        select.value = value;
        select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      });
      await flush();
    },
    async publish(page: TaskFeedPage, source = sources.at(-1)!) { assert.ok(source, 'Expected a live feed stream'); await act(async () => source.snapshot(page)); await flush(); },
    async resolveGet(match: (url: URL) => boolean, page: TaskFeedPage | TaskActivityPage) {
      const request = pending.find((candidate) => !candidate.resolved && match(candidate.url));
      assert.ok(request, 'Expected matching deferred GET');
      request.resolved = true;
      await act(async () => request.resolve(response(payload(page))));
      await flush();
    },
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

test('Task activity DOM: real project metadata filters correctly and opens the exact task without exposing payloads', async () => {
  const project = { id: 'project-relaydesk', label: 'RelayDesk 项目' };
  const assigned = { ...item('assigned', { project }), prompt: 'DO_NOT_SHOW_PROMPT', hiddenReasoning: 'DO_NOT_SHOW_HIDDEN_REASONING' };
  const ungrouped = item('ungrouped', { title: '<img src=x onerror="alert(1)">' });
  const ui = await mount({ feeds: [feed('active', [assigned, ungrouped])] });
  try {
    assert.deepEqual(ui.taskIds(), ['assigned', 'ungrouped']);
    assert.match(ui.query('[data-task-id="assigned"]').textContent ?? '', /RelayDesk 项目/);
    assert.match(ui.query('[data-task-id="ungrouped"]').textContent ?? '', /未分组/);
    assert.doesNotMatch(ui.dom.window.document.body.textContent ?? '', /DO_NOT_SHOW_PROMPT|DO_NOT_SHOW_HIDDEN_REASONING/);
    assert.equal(ui.dom.window.document.querySelector('[data-testid="feed-task"] img'), null);
    await ui.selectProject(project.id);
    assert.deepEqual(ui.taskIds(), ['assigned']);
    await ui.click('[data-task-id="assigned"] [data-testid="feed-open-task"]');
    assert.deepEqual(ui.opened, [{ sessionId: 'session-assigned', taskId: 'assigned' }]);
    await ui.selectProject('ungrouped');
    assert.deepEqual(ui.taskIds(), ['ungrouped']);
    await ui.click('[data-task-id="ungrouped"] [data-testid="feed-open-task"]');
    assert.deepEqual(ui.opened.at(-1), { sessionId: 'session-ungrouped', taskId: 'ungrouped' });
    await ui.selectProject('all');
    assert.deepEqual(ui.taskIds(), ['assigned', 'ungrouped']);
    assert.ok(ui.requests.every((request) => request.method === 'GET'));
    assert.ok(ui.requests.filter((request) => request.url.pathname === '/api/task-feed').every((request) => request.url.searchParams.get('limit') === '20'));
  } finally { await ui.cleanup(); }
});

test('Task activity DOM: a fresh SSE snapshot supersedes a late initial GET and reconnect awaits evidence', async () => {
  const ui = await mount({ defer: (url) => url.pathname === '/api/task-feed' });
  try {
    assert.equal(ui.sources.length, 1, 'The event stream must start while the initial GET is pending');
    const source = ui.sources[0];
    const latest = feed('active', [item('latest', { title: 'SSE 最新任务' })], { revision: 'test-epoch:2', generatedAt: '2026-10-12T12:00:01.000Z' });
    await ui.publish(latest, source);
    assert.deepEqual(ui.taskIds(), ['latest']);
    await ui.resolveGet((url) => url.searchParams.get('scope') === 'active', feed('active', [item('stale-get')]));
    assert.deepEqual(ui.taskIds(), ['latest']);
    await ui.publish(feed('active', [item('older-revision')], { generatedAt: '2026-10-12T12:00:02.000Z' }), source);
    assert.deepEqual(ui.taskIds(), ['latest'], 'An older revision in the same server epoch cannot replace newer evidence');
    assert.equal(ui.query('[data-testid="feed-stream-state"]').getAttribute('data-stream-state'), 'connected');
    await act(async () => source.onerror?.());
    assert.notEqual(ui.query('[data-testid="feed-stream-state"]').getAttribute('data-stream-state'), 'connected');
    await act(async () => source.onopen?.());
    assert.notEqual(ui.query('[data-testid="feed-stream-state"]').getAttribute('data-stream-state'), 'connected');
    await ui.publish(latest, source);
    assert.equal(ui.query('[data-testid="feed-stream-state"]').getAttribute('data-stream-state'), 'connected');
  } finally { await ui.cleanup(); }
});

test('Task activity DOM: switching scopes ignores old snapshots and deferred responses from either stale read', async () => {
  const ui = await mount({ defer: (url) => url.pathname === '/api/task-feed' });
  try {
    const oldSource = ui.sources[0];
    await ui.click('[data-testid="feed-scope-history"]');
    assert.ok(oldSource.closed);
    assert.equal(new URL(ui.sources.at(-1)!.url, ui.dom.window.location.href).searchParams.get('scope'), 'history');
    const latest = feed('history', [item('history-current', { status: 'completed' })], { revision: 'test-epoch:3' });
    await ui.publish(latest);
    await ui.publish(feed('active', [item('stale-stream')]), oldSource);
    await ui.resolveGet((url) => url.searchParams.get('scope') === 'active', feed('active', [item('stale-active-get')]));
    await ui.resolveGet((url) => url.searchParams.get('scope') === 'history', feed('history', [item('stale-history-get', { status: 'completed' })]));
    assert.deepEqual(ui.taskIds(), ['history-current']);
    assert.equal(ui.query('[data-testid="feed-scope-history"]').getAttribute('aria-pressed'), 'true');
  } finally { await ui.cleanup(); }
});

test('Task activity DOM: history pages deduplicate task IDs and preserve older pages after a new snapshot', async () => {
  const a = item('a', { title: 'A 原始标题', status: 'completed' });
  const b = item('b', { status: 'completed' });
  const c = item('c', { status: 'completed' });
  const ui = await mount({ feeds: [feed('active', []), feed('history', [a, b], { total: 3, historyCount: 3, truncated: true, nextCursor: 'older-page' })] });
  try {
    ui.setFeed(feed('history', [{ ...a, title: 'A 过期分页副本' }, c], { total: 3, historyCount: 3 }), 'older-page');
    await ui.click('[data-testid="feed-scope-history"]');
    await ui.click('[data-testid="feed-load-more"]');
    assert.deepEqual(ui.taskIds(), ['a', 'b', 'c']);
    assert.equal(ui.requests.filter((request) => request.url.searchParams.get('cursor') === 'older-page').length, 1);
    await ui.publish(feed('history', [item('d', { status: 'completed' }), { ...a, title: 'A 最新标题' }], { total: 4, historyCount: 4, truncated: true, nextCursor: 'older-page', revision: 'test-epoch:2' }));
    assert.deepEqual(new Set(ui.taskIds()), new Set(['d', 'a', 'b', 'c']));
    assert.equal(ui.taskIds().length, 4);
    assert.ok(ui.taskIds().includes('b'), 'An item shifted out of the head page must survive even if it was not in a loaded older page');
    assert.match(ui.query('[data-task-id="a"]').textContent ?? '', /A 最新标题/);
    assert.doesNotMatch(ui.query('[data-task-id="a"]').textContent ?? '', /A 原始标题|A 过期分页副本/);
    assert.equal(ui.dom.window.document.querySelector('[data-testid="feed-load-more"]:not(:disabled)'), null, 'A head snapshot must not reset the exhausted older-page cursor');
    assert.doesNotMatch(ui.dom.window.document.body.textContent ?? '', /还有任务未载入/);
  } finally { await ui.cleanup(); }
});

test('Task activity DOM: bounded log pages deduplicate sequence IDs and stale task or scope reads cannot replace the open log', async () => {
  const a = item('log-a');
  const b = item('log-b');
  const ui = await mount({
    feeds: [feed('active', [a, b]), feed('history', [])],
    activities: [activity(a.id, [10, 9], { nextBefore: 9, retainedFrom: 1, truncated: true })],
    defer: (url) => url.pathname.endsWith('/log-b/activity') || (url.pathname.endsWith('/log-a/activity') && url.searchParams.get('before') === '7'),
  });
  try {
    ui.setActivity(activity(a.id, [9, 8, 7], { nextBefore: 7, retainedFrom: 1, latestSeq: 10, truncated: true }), '9');
    await ui.click('[data-task-id="log-a"] [data-testid="feed-toggle-log"]');
    assert.deepEqual(ui.logSeqs(), [10, 9]);
    await ui.click('[data-testid="activity-load-more"]');
    assert.deepEqual(ui.logSeqs(), [10, 9, 8, 7]);
    await ui.click('[data-testid="activity-load-more"]');
    await ui.click('[data-task-id="log-b"] [data-testid="feed-toggle-log"]');
    await ui.resolveGet((url) => url.pathname.endsWith('/log-a/activity') && url.searchParams.get('before') === '7', activity(a.id, [6, 5], { latestSeq: 10 }));
    assert.equal(ui.dom.window.document.querySelector('[data-activity-seq="5"]'), null);
    await ui.resolveGet((url) => url.pathname.endsWith('/log-b/activity'), activity(b.id, [40, 39]));
    assert.deepEqual(ui.logSeqs(), [40, 39]);
    await ui.click('[data-task-id="log-b"] [data-testid="feed-toggle-log"]');
    await ui.click('[data-task-id="log-b"] [data-testid="feed-toggle-log"]');
    await ui.click('[data-testid="feed-scope-history"]');
    await ui.resolveGet((url) => url.pathname.endsWith('/log-b/activity'), activity(b.id, [42, 41]));
    assert.equal(ui.dom.window.document.querySelector('[data-testid="activity-log"]'), null);
    assert.deepEqual(ui.taskIds(), []);
    const logRequests = ui.requests.filter((request) => request.url.pathname.endsWith('/activity'));
    assert.ok(logRequests.length >= 5);
    assert.ok(logRequests.every((request) => request.method === 'GET' && request.url.searchParams.get('limit') === '30'));
  } finally { await ui.cleanup(); }
});

test('Task activity DOM: a live log stays within retention and does not reopen an exhausted older cursor', async () => {
  const seqs = (high: number, low: number) => Array.from({ length: high - low + 1 }, (_, index) => high - index);
  const current = item('retained', { currentActivity: { seq: 200, at: timestamp, kind: 'answering', label: '正在生成回复' } });
  const ui = await mount({
    feeds: [feed('active', [current])],
    activities: [activity(current.id, seqs(200, 171), { nextBefore: 171, retainedFrom: 1, latestSeq: 200 })],
  });
  try {
    for (const before of [171, 141, 111, 81, 51, 21]) {
      const low = Math.max(1, before - 30);
      ui.setActivity(activity(current.id, seqs(before - 1, low), { nextBefore: low === 1 ? null : low, retainedFrom: 1, latestSeq: 200 }), String(before));
    }
    await ui.click('[data-task-id="retained"] [data-testid="feed-toggle-log"]');
    for (let page = 0; page < 6; page++) await ui.click('[data-testid="activity-load-more"]');
    assert.deepEqual(ui.logSeqs(), seqs(200, 1));
    assert.ok(!ui.dom.window.document.querySelector('[data-testid="activity-load-more"]:not(:disabled)'));
    ui.setActivity(activity(current.id, seqs(201, 172), { nextBefore: 172, retainedFrom: 2, latestSeq: 201, truncated: true }));
    await ui.publish(feed('active', [{ ...current, currentActivity: { seq: 201, at: timestamp, kind: 'answering', label: '正在生成回复' } }], { revision: 'test-epoch:2' }));
    assert.deepEqual(ui.logSeqs(), seqs(201, 2));
    assert.equal(ui.logSeqs().length, 200);
    assert.ok(!ui.dom.window.document.querySelector('[data-testid="activity-load-more"]:not(:disabled)'), 'A fresh head page must preserve an exhausted older cursor');
    const logRequests = ui.requests.filter((request) => request.url.pathname.endsWith('/activity'));
    assert.equal(logRequests.length, 8);
    assert.ok(logRequests.every((request) => request.url.searchParams.get('limit') === '30'));
    await ui.publish(feed('active', [], { revision: 'test-epoch:3' }));
    assert.deepEqual(ui.taskIds(), []);
    assert.equal(ui.dom.window.document.querySelector('[data-testid="activity-log"]'), null);
  } finally { await ui.cleanup(); }
});

test('Task activity DOM: active view is explicitly bounded and coalesced activity updates the open log without refetching', async () => {
  const current = item('coalesced', { currentActivity: { seq: 50, at: timestamp, kind: 'answering', label: '正在生成回复' } });
  const page = feed('active', [current], { total: 25, activeCount: 25, truncated: true, nextCursor: 'unused-active-cursor' });
  const initialLog = activity(current.id, [50, 49]);
  initialLog.items[0].at = '2026-10-12T12:01:00.000Z';
  const ui = await mount({ feeds: [page], activities: [initialLog] });
  try {
    assert.equal(ui.dom.window.document.querySelector('[data-testid="feed-load-more"]'), null);
    assert.match(ui.dom.window.document.body.textContent ?? '', /实时视图显示最近 20 项/);
    await ui.click('[data-testid="feed-toggle-log"]');
    assert.equal(ui.query('[data-activity-seq="50"] time').getAttribute('dateTime'), '2026-10-12T12:01:00.000Z', 'An older same-sequence feed timestamp must not overwrite the newer log GET');
    const readsBefore = ui.requests.filter((request) => request.url.pathname.endsWith('/activity')).length;
    const updatedAt = '2026-10-12T12:03:00.000Z';
    await ui.publish({ ...page, generatedAt: updatedAt, revision: 'test-epoch:2', items: [{ ...current, lastActivityAt: updatedAt, currentActivity: { ...current.currentActivity!, at: updatedAt } }] });
    assert.equal(ui.query('[data-activity-seq="50"] time').getAttribute('dateTime'), updatedAt);
    assert.equal(ui.requests.filter((request) => request.url.pathname.endsWith('/activity')).length, readsBefore);
    await ui.publish(feed('active', [], { revision: 'test-epoch:3', generatedAt: updatedAt }));
    assert.deepEqual(ui.taskIds(), []);
    assert.equal(ui.dom.window.document.querySelector('[data-testid="activity-log"]'), null);
  } finally { await ui.cleanup(); }
});


test('Task activity DOM: a legacy status fallback never invents an activity log entry', async () => {
  const legacy = item('legacy', { currentActivity: { seq: 0, at: timestamp, kind: 'completed', label: '任务已完成' }, status: 'completed' });
  const ui = await mount({ feeds: [feed('active', []), feed('history', [legacy])], activities: [activity(legacy.id, [], { retainedFrom: null, latestSeq: 0 })] });
  try {
    await ui.click('[data-testid="feed-scope-history"]');
    await ui.click('[data-testid="feed-toggle-log"]');
    assert.deepEqual(ui.logSeqs(), []);
    assert.match(ui.query('[data-testid="activity-log"]').textContent ?? '', /尚无活动元数据/);
  } finally { await ui.cleanup(); }
});
