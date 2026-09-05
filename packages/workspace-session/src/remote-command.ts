export type RemoteCommandRetry = 'never' | 'once';

export interface DesiredStateCommand {
  commandId: string;
  resourceId: string;
  resourceVersion: number;
  action: string;
  retry: RemoteCommandRetry;
  payload?: Readonly<Record<string, unknown>>;
}

export interface AuthoritativeCommandResult {
  commandId: string;
  outcome: 'APPLIED' | 'REJECTED';
  resourceVersion: number;
  reason?: string;
}

export interface ReconciledCommandResult {
  outcome: 'APPLIED' | 'NOT_APPLIED' | 'REJECTED';
  resourceVersion: number;
  reason?: string;
}

export interface RemoteCommandTransport {
  send(command: DesiredStateCommand): Promise<void>;
  reconcile(command: DesiredStateCommand): Promise<ReconciledCommandResult>;
}

export interface RemoteCommandCoordinatorOptions {
  now?: () => number;
  acknowledgementTimeoutMs?: number;
  uncertaintyTimeoutMs?: number;
}

export type RemoteCommandState =
  | { phase: 'IDLE' }
  | {
      phase: 'PENDING' | 'SUCCEEDED' | 'REJECTED' | 'CONTROL_DEGRADED';
      commandId: string;
      action: string;
      resourceVersion: number;
      attempts: number;
      reason?: string;
    };

export class RemoteCommandCoordinator {
  private state: RemoteCommandState = { phase: 'IDLE' };
  private command?: DesiredStateCommand;
  private startedAt?: number;
  private reconciled = false;
  private readonly now: () => number;
  private readonly acknowledgementTimeoutMs: number;
  private readonly uncertaintyTimeoutMs: number;

  constructor(
    private readonly transport: RemoteCommandTransport,
    options: RemoteCommandCoordinatorOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.acknowledgementTimeoutMs = options.acknowledgementTimeoutMs ?? 5_000;
    this.uncertaintyTimeoutMs = options.uncertaintyTimeoutMs ?? 15_000;
  }

  current(): RemoteCommandState {
    return this.state;
  }

  async execute(command: DesiredStateCommand): Promise<RemoteCommandState> {
    if (this.state.phase === 'PENDING') {
      throw new Error('command ' + this.state.commandId + ' is still pending');
    }
    this.command = command;
    this.startedAt = this.now();
    this.reconciled = false;
    this.state = {
      phase: 'PENDING',
      commandId: command.commandId,
      action: command.action,
      resourceVersion: command.resourceVersion,
      attempts: 1,
    };
    await this.transport.send(command);
    return this.state;
  }

  async reconcileIfDue(): Promise<RemoteCommandState> {
    if (this.state.phase !== 'PENDING' || !this.command || this.startedAt === undefined) {
      return this.state;
    }
    const elapsedMs = this.now() - this.startedAt;
    if (elapsedMs >= this.uncertaintyTimeoutMs) {
      this.state = {
        ...this.state,
        phase: 'CONTROL_DEGRADED',
        reason: 'authoritative result remained uncertain for ' + this.uncertaintyTimeoutMs + 'ms',
      };
      return this.state;
    }
    if (elapsedMs < this.acknowledgementTimeoutMs || this.reconciled) {
      return this.state;
    }

    this.reconciled = true;
    const result = await this.transport.reconcile(this.command);
    if (result.outcome === 'APPLIED' || result.outcome === 'REJECTED') {
      return this.observe({
        commandId: this.command.commandId,
        outcome: result.outcome,
        resourceVersion: result.resourceVersion,
        ...(result.reason ? { reason: result.reason } : {}),
      });
    }
    if (this.command.retry === 'once' && this.state.attempts === 1) {
      await this.transport.send(this.command);
      this.state = { ...this.state, attempts: 2 };
    }
    return this.state;
  }

  observe(result: AuthoritativeCommandResult): RemoteCommandState {
    if (!this.command || result.commandId !== this.command.commandId) return this.state;
    this.state = {
      phase: result.outcome === 'APPLIED' ? 'SUCCEEDED' : 'REJECTED',
      commandId: this.command.commandId,
      action: this.command.action,
      resourceVersion: result.resourceVersion,
      attempts: this.state.phase === 'IDLE' ? 1 : this.state.attempts,
      ...(result.reason ? { reason: result.reason } : {}),
    };
    return this.state;
  }
}
