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
