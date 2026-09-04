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

export class WorkspaceRuntime {
  private routingSocket?: RoutingSocket;
  private heartbeatTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly election: WorkspaceTabLeaderElection,
    private readonly connectRoutingSocket: (
      mode: RoutingSocketMode,
      onEvent: WorkspaceRoutingEventHandler,
    ) => RoutingSocket,
    private readonly showRoutingOffer: (offer: WorkspaceRoutingOffer) => void = () => undefined,
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
    this.routingSocket ??= this.connectRoutingSocket(mode, (event) =>
      this.handleRoutingEvent(event),
    );
  }

  private disconnect(): void {
    this.routingSocket?.close();
    this.routingSocket = undefined;
  }

  private handleRoutingEvent(event: unknown): void {
    if (!event || typeof event !== 'object' || Array.isArray(event)) return;
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
}
