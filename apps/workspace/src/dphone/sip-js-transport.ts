import {
  Invitation,
  Registerer,
  SessionState,
  TransportState,
  UserAgent,
  Web,
  type Session,
  type SessionDescriptionHandlerModifier,
} from 'sip.js';
import type { BrowserSipTransport, SipCredentialLease } from './dphone.js';

export interface SipJsTransportCallbacks {
  onInvitation?(): void;
  onSessionEstablished?(): void;
  onSessionTerminated?(): void;
  onRegistrationLost?(): void;
  onAutoplayBlocked?(): void;
}

export class SipJsBrowserTransport implements BrowserSipTransport {
  private userAgent?: UserAgent;
  private registerer?: Registerer;
  private session?: Invitation;

  constructor(
    private readonly remoteAudio: HTMLAudioElement,
    private readonly callbacks: SipJsTransportCallbacks = {},
  ) {}

  async configure(lease: SipCredentialLease): Promise<void> {
    if (this.userAgent) await this.userAgent.stop();
    const uri = UserAgent.makeURI(`sip:${lease.extension}@${lease.sipDomain}`);
    if (!uri) throw new Error('SIP address is invalid');
    const userAgent = new UserAgent({
      uri,
      authorizationUsername: lease.authorizationUsername,
      authorizationPassword: lease.authorizationPassword,
      transportOptions: { server: lease.wssUrl },
      logBuiltinEnabled: false,
      reconnectionAttempts: 0,
      sessionDescriptionHandlerFactoryOptions: {
        peerConnectionConfiguration: { iceServers: lease.iceServers },
      },
      delegate: {
        onInvite: (invitation) => this.receive(invitation),
      },
    });
    userAgent.transport.stateChange.addListener((state) => {
      if (state === TransportState.Disconnected) this.callbacks.onRegistrationLost?.();
    });
    this.userAgent = userAgent;
    this.registerer = new Registerer(userAgent, { expires: 300, refreshFrequency: 80 });
  }

  async register(): Promise<void> {
    if (!this.userAgent || !this.registerer) throw new Error('SIP transport is not configured');
    if (!this.userAgent.isConnected()) await this.userAgent.start();
    await this.registerer.register();
  }

  async unregister(): Promise<void> {
    if (this.registerer) await this.registerer.unregister().catch(() => undefined);
    if (this.userAgent) await this.userAgent.stop();
    this.session = undefined;
    this.registerer = undefined;
    this.userAgent = undefined;
    this.remoteAudio.srcObject = null;
  }

  async accept(): Promise<void> {
    const session = this.requiredSession();
    await session.accept({
      sessionDescriptionHandlerOptions: { constraints: { audio: true, video: false } },
    });
  }

  async reject(): Promise<void> {
    if (!this.session) return;
    await this.session.reject();
    this.session = undefined;
  }

  async hold(): Promise<void> {
    await this.reinvite([Web.holdModifier]);
  }

  async resume(): Promise<void> {
    await this.reinvite([]);
  }

  async sendDtmf(value: string): Promise<void> {
    if (!/^[0-9A-D*#]+$/i.test(value)) throw new Error('DTMF value is invalid');
    const handler = this.requiredSession().sessionDescriptionHandler;
    if (!handler?.sendDtmf(value)) throw new Error('SIP media cannot send DTMF');
  }

  async hangup(): Promise<void> {
    const session = this.requiredSession();
    if (session.state === SessionState.Established) await session.bye();
    else await session.reject();
  }

  sessionId(): string | undefined {
    return this.session?.id;
  }

  setMuted(muted: boolean): void {
    for (const sender of this.peerConnection()?.getSenders() ?? []) {
      if (sender.track?.kind === 'audio') sender.track.enabled = !muted;
    }
  }

  /**
   * `Session.invite()` resolve ทันทีที่ส่ง re-INVITE — รอ 2xx/ACK ก่อน ไม่อย่างนั้น dphone แสดงพักสาย/กลับเข้าสาย
   * ก่อน media เปลี่ยนจริง และคำสั่งถัดไปถูก SIP.js ปฏิเสธเงียบ ๆ ("Reinvite in progress") (D1.16 #455)
   */
  private reinvite(modifiers: SessionDescriptionHandlerModifier[]): Promise<void> {
    const session = this.requiredSession();
    return new Promise((resolve, reject) => {
      session
        .invite({
          sessionDescriptionHandlerModifiers: modifiers,
          requestDelegate: {
            onAccept: () => resolve(),
            onReject: (response) =>
              reject(new Error(`re-INVITE rejected: ${response.message.statusCode}`)),
          },
        })
        .catch(reject);
    });
  }

  private receive(invitation: Invitation): void {
    if (this.session) {
      void invitation.reject();
      return;
    }
    this.session = invitation;
    invitation.stateChange.addListener((state) => {
      if (state === SessionState.Established) {
        this.attachRemoteAudio(invitation);
        this.callbacks.onSessionEstablished?.();
      }
      if (state === SessionState.Terminated) {
        this.remoteAudio.srcObject = null;
        this.session = undefined;
        this.callbacks.onSessionTerminated?.();
      }
    });
    this.callbacks.onInvitation?.();
  }

  private attachRemoteAudio(session: Session): void {
    const handler = session.sessionDescriptionHandler as Web.SessionDescriptionHandler | undefined;
    const receivers = handler?.peerConnection?.getReceivers() ?? [];
    const stream = new MediaStream(
      receivers.flatMap((receiver) => (receiver.track ? [receiver.track] : [])),
    );
    this.remoteAudio.srcObject = stream;
    void this.remoteAudio.play().catch(() => this.callbacks.onAutoplayBlocked?.());
  }

  private peerConnection(): RTCPeerConnection | undefined {
    const handler = this.session?.sessionDescriptionHandler as
      Web.SessionDescriptionHandler | undefined;
    return handler?.peerConnection;
  }

  private requiredSession(): Invitation {
    if (!this.session) throw new Error('SIP session is not available');
    return this.session;
  }
}
