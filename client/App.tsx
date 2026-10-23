import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, ReactNode } from 'react';
import {
  Activity, ArrowDown, ArrowRight, ArrowUp, AudioLines, Bot, Check, CheckCheck,
  ChevronRight, Circle, CircleCheck, CircleHelp, Clock3, Code2, Globe2, Inbox as InboxIcon,
  Layers3, LoaderCircle, Menu, MessageCircle, Monitor, Network, Plus,
  RotateCcw, Server, ShieldCheck, Sparkles, Square, TriangleAlert, Waypoints,
  WifiOff, X,
} from 'lucide-react';
import Inbox from './Inbox.tsx';
import TaskActivity from './TaskActivity.tsx';
import NativeApprovals from './NativeApprovals.tsx';
import TaskOverview from './TaskOverview.tsx';
import type { NativeDecisionAttempt } from './NativeApprovals.tsx';
import type { AdapterId, AdapterInfo, Bootstrap, Session, SessionSummary, Task, TaskMode, TaskStatus } from '../shared/types.ts';

type Panel = 'sessions' | 'tasks' | null;
type StreamStatus = 'connecting' | 'connected' | 'offline';
const activeStatuses: TaskStatus[] = ['queued', 'running', 'awaiting_approval', 'cancelling', 'unknown'];
const statusLabels: Record<TaskStatus | 'idle', string> = {
  queued: '等待执行', running: '正在执行', awaiting_approval: '等待你的批准',
  cancelling: '正在停止', completed: '已完成', cancelled: '已取消', failed: '执行失败', unknown: '原生状态未知', idle: '就绪',
};
const realNotice = '内容与本会话历史发送到官方 Codex；按当前账户规则计费或计入额度。受限只读，未启用远程。';
const nativeNotice = '内容会发送到官方 Codex；按当前账户规则计费或计入额度。AppServer 原生会话与逐项审批，未启用远程。';
const hermesNotice = '任务交给这台电脑上的 Hermes；它按本机配置调用模型和工具。当前仅本机接入，远程链路待验收。';
const hermesRestrictions = 'Hermes 的工具权限由本机操作者配置；这里的审批只对应明确列出的单次操作。停止不会撤销已经发生的修改。';
const nativeRestrictions = '使用服务端固定的测试工作区与权限配置。仅对审批卡中列出的这一次操作作出决定；批准可能授权写入，实际可用操作以服务端配置为准。这不等同于完整系统隔离。';
const realRestrictions = '禁用 shell、浏览器与插件；工作目录固定，使用只读 sandbox。这些限制不等同于完整的系统隔离。';
const mockNotice = '当前为模拟体验，不会调用真实 AI 或发送外部消息。';
function adapterMode(adapter?: AdapterInfo) {
  if (!adapter) return '正在载入';
  if (adapter.kind === 'mock') return '模拟';
  if (adapter.id === 'hermes') return '真实 · 本机任务';
  return adapter.id === 'codex-app-server' ? '真实 · 原生审批' : adapter.id === 'codex' ? '真实 · 文本' : '真实 · CLI';
}
function adapterTitle(adapter?: AdapterInfo) {
  const name = providerName(adapter?.id);
  if (adapter?.id === 'hermes') return 'Hermes · 本机 API';
  return adapter?.kind === 'mock' ? `${name} 模拟适配器` : adapter?.id === 'codex-app-server' ? `${name} · AppServer` : adapter?.id === 'codex' ? `${name} · exec` : `${name} · CLI`;
}
const examples = [
  { icon: Sparkles, label: '梳理一个想法', description: '从一个问题，走向清晰的下一步', prompt: '我想做一个自己的小项目，请帮我把想法拆成可以开始的三个步骤。', mode: 'chat' as TaskMode },
  { icon: ShieldCheck, label: '体验任务审批', description: '先看计划，再由你决定是否执行', prompt: '请演示一个需要我批准后才会继续的任务。', mode: 'approval-demo' as TaskMode },
];

class ApiFailure extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}
async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const data = await response.json();
  if (!response.ok) throw new ApiFailure(data.error || `请求失败（${response.status}）`, response.status);
  return data as T;
}
function errorText(error: unknown) { return error instanceof Error ? error.message : '暂时无法完成请求，请重试。'; }
function storedSession() { try { return localStorage.getItem('relaydesk.selected-session'); } catch { return null; } }
function time(value: string) { return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(value)); }
function providerName(id?: AdapterId) { return id === 'hermes' ? 'Hermes' : id?.includes('claude') ? 'Claude' : 'Codex'; }
function ProviderIcon({ id, size = 20 }: { id?: AdapterId; size?: number }) {
  if (id === 'hermes') return <Bot size={size} />;
  return id?.includes('claude') ? <Sparkles size={size} /> : <Code2 size={size} />;
}
function StatusIcon({ status, size = 16 }: { status: TaskStatus; size?: number }) {
  if (status === 'completed') return <CircleCheck size={size} />;
  if (status === 'failed' || status === 'unknown') return <TriangleAlert size={size} />;
  if (status === 'awaiting_approval') return <ShieldCheck size={size} />;
  if (status === 'running' || status === 'cancelling') return <LoaderCircle size={size} className="spin" />;
  if (status === 'cancelled') return <Square size={size} />;
  return <Clock3 size={size} />;
}

