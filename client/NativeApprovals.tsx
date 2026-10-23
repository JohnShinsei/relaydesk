import { useEffect, useRef, useState } from 'react';
import { Check, FileDiff, LoaderCircle, RefreshCw, ShieldCheck, Square, TerminalSquare, TriangleAlert, X } from 'lucide-react';
import type { NativeApproval, NativeApprovalDecision, Session, Task } from '../shared/types.ts';

const approvalLabels: Record<NativeApproval['status'], string> = {
  pending: '等待本次决定', responding: '决定正在提交', accepted: '已批准本次操作', declined: '已拒绝本次操作',
  cancelled: '已请求取消此轮', expired: '请求已过期', resolved: '原生请求已处理', unknown: '决定结果未知',
};
const decisionLabels: Record<NativeApprovalDecision, string> = {
  accept: '批准一次', decline: '拒绝本次操作', cancel: '拒绝并停止此轮',
};
export type NativeDecisionAttempt = 'submitting' | 'waiting' | 'uncertain';

async function requestSession(path: string, body?: object): Promise<Session> {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `请求失败（${response.status}）`);
  return (result as { session: Session }).session;
}
function problem(error: unknown) { return error instanceof Error ? error.message : '暂时无法核对请求状态。'; }
function dateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间不可用' : new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date);
}

