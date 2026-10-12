import { useEffect, useRef, useState } from 'react';
import { Activity, ArrowUpRight, ChevronDown, ChevronUp, Clock3, Folder, Layers3, LoaderCircle, Radio, RefreshCw, ShieldCheck, TriangleAlert, WifiOff } from 'lucide-react';
import type { TaskActivity as ActivityEntry, TaskActivityPage, TaskFeedItem, TaskFeedPage, TaskFeedScope, TaskStatus } from '../shared/types.ts';

type Connection = 'connecting' | 'connected' | 'offline';
const statusLabels: Record<TaskStatus, string> = {
  queued: '等待执行', running: '正在执行', awaiting_approval: '等待审批', cancelling: '正在停止',
  completed: '已完成', cancelled: '已取消', failed: '执行失败', unknown: '结果待核对',
};
const active = new Set<TaskStatus>(['queued', 'running', 'awaiting_approval', 'cancelling', 'unknown']);
const pageSize = 20;
async function read<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `读取失败（${response.status}）`);
  return body as T;
}
function problem(error: unknown) { return error instanceof Error ? error.message : '暂时无法读取活动。'; }
function duration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  return `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分`;
}
function timestamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间不可用' : new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date);
}
function newer(incoming: TaskFeedPage, previous: TaskFeedPage | null) {
  if (!previous) return true;
  const split = (revision: string) => { const index = revision.lastIndexOf(':'); return [revision.slice(0, index), Number(revision.slice(index + 1))] as const; };
  const [incomingEpoch, incomingSeq] = split(incoming.revision);
  const [previousEpoch, previousSeq] = split(previous.revision);
  if (incomingEpoch === previousEpoch && Number.isFinite(incomingSeq) && Number.isFinite(previousSeq) && incomingSeq !== previousSeq) return incomingSeq > previousSeq;
  return Date.parse(incoming.generatedAt) >= Date.parse(previous.generatedAt);
}
function mergeById(first: TaskFeedItem[], tail: TaskFeedItem[]) {
  const ids = new Set(first.map((item) => item.id));
  return [...first, ...tail.filter((item) => !ids.has(item.id))];
}

export default function TaskActivity({ onOpenSession, online }: {
  onOpenSession: (sessionId: string, taskId: string) => void; online: boolean;
}) {
  const [scope, setScope] = useState<TaskFeedScope>('active');
  return <section className="activity-page" data-testid="task-feed" aria-label="真实任务运行动态">
    <div className="activity-heading"><div><div className="activity-eyebrow"><Radio size={14} /> LIVE WORKSPACE</div><h1>运行动态<span>每一步，有迹可循。</span></h1><p>查看 Codex AppServer 的实际任务、原生审批与最近活动。</p></div><span className="badge available">真实执行记录</span></div>
    <div className="activity-tabs" role="group" aria-label="任务范围"><button data-testid="feed-scope-active" className={scope === 'active' ? 'selected' : ''} aria-pressed={scope === 'active'} onClick={() => setScope('active')}><Activity size={16} />进行中</button><button data-testid="feed-scope-history" className={scope === 'history' ? 'selected' : ''} aria-pressed={scope === 'history'} onClick={() => setScope('history')}><Clock3 size={16} />历史任务</button></div>
    <Feed key={scope} scope={scope} online={online} onOpenSession={onOpenSession} />
  </section>;
}