export default function App() {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [bootstrapError, setBootstrapError] = useState('');
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [listError, setListError] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(storedSession);
  const [session, setSession] = useState<Session | null>(null);
  const [sessionError, setSessionError] = useState('');
  const [streamStatus, setStreamStatus] = useState<StreamStatus>('connecting');
  const [online, setOnline] = useState(navigator.onLine);
  const [view, setView] = useState<'chat' | 'channels' | 'inbox' | 'activity'>('chat');
  const [panel, setPanel] = useState<Panel>(null);
  const [adapterId, setAdapterId] = useState<AdapterId>('mock-codex');
  const [draft, setDraft] = useState('');
  const [mode, setMode] = useState<TaskMode>('chat');
  const [sending, setSending] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionAttempts, setActionAttempts] = useState<Record<string, 'pending' | 'uncertain' | 'waiting'>>({});
  const [submissions, setSubmissions] = useState<Record<string, string>>({});
  const [checkingTask, setCheckingTask] = useState(false);
  const submitBusy = useRef(false);
  const actionLocks = useRef(new Set<string>());
  const readTaskBusy = useRef(false);
  const [nativeAttempts, setNativeAttempts] = useState<Record<string, NativeDecisionAttempt>>({});
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const navigation = useRef(0);
  const listRequest = useRef(0);
  const composer = useRef<HTMLTextAreaElement>(null);
  const messagesEnd = useRef<HTMLDivElement>(null);
  const conversation = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const drawer = useRef<HTMLDivElement>(null);
  const [showScroll, setShowScroll] = useState(false);
  const current = session?.id === selectedId ? session : null;
  const tasks = current?.tasks ?? [];
  const currentTask = tasks.findLast((task) => activeStatuses.includes(task.status) || task.stopUnconfirmed);
  const newestTask = tasks.at(-1);
  const displayedAdapterId = selectedId ? current?.adapterId ?? sessions.find((item) => item.id === selectedId)?.adapterId : adapterId;
  const currentAdapter = bootstrap?.adapters.find((adapter) => adapter.id === displayedAdapterId);
  const isMock = currentAdapter?.kind === 'mock';
  const isReal = !!currentAdapter && currentAdapter.kind !== 'mock';
  const isHermes = currentAdapter?.id === 'hermes';
  const isNative = currentAdapter?.id === 'codex-app-server' || isHermes;
  const currentNotice = isHermes ? hermesNotice : isNative ? nativeNotice : isReal ? realNotice : isMock ? mockNotice : '正在读取适配器配置。';
  const currentRestrictions = isHermes ? hermesRestrictions : isNative ? nativeRestrictions : realRestrictions;
  const nativeTask = currentTask ?? newestTask;
  const freshConnection = online && (!selectedId || streamStatus === 'connected');
  const pendingSubmission = selectedId ? submissions[selectedId] : undefined;
  const uncertainSubmission = !!pendingSubmission && !tasks.some((task) => task.idempotencyKey === pendingSubmission);
  const cancelLocked = currentTask ? !!actionAttempts[`${currentTask.id}/cancel`] : false;
  const mutationBlocked = !freshConnection || uncertainSubmission;

  const refreshSessions = useCallback(async () => {
    const request = ++listRequest.current;
    try {
      const result = await api<{ sessions: SessionSummary[] }>('/api/sessions');
      if (request === listRequest.current) { setSessions(result.sessions); setListError(false); }
    } catch { if (request === listRequest.current) setListError(true); }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setBootstrapError('');
    api<Bootstrap>('/api/bootstrap', { signal: controller.signal }).then(setBootstrap).catch((reason) => {
      if (!controller.signal.aborted) setBootstrapError(errorText(reason));
    });
    void refreshSessions();
    const interval = window.setInterval(() => void refreshSessions(), 5000);
    return () => { controller.abort(); window.clearInterval(interval); };
  }, [refreshSessions, retry]);

  useEffect(() => {
    const updateOnline = () => { setOnline(navigator.onLine); if (navigator.onLine) void refreshSessions(); };
    window.addEventListener('online', updateOnline);
    window.addEventListener('offline', updateOnline);
    return () => { window.removeEventListener('online', updateOnline); window.removeEventListener('offline', updateOnline); };
  }, [refreshSessions]);

  useEffect(() => {
    try {
      if (selectedId) localStorage.setItem('relaydesk.selected-session', selectedId);
      else localStorage.removeItem('relaydesk.selected-session');
    } catch { /* Session history is persisted by the server even when browser storage is unavailable. */ }
    setSessionError('');
    setSession(null);
    stickToBottom.current = true;
    if (!selectedId) return;
    const controller = new AbortController();
    let source: EventSource | undefined;
    let refreshTimer: number | undefined;
    setStreamStatus('connecting');
    api<{ session: Session }>(`/api/sessions/${encodeURIComponent(selectedId)}`, { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      setSession(result.session);
      source = new EventSource(`/api/sessions/${encodeURIComponent(selectedId)}/events`);
      source.onopen = () => { if (!controller.signal.aborted) { setStreamStatus('connecting'); setSessionError(''); } };
      source.onerror = () => { if (!controller.signal.aborted) setStreamStatus(navigator.onLine ? 'connecting' : 'offline'); };
      source.addEventListener('snapshot', (event: MessageEvent<string>) => {
        if (controller.signal.aborted) return;
        try {
          const snapshot = JSON.parse(event.data) as { session: Session };
          if (snapshot.session.id !== selectedId) return;
          setSession(snapshot.session);
          setStreamStatus('connected');
          if (!refreshTimer) refreshTimer = window.setTimeout(() => { void refreshSessions(); refreshTimer = undefined; }, 750);
        } catch { setSessionError('收到的会话数据有误，请重新连接。'); }
      });
    }).catch((reason) => { if (!controller.signal.aborted) { setSessionError(errorText(reason)); setStreamStatus('offline'); } });
    return () => { controller.abort(); source?.close(); window.clearTimeout(refreshTimer); };
  }, [selectedId, retry, refreshSessions]);

  useEffect(() => {
    if (stickToBottom.current) messagesEnd.current?.scrollIntoView({ block: 'end' });
  }, [current?.messages, currentTask?.status]);

  useEffect(() => {
    if (!panel) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const getControls = () => Array.from(drawer.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input, textarea, select, [tabindex="0"]') ?? []);
    getControls()[0]?.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setPanel(null);
      if (event.key !== 'Tab') return;
      const controls = getControls();
      if (!controls.length) return;
      if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('keydown', onKeyDown); previousFocus?.focus(); };
  }, [panel]);

  function selectSession(id: string | null) {
    navigation.current++;
    setSelectedId(id);
    setDraft('');
    setMode('chat');
    setError('');
    setView('chat');
    setPanel(null);
    setShowScroll(false);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    const prompt = draft.trim();
    if (!prompt || submitBusy.current || uncertainSubmission || currentTask || !freshConnection || !bootstrap || !currentAdapter?.available || (selectedId && !current)) return;
    const epoch = navigation.current;
    const taskMode = isMock ? mode : 'chat';
    let targetId = selectedId;
    submitBusy.current = true;
    setSending(true);
    setError('');
    let taskRequested = false;
    let idempotencyKey = '';
    try {
      if (!targetId) {
        const result = await api<{ session: Session }>('/api/sessions', { method: 'POST', body: JSON.stringify({ adapterId }) });
        targetId = result.session.id;
        if (navigation.current === epoch) { setSelectedId(targetId); setSession(result.session); }
      }
      idempotencyKey = crypto.randomUUID();
      taskRequested = true;
      await api<{ task: Task }>(`/api/sessions/${encodeURIComponent(targetId)}/tasks`, { method: 'POST', body: JSON.stringify({ prompt, mode: taskMode, idempotencyKey }) });
      if (navigation.current === epoch) { setDraft(''); setMode('chat'); stickToBottom.current = true; }
      void refreshSessions();
    } catch (reason) {
      if (taskRequested && targetId && !(reason instanceof ApiFailure && reason.status >= 400 && reason.status < 500)) {
        setSubmissions((previous) => ({ ...previous, [targetId!]: idempotencyKey }));
        if (navigation.current === epoch) setError('任务提交结果尚未确认。不会自动重发；请读取最新状态核对。');
      } else if (navigation.current === epoch) setError(errorText(reason));
    } finally { submitBusy.current = false; setSending(false); void refreshSessions(); }
  }
  async function taskAction(task: Task, action: 'approve' | 'cancel') {
    const lock = `${task.id}/${action}`;
    if (actionLocks.current.has(lock) || mutationBlocked || task.status === 'cancelling' || task.status === 'unknown' || task.stopUnconfirmed || (action === 'approve' && !isMock)) return;
    actionLocks.current.add(lock);
    setActionAttempts((previous) => ({ ...previous, [lock]: 'pending' }));
    setActionBusy(task.id); setError('');
    const epoch = navigation.current;
    try {
      await api(`/api/tasks/${encodeURIComponent(task.id)}/${action}`, { method: 'POST', body: '{}' });
      setActionAttempts((previous) => ({ ...previous, [lock]: 'waiting' }));
      void refreshSessions();
    } catch (reason) {
      if (reason instanceof ApiFailure && reason.status >= 400 && reason.status < 500) {
        actionLocks.current.delete(lock);
        setActionAttempts((previous) => { const next = { ...previous }; delete next[lock]; return next; });
        if (navigation.current === epoch) setError(errorText(reason));
      } else {
        setActionAttempts((previous) => ({ ...previous, [lock]: 'uncertain' }));
        if (navigation.current === epoch) setError('这次操作的结果尚未确认。不会重复提交，请读取最新状态。');
      }
    } finally { setActionBusy(null); }
  }
  async function checkTaskState() {
    if (!current || readTaskBusy.current) return;
    readTaskBusy.current = true; setCheckingTask(true);
    const epoch = navigation.current;
    const startedWith = current;
    try {
      const result = await api<{ session: Session }>(`/api/sessions/${encodeURIComponent(current.id)}`);
      if (navigation.current === epoch && result.session.id === startedWith.id) setSession((previous) => previous === startedWith ? result.session : previous);
    } catch (reason) { if (navigation.current === epoch) setError(errorText(reason)); }
    finally { readTaskBusy.current = false; setCheckingTask(false); }
  }
  function fillExample(example: typeof examples[number]) {
    setDraft(example.prompt); setMode(isMock ? example.mode : 'chat'); composer.current?.focus();
  }
  function handleComposerKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && window.matchMedia('(pointer: fine)').matches) {
      event.preventDefault(); event.currentTarget.form?.requestSubmit();
    }
  }

  const sidebar = <>
    <div className="brand"><span className="brand-mark"><Waypoints size={23} strokeWidth={2.2} /></span><span>RelayDesk<span className="brand-period">.</span></span><span className="version">LOCAL</span></div>
    <div className="sidebar-content">
      <button className="new-session" data-testid="new-session" onClick={() => selectSession(null)}><Plus size={18} /> 开启新会话 <span className="new-session-symbol">↗</span></button>
      <nav aria-label="工作空间"><button className={`nav-item ${view === 'chat' ? 'active' : ''}`} onClick={() => { setView('chat'); setPanel(null); }}><MessageCircle size={18} /><span>对话工作台</span><ChevronRight size={15} /></button><button className={`nav-item ${view === 'channels' ? 'active' : ''}`} onClick={() => { setView('channels'); setPanel(null); }}><Network size={18} /><span>连接与渠道</span><span className="mini-label">预览</span></button><button className={`nav-item ${view === 'inbox' ? 'active' : ''}`} onClick={() => { setView('inbox'); setPanel(null); }}><InboxIcon size={18} /><span>工作收件箱</span><span className="mini-label">模拟</span></button><button className={`nav-item ${view === 'activity' ? 'active' : ''}`} data-testid="activity-nav" onClick={() => { setView('activity'); setPanel(null); }}><Activity size={18} /><span>运行动态</span><span className="mini-label">实时</span></button></nav>
      <div className="section-label session-label"><span>最近会话</span><span>{sessions.length > 0 ? sessions.length : '—'}</span></div>
      <div className="session-list" aria-label="最近会话">
        {sessions.map((item) => <button className={`session-item ${item.id === selectedId && view === 'chat' ? 'selected' : ''}`} key={item.id} data-testid="session-item" data-session-id={item.id} onClick={() => selectSession(item.id)} aria-current={item.id === selectedId ? 'page' : undefined}><span className={`session-provider ${item.adapterId.includes('claude') ? 'claude' : ''}`}><ProviderIcon id={item.adapterId} size={16} /></span><span className="session-item-text"><strong>{item.title}</strong><span>{item.lastMessage || '等待第一条消息'}</span></span>{activeStatuses.includes(item.status as TaskStatus) && <span className={`activity-dot ${item.status}`} aria-label={statusLabels[item.status]} />}</button>)}
        {!sessions.length && <div className="sessions-empty"><MessageCircle size={22} strokeWidth={1.4} /><p>好想法，从一段对话开始。</p><span>你的会话会保存在这台电脑上。</span></div>}
        {listError && <button className="list-retry" onClick={() => void refreshSessions()}><RotateCcw size={13} />会话列表连接失败，重试</button>}
      </div>
    </div>
    <div className="sidebar-bottom"><div className="local-device"><span className="device-icon"><Monitor size={19} /></span><div><strong>本地工作空间</strong><span><i className={`status-dot ${!online || bootstrapError ? 'muted' : ''}`} />{online && !bootstrapError ? '本机执行节点 · 开发版' : '连接暂不可用'}</span></div><ShieldCheck size={16} className="muted-icon" /></div><div className="sidebar-footer"><span>属于你的 AI 工作空间</span><span>v{bootstrap?.runtime.version ?? '0.3.0'}</span></div></div>
  </>;

  const taskPanel = <>
    <div className="task-panel-title"><div><Activity size={17} /><h2>执行动态</h2></div><span className="small-live-dot" /></div>
    {newestTask ? <>
      <div className={`task-state ${newestTask.status}`}><span className="task-state-icon"><StatusIcon status={newestTask.status} size={22} /></span><span className="section-label">当前任务</span><h3 data-testid="task-status" data-status={newestTask.status}>{newestTask.stopUnconfirmed ? '停止状态未确认' : statusLabels[newestTask.status]}</h3><p>{newestTask.stopUnconfirmed ? '尚未确认执行已经停止；不能提交新任务。' : newestTask.status === 'unknown' ? '需读取原生历史核对结果，不会自动重发提示词。' : newestTask.status === 'awaiting_approval' ? '执行已暂停，接下来由你决定。' : newestTask.status === 'running' ? '适配器正在处理你的请求。' : newestTask.status === 'cancelling' ? isNative ? '正在等待原生轮次结束确认。' : '正在等待执行进程退出。' : newestTask.status === 'completed' ? '这一步已完成，随时继续对话。' : newestTask.status === 'failed' ? newestTask.error || '任务未能完成，可以再次尝试。' : newestTask.status === 'cancelled' ? '执行已停止。你可以开始新的任务。' : '请求已接收，即将开始。'}</p><span className="task-id">TASK {newestTask.id.slice(0, 8).toUpperCase()}</span></div>
      <div className="timeline-heading section-label">任务轨迹 <span>{newestTask.events.length} 个状态</span></div>
      <ol className="timeline">{newestTask.events.map((event, index) => <li key={`${event.at}-${index}`}><span className={`timeline-marker ${index === newestTask.events.length - 1 ? 'latest' : ''}`}><StatusIcon status={event.status} size={13} /></span><div><strong>{statusLabels[event.status]}</strong><time>{time(event.at)}</time><p>{event.detail}</p></div></li>)}</ol>
      {currentTask && (currentTask.status !== 'awaiting_approval' || isNative) && <button className="cancel-task" data-testid="cancel-task" onClick={() => void taskAction(currentTask, 'cancel')} disabled={!!actionBusy || mutationBlocked || cancelLocked || currentTask.status === 'cancelling' || currentTask.status === 'unknown' || currentTask.stopUnconfirmed}><Square size={13} />{currentTask.status === 'cancelling' ? '正在等待停止确认' : currentTask.status === 'unknown' || currentTask.stopUnconfirmed ? '停止状态待核对' : '停止当前任务'}</button>}
    </> : <div className="task-empty"><div className="empty-orbit"><Circle size={72} strokeWidth={0.65} /><Clock3 size={23} /><span /><i /></div><h3>每一步，都看得见</h3><p>发送消息后，这里会展示<br />任务进度与执行轨迹。</p><div className="empty-steps"><span><Circle size={10} />接收请求</span><span><Circle size={10} />适配器执行</span><span><Circle size={10} />返回结果</span></div></div>}
    {tasks.length > 1 && <div className="past-tasks"><div className="section-label">本会话任务 <span>{tasks.length}</span></div>{tasks.slice(0, -1).reverse().slice(0, 4).map((task) => <div className="past-task" key={task.id}><StatusIcon status={task.status} size={14} /><span>{task.prompt}</span><span>{statusLabels[task.status]}</span></div>)}</div>}
    <div className="task-panel-bottom"><div className="section-label">本次连接路径</div><div className="connection-route"><span><Monitor size={14} />本地界面</span><ChevronRight size={12} /><span><Server size={14} />本地网关</span></div><div className="adapter-route"><span className="route-line" /><ProviderIcon id={displayedAdapterId} size={15} /><strong>{adapterTitle(currentAdapter)}</strong><span className={`badge ${isMock ? 'simulation' : 'available'}`}>{adapterMode(currentAdapter)}</span></div><div className="privacy-note"><ShieldCheck size={15} /><p>{currentNotice}{isReal && <><br />{currentRestrictions}</>}</p></div></div>
  </>;

  return <div className="app-shell">
    <aside className="sidebar desktop-sidebar" inert={!!panel}>{sidebar}</aside>
    <div className="workspace" inert={!!panel} data-testid="active-stream-state" data-stream-state={streamStatus} data-session-id={selectedId ?? ""}>
      <header className="topbar"><div className="topbar-location"><button className="icon-button mobile-menu" aria-label="打开会话列表" onClick={() => setPanel('sessions')}><Menu size={20} /></button><span className="desktop-breadcrumb">工作空间 <ChevronRight size={13} /></span><strong>{view === 'chat' ? '对话工作台' : view === 'inbox' ? '工作收件箱 · 模拟' : view === 'activity' ? '运行动态' : '连接与渠道'}</strong></div><div className="topbar-actions"><span className={`connection-badge ${!online || bootstrapError ? 'offline' : ''}`}><span className="status-dot" />{!online ? '已离线' : bootstrapError ? '服务未连接' : '本地开发'}</span>{view !== 'inbox' && view !== 'activity' && <button className="icon-button tasks-toggle" aria-label="查看执行动态" onClick={() => setPanel('tasks')}><Activity size={19} />{currentTask && <i className="task-notification" />}</button>}</div></header>
      <div className="workspace-body"><main className={`main-panel ${view !== 'chat' ? 'channels-main' : ''}`}>
        {bootstrapError && <div className="error-banner" role="alert"><TriangleAlert size={17} /><span>无法连接本地服务：{bootstrapError}</span><button onClick={() => setRetry((value) => value + 1)}>重试</button></div>}
        {!online && <div className="connection-notice" role="status"><WifiOff size={15} />网络已断开，重新连接后可以继续。</div>}
        {view === 'channels' ? <Channels bootstrap={bootstrap} /> : view === 'inbox' ? <Inbox /> : view === 'activity' ? <TaskActivity online={online} onOpenSession={(sessionId) => selectSession(sessionId)} /> : <>
          <div className="chat-heading"><div className="chat-heading-title"><span className={`heading-provider ${current?.adapterId.includes('claude') ? 'claude' : ''}`}><ProviderIcon id={displayedAdapterId} size={19} /></span><div><h1>{current?.title ?? (selectedId ? '正在载入会话…' : '新的会话')}</h1><p>{selectedId && current ? `${providerName(current.adapterId)} · ${current.messages.filter((message) => message.role === 'user').length} 轮对话` : '给想法一个开始的地方'}</p></div></div><span data-testid="adapter-mode" className={`badge ${isMock ? 'simulation' : 'available'}`}><ShieldCheck size={11} />{adapterMode(currentAdapter)}</span></div>
          <TaskOverview task={newestTask} result={current?.messages.findLast(message => message.taskId === newestTask?.id && message.role === 'assistant')?.content} connected={freshConnection} />
          {selectedId && streamStatus !== 'connected' && !sessionError && <div className="connection-notice" role="status"><LoaderCircle size={14} className="spin" />{streamStatus === 'offline' ? '等待网络恢复…' : current ? '正在重新连接，任务可能仍在运行…' : '正在连接会话…'}</div>}
          <div className="conversation" ref={conversation} onScroll={() => { const el = conversation.current; if (el) { stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90; setShowScroll(!stickToBottom.current); } }}>
            {sessionError ? <div className="session-error" role="alert"><TriangleAlert size={28} /><h2>会话暂时无法载入</h2><p>{sessionError}</p><button className="secondary-button" onClick={() => setRetry((value) => value + 1)}><RotateCcw size={15} />重新连接</button><button className="text-button" onClick={() => selectSession(null)}>开启新会话</button></div> : selectedId && !current ? <div className="loading-state"><LoaderCircle className="spin" size={24} /><span>正在恢复你的工作空间</span></div> : !current?.messages.length ? <div className="welcome">
              <div className="welcome-eyebrow"><span /> YOUR AI, IN ONE PLACE</div><h2>一个入口，<br />让想法<span>继续。</span></h2><p className="welcome-description">在这里交代任务、核对状态、查看结果。<br />先验证本机执行，再接通远程访问。</p>
              {!selectedId && <div className="provider-section"><div className="section-label">选择执行器 <span>模拟与真实执行分别标明</span></div><div className="provider-grid">{(bootstrap?.adapters ?? []).map((adapter) => <ProviderCard key={adapter.id} adapter={adapter} selected={adapterId === adapter.id} onClick={() => { setAdapterId(adapter.id); setMode('chat'); }} />)}{!bootstrap && !bootstrapError && <div className="loading-providers"><LoaderCircle size={17} className="spin" />正在载入适配器…</div>}</div></div>}
              <div className="starter-section"><div className="section-label">不妨从这里开始</div><div className="starter-grid">{examples.filter((example) => isMock || example.mode !== 'approval-demo').map((example) => <button key={example.mode} className="starter-card" onClick={() => fillExample(example)}><example.icon size={19} /><strong>{example.label}<ArrowUp size={14} /></strong><span>{example.description}</span></button>)}</div></div>
            </div> : <div className="messages"><div className="conversation-date"><span />会话记录保存在本机<span /></div>{current.messages.map((message) => <div key={message.id} className={`message message-${message.role}`}><div className={`message-avatar ${current.adapterId.includes('claude') ? 'claude' : ''}`}>{message.role === 'user' ? <span>你</span> : message.role === 'system' ? <CircleHelp size={18} /> : <ProviderIcon id={current.adapterId} size={19} />}</div><div className="message-body"><div className="message-meta"><strong>{message.role === 'user' ? '你' : message.role === 'system' ? '系统' : providerName(current.adapterId)}</strong>{message.role === 'assistant' && <span className={`message-simulation ${isReal ? 'message-real' : ''}`}>{adapterMode(currentAdapter)}</span>}<time>{time(message.createdAt)}</time></div><div className="message-content">{message.content || <span className="typing-dots" aria-label="正在生成回复"><i /><i /><i /></span>}</div></div></div>)}</div>}
            {isMock && currentTask?.status === 'awaiting_approval' && <div className="approval-card" role="region" aria-label="待审批任务"><span className="approval-icon"><ShieldCheck size={22} /></span><div className="approval-content"><div className="approval-eyebrow">执行前，请你确认 <span>模拟审批</span></div><h3>{currentTask.approval?.title ?? '批准后继续模拟任务'}</h3><p>{currentTask.approval?.description ?? '这只会继续本地演示，不会发送消息或运行外部操作。'}</p><div className="approval-actions"><button className="primary-button" data-testid="approve-task" disabled={!!actionBusy || mutationBlocked || !!actionAttempts[`${currentTask.id}/approve`]} onClick={() => void taskAction(currentTask, 'approve')}>{actionBusy ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}批准并继续模拟</button><button className="secondary-button" disabled={!!actionBusy || mutationBlocked || cancelLocked} onClick={() => void taskAction(currentTask, 'cancel')}>取消任务</button></div></div></div>}
            {isNative && current && nativeTask && <NativeApprovals key={current.id} session={current} task={nativeTask} connected={freshConnection} decisionsBlocked={cancelLocked || uncertainSubmission} attempts={nativeAttempts} onAttempt={(key, attempt) => setNativeAttempts((previous) => ({ ...previous, [key]: attempt }))} onSession={(snapshot) => setSession((previous) => previous?.id === snapshot.id ? snapshot : previous)} />}
            {!isNative && newestTask?.stopUnconfirmed && <div className="inline-task-error" role="status"><TriangleAlert size={16} /><span>停止状态未确认，当前会话不能继续提交任务。请在本机核对执行进程，不能将失败状态视为已经停止。</span></div>}
            {newestTask?.status === 'failed' && <div className="inline-task-error" role="status"><TriangleAlert size={16} /><span>任务失败：{newestTask.error || '请重新尝试。'}</span></div>}
            <div ref={messagesEnd} className="messages-end" />
          </div>
          <div className="composer-area">{currentAdapter && !currentAdapter.available && <div className="connection-notice" role="status">{currentAdapter.reason ?? '此适配器尚未启用，暂时无法继续发送。'}</div>}{showScroll && <button className="scroll-latest" onClick={() => { stickToBottom.current = true; messagesEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }}><ArrowDown size={14} />回到最新消息</button>}{error && <div className="error-banner composer-error" role="alert"><TriangleAlert size={16} /><span>{error}</span><button className="icon-button" aria-label="关闭错误提示" onClick={() => setError('')}><X size={15} /></button></div>}
            {(uncertainSubmission || (currentTask && (actionAttempts[`${currentTask.id}/cancel`] === 'uncertain' || actionAttempts[`${currentTask.id}/approve`] === 'uncertain'))) && <div className="submission-uncertain" data-testid="submission-uncertain" role="status"><TriangleAlert size={16} /><span>写入结果尚未确认，已暂停重复提交。读取状态不会重新发送任务或执行操作。</span><button className="text-button" data-testid="task-check-state" disabled={checkingTask} onClick={() => void checkTaskState()}>{checkingTask ? '正在读取…' : '读取最新状态'}</button></div>}
            <form className={`composer ${isMock && mode === 'approval-demo' ? 'approval-mode' : ''}`} onSubmit={(event) => void submit(event)}><label className="sr-only" htmlFor="message-input">发送消息</label><textarea id="message-input" data-testid="message-input" ref={composer} value={draft} maxLength={8000} onChange={(event) => setDraft(event.target.value)} onKeyDown={handleComposerKey} placeholder={currentTask ? currentTask.status === 'awaiting_approval' ? '请先批准或取消上面的任务…' : '当前任务完成后，即可继续对话…' : `想和 ${providerName(displayedAdapterId)} 聊些什么？`} rows={2} disabled={sending || uncertainSubmission || !!currentTask || !!(selectedId && !current)} /><div className="composer-controls">{isMock ? <button type="button" data-testid="approval-demo" className={`mode-toggle ${mode === 'approval-demo' ? 'enabled' : ''}`} onClick={() => setMode(mode === 'chat' ? 'approval-demo' : 'chat')} aria-pressed={mode === 'approval-demo'} disabled={sending || !!currentTask}><ShieldCheck size={15} />{mode === 'approval-demo' ? '审批演示已开启' : '审批演示'}{mode === 'approval-demo' && <X size={12} />}</button> : <span className="cli-composer-label"><ShieldCheck size={15} />{isHermes ? 'Hermes · 本机任务与单次审批' : isNative ? 'AppServer · 原生审批' : isReal ? 'exec · 旧模式 / 文本' : '载入适配器…'}</span>}<div className="composer-right"><span className="character-count">{draft.length > 7600 ? `${draft.length}/8000` : ''}</span>{currentTask && (currentTask.status !== 'awaiting_approval' || isNative) ? <button type="button" className="send-button stop-button" data-testid="cancel-task" aria-label="停止当前任务" onClick={() => void taskAction(currentTask, 'cancel')} disabled={!!actionBusy || mutationBlocked || cancelLocked || currentTask.status === 'cancelling' || currentTask.status === 'unknown' || currentTask.stopUnconfirmed}><Square size={16} fill="currentColor" /></button> : <button className="send-button" data-testid="send-message" aria-label="发送消息" type="submit" disabled={!draft.trim() || sending || uncertainSubmission || !!currentTask || !freshConnection || !bootstrap || !currentAdapter?.available || !!(selectedId && !current)}>{sending ? <LoaderCircle className="spin" size={18} /> : <ArrowUp size={20} />}</button>}</div></div></form><div className={`composer-footnote ${isReal ? 'real-footnote' : ''}`}><ShieldCheck size={12} /><span data-testid="adapter-notice">{currentNotice}</span><span className="keyboard-hint">Enter 发送 · Shift + Enter 换行</span></div>{isReal && <details className="execution-boundary"><summary>查看真实执行边界</summary><p>{currentRestrictions}</p></details>}
          </div>
        </>}
      </main>{view !== 'inbox' && view !== 'activity' && <aside className="task-panel desktop-tasks">{taskPanel}</aside>}</div>
    </div>
    {panel && <div className="drawer-layer"><button className="drawer-backdrop" aria-label="关闭面板" onClick={() => setPanel(null)} /><div ref={drawer} role="dialog" aria-modal="true" aria-label={panel === 'sessions' ? '会话导航' : '执行动态'} className={`mobile-drawer ${panel === 'sessions' ? 'sidebar' : 'task-panel task-drawer'}`}><button className="icon-button drawer-close" aria-label="关闭面板" onClick={() => setPanel(null)}><X size={20} /></button>{panel === 'sessions' ? sidebar : taskPanel}</div></div>}
  </div>;
}

