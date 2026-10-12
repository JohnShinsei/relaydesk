import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowRight, Check, CheckCheck, ChevronRight, CircleHelp, Clock3, FileText, Inbox as InboxIcon, Link2, LoaderCircle, MessageCircle, RefreshCw, Send, ShieldCheck, Sparkles, TriangleAlert, X } from 'lucide-react';
import type { DemoDeliveryOutcome, InboxMessage, InboxReply, InboxSnapshot, PrepareInboxReply } from '../shared/inbox.ts';

const deliveryLabels = {
  draft: '待确认发送', sending: '正在模拟发送', succeeded: '模拟发送成功', failed: '模拟发送失败', unknown: '模拟结果未知',
};

class InboxRequestError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

async function inboxRequest<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST', signal,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw new InboxRequestError(result.error || `请求失败（${response.status}）`, response.status);
  return result as T;
}

function errorMessage(error: unknown) { return error instanceof Error ? error.message : '暂时无法完成请求。'; }
function shortId(id: string) { return id.length > 14 ? `…${id.slice(-14)}` : id; }
function messageTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}
function matchPrepared(reply: InboxReply, pending: PrepareInboxReply) {
  // The server also deduplicates identical immutable payloads and retains the original key.
  return reply.idempotencyKey === pending.idempotencyKey || (
    reply.threadId === pending.threadId && reply.sourceMessageId === pending.sourceMessageId &&
    reply.content === pending.content && reply.demoOutcome === pending.demoOutcome
  );
}

