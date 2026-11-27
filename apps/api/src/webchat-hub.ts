/**
 * #1044: tells waiting clients that a chat changed. In-process only: the API that commits a change is
 * the one holding the visitor's long poll and the Agents' sockets. Clients also poll on a slow timer,
 * so a missed notice (another API instance, a restart) delays an update instead of losing it.
 */
export interface WebchatNotice {
  tenantId: string;
  sessionIds?: readonly string[];
  agentIds?: readonly string[];
}

type AgentListener = (tenantId: string, agentIds: readonly string[]) => void;

export class WebchatHub {
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly agentListeners = new Set<AgentListener>();

  /** `holdProcess` keeps the process alive while a wait is pending; off in the API so shutdown is not delayed */
  constructor(private readonly options: { holdProcess?: boolean } = {}) {}

  onAgents(listener: AgentListener): void {
    this.agentListeners.add(listener);
  }

  publish(notice: WebchatNotice): void {
    for (const sessionId of new Set(notice.sessionIds ?? [])) {
      const key = `${notice.tenantId}:${sessionId}`;
      const waiting = this.waiters.get(key);
      if (!waiting) continue;
      this.waiters.delete(key);
      for (const wake of waiting) wake();
    }
    const agentIds = [...new Set(notice.agentIds ?? [])];
    if (agentIds.length === 0) return;
    for (const listener of this.agentListeners) {
      try {
        listener(notice.tenantId, agentIds);
      } catch {
        // a broken listener must not stop the others or fail the request that published
      }
    }
  }

  /** Resolves `true` when the session changes, or `false` after the timeout or when aborted. */
  waitForSession(
    tenantId: string,
    sessionId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const key = `${tenantId}:${sessionId}`;
    return new Promise((resolve) => {
      const waiting = this.waiters.get(key) ?? new Set<() => void>();
      this.waiters.set(key, waiting);
      const finish = (changed: boolean) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        waiting.delete(wake);
        if (waiting.size === 0 && this.waiters.get(key) === waiting) this.waiters.delete(key);
        resolve(changed);
      };
      const wake = () => finish(true);
      const onAbort = () => finish(false);
      const timer = setTimeout(() => finish(false), timeoutMs);
      if (!this.options.holdProcess) timer.unref?.();
      waiting.add(wake);
      if (signal?.aborted) finish(false);
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
