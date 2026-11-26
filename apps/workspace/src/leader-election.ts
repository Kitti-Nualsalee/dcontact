/**
 * leader election of Workspace tabs within one origin (`BroadcastChannel` + heartbeat in `localStorage`)
 *
 * ADR-026 item 2 (amended in E1.9 #483, used in E1.12 #486): **only a load reducer within an origin — not a guarantee
 * of "a single work point"**; the enforcer is the server-side work-session lease (`/api/v1/me/work-session`) covering every surface
 * including a dphone embedded on another origin, which browsers cannot see
 *
 * - work-session lease (enforced for every tenant since #583): the origin's leader is the only tab that requests the lease automatically
 *   (other tabs fire no duplicate request) — whether work can be taken is decided by the lease alone; losing the leader does not cut a call
 * - no `workSession` (test/harness only): the working tab (leader) connects the WS as in D1 but has no SIP
 */
export interface WorkspaceLeaderLease {
  tabId: string;
  heartbeatAt: number;
}

export interface WorkspaceLeaderStorage {
  read(): WorkspaceLeaderLease | undefined;
  write(lease: WorkspaceLeaderLease): void;
  remove(tabId: string): void;
}

export interface WorkspaceLeaderChannel {
  announce(lease: WorkspaceLeaderLease): void;
  subscribe(listener: (lease: WorkspaceLeaderLease) => void): () => void;
}

export class WorkspaceTabLeaderElection {
  private leader = false;
  private unsubscribe?: () => void;

  constructor(
    readonly tabId: string,
    private readonly storage: WorkspaceLeaderStorage,
    private readonly channel: WorkspaceLeaderChannel,
    private readonly now: () => number = Date.now,
    private readonly leaseMs = 5_000,
  ) {}

  start(): boolean {
    this.unsubscribe = this.channel.subscribe((lease) => this.observe(lease));
    return this.claimIfAvailable();
  }

  claim(): void {
    const lease = { tabId: this.tabId, heartbeatAt: this.now() };
    this.storage.write(lease);
    this.channel.announce(lease);
    this.leader = true;
  }

  heartbeat(): boolean {
    if (!this.leader) return this.claimIfAvailable();
    const current = this.storage.read();
    if (
      current &&
      current.tabId !== this.tabId &&
      this.now() - current.heartbeatAt <= this.leaseMs
    ) {
      this.leader = false;
      return false;
    }
    const lease = { tabId: this.tabId, heartbeatAt: this.now() };
    this.storage.write(lease);
    this.channel.announce(lease);
    return true;
  }

  stop(): void {
    this.unsubscribe?.();
    if (this.leader) this.storage.remove(this.tabId);
    this.leader = false;
  }

  isWorkingTab(): boolean {
    return this.leader && this.storage.read()?.tabId === this.tabId;
  }

  private claimIfAvailable(): boolean {
    const current = this.storage.read();
    if (!current || this.now() - current.heartbeatAt > this.leaseMs) this.claim();
    else this.leader = current.tabId === this.tabId;
    return this.isWorkingTab();
  }

  private observe(lease: WorkspaceLeaderLease): void {
    if (
      lease.tabId !== this.tabId &&
      lease.heartbeatAt >= (this.storage.read()?.heartbeatAt ?? 0)
    ) {
      this.leader = false;
    }
  }
}

export function createBrowserWorkspaceLeaderElection(tabId: string): WorkspaceTabLeaderElection {
  const key = 'dcontact.workspace.leader';
  const broadcast = new BroadcastChannel(key);
  return new WorkspaceTabLeaderElection(
    tabId,
    {
      read: () => {
        const value = localStorage.getItem(key);
        return value ? (JSON.parse(value) as WorkspaceLeaderLease) : undefined;
      },
      write: (lease) => localStorage.setItem(key, JSON.stringify(lease)),
      remove: (owner) => {
        const value = localStorage.getItem(key);
        if (value && (JSON.parse(value) as WorkspaceLeaderLease).tabId === owner)
          localStorage.removeItem(key);
      },
    },
    {
      announce: (lease) => broadcast.postMessage(lease),
      subscribe: (listener) => {
        const handler = (event: MessageEvent<WorkspaceLeaderLease>) => listener(event.data);
        broadcast.addEventListener('message', handler);
        return () => broadcast.removeEventListener('message', handler);
      },
    },
  );
}