export default function Inbox() {
  const [snapshot, setSnapshot] = useState<InboxSnapshot | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [outcome, setOutcome] = useState<DemoDeliveryOutcome>('succeeded');
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [pendingPrepare, setPendingPrepare] = useState<PrepareInboxReply | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [uncertainSends, setUncertainSends] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<'load' | 'prepare' | 'send' | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const epoch = useRef(0);
  const readSequence = useRef(0);
  const mounted = useRef(true);
  const operation = useRef(false);
  const readController = useRef<AbortController | null>(null);
  const shouldFocusSource = useRef(false);
  const thread = snapshot?.threads.find((item) => item.id === selectedThreadId);
  const source = thread?.messages.find((message) => message.id === sourceId);
  const preview = snapshot?.replies.find((reply) => reply.id === previewId);
  const previewThread = snapshot?.threads.find((item) => item.id === preview?.threadId);
  const previewSource = previewThread?.messages.find((message) => message.id === preview?.sourceMessageId);
  const sendUncertain = !!preview && uncertainSends.has(preview.id);
  const frozen = !!preview || !!pendingPrepare || busy === 'prepare' || busy === 'send';
  const selectedReplies = snapshot?.replies.filter((reply) => reply.threadId === selectedThreadId).toReversed() ?? [];

  const refresh = useCallback(async () => {
    if (readController.current) return;
    const sequence = ++readSequence.current;
    const controller = new AbortController();
    readController.current = controller;
    setRefreshing(true);
    try {
      const result = await inboxRequest<{ inbox: InboxSnapshot }>('/api/inbox', undefined, controller.signal);
      if (!mounted.current || sequence !== readSequence.current) return;
      setSnapshot(result.inbox);
      setReadError('');
      setSelectedThreadId((id) => id ?? result.inbox.threads[0]?.id ?? null);
    } catch (reason) {
      if (mounted.current && !controller.signal.aborted && sequence === readSequence.current) setReadError(errorMessage(reason));
    } finally {
      if (readController.current === controller) readController.current = null;
      if (mounted.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 1000);
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      mounted.current = false;
      readController.current?.abort();
      readController.current = null;
      readSequence.current++;
      epoch.current++;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  useEffect(() => {
    if (!pendingPrepare || previewId) return;
    const recovered = snapshot?.replies.find((reply) => matchPrepared(reply, pendingPrepare));
    if (recovered && recovered.threadId === selectedThreadId) {
      setPreviewId(recovered.id);
      setPendingPrepare(null);
      setConfirmed(false);
    }
  }, [pendingPrepare, previewId, selectedThreadId, snapshot]);

  useEffect(() => {
    if (shouldFocusSource.current && sourceId) {
      const item = document.getElementById(`inbox-message-${sourceId}`);
      item?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      item?.focus({ preventScroll: true });
      shouldFocusSource.current = false;
    }
  }, [sourceId, selectedThreadId]);

  function resetReply() {
    setDraft(''); setSourceId(null); setPreviewId(null); setPendingPrepare(null);
    setConfirmed(false); setError(''); setOutcome('succeeded');
  }
  function selectThread(id: string, messageId?: string) {
    epoch.current++;
    operation.current = false;
    setBusy(null);
    resetReply();
    setSelectedThreadId(id);
    if (messageId) { shouldFocusSource.current = true; setSourceId(messageId); }
  }
  function locateMessage(id: string) {
    const owner = snapshot?.threads.find((item) => item.messages.some((message) => message.id === id));
    if (owner) selectThread(owner.id, id);
  }
  function mergeReply(reply: InboxReply) {
    readSequence.current++;
    setSnapshot((current) => current ? {
      ...current, replies: [...current.replies.filter((item) => item.id !== reply.id), reply],
    } : current);
  }
  async function loadDemo() {
    if (operation.current) return;
    const selection = epoch.current;
    operation.current = true;
    setBusy('load'); setError('');
    readSequence.current++;
    try {
      const result = await inboxRequest<{ inbox: InboxSnapshot }>('/api/inbox/demo', {});
      if (!mounted.current || selection !== epoch.current) return;
      readSequence.current++;
      setSnapshot(result.inbox);
      setSelectedThreadId((id) => id ?? result.inbox.threads[0]?.id ?? null);
    } catch (reason) {
      if (mounted.current && selection === epoch.current) setError(errorMessage(reason));
    } finally {
      if (mounted.current && selection === epoch.current) { operation.current = false; setBusy(null); }
    }
  }
  async function prepare(event: FormEvent) {
    event.preventDefault();
    if (operation.current || frozen || !thread || !source || !draft.trim()) return;
    const selection = epoch.current;
    const pending: PrepareInboxReply = {
      threadId: thread.id, sourceMessageId: source.id, content: draft,
      idempotencyKey: crypto.randomUUID(), demoOutcome: outcome,
    };
    operation.current = true;
    setBusy('prepare'); setPendingPrepare(pending); setConfirmed(false); setError('');
    readSequence.current++;
    try {
      const result = await inboxRequest<{ reply: InboxReply }>('/api/inbox/replies', pending);
      if (!mounted.current || selection !== epoch.current) return;
      mergeReply(result.reply);
      setPreviewId(result.reply.id);
      setPendingPrepare(null);
    } catch (reason) {
      if (mounted.current && selection === epoch.current) {
        if (reason instanceof InboxRequestError && reason.status >= 400 && reason.status < 500) {
          setPendingPrepare(null);
          setError(`预览未创建：${errorMessage(reason)}。可以修改后重新预览。`);
        } else {
          setError(`预览请求结果待核对：${errorMessage(reason)}。已保留请求标识；请查询状态，不会自动重发。`);
        }
      }
    } finally {
      if (mounted.current && selection === epoch.current) { operation.current = false; setBusy(null); }
    }
  }
  async function send() {
    if (operation.current || !preview || preview.status !== 'draft' || sendUncertain || (preview.reviewRequired && !confirmed)) return;
    const selection = epoch.current;
    const replyId = preview.id;
    operation.current = true;
    setBusy('send'); setError('');
    readSequence.current++;
    try {
      const result = await inboxRequest<{ reply: InboxReply }>(`/api/inbox/replies/${encodeURIComponent(replyId)}/send`, {
        intent: 'send-reply', ...(preview.reviewRequired ? { confirmReview: true } : {}),
      });
      if (!mounted.current || selection !== epoch.current) return;
      mergeReply(result.reply);
    } catch (reason) {
      if (!mounted.current) return;
      setUncertainSends((ids) => new Set(ids).add(replyId));
      if (selection === epoch.current) setError(`发送请求结果待核对：${errorMessage(reason)}。已保留回复标识；只查询状态，不再提交发送。`);
    } finally {
      if (mounted.current && selection === epoch.current) { operation.current = false; setBusy(null); }
    }
  }
  function cancelPreview() {
    if (busy || !preview || preview.status !== 'draft' || sendUncertain) return;
    setDraft(preview.content); setPreviewId(null); setPendingPrepare(null); setConfirmed(false); setError('');
  }
  function viewReply(reply: InboxReply) {
    epoch.current++;
    operation.current = false;
    setBusy(null); setPreviewId(reply.id); setPendingPrepare(null); setSourceId(reply.sourceMessageId);
    setDraft(reply.content); setOutcome(reply.demoOutcome); setConfirmed(false); setError('');
  }

  return <div className="inbox-view">
    <header className="inbox-page-heading">
      <div><div className="welcome-eyebrow"><span /> WORK, WITH CONTEXT</div><h1>消息有来处，<br />工作有下一步。</h1><p>把项目需求、期限与待确认事项放在一起，回复前先看清原文与目标。</p></div>
      <span className="badge simulation inbox-mode-badge">合成数据 · 模拟收件箱</span>
    </header>
    <div className="inbox-scope"><ShieldCheck size={17} /><p>当前仅使用固定合成数据与规则整理。真实微信未接入；不保障实时或锁屏接收。</p></div>
    {readError && <div className="inbox-error" role="alert"><TriangleAlert size={16} /><span>收件箱暂未更新：{readError}</span><button onClick={() => void refresh()} disabled={refreshing}>重试读取</button></div>}
    {error && <div className="inbox-error" role="alert"><TriangleAlert size={16} /><span>{error}</span><button aria-label="关闭收件箱提示" onClick={() => setError('')}><X size={16} /></button></div>}
    {!snapshot ? <div className="inbox-loading"><LoaderCircle size={24} className="spin" /><p>正在读取本地模拟收件箱…</p></div> : !snapshot.threads.length ? <div className="inbox-empty"><span className="inbox-empty-icon"><InboxIcon size={35} strokeWidth={1.3} /></span><div className="section-label">从一组演示消息开始</div><h2>让工作消息，变得有条理。</h2><p>显式载入合成消息，体验项目整理、原文追溯<br />与回复预览。不会读取或发送真实微信消息。</p><button className="primary-button" data-testid="inbox-load-demo" disabled={!!busy} onClick={() => void loadDemo()}>{busy === 'load' ? <LoaderCircle size={16} className="spin" /> : <Sparkles size={16} />}载入合成演示<ArrowRight size={15} /></button></div> : <>
      <div className="inbox-section-heading"><div><h2>项目概览</h2><span className="badge simulation">规则模拟整理</span></div><button className="inbox-text-action" data-testid="inbox-load-demo" disabled={!!busy} onClick={() => void loadDemo()}><RefreshCw size={13} />再次载入演示<span>去重保留状态</span></button></div>
      <div className="inbox-projects">{snapshot.projects.map((project) => <article className="inbox-project" key={project.id}><header><span className="inbox-project-icon"><FileText size={18} /></span><h3>{project.name}</h3><span className="badge planned">合成项目</span></header><div className="inbox-project-columns">{[
        { label: '需求', icon: FileText, items: project.requirements },
        { label: '期限', icon: Clock3, items: project.deadlines },
        { label: '待确认', icon: CircleHelp, items: project.questions },
      ].map((column) => <section key={column.label}><h4><column.icon size={14} />{column.label}</h4>{column.items.length ? <ul>{column.items.map((item, index) => <li key={`${item.sourceMessageId}-${index}`}><span>{item.text}</span><button onClick={() => locateMessage(item.sourceMessageId)} aria-label={`查看原文：${item.text}`}><Link2 size={11} />原文</button></li>)}</ul> : <p className="inbox-no-items">暂无此类事项</p>}</section>)}</div></article>)}</div>
      <div className="inbox-section-heading"><div><h2>会话与回复</h2><span>{snapshot.threads.length} 个合成会话</span></div><span className="inbox-read-status"><i className="status-dot" />{refreshing ? '正在更新' : '页面打开时每秒查询'}</span></div>
      <div className="inbox-workbench">
        <nav className="inbox-threads" aria-label="合成工作会话">{snapshot.threads.map((item) => <button key={item.id} data-testid="inbox-thread" data-thread-id={item.id} className={`inbox-thread ${item.id === selectedThreadId ? 'selected' : ''}`} aria-current={item.id === selectedThreadId ? 'true' : undefined} onClick={() => selectThread(item.id)}><span className="inbox-thread-icon"><MessageCircle size={17} /></span><span><strong>{item.title}</strong><small>{item.messages.length} 条合成消息 · {shortId(item.externalThreadId)}</small></span><ChevronRight size={14} /></button>)}</nav>
        {thread && <div className="inbox-thread-detail"><header className="inbox-thread-heading"><div><h3>{thread.title}</h3><p>账号 {shortId(thread.accountId)} · 原会话 {shortId(thread.externalThreadId)}</p></div><span className="badge simulation">合成原文</span></header>
          <div className="inbox-messages">{thread.messages.map((message) => <SourceMessage key={message.id} message={message} selected={message.id === sourceId} disabled={frozen} onSelect={() => { setSourceId(message.id); setConfirmed(false); setError(''); }} />)}</div>
          <section className="inbox-reply-section" aria-label="模拟回复编辑与预览">
            <div className="inbox-reply-label"><Send size={16} /><h3>{preview ? '核对这条模拟回复' : '回复所选原消息'}</h3><span>输入与预览均不会发送</span></div>
            {!preview && <form onSubmit={(event) => void prepare(event)}>
              {source ? <div className="inbox-selected-source"><span>回复原文 · {source.sender}</span><blockquote>{source.text}</blockquote></div> : <p className="inbox-select-hint">先在上方选择一条原消息，固定本次回复的目标。</p>}
              <label className="sr-only" htmlFor="inbox-reply-input">回复内容</label><textarea id="inbox-reply-input" data-testid="inbox-reply-input" value={draft} onChange={(event) => setDraft(event.target.value)} disabled={frozen || !source} placeholder="在这里写回复。只有核对预览后点击发送，才会模拟发送。" maxLength={4000} rows={4} />
              <div className="inbox-compose-controls"><label>演示结果<select data-testid="inbox-outcome" value={outcome} disabled={frozen} onChange={(event) => setOutcome(event.target.value as DemoDeliveryOutcome)}><option value="succeeded">模拟成功</option><option value="failed">模拟失败</option><option value="unknown">模拟结果未知</option></select><span>仅控制模拟</span></label><button type="submit" className="primary-button" data-testid="inbox-preview" disabled={!source || !draft.trim() || frozen}>{busy === 'prepare' ? <LoaderCircle size={15} className="spin" /> : <FileText size={15} />}预览回复</button></div>
            </form>}
            {pendingPrepare && !preview && <div className="inbox-pending"><Clock3 size={16} /><div><strong>{busy === 'prepare' ? '正在创建不可变预览' : '预览请求结果待核对'}</strong><p>请求标识 {shortId(pendingPrepare.idempotencyKey)} · 仅查询已保存的预览，不自动重复提交。</p><button className="secondary-button" data-testid="inbox-refresh-status" onClick={() => void refresh()} disabled={refreshing}>查询状态</button></div></div>}
            {preview && <div className="inbox-preview-card" data-testid="inbox-reply-preview">
              <div className="inbox-preview-target"><span className="section-label">固定发送目标 · 合成微信会话</span><strong>{preview.targetTitle}</strong><p>账号 <code>{preview.accountId}</code> · 会话 ID <code>{preview.externalThreadId}</code></p><span className="inbox-reply-reference">回复 ID {shortId(preview.id)}</span></div>
              <div className="inbox-preview-source"><span>引用原文 · {previewSource?.sender ?? '原消息'}</span><blockquote>{previewSource?.text ?? '原消息暂未读取，请先查询状态。'}</blockquote></div>
              <div className="inbox-preview-content"><span>完整回复内容</span><p>{preview.content}</p></div>
              {preview.reviewRequired && <div className="inbox-review"><ShieldCheck size={18} /><div><strong>这条回复需要独立复核</strong><p>{preview.reviewReason ?? '涉及敏感或高影响内容，请核对原文、接收目标与完整回复。'}</p>{preview.status === 'draft' && !sendUncertain && <label><input type="checkbox" data-testid="inbox-review" checked={confirmed} disabled={busy === 'send'} onChange={(event) => setConfirmed(event.target.checked)} />我已核对目标、原文与风险，确认发送这条模拟回复。</label>}</div></div>}
              <div className={`inbox-delivery inbox-delivery-${sendUncertain && preview.status === 'draft' ? 'unknown' : preview.status}`} role="status" data-testid="inbox-reply-status" data-status={sendUncertain && preview.status === 'draft' ? 'unknown' : preview.status}><span>{preview.status === 'sending' || busy === 'send' ? <LoaderCircle size={16} className="spin" /> : preview.status === 'succeeded' ? <CheckCheck size={16} /> : preview.status === 'failed' || preview.status === 'unknown' || sendUncertain ? <TriangleAlert size={16} /> : <ShieldCheck size={16} />}{busy === 'send' ? '正在提交模拟发送' : sendUncertain && preview.status === 'draft' ? '发送请求结果未知，尚待核对' : deliveryLabels[preview.status]}</span>{preview.receiptId && <small>模拟回执 {shortId(preview.receiptId)}</small>}{preview.error && <p>{preview.error}</p>}{(preview.status === 'unknown' || sendUncertain) && <p>结果不确定时不会重发。查询状态只读取记录，不会再次提交发送。</p>}</div>
              <div className="inbox-preview-actions">{preview.status === 'draft' && !sendUncertain ? <><button className="primary-button" data-testid="inbox-send" onClick={() => void send()} disabled={busy === 'send' || !previewSource || (preview.reviewRequired && !confirmed)}><Send size={14} />发送模拟回复</button><button className="secondary-button" data-testid="inbox-cancel-preview" disabled={!!busy} onClick={cancelPreview}>取消预览并修改</button></> : <button className="secondary-button" data-testid="inbox-refresh-status" onClick={() => void refresh()} disabled={refreshing}><RefreshCw size={14} />查询状态</button>}{preview.status !== 'draft' && preview.status !== 'sending' && busy !== 'send' && <button className="inbox-text-action" onClick={resetReply}>返回会话</button>}</div>
              <p className="inbox-preview-footnote">仅演示发送到上方合成原会话，不连接真实微信。预览的目标和内容不能直接修改。</p>
            </div>}
          </section>
          {selectedReplies.length > 0 && <section className="inbox-history"><div className="section-label">本会话的模拟回复记录 <span>{selectedReplies.length}</span></div>{selectedReplies.map((reply) => <button key={reply.id} className="inbox-history-row" disabled={busy === 'send' || busy === 'prepare'} onClick={() => viewReply(reply)}><span>{reply.status === 'succeeded' ? <Check size={14} /> : <Clock3 size={14} />}</span><strong>{reply.content}</strong><span>{uncertainSends.has(reply.id) && reply.status === 'draft' ? '结果待核对' : deliveryLabels[reply.status]}</span><ChevronRight size={13} /></button>)}</section>}
        </div>}
      </div>
    </>}
  </div>;
}

function SourceMessage({ message, selected, disabled, onSelect }: { message: InboxMessage; selected: boolean; disabled: boolean; onSelect: () => void }) {
  return <article id={`inbox-message-${message.id}`} tabIndex={-1} className={`inbox-source-message ${selected ? 'selected' : ''}`}><header><span className="inbox-sender-avatar">{message.sender.slice(0, 1)}</span><strong>{message.sender}</strong><time>{messageTime(message.receivedAt)}</time>{message.risk !== 'normal' && <span className="badge simulation">需复核</span>}</header><p>{message.text}</p><footer><span>原消息 {shortId(message.externalId)}</span><button data-testid="inbox-source" data-message-id={message.id} disabled={disabled} aria-pressed={selected} onClick={onSelect}>{selected ? <Check size={13} /> : <MessageCircle size={13} />}{selected ? '已选中此原文' : '选择此消息回复'}</button></footer></article>;
}