function Feed({ scope, online, onOpenSession }: {
  scope: TaskFeedScope; online: boolean; onOpenSession: (sessionId: string, taskId: string) => void;
}) {
  const [page, setPage] = useState<TaskFeedPage | null>(null);
  const [items, setItems] = useState<TaskFeedItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [error, setError] = useState('');
  const [pagingError, setPagingError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [project, setProject] = useState('all');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [now, setNow] = useState(Date.now);
  const currentPage = useRef<TaskFeedPage | null>(null);
  const olderItems = useRef<TaskFeedItem[]>([]);
  const historyExpanded = useRef(false);
  const nextCursor = useRef<string | null>(null);
  const paging = useRef(false);
  const generation = useRef(0);
  const pageController = useRef<AbortController | null>(null);
  const connected = online && connection === 'connected';

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const epoch = ++generation.current;
    let receivedSnapshot = false;
    setConnection(online ? 'connecting' : 'offline');
    setError('');
    function accept(feed: TaskFeedPage, fromStream: boolean) {
      if (controller.signal.aborted || epoch !== generation.current || feed.scope !== scope || !newer(feed, currentPage.current)) return;
      if (fromStream) receivedSnapshot = true;
      if (scope === 'history' && historyExpanded.current && currentPage.current) {
        olderItems.current = mergeById(currentPage.current.items, olderItems.current).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      }
      currentPage.current = feed;
      setPage(feed);
      if (scope !== 'history') olderItems.current = [];
      // New first-page data wins; historical pages keep their stable IDs and order.
      const tail = scope === 'history' ? olderItems.current : [];
      setItems(mergeById(feed.items, tail));
      if (!historyExpanded.current) { nextCursor.current = feed.nextCursor; setCursor(feed.nextCursor); }
      setError('');
      if (fromStream) setConnection('connected');
    }
    void read<{ feed: TaskFeedPage }>(`/api/task-feed?scope=${scope}&limit=${pageSize}`, controller.signal).then(({ feed }) => {
      if (!receivedSnapshot) accept(feed, false);
    }).catch((reason) => { if (!controller.signal.aborted && !receivedSnapshot) setError(problem(reason)); });
    const source = new EventSource(`/api/task-feed/events?scope=${scope}&limit=${pageSize}`);
    source.onopen = () => { if (!controller.signal.aborted) setConnection('connecting'); };
    source.onerror = () => { if (!controller.signal.aborted) setConnection(navigator.onLine ? 'connecting' : 'offline'); };
    source.addEventListener('snapshot', (event: MessageEvent<string>) => {
      if (controller.signal.aborted) return;
      try { accept((JSON.parse(event.data) as { feed: TaskFeedPage }).feed, true); }
      catch { setConnection('connecting'); setError('活动快照暂不可读，请重新连接。'); }
    });
    return () => { controller.abort(); source.close(); pageController.current?.abort(); paging.current = false; };
  }, [scope, retry, online]);

  async function loadMore() {
    if (paging.current || !nextCursor.current) return;
    paging.current = true; setLoadingMore(true); setPagingError('');
    const epoch = generation.current;
    const controller = new AbortController();
    pageController.current = controller;
    try {
      const { feed } = await read<{ feed: TaskFeedPage }>(`/api/task-feed?scope=${scope}&limit=${pageSize}&cursor=${encodeURIComponent(nextCursor.current)}`, controller.signal);
      if (controller.signal.aborted || epoch !== generation.current || feed.scope !== scope) return;
      historyExpanded.current = scope === 'history';
      olderItems.current = mergeById(olderItems.current, feed.items);
      setItems((previous) => mergeById(previous, feed.items));
      nextCursor.current = feed.nextCursor; setCursor(feed.nextCursor);
    } catch (reason) { if (!controller.signal.aborted && epoch === generation.current) setPagingError(problem(reason)); }
    finally { if (!controller.signal.aborted && epoch === generation.current) { paging.current = false; setLoadingMore(false); } }
  }
  const projects = Array.from(new Map(items.filter((item) => item.project).map((item) => [item.project!.id, item.project!])).values());
  const visible = items.filter((item) => project === 'all' || (project === 'ungrouped' ? !item.project : item.project?.id === project));
  return <>
    <div className="activity-summary"><div><span>进行中</span><strong>{page?.activeCount ?? '—'}</strong></div><div><span>已结束</span><strong>{page?.historyCount ?? '—'}</strong></div><div className={`activity-connection ${connected ? '' : 'disconnected'}`} data-testid="feed-stream-state" data-stream-state={online ? connection : 'offline'}>{connected ? <Radio size={16} /> : !online || connection === 'offline' ? <WifiOff size={16} /> : <LoaderCircle size={16} className="spin" />}<span>{connected ? '活动已同步' : !online || connection === 'offline' ? '连接已断开' : '等待新快照'}<small>{connected ? '仅展示服务端记录的活动' : '显示最后记录，操作需恢复连接'}</small></span><button className="icon-button" aria-label="重新读取任务动态" onClick={() => setRetry((value) => value + 1)}><RefreshCw size={16} /></button></div></div>
    <div className="activity-filter"><label htmlFor="feed-project"><Folder size={16} />工作区</label><select id="feed-project" data-testid="feed-project-filter" value={project} onChange={(event) => setProject(event.target.value)}><option value="all">全部已载入工作区</option><option value="ungrouped">未分组</option>{projects.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select><span>已载入 {items.length} / {page?.total ?? '—'} 项</span></div>
    <p className="activity-boundary">工作区来自实际原生会话绑定，名称已脱敏。此处不包含模拟任务或合成收件箱；日志只展示有限的状态元数据。历时为本地观察时间，包含连接与等待核验；不代表官方精确运行耗时。</p>
    {error && <div className="error-banner" role="alert"><TriangleAlert size={16} /><span>{error}</span><button onClick={() => setRetry((value) => value + 1)}>重新读取</button></div>}
    {!page && !error ? <div className="activity-empty"><LoaderCircle size={25} className="spin" /><h2>正在读取实际任务</h2><p>收到快照后，执行动态会出现在这里。</p></div> : !visible.length && <div className="activity-empty"><Layers3 size={30} strokeWidth={1.3} /><h2>{project !== 'all' ? '已载入记录中，没有匹配任务' : scope === 'active' ? '此刻没有进行中的原生任务' : '还没有已结束的原生任务'}</h2><p>{project !== 'all' ? '切换工作区筛选，或继续载入更多任务。' : '从对话工作台开始 Codex AppServer 会话后，这里会记录真实的执行状态。'}</p></div>}
    <div className="activity-task-list">{visible.map((item) => {
      const elapsed = item.elapsedMs + (connected && active.has(item.status) && !item.endedAt ? Math.max(0, now - Date.parse(page?.generatedAt ?? '')) || 0 : 0);
      const quiet = active.has(item.status) && now - Date.parse(item.lastActivityAt) >= 60000;
      return <article key={item.id} className={`activity-task activity-task-${item.status}`} data-testid="feed-task" data-task-id={item.id}>
        <div className="activity-task-heading"><span className="activity-task-icon"><Activity size={20} /></span><div><span className="activity-project"><Folder size={12} />{item.project?.label ?? '未分组'}<i />{item.provider} · AppServer</span><h2>{item.title}</h2></div><span className={`activity-status ${item.status}`}>{item.stopUnconfirmed ? '停止状态未确认' : statusLabels[item.status]}</span></div>
        <div className="activity-current"><span className={`activity-indicator ${connected && item.status === 'running' ? 'live' : ''}`} /><strong>{item.currentActivity?.label ?? statusLabels[item.status]}</strong>{item.pendingApprovalCount > 0 && <span className="activity-approval-count"><ShieldCheck size={13} />{item.pendingApprovalCount} 项待处理审批</span>}</div>
        <dl className="activity-task-times"><div><dt>{item.endedAt ? '观察耗时' : '本地历时'}</dt><dd>{duration(elapsed)}{!connected && active.has(item.status) && <small>最后快照</small>}</dd></div><div><dt>最近活动</dt><dd><time dateTime={item.lastActivityAt}>{timestamp(item.lastActivityAt)}</time></dd></div><div><dt>{item.endedAt ? '结束时间' : '接收时间'}</dt><dd><time dateTime={item.endedAt ?? item.createdAt}>{timestamp(item.endedAt ?? item.createdAt)}</time></dd></div></dl>
        {quiet && <p className="activity-quiet"><Clock3 size={13} />最近 {duration(now - Date.parse(item.lastActivityAt))} 暂无新活动记录（至少 60 秒未记录事件）。{!connected ? '当前连接中断，无法确认最新状态。' : item.status === 'awaiting_approval' ? '任务正在等待审批。' : '这不代表任务已停止。'}</p>}
        {(item.status === 'unknown' || item.stopUnconfirmed) && <p className="activity-unknown"><TriangleAlert size={14} />执行结果尚未确认。请打开会话核对原生历史，不能重新提交同一任务。</p>}
        <div className="activity-task-actions"><button className="text-button" data-testid="feed-toggle-log" aria-expanded={expanded === item.id} aria-controls={`activity-log-${item.id}`} onClick={() => setExpanded(expanded === item.id ? null : item.id)}>{expanded === item.id ? <ChevronUp size={15} /> : <ChevronDown size={15} />}活动记录</button><button className="secondary-button" data-testid="feed-open-task" onClick={() => onOpenSession(item.sessionId, item.id)}>{item.pendingApprovalCount ? '打开会话核对审批' : item.status === 'unknown' || item.stopUnconfirmed ? '打开会话核对状态' : '打开会话'}<ArrowUpRight size={15} /></button></div>
        {expanded === item.id && <ActivityLog key={item.id} taskId={item.id} latestActivity={item.currentActivity} />}
      </article>;
    })}</div>
    {pagingError && <p className="activity-page-error" role="alert">{pagingError}</p>}
    {scope === 'history' && cursor && <button className="secondary-button activity-load-more" data-testid="feed-load-more" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? <LoaderCircle size={15} className="spin" /> : <ChevronDown size={15} />}载入更多任务</button>}
    {(scope === 'history' ? !!cursor : page?.truncated) && <p className="activity-boundary">{scope === 'history' ? '还有任务未载入，可继续分页查看。' : `实时视图显示最近 ${pageSize} 项进行中任务；其余任务可在原会话查看。`}</p>}
    <p className="activity-footer"><ShieldCheck size={13} />审批与停止均在原会话中核对，不从列表直接授权。这里不显示提示词、工具输出或隐藏推理。</p>
  </>;
}

