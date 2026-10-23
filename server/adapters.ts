import type { AdapterInfo, EngineDriver, ExecutionAdapter, ExecutionContext } from '../shared/types.ts';

/** Real providers become available only through explicit local startup configuration. */
export const adapterCatalog: AdapterInfo[] = [
  { id: 'hermes', name: 'Hermes Agent', description: '通过本机 Hermes 执行任务；进度、审批、停止与恢复以执行器回执为准。', available: false, kind: 'http', reason: '尚未启用；由本机操作者配置 Hermes API 并完成连接验证。' },
  { id: 'mock-codex', name: 'Codex · 模拟', description: '本地确定性模拟，验证流式聊天与任务流程；不调用 Codex。', available: true, kind: 'mock' },
  { id: 'mock-claude', name: 'Claude · 模拟', description: '本地确定性模拟，验证第二种执行适配器；不调用 Claude。', available: true, kind: 'mock' },
  { id: 'codex', name: 'Codex exec · 旧模式', description: '旧版 exec 文本适配器：受限只读对话，不支持原生审批或线程恢复。', available: false, kind: 'cli', reason: '本地未启用 Codex；需要显式配置官方 CLI 路径并使用已有登录。' },
  { id: 'codex-app-server', name: 'Codex App Server', description: '原生持久线程、单次审批与中断；固定本地测试目录，执行结果未知时停止重试。', available: false, kind: 'cli', reason: '需要本机显式启用官方 App Server 0.162.1。' },
  { id: 'claude', name: 'Claude Agent', description: '通过官方 Claude Agent SDK 执行任务；审批、停止与结果以执行器回执为准。', available: false, kind: 'cli', reason: '尚未启用；需要本机配置官方 SDK、CLI 与登录，真实任务和账号可用性待验证。' },
];

export function createAdapterRegistry(delayMs: number, codex?: ExecutionAdapter, nativeDriver?: EngineDriver, drivers: EngineDriver[] = []) {
  const adapters = createMockAdapters(delayMs);
  if (codex) {
    if (codex.info.id !== 'codex' || codex.info.kind !== 'cli' || !codex.info.available) throw new Error('Invalid internal Codex adapter.');
    adapters.set('codex', codex);
  }
  if (nativeDriver) {
    if (nativeDriver.info.id !== 'codex-app-server' || nativeDriver.info.kind !== 'cli' || !nativeDriver.info.available) throw new Error('Invalid internal App Server driver.');
    adapters.set('codex-app-server', nativeDriver);
  }
  for (const driver of drivers) {
    const expectedKind = driver.info.id === 'hermes' ? 'http' : driver.info.id === 'codex-app-server' || driver.info.id === 'claude' ? 'cli' : undefined;
    if (!expectedKind || driver.info.kind !== expectedKind || !driver.info.available || adapters.has(driver.info.id)) {
      throw new Error('Invalid or duplicate internal execution driver.');
    }
    adapters.set(driver.info.id, driver);
  }
  const catalog = adapterCatalog.map(info => structuredClone(adapters.get(info.id)?.info ?? info));
  return { adapters, catalog };
}

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