/** Native approval IDs and previews are provided by the server; no editable command payload is sent. */
export default function NativeApprovals({ session, task, connected, onSession, attempts, onAttempt, decisionsBlocked = false }: {
  session: Session; task: Task; connected: boolean; decisionsBlocked?: boolean; onSession: (session: Session) => void;
  attempts: Record<string, NativeDecisionAttempt>;
  onAttempt: (key: string, attempt: NativeDecisionAttempt) => void;
}) {
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [now, setNow] = useState(Date.now);
  const attempted = useRef(new Set<string>());
  const alive = useRef(true);
  const currentSession = useRef(session);
  const currentTask = useRef(task);
  const currentConnected = useRef(connected);
  const currentBlocked = useRef(decisionsBlocked);
  const currentAttempts = useRef(attempts);
  const readBusy = useRef(false);
  const recoveringNow = useRef(false);
  currentSession.current = session;
  currentTask.current = task;
  currentConnected.current = connected;
  currentBlocked.current = decisionsBlocked;
  currentAttempts.current = attempts;

  useEffect(() => {
    alive.current = true;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { alive.current = false; window.clearInterval(timer); };
  }, []);

  function acceptSnapshot(result: Session, startedWith: Session) {
    // An SSE snapshot that arrived during a request is newer evidence; never overwrite it with an old response.
    if (alive.current && result.id === startedWith.id && currentSession.current === startedWith) onSession(result);
  }
  function canDecide(approval: NativeApproval, decision: NativeApprovalDecision) {
    return currentConnected.current && !currentBlocked.current && !currentTask.current.stopUnconfirmed &&
      ['queued', 'running', 'awaiting_approval'].includes(currentTask.current.status) &&
      approval.status === 'pending' && Date.parse(approval.expiresAt) > Date.now() &&
      approval.allowedDecisions.includes(decision) && !attempted.current.has(approval.id) &&
      !currentAttempts.current[`${currentSession.current.id}/${approval.id}`];
  }
  async function decide(approvalId: string, decision: NativeApprovalDecision) {
    const approval = currentTask.current.nativeApprovals?.find((item) => item.id === approvalId);
    if (!approval || !canDecide(approval, decision)) return;
    const startedWith = currentSession.current;
    const taskId = currentTask.current.id;
    const attemptKey = `${startedWith.id}/${approvalId}`;
    attempted.current.add(approvalId);
    onAttempt(attemptKey, 'submitting');
    setError('');
    try {
      const result = await requestSession(`/api/tasks/${encodeURIComponent(taskId)}/native-approvals/${encodeURIComponent(approvalId)}`, { decision });
      onAttempt(attemptKey, 'waiting');
      if (!alive.current) return;
      acceptSnapshot(result, startedWith);
    } catch (reason) {
      onAttempt(attemptKey, 'uncertain');
      if (!alive.current) return;
      setError(`这次决定的结果尚未确认：${problem(reason)}。不会自动重发，请读取最新状态。`);
    }
  }
  async function checkState() {
    if (readBusy.current) return;
    const startedWith = currentSession.current;
    readBusy.current = true; setChecking(true); setError('');
    try {
      const result = await requestSession(`/api/sessions/${encodeURIComponent(startedWith.id)}`);
      acceptSnapshot(result, startedWith);
    } catch (reason) { if (alive.current) setError(problem(reason)); }
    finally { readBusy.current = false; if (alive.current) setChecking(false); }
  }
  async function recover() {
    const startedWith = currentSession.current;
    if (!currentConnected.current || recoveringNow.current || currentTask.current.status !== 'unknown' || (!startedWith.engineBinding && !(startedWith.adapterId === 'hermes' && currentTask.current.nativeTurnId))) return;
    recoveringNow.current = true; setRecovering(true); setError('');
    try {
      const result = await requestSession(`/api/sessions/${encodeURIComponent(startedWith.id)}/recover`, {});
      acceptSnapshot(result, startedWith);
    } catch (reason) { if (alive.current) setError(`原生状态尚未核对成功：${problem(reason)}`); }
    finally { recoveringNow.current = false; if (alive.current) setRecovering(false); }
  }

  return <section className="native-approvals" aria-label={session.adapterId === 'hermes' ? 'Hermes 操作审批与恢复' : 'AppServer 原生审批与恢复'}>
    {(task.status === 'unknown' || task.stopUnconfirmed) && <div className="native-state-warning" role="status"><TriangleAlert size={19} /><div><strong>{task.stopUnconfirmed ? '停止状态未确认' : '原生任务结果未知'}</strong><p>尚未确认此轮执行已经结束。当前会话不能提交新任务，审批入口也已暂停；不能把断线视为操作已取消。</p>{task.status === 'unknown' && (session.engineBinding || (session.adapterId === 'hermes' && task.nativeTurnId)) && <><button className="secondary-button" data-testid="native-recover" onClick={() => void recover()} disabled={recovering || !connected}>{recovering ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}读取原生历史并恢复状态</button><small>只核对已有原生会话，不会重新发送提示词，也不会重放审批。</small></>}</div></div>}
    {error && <div className="error-banner native-error" role="alert"><TriangleAlert size={16} /><span>{error}</span></div>}
    {(task.nativeApprovals ?? []).map((approval) => {
      const pending = approval.status === 'pending';
      const expiry = Date.parse(approval.expiresAt);
      const expired = !Number.isFinite(expiry) || expiry <= now;
      const localAttempt = attempts[`${session.id}/${approval.id}`];
      const actionable = pending && !expired && !localAttempt && connected && !decisionsBlocked && !task.stopUnconfirmed && ['queued', 'running', 'awaiting_approval'].includes(task.status);
      return <article className={`native-approval-card native-approval-${approval.status}`} data-testid="native-approval-card" data-approval-id={approval.id} key={approval.id}>
        <header><span className="native-approval-icon">{approval.kind === 'command' ? <TerminalSquare size={21} /> : <FileDiff size={21} />}</span><div><span className="native-eyebrow">{session.adapterId === 'hermes' ? 'HERMES · 单次操作审批' : 'APPSERVER · 原生操作审批'}</span><h3>{approval.kind === 'tool' ? '核对这一次工具操作' : approval.kind === 'command' ? '核对这一次执行操作' : '核对这一次文件变更'}</h3></div><span className="badge native-badge">真实操作</span></header>
        <div className="native-operation"><span className="section-label">固定操作内容</span><pre>{approval.operation}</pre></div>
        <dl className="native-approval-meta"><div><dt>工作目录</dt><dd>{approval.cwd ?? '原生请求未提供'}</dd></div><div><dt>原生请求 ID · {typeof approval.requestId}</dt><dd>{JSON.stringify(approval.requestId)}</dd></div><div><dt>收到时间</dt><dd>{dateTime(approval.createdAt)}</dd></div><div><dt>有效期至</dt><dd>{dateTime(approval.expiresAt)}</dd></div></dl>
        {!!approval.changes?.length && <div className="native-changes"><span className="section-label">待确认的文件变更 <span>{approval.changes.length} 个文件</span></span>{approval.changes.map((change, index) => <div className="native-change" key={`${change.path}-${index}`}><h4>{change.path}</h4><pre>{change.diff}</pre></div>)}</div>}
        <details className="native-request-binding"><summary>请求绑定信息</summary><dl><div><dt>审批记录</dt><dd>{approval.id}</dd></div><div><dt>原生会话</dt><dd>{approval.threadId}</dd></div><div><dt>轮次</dt><dd>{approval.turnId}</dd></div><div><dt>操作项</dt><dd>{approval.itemId}</dd></div>{approval.decidedAt && <div><dt>决定时间</dt><dd>{dateTime(approval.decidedAt)}</dd></div>}</dl></details>
        <div className="native-approval-state" data-testid="native-approval-status" data-status={approval.status} role="status"><ShieldCheck size={15} /><span>{pending && expired ? '请求已过期，不能批准' : pending && localAttempt === 'submitting' ? '正在提交这次决定' : pending && localAttempt ? '决定已提交，等待核对结果' : approvalLabels[approval.status]}</span></div>
        {pending && decisionsBlocked && <p className="native-approval-note">另一项任务操作正在等待结果核对，当前审批决定已暂停。</p>}
        {pending && !connected && <p className="native-approval-note">连接已中断或正在恢复。收到新的会话快照后，才能确认当前审批仍然有效。</p>}
        {pending && localAttempt && <p className="native-approval-note">这条请求不会重复提交决定。读取状态仅获取当前记录，不会批准或重放操作。</p>}
        {pending && !expired && <div className="native-approval-actions">{approval.allowedDecisions.map((decision) => <button key={decision} data-testid={decision === 'accept' ? 'native-approve' : decision === 'decline' ? 'native-decline' : 'native-cancel'} className={decision === 'accept' ? 'primary-button' : 'secondary-button'} disabled={!actionable} onClick={() => void decide(approval.id, decision)}>{decision === 'accept' ? <Check size={14} /> : decision === 'decline' ? <X size={14} /> : <Square size={13} />}{decisionLabels[decision]}</button>)}</div>}
        {(!!localAttempt || approval.status === 'unknown' || approval.status === 'responding') && <button className="secondary-button native-check-state" data-testid="native-check-state" onClick={() => void checkState()} disabled={checking}>{checking ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}读取最新状态</button>}
        <p className="native-approval-footnote">决定仅对应这条固定请求，不授权后续操作。批准可能允许写入；拒绝会交回模型继续处理，停止此轮也不代表已经发生的操作会被撤销。</p>
      </article>;
    })}
  </section>;
}
