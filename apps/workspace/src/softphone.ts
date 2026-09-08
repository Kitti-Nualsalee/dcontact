export interface SipCredentialLease {
  leaseId: string;
  extension: string;
  authorizationUsername: string;
  authorizationPassword: string;
  sipDomain: string;
  wssUrl: string;
  telephonyNodeId: string;
  iceServers: { urls: string[]; username?: string; credential?: string }[];
  expiresAt: string;
}

export interface BrowserSipTransport {
  configure(lease: SipCredentialLease): Promise<void>;
  register(): Promise<void>;
  unregister(): Promise<void>;
  accept(): Promise<void>;
  reject(): Promise<void>;
  hold(): Promise<void>;
  resume(): Promise<void>;
  sendDtmf(value: string): Promise<void>;
  hangup(): Promise<void>;
  setMuted(muted: boolean): void;
}

export type SoftphoneState =
  | { phase: 'OFFLINE' }
  | { phase: 'REGISTERING' | 'READY'; telephonyNodeId: string }
  | {
      phase: 'RINGING' | 'CONNECTING' | 'ACTIVE' | 'HELD';
      interactionId: string;
      telephonyNodeId: string;
    }
  | {
      phase: 'RECONNECTING' | 'RECOVERY_REQUIRED';
      telephonyNodeId: string;
      attempts: number;
      interactionId?: string;
    };

export interface BrowserSoftphoneOptions {
  sleep?: (milliseconds: number) => Promise<void>;
  maxReconnectAttempts?: number;
}

interface SoftphoneReadiness {
  ownsWorkingTab: boolean;
  mediaReady: boolean;
}

export class BrowserSoftphone {
  private state: SoftphoneState = { phase: 'OFFLINE' };
  private lease?: SipCredentialLease;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly maxReconnectAttempts: number;

  constructor(
    private readonly transport: BrowserSipTransport,
    options: BrowserSoftphoneOptions = {},
  ) {
    this.sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 6;
  }

  current(): SoftphoneState {
    return this.state;
  }

  async start(lease: SipCredentialLease, readiness: SoftphoneReadiness): Promise<SoftphoneState> {
    if (!readiness.ownsWorkingTab || !readiness.mediaReady) {
      this.state = { phase: 'OFFLINE' };
      return this.state;
    }
    this.lease = lease;
    this.state = { phase: 'REGISTERING', telephonyNodeId: lease.telephonyNodeId };
    await this.transport.configure(lease);
    await this.transport.register();
    this.state = { phase: 'READY', telephonyNodeId: lease.telephonyNodeId };
    return this.state;
  }

  async stop(): Promise<SoftphoneState> {
    if (this.state.phase !== 'OFFLINE') await this.transport.unregister();
    this.lease = undefined;
    this.state = { phase: 'OFFLINE' };
    return this.state;
  }

  async receiveInvitation(interactionId: string): Promise<SoftphoneState> {
    if (this.state.phase !== 'READY') {
      await this.transport.reject();
      return this.state;
    }
    this.state = {
      phase: 'RINGING',
      interactionId,
      telephonyNodeId: this.state.telephonyNodeId,
    };
    return this.state;
  }

  async accept(): Promise<SoftphoneState> {
    if (this.state.phase !== 'RINGING') throw new Error('accept requires RINGING softphone');
    const next: SoftphoneState = { ...this.state, phase: 'CONNECTING' };
    await this.transport.accept();
    this.state = next;
    return this.state;
  }

  connected(): SoftphoneState {
    if (this.state.phase !== 'CONNECTING') return this.state;
    this.state = { ...this.state, phase: 'ACTIVE' };
    return this.state;
  }

  terminated(): SoftphoneState {
    if (!this.lease || this.state.phase === 'OFFLINE') return this.state;
    this.state = { phase: 'READY', telephonyNodeId: this.lease.telephonyNodeId };
    return this.state;
  }

  setMuted(muted: boolean): void {
    if (this.state.phase !== 'ACTIVE' && this.state.phase !== 'HELD') {
      throw new Error('mute requires ACTIVE or HELD softphone');
    }
    this.transport.setMuted(muted);
  }

  async hold(): Promise<SoftphoneState> {
    if (this.state.phase !== 'ACTIVE') throw new Error('hold requires ACTIVE softphone');
    await this.transport.hold();
    this.state = { ...this.state, phase: 'HELD' };
    return this.state;
  }

  async resume(): Promise<SoftphoneState> {
    if (this.state.phase !== 'HELD') throw new Error('resume requires HELD softphone');
    await this.transport.resume();
    this.state = { ...this.state, phase: 'ACTIVE' };
    return this.state;
  }

  async sendDtmf(value: string): Promise<SoftphoneState> {
    if (this.state.phase !== 'ACTIVE') throw new Error('DTMF requires ACTIVE softphone');
    await this.transport.sendDtmf(value);
    return this.state;
  }

  async hangup(): Promise<SoftphoneState> {
    if (
      this.state.phase !== 'CONNECTING' &&
      this.state.phase !== 'ACTIVE' &&
      this.state.phase !== 'HELD'
    ) {
      throw new Error('hangup requires a connected softphone');
    }
    const telephonyNodeId = this.state.telephonyNodeId;
    await this.transport.hangup();
    this.state = { phase: 'READY', telephonyNodeId };
    return this.state;
  }

  async registrationLost(): Promise<SoftphoneState> {
    if (!this.lease || this.state.phase === 'OFFLINE') return this.state;
    const interactionId = 'interactionId' in this.state ? this.state.interactionId : undefined;
    for (let attempt = 1; attempt <= this.maxReconnectAttempts; attempt += 1) {
      this.state = {
        phase: 'RECONNECTING',
        telephonyNodeId: this.lease.telephonyNodeId,
        attempts: attempt,
        ...(interactionId ? { interactionId } : {}),
      };
      await this.sleep(Math.min(1_000 * 2 ** (attempt - 1), 10_000));
      try {
        await this.transport.register();
        this.state = interactionId
          ? { phase: 'ACTIVE', interactionId, telephonyNodeId: this.lease.telephonyNodeId }
          : { phase: 'READY', telephonyNodeId: this.lease.telephonyNodeId };
        return this.state;
      } catch {
        // ลองใหม่ตามเพดานที่กำหนด; active Interaction identity เดิมต้องไม่ถูกสร้างซ้ำ
      }
    }
    this.state = {
      phase: 'RECOVERY_REQUIRED',
      telephonyNodeId: this.lease.telephonyNodeId,
      attempts: this.maxReconnectAttempts,
      ...(interactionId ? { interactionId } : {}),
    };
    return this.state;
  }
}
