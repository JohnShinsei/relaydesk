import type { AdapterInfo, ExecutionAdapter, ExecutionContext } from '../shared/types.ts';

/** Adapter metadata is explicit: installed or authenticated CLIs are not yet integrated. */
export const adapterCatalog: AdapterInfo[] = [
  { id: 'mock-codex', name: 'Codex · 模拟', description: '本地确定性模拟，验证流式聊天与任务流程；不调用 Codex。', available: true, kind: 'mock' },
  { id: 'mock-claude', name: 'Claude · 模拟', description: '本地确定性模拟，验证第二种执行适配器；不调用 Claude。', available: true, kind: 'mock' },
  { id: 'codex', name: 'Codex CLI', description: '计划接入官方 CLI / SDK。', available: false, kind: 'cli', reason: '尚未实现官方执行适配器；此版本不使用登录状态或会员额度。' },
  { id: 'claude', name: 'Claude Code', description: '计划接入官方 CLI / Agent SDK。', available: false, kind: 'cli', reason: '尚未实现官方执行适配器；此版本不使用登录状态或会员额度。' },
];

export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Aborted')); return; }
    const abort = () => { clearTimeout(timer); reject(new Error('Aborted')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export function createMockAdapters(delayMs: number): Map<string, ExecutionAdapter> {
  return new Map(adapterCatalog.filter(info => info.kind === 'mock').map(info => [info.id, {
    info,
    async execute({ task, history, signal, emit }: ExecutionContext) {
      await pause(delayMs, signal);
      if (task.prompt.trim() === '/fail') throw new Error('模拟失败：这是 /fail 触发的预期测试结果，可重新提交任务。');
      const turn = history.filter(message => message.role === 'user').length;
      const persona = info.id === 'mock-codex' ? 'Codex 模拟适配器' : 'Claude 模拟适配器';
      const reply = task.mode === 'approval-demo'
        ? `【本地模拟 · 已获批准】\n${persona}已完成第 ${turn} 轮的模拟计划：整理「${task.prompt}」。\n结果仅记录在当前会话中，没有执行命令、访问外部服务或发送消息。`
        : `【本地模拟 · ${persona}】\n这是本会话第 ${turn} 轮对话。我收到：「${task.prompt}」。\n这条回复由确定性模拟器逐段生成，已走通前端、网关、执行适配器与会话存储。真实 AI 尚未接入。\n你可以继续追问，或创建一个需要批准的模拟任务。`;
      // Code points keep emoji intact while demonstrating the same chunk boundary used by future adapters.
      const characters = Array.from(reply);
      for (let offset = 0; offset < characters.length; offset += 14) {
        await pause(delayMs, signal);
        if (signal.aborted) return;
        emit(characters.slice(offset, offset + 14).join(''));
      }
    },
  }]));
}