function ProviderCard({ adapter, selected, onClick }: { adapter: AdapterInfo; selected: boolean; onClick: () => void }) {
  const isMock = adapter.kind === 'mock';
  const description = !adapter.available ? adapter.reason ?? '尚未启用此适配器。' : isMock ? '本地模拟，不调用真实 AI' : adapter.id === 'codex-app-server' ? '原生会话与逐项审批 · 执行以实际结果为准' : adapter.id === 'codex' ? '旧模式 / 文本调用 · 无原生审批' : '官方 CLI · 已配置，执行以实际结果为准';
  return (
    <button data-testid="adapter-select" data-adapter-id={adapter.id}
      className={`provider-card ${selected ? 'selected' : ''} ${adapter.id.includes('claude') ? 'claude' : ''} ${!isMock ? 'provider-cli' : ''}`}
      onClick={onClick} disabled={!adapter.available} aria-pressed={selected} title={adapter.reason}>
      <span className="provider-icon"><ProviderIcon id={adapter.id} size={25} /></span>
      <span>
        <strong>{isMock ? providerName(adapter.id) : adapterTitle(adapter)}<span className={`badge ${isMock ? 'simulation' : adapter.available ? 'available' : 'planned'}`}>{adapter.available ? adapterMode(adapter) : '未启用'}</span></strong>
        <span>{description}</span>
      </span>
      <span className="provider-check">{selected ? <Check size={12} /> : <Circle size={15} />}</span>
    </button>
  );
}