function ActivityLog({ taskId, latestActivity }: { taskId: string; latestActivity: ActivityEntry | null }) {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [page, setPage] = useState<TaskActivityPage | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const nextBefore = useRef<number | null>(null);
  const loadingOlder = useRef(false);
  const initialized = useRef(false);
  const olderController = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const retainedFrom = useRef<number | null>(null);
  const currentActivity = useRef(latestActivity);
  currentActivity.current = latestActivity;
  function merge(previous: ActivityEntry[], incoming: ActivityEntry[]) {
    const map = new Map(previous.map((entry) => [entry.seq, entry]));
    for (const entry of incoming) map.set(entry.seq, entry);
    const latest = currentActivity.current;
    const existing = latest ? map.get(latest.seq) : undefined;
    if (latest && latest.seq > 0 && ((existing && Date.parse(latest.at) >= Date.parse(existing.at)) || (!existing && latest.seq > Math.max(0, ...map.keys())))) map.set(latest.seq, latest);
    return [...map.values()].filter((entry) => retainedFrom.current === null || entry.seq >= retainedFrom.current).sort((a, b) => b.seq - a.seq).slice(0, 200);
  }
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; olderController.current?.abort(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void read<{ activity: TaskActivityPage }>(`/api/task-feed/${encodeURIComponent(taskId)}/activity?limit=30`, controller.signal).then(({ activity }) => {
      if (controller.signal.aborted || activity.taskId !== taskId) return;
      retainedFrom.current = activity.retainedFrom;
      setPage(activity); setEntries((previous) => merge(previous, activity.items));
      // Preserve a deeper loaded cursor; the newest page must not move it forward.
      if (!initialized.current) { nextBefore.current = activity.nextBefore; initialized.current = true; }
      if (nextBefore.current !== null && activity.retainedFrom !== null && nextBefore.current <= activity.retainedFrom) nextBefore.current = null;
      setError('');
    }).catch((reason) => { if (!controller.signal.aborted) setError(problem(reason)); });
    return () => controller.abort();
  }, [taskId, latestActivity?.seq, retry]);
  useEffect(() => {
    setEntries((previous) => previous.length ? merge(previous, []) : previous);
  }, [latestActivity?.seq, latestActivity?.at, latestActivity?.label]);
  async function more() {
    if (loadingOlder.current || nextBefore.current === null) return;
    const controller = new AbortController(); olderController.current = controller;
    loadingOlder.current = true; setLoading(true); setError('');
    try {
      const { activity } = await read<{ activity: TaskActivityPage }>(`/api/task-feed/${encodeURIComponent(taskId)}/activity?limit=30&before=${nextBefore.current}`, controller.signal);
      if (controller.signal.aborted || !alive.current || activity.taskId !== taskId) return;
      nextBefore.current = activity.nextBefore;
      setEntries((previous) => merge(previous, activity.items));
    } catch (reason) { if (!controller.signal.aborted && alive.current) setError(problem(reason)); }
    finally { if (!controller.signal.aborted && alive.current) { loadingOlder.current = false; setLoading(false); } }
  }
  return <div id={`activity-log-${taskId}`} className="activity-log" data-testid="activity-log" aria-label="脱敏活动记录"><div className="activity-log-label">有限活动记录 <span>新 → 旧 · 仅状态元数据</span></div>{error && <p role="alert">{error}<button className="text-button" onClick={() => setRetry((value) => value + 1)}>重新读取</button></p>}{!page && !error && <p>正在读取记录…</p>}<ol>{entries.map((entry) => <li key={entry.seq} data-activity-seq={entry.seq}><span>#{entry.seq}</span><strong>{entry.label}</strong><time dateTime={entry.at}>{timestamp(entry.at)}</time></li>)}</ol>{page && !entries.length && <p>此任务尚无活动元数据。</p>}{nextBefore.current !== null && <button className="text-button" data-testid="activity-load-more" disabled={loading} onClick={() => void more()}>{loading ? '正在读取…' : '读取更早活动'}</button>}{page?.truncated && <p className="activity-log-retention">仅保留最近的有限活动；更早记录已不在此日志中。</p>}</div>;
}
