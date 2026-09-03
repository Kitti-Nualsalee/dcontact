import type { WorkspaceTabLeaderElection } from './leader-election.js';

export interface RoutingSocket {
  close(): void;
}

export class WorkspaceRuntime {
  private routingSocket?: RoutingSocket;
  private heartbeatTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly election: WorkspaceTabLeaderElection,
    private readonly connectRoutingSocket: () => RoutingSocket,
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
    this.connect();
  }

  stop(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    this.disconnect();
    this.election.stop();
  }

  private connect(): void {
    this.routingSocket ??= this.connectRoutingSocket();
  }

  private disconnect(): void {
    this.routingSocket?.close();
    this.routingSocket = undefined;
  }
}
