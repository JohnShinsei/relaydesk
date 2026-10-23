import type { AdapterId, EngineBinding } from '../shared/types.ts';

/** A provider may have accepted a task. Inspect the exact task; never replay its prompt. */
export class NativeOutcomeUnknownError extends Error {}

export function isDriverAdapterId(id: AdapterId): id is EngineBinding['driverId'] {
  return id === 'codex-app-server' || id === 'hermes' || id === 'claude';
}

/** Driver bindings are local persisted evidence, never browser-supplied execution targets. */
export function bindingMatchesDriver(binding: EngineBinding, driverId: AdapterId): boolean {
  return binding.driverId === driverId && typeof binding.threadId === 'string' && binding.threadId.length > 0;
}
