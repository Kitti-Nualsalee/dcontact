import type { WorkspaceTabLeaderElection } from './leader-election.js';

export interface RoutingSocket {
  close(): void;
  claimWorkingTab?(): void;
}

export type RoutingSocketMode = 'connect' | 'claim';

export interface WorkspaceRoutingOffer {
  type: 'routing.offered';
  interactionId: string;
  tenantId: string;
  userId: string;
}

export type WorkspaceRoutingEventHandler = (event: unknown) => void;

export interface WorkspaceLiveSnapshot {
  sequence: number;
}

export interface WorkspaceLiveEvent {
  type: 'workspace.live';
  sequence: number;
  payload: Record<string, unknown>;
}

export class WorkspaceRuntime {
  private routingSocket?: RoutingSocket;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private liveSequence?: number;

  constructor(
    private readonly election: WorkspaceTabLeaderElection,
    private readonly connectRoutingSocket: (
      mode: RoutingSocketMode,
      onEvent: WorkspaceRoutingEventHandler,
    ) => RoutingSocket,
    private readonly showRoutingOffer: (offer: WorkspaceRoutingOffer) => void = () => undefined,
    private readonly loadLiveSnapshot?: () => Promise<WorkspaceLiveSnapshot>,
    private readonly showLiveEvent: (event: WorkspaceLiveEvent) => void = () => undefined,
  ) {}

  start(): void {
    if (this.election.start()) this.connect();
    this.heartbeatTimer = setInterval(() => this.heartbeat(), 1_000);
  }

  heartbeat(): void {
    if (this.election.heartbeat()) this.connect();
    else this.disconnect();
  }

  moveWorkingTabHere(): void {
    this.election.claim();
    if (this.routingSocket) this.routingSocket.claimWorkingTab?.();
    else this.connect('claim');
  }

  stop(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    this.disconnect();
    this.election.stop();
  }

  private connect(mode: RoutingSocketMode = 'connect'): void {
    if (this.routingSocket) return;
    this.routingSocket = this.connectRoutingSocket(mode, (event) => this.handleRoutingEvent(event));
    void this.refreshLiveSnapshot().catch(() => undefined);
  }

  private disconnect(): void {
    this.routingSocket?.close();
    this.routingSocket = undefined;
  }

  private handleRoutingEvent(event: unknown): void {
    if (!event || typeof event !== 'object' || Array.isArray(event)) return;
    if (this.isLiveEvent(event)) {
      if (this.liveSequence !== undefined && event.sequence !== this.liveSequence + 1) {
        void this.refreshLiveSnapshot().catch(() => undefined);
        return;
      }
      this.liveSequence = event.sequence;
      this.showLiveEvent(event);
      return;
    }
    const candidate = event as Partial<WorkspaceRoutingOffer>;
    if (
      candidate.type !== 'routing.offered' ||
      typeof candidate.interactionId !== 'string' ||
      typeof candidate.tenantId !== 'string' ||
      typeof candidate.userId !== 'string'
    ) {
      return;
    }
    this.showRoutingOffer(candidate as WorkspaceRoutingOffer);
  }

  private isLiveEvent(event: object): event is WorkspaceLiveEvent {
    const candidate = event as Partial<WorkspaceLiveEvent>;
    return (
      candidate.type === 'workspace.live' &&
      Number.isSafeInteger(candidate.sequence) &&
      (candidate.sequence ?? 0) > 0 &&
      Boolean(candidate.payload) &&
      typeof candidate.payload === 'object' &&
      !Array.isArray(candidate.payload)
    );
  }

  private async refreshLiveSnapshot(): Promise<void> {
    if (!this.loadLiveSnapshot) return;
    const snapshot = await this.loadLiveSnapshot();
    if (!Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0) return;
    if (this.liveSequence === undefined || snapshot.sequence >= this.liveSequence) {
      this.liveSequence = snapshot.sequence;
    }
  }
}