function Channels({ bootstrap }: { bootstrap: Bootstrap | null }) {
  const icons: Record<string, ReactNode> = { wechat: <MessageCircle size={22} />, slack: <Layers3 size={22} />, email: <MessageCircle size={22} />, web: <Globe2 size={22} />, 'local-web': <Globe2 size={22} />, tts: <AudioLines size={22} /> };
  return <div className="channels-view"><div className="welcome-eyebrow"><span /> YOUR WORKSPACE, CONNECTED</div><h1>每一种连接，<br />都有清晰的边界。</h1><p className="channels-intro">先把本地链路做好，再逐步连接你的设备与工作渠道。</p><div className="architecture-card"><div className="section-label">当前应用链路 <span className="badge available">本地模式</span></div><div className="architecture-flow"><div><Monitor size={24} /><strong>聊天前端</strong><span>适配手机屏幕</span></div><ArrowRight size={18} /><div><Server size={24} /><strong>本地网关</strong><span>会话 · 任务 · 审批</span></div><ArrowRight size={18} /><div><Bot size={24} /><strong>执行适配器</strong><span>{bootstrap?.adapters.some((adapter) => adapter.available && adapter.kind === 'cli') ? '模拟 / 官方 CLI' : '本地模拟'}</span></div></div><p><ShieldCheck size={14} />当前仅本机可访问。手机远程接入需要后续的 VPS 网关与身份验证。</p></div><div className="channels-section-title"><h2>AI 执行适配器</h2><span>真实状态，明确呈现</span></div><div className="integration-grid">{bootstrap?.adapters.map((adapter) => <div className="integration-card" key={adapter.id}><div className="integration-card-top"><span className={`integration-icon ${adapter.id.includes('claude') ? 'claude' : ''}`}><ProviderIcon id={adapter.id} size={22} /></span><span className={`badge ${adapter.available ? 'available' : 'planned'}`}>{adapter.available ? adapter.kind === 'mock' ? '模拟可用' : adapter.id === 'hermes' ? '已配置 · 本机 API' : adapter.id === 'codex-app-server' ? '已配置 · AppServer' : adapter.id === 'codex' ? '已配置 · exec' : '已配置 · CLI' : '尚未启用'}</span></div><h3>{adapter.name}</h3><p>{adapter.reason ?? adapter.description}</p>{adapter.kind !== 'mock' && adapter.available && <p>配置可用不代表本轮调用已成功；请以任务结果为准。</p>}</div>)}</div><div className="channels-section-title"><h2>消息渠道</h2><span>接收、总结与执行，各自独立</span></div><div className="integration-grid">{bootstrap?.channels.map((channel) => <div className="integration-card" key={channel.id}><div className="integration-card-top"><span className="integration-icon">{icons[channel.id] ?? <Network size={22} />}</span><span className={`badge ${channel.status === 'local' ? 'available' : 'planned'}`}>{channel.status === 'local' ? '本地可用' : '规划中'}</span></div><h3>{channel.name}</h3><p>{channel.description}</p></div>)}</div><div className="channels-section-title"><h2>下一程</h2><span>独立模块，逐步接入</span></div><div className="future-row"><span className="integration-icon"><Server size={22} /></span><div><h3>远程访问接入</h3><p>目标是在国内提交任务，由日本电脑上的本机服务执行。身份验证、跨境连接和设备恢复仍待实施与验收；中转仅按网络需要引入。</p></div><span className="badge planned">规划中</span></div><div className="future-row"><span className="integration-icon"><AudioLines size={22} /></span><div><h3>可选语音服务</h3><p>GPT-SoVITS 等语音服务可作为独立模块。当前未接入，未下载或运行第三方语音权重。</p></div><span className="badge planned">后续可选</span></div><div className="channels-footer"><CheckCheck size={17} /><p>连接渠道不会自动授予发送权限。重要操作仍需你明确授权。</p></div></div>;
}
