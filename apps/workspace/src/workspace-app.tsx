import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentWorkspaceApi, AgentWorkspaceSnapshot } from './agent-api.js';
import { createBrowserWorkspaceLeaderElection } from './leader-election.js';
import { BrowserSoftphone, type BrowserSipTransport, type SoftphoneState } from './softphone.js';
import type { SipJsTransportCallbacks } from './sip-js-transport.js';
import { WorkspaceOutboundGate, type WorkspaceGovernanceAlert } from './workspace-governance.js';

type MediaReadiness = 'UNCHECKED' | 'CHECKING' | 'READY' | 'BLOCKED';
type Availability = 'OFFLINE' | 'AVAILABLE';

export interface WorkspaceAppProps {
  api?: AgentWorkspaceApi;
  tenantLabel?: string;
  onSignOut?: () => void;
  createSoftphone?: SoftphoneFactory;
}

export type SoftphoneFactory = (
  remoteAudio: HTMLAudioElement,
  callbacks: SipJsTransportCallbacks,
) => BrowserSoftphone;

export function createDeterministicSoftphone(
  callbacks: SipJsTransportCallbacks = {},
): BrowserSoftphone {
  const transport: BrowserSipTransport = {
    configure: async () => undefined,
    register: async () => {
      window.setTimeout(() => callbacks.onInvitation?.(), 0);
    },
    unregister: async () => undefined,
    accept: async () => {
      window.setTimeout(() => callbacks.onSessionEstablished?.(), 0);
    },
    reject: async () => undefined,
    hold: async () => undefined,
    resume: async () => undefined,
    sendDtmf: async () => undefined,
    hangup: async () => undefined,
    setMuted: () => undefined,
  };
  return new BrowserSoftphone(transport);
}

export function WorkspaceApp({
  api,
  tenantLabel = 'acme.d-contact.io',
  onSignOut,
  createSoftphone,
}: WorkspaceAppProps) {
  const leaderElection = useMemo(
    () => createBrowserWorkspaceLeaderElection(crypto.randomUUID()),
    [],
  );
  const [workingTab, setWorkingTab] = useState<boolean>();
  const [mediaReadiness, setMediaReadiness] = useState<MediaReadiness>('UNCHECKED');
  const [availability, setAvailability] = useState<Availability>('OFFLINE');
  const [mediaError, setMediaError] = useState<string>();
  const [snapshot, setSnapshot] = useState<AgentWorkspaceSnapshot>();
  const [snapshotError, setSnapshotError] = useState<string>();
  const [softphoneState, setSoftphoneState] = useState<SoftphoneState>({ phase: 'OFFLINE' });
  const [softphoneError, setSoftphoneError] = useState<string>();
  const [muted, setMuted] = useState(false);
  const [wrapupDisposition, setWrapupDisposition] = useState<string>();
  const [wrapupPending, setWrapupPending] = useState(false);
  const [wrapupError, setWrapupError] = useState<string>();
  const [governanceAlert, setGovernanceAlert] = useState<WorkspaceGovernanceAlert>();
  const [liveRetry, setLiveRetry] = useState(0);
  const mediaStream = useRef<MediaStream | undefined>(undefined);
  const remoteAudio = useRef<HTMLAudioElement | null>(null);
  const softphone = useRef<BrowserSoftphone | undefined>(undefined);
  const governanceGate = useMemo(() => new WorkspaceOutboundGate(), []);

  useEffect(() => {
    if (!api) return;
    let active = true;
    void api
      .snapshot()
      .then((nextSnapshot) => {
        if (!active) return;
        setSnapshot(nextSnapshot);
        setSnapshotError(undefined);
      })
      .catch(() => {
        if (!active) return;
        setSnapshotError('โหลดสถานะจาก API ไม่สำเร็จ การควบคุมระยะไกลจะยังไม่พร้อมใช้งาน');
      });
    return () => {
      active = false;
    };
  }, [api]);

  useEffect(() => {
    if (!api?.subscribeLive || !workingTab) return;
    let disposed = false;
    const connection = api.subscribeLive({
      onEvent: (event) => {
        const alert = governanceGate.apply(event);
        if (alert) setGovernanceAlert(alert);
      },
      onDisconnect: () => {
        if (!disposed) setGovernanceAlert(governanceGate.markDisconnected());
      },
    });
    return () => {
      disposed = true;
      connection.close();
    };
  }, [api, governanceGate, liveRetry, workingTab]);

  useEffect(() => {
    if (!createSoftphone || !remoteAudio.current) return;
    const phone = createSoftphone(remoteAudio.current, {
      onInvitation: () => {
        void api
          ?.snapshot()
          .then(async (nextSnapshot) => {
            setSnapshot(nextSnapshot);
            const interaction = nextSnapshot.interaction;
            if (interaction?.state !== 'ASSIGNED') return;
            setSoftphoneState(await phone.receiveInvitation(interaction.id));
          })
          .catch(() => setSnapshotError('ยืนยัน incoming offer กับ API ไม่สำเร็จ'));
      },
      onSessionEstablished: () => setSoftphoneState(phone.connected()),
      onSessionTerminated: () => {
        setSoftphoneState(phone.terminated());
        setMuted(false);
        void api
          ?.snapshot()
          .then(setSnapshot)
          .catch(() => undefined);
      },
      onRegistrationLost: () => {
        void phone.registrationLost().then(setSoftphoneState);
      },
      onAutoplayBlocked: () =>
        setSoftphoneError('Browser บล็อกเสียงสายเข้า โปรดกดอนุญาตเล่นเสียงแล้วลองอีกครั้ง'),
    });
    softphone.current = phone;
    return () => {
      softphone.current = undefined;
      void phone.stop();
    };
  }, [api, createSoftphone]);

  useEffect(() => {
    setWorkingTab(leaderElection.start());
    const heartbeat = window.setInterval(() => setWorkingTab(leaderElection.heartbeat()), 1_000);
    return () => {
      window.clearInterval(heartbeat);
      leaderElection.stop();
    };
  }, [leaderElection]);

  useEffect(() => {
    if (workingTab !== false) return;
    for (const track of mediaStream.current?.getTracks() ?? []) track.stop();
    mediaStream.current = undefined;
    setMediaReadiness('UNCHECKED');
    setAvailability('OFFLINE');
    void softphone.current?.stop().then(setSoftphoneState);
  }, [workingTab]);

  useEffect(
    () => () => {
      for (const track of mediaStream.current?.getTracks() ?? []) track.stop();
    },
    [],
  );

  async function checkMediaReadiness() {
    if (!workingTab) return;
    setMediaReadiness('CHECKING');
    setMediaError(undefined);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of mediaStream.current?.getTracks() ?? []) track.stop();
      mediaStream.current = stream;
      for (const track of stream.getTracks()) {
        track.addEventListener(
          'ended',
          () => {
            setAvailability('OFFLINE');
            setMediaReadiness('BLOCKED');
            setMediaError('ไมโครโฟนหยุดทำงาน ระบบปิดรับสายใหม่แล้ว โปรดตรวจอุปกรณ์เสียงอีกครั้ง');
            void softphone.current?.stop().then(setSoftphoneState);
          },
          { once: true },
        );
      }
      setMediaReadiness('READY');
    } catch {
      setAvailability('OFFLINE');
      setMediaReadiness('BLOCKED');
      setMediaError(
        'Workspace ใช้ไมโครโฟนไม่ได้ โปรดอนุญาตสิทธิ์หรือเชื่อมต่ออุปกรณ์เสียงแล้วลองใหม่',
      );
      setSoftphoneState({ phase: 'OFFLINE' });
      return;
    }

    if (api && softphone.current) {
      setSoftphoneError(undefined);
      try {
        const lease = await api.sipCredentials();
        setSoftphoneState({
          phase: 'REGISTERING',
          telephonyNodeId: lease.telephonyNodeId,
        });
        setSoftphoneState(
          await softphone.current.start(lease, { ownsWorkingTab: true, mediaReady: true }),
        );
      } catch {
        setAvailability('OFFLINE');
        setSoftphoneState({ phase: 'OFFLINE' });
        setSoftphoneError('ลงทะเบียน browser softphone ไม่สำเร็จ ระบบจึงยังไม่เปิดรับสายใหม่');
      }
    }
  }

  function becomeAvailable() {
    if (!workingTab || mediaReadiness !== 'READY' || (api && softphoneState.phase !== 'READY'))
      return;
    setAvailability('AVAILABLE');
  }

  async function acceptCall() {
    if (!softphone.current || softphoneState.phase !== 'RINGING') return;
    setSoftphoneState(await softphone.current.accept());
  }

  function toggleMute() {
    if (!softphone.current) return;
    const next = !muted;
    softphone.current.setMuted(next);
    setMuted(next);
  }

  async function toggleHold() {
    if (!softphone.current) return;
    if (softphoneState.phase === 'ACTIVE') {
      setSoftphoneState(await softphone.current.hold());
      return;
    }
    if (softphoneState.phase === 'HELD') {
      setSoftphoneState(await softphone.current.resume());
    }
  }

  async function sendDtmf(value: string) {
    if (!softphone.current || softphoneState.phase !== 'ACTIVE') return;
    setSoftphoneState(await softphone.current.sendDtmf(value));
  }

  async function hangup() {
    if (!softphone.current) return;
    setSoftphoneState(await softphone.current.hangup());
    setMuted(false);
    void api
      ?.snapshot()
      .then(setSnapshot)
      .catch(() => undefined);
  }

  async function submitWrapup() {
    const interaction = snapshot?.interaction;
    if (!api || !interaction || interaction.state !== 'WRAPUP' || !wrapupDisposition) return;
    setWrapupPending(true);
    setWrapupError(undefined);
    try {
      await api.submitWrapup({
        interactionId: interaction.id,
        disposition: wrapupDisposition,
        commandId: crypto.randomUUID(),
      });
      setSnapshot(await api.snapshot());
      setWrapupDisposition(undefined);
    } catch {
      setWrapupError('ส่ง disposition ไม่สำเร็จ โปรดลองใหม่ด้วยข้อมูลเดิม');
    } finally {
      setWrapupPending(false);
    }
  }

  function moveWorkHere() {
    leaderElection.claim();
    setWorkingTab(true);
  }

  const readinessLabel = {
    UNCHECKED: 'ยังไม่ได้ตรวจอุปกรณ์',
    CHECKING: 'กำลังตรวจอุปกรณ์เสียง',
    READY: 'อุปกรณ์เสียงพร้อม',
    BLOCKED: 'อุปกรณ์เสียงไม่พร้อม',
  }[mediaReadiness];
  const softphoneLabel = {
    OFFLINE: 'โทรศัพท์ยังไม่พร้อม',
    REGISTERING: 'กำลังลงทะเบียนโทรศัพท์',
    READY: 'โทรศัพท์พร้อม',
    RINGING: 'มีสายเรียกเข้า',
    CONNECTING: 'กำลังเชื่อมต่อสาย',
    ACTIVE: 'กำลังสนทนา',
    HELD: 'พักสาย',
    RECONNECTING: 'กำลังกู้คืนโทรศัพท์',
    RECOVERY_REQUIRED: 'ต้องกู้คืนโทรศัพท์ด้วยตนเอง',
  }[softphoneState.phase];

  return (
    <div className="workspace-shell">
      <aside className="product-rail" aria-label="พื้นที่หลัก">
        <div className="product-mark" aria-label="D-Contact">
          D
        </div>
        <button type="button" aria-label="ภาพรวม">
          01
        </button>
        <button type="button" className="active" aria-label="Agent Workspace">
          02
        </button>
        <button type="button" aria-label="Supervisor">
          03
        </button>
      </aside>

      <aside className="navigation">
        <div className="brand">
          <span>D</span>
          D-Contact
        </div>
        <p className="navigation-label">AGENT WORKSPACE</p>
        <button type="button" className="navigation-item active">
          กล่องงานของฉัน
        </button>
        <button type="button" className="navigation-item">
          ประวัติการติดต่อ
        </button>
        <p className="pilot-note">INBOUND VOICE · PILOT</p>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="identity-strip">
            <span className="tenant">{tenantLabel}</span>
            {snapshot ? <strong>{snapshot.agent.displayName}</strong> : null}
          </div>
          <div className="status-strip" aria-label="สถานะ Workspace">
            <span
              className={'status-chip ' + (workingTab ? 'success' : 'neutral')}
              role="status"
              aria-label="เจ้าของ Workspace"
            >
              {workingTab === undefined
                ? 'กำลังตรวจแท็บ'
                : workingTab
                  ? 'แท็บทำงาน'
                  : 'แท็บดูอย่างเดียว'}
            </span>
            <span className={'status-chip ' + (mediaReadiness === 'READY' ? 'success' : 'warning')}>
              {readinessLabel}
            </span>
            <span
              className={'status-chip ' + (availability === 'AVAILABLE' ? 'success' : 'neutral')}
            >
              {availability}
            </span>
            <span
              className={
                'status-chip ' + (softphoneState.phase === 'READY' ? 'success' : 'neutral')
              }
              role="status"
              aria-label="สถานะ browser softphone"
            >
              {softphoneLabel}
            </span>
            {onSignOut ? (
              <button type="button" className="signout-action" onClick={onSignOut}>
                ออกจากระบบ
              </button>
            ) : null}
          </div>
        </header>

        <main>
          <div className="page-heading">
            <div>
              <p className="eyebrow">VOICE OPERATIONS</p>
              <h1>Agent Workspace</h1>
              <p>เตรียม browser และอุปกรณ์เสียงให้พร้อมก่อนเปิดรับสาย</p>
            </div>
            <span className="phase-badge">PHASE 2</span>
          </div>

          {governanceAlert ? (
            <section
              className={'governance-workspace-alert ' + governanceAlert.state.toLowerCase()}
              role="alert"
            >
              <div>
                <strong>
                  {governanceAlert.state === 'READY'
                    ? 'ตรวจสอบการติดต่อแล้ว'
                    : 'ต้องตรวจสอบการติดต่อก่อน outbound'}
                </strong>
                <p>{governanceAlert.message}</p>
              </div>
              {governanceAlert.state !== 'READY' ? (
                <button
                  type="button"
                  className="secondary-action"
                  onClick={() => setLiveRetry((value) => value + 1)}
                >
                  ลองเชื่อมต่อสถานะใหม่
                </button>
              ) : null}
            </section>
          ) : null}

          <section className="workspace-grid" aria-label="การเตรียมพร้อมรับสาย">
            {snapshot?.interaction?.state === 'ASSIGNED' ? (
              <article className="panel incoming-offer" aria-labelledby="incoming-offer-title">
                <div>
                  <p className="step">VOICE OFFER</p>
                  <h2 id="incoming-offer-title">สายเรียกเข้า</h2>
                  <strong className="caller-number">
                    {snapshot.interaction.caller ?? 'ไม่แสดงหมายเลข'}
                  </strong>
                </div>
                <dl>
                  <div>
                    <dt>Queue</dt>
                    <dd>{snapshot.interaction.queue?.name ?? 'ไม่ระบุ'}</dd>
                  </div>
                  <div>
                    <dt>Authority</dt>
                    <dd>Interaction v{snapshot.interaction.version}</dd>
                  </div>
                </dl>
                <div className="offer-actions">
                  <button
                    type="button"
                    className="primary-action"
                    disabled={softphoneState.phase !== 'RINGING'}
                    onClick={() => void acceptCall()}
                  >
                    รับสาย
                  </button>
                </div>
              </article>
            ) : null}

            {softphoneState.phase === 'ACTIVE' || softphoneState.phase === 'HELD' ? (
              <article className="panel call-controls" aria-labelledby="call-controls-title">
                <div>
                  <p className="step">BROWSER SOFTPHONE</p>
                  <h2 id="call-controls-title">ควบคุมสาย</h2>
                </div>
                <div className="control-row">
                  <button type="button" className="secondary-action" onClick={toggleMute}>
                    {muted ? 'เปิดไมค์' : 'ปิดไมค์'}
                  </button>
                  <button
                    type="button"
                    className="secondary-action"
                    onClick={() => void toggleHold()}
                  >
                    {softphoneState.phase === 'HELD' ? 'กลับเข้าสาย' : 'พักสาย'}
                  </button>
                  <button type="button" className="danger-action" onClick={() => void hangup()}>
                    วางสาย
                  </button>
                </div>
                <div className="dtmf-pad" aria-label="แป้น DTMF">
                  {['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map((value) => (
                    <button
                      type="button"
                      key={value}
                      aria-label={`ส่ง DTMF ${value}`}
                      disabled={softphoneState.phase !== 'ACTIVE'}
                      onClick={() => void sendDtmf(value)}
                    >
                      {value}
                    </button>
                  ))}
                </div>
              </article>
            ) : null}

            {snapshot?.interaction?.state === 'WRAPUP' ? (
              <article className="panel" aria-labelledby="wrapup-title">
                <div>
                  <p className="step">WRAP-UP</p>
                  <h2 id="wrapup-title">สรุปผลหลังสาย</h2>
                  <p className="panel-copy">ส่ง disposition ก่อนกลับสู่สถานะรับงาน</p>
                </div>
                <div className="control-row" aria-label="เลือก disposition">
                  <button
                    type="button"
                    className="secondary-action"
                    aria-pressed={wrapupDisposition === 'CUSTOMER_ASSISTED'}
                    disabled={wrapupPending}
                    onClick={() => setWrapupDisposition('CUSTOMER_ASSISTED')}
                  >
                    ลูกค้าได้รับความช่วยเหลือ
                  </button>
                  <button
                    type="button"
                    className="secondary-action"
                    aria-pressed={wrapupDisposition === 'FOLLOW_UP_REQUIRED'}
                    disabled={wrapupPending}
                    onClick={() => setWrapupDisposition('FOLLOW_UP_REQUIRED')}
                  >
                    ต้องติดตามต่อ
                  </button>
                </div>
                <button
                  type="button"
                  className="primary-action"
                  disabled={!wrapupDisposition || wrapupPending}
                  onClick={() => void submitWrapup()}
                >
                  ส่ง disposition
                </button>
                {wrapupPending ? <p role="status">กำลังรอ server ยืนยัน</p> : null}
                {wrapupError ? (
                  <p role="alert" className="error-message">
                    {wrapupError}
                  </p>
                ) : null}
              </article>
            ) : null}

            {snapshotError ? (
              <p className="snapshot-warning" role="status">
                {snapshotError}
              </p>
            ) : null}

            {softphoneError ? (
              <p className="snapshot-warning" role="alert">
                {softphoneError}
              </p>
            ) : null}

            <article className="panel readiness-panel">
              <div className="panel-heading">
                <div>
                  <p className="step">ขั้นตอนที่ 1</p>
                  <h2>เตรียมอุปกรณ์เสียง</h2>
                </div>
                <span
                  className={'readiness-indicator ' + mediaReadiness.toLowerCase()}
                  role="status"
                  aria-label="ความพร้อมของอุปกรณ์เสียง"
                >
                  {readinessLabel}
                </span>
              </div>

              <p className="panel-copy">
                ระบบจะขอใช้ไมโครโฟนและตรวจว่า browser เปิด media stream ได้ ก่อนอนุญาตให้รับ voice
                offer
              </p>

              <div className="device-row">
                <div className="device-icon" aria-hidden="true">
                  MIC
                </div>
                <div>
                  <strong>ไมโครโฟนหลัก</strong>
                  <span>ตรวจผ่าน Browser MediaDevices</span>
                </div>
              </div>

              {mediaError ? (
                <p className="error-message" role="alert">
                  {mediaError}
                </p>
              ) : null}

              <button
                type="button"
                className="secondary-action"
                disabled={!workingTab || mediaReadiness === 'CHECKING'}
                onClick={() => void checkMediaReadiness()}
              >
                {mediaReadiness === 'CHECKING' ? 'กำลังตรวจ…' : 'ตรวจอุปกรณ์เสียง'}
              </button>
            </article>

            <article className="panel availability-panel">
              <div className="panel-heading">
                <div>
                  <p className="step">ขั้นตอนที่ 2</p>
                  <h2>สถานะการรับสาย</h2>
                </div>
                <span
                  className={'availability-dot ' + availability.toLowerCase()}
                  aria-hidden="true"
                />
              </div>

              <div className="availability-state" aria-live="polite">
                <strong>
                  {availability === 'AVAILABLE' ? 'พร้อมรับสาย' : 'ยังไม่พร้อมรับสาย'}
                </strong>
                <span>
                  {availability === 'AVAILABLE'
                    ? 'Router สามารถส่ง voice offer มายัง working tab นี้ได้'
                    : 'ต้องตรวจอุปกรณ์เสียงให้ผ่านก่อนเปิดรับสาย'}
                </span>
              </div>

              <button
                type="button"
                className="primary-action"
                disabled={
                  !workingTab ||
                  mediaReadiness !== 'READY' ||
                  availability === 'AVAILABLE' ||
                  Boolean(api && softphoneState.phase !== 'READY')
                }
                onClick={becomeAvailable}
              >
                เปิดรับสาย
              </button>
            </article>

            <article className="panel authority-panel">
              <p className="step">ขอบเขต authority</p>
              <h2>สถานะที่เชื่อถือได้</h2>
              <dl>
                <div>
                  <dt>Interaction</dt>
                  <dd>{snapshot?.interaction?.state ?? 'Router / API'}</dd>
                </div>
                <div>
                  <dt>Browser media</dt>
                  <dd>{readinessLabel}</dd>
                </div>
                <div>
                  <dt>Presence</dt>
                  <dd>{snapshot?.agent.state ?? availability}</dd>
                </div>
              </dl>
              <p className="authority-note">
                Browser แสดง projection และส่ง intent เท่านั้น ไม่สร้าง durable Interaction state
                เอง
              </p>
            </article>
          </section>
        </main>
      </section>

      <audio ref={remoteAudio} autoPlay className="remote-audio" />

      {workingTab === false ? (
        <div className="passive-overlay">
          <section className="passive-card" aria-labelledby="passive-title">
            <p className="eyebrow">SINGLE WORKING TAB</p>
            <h2 id="passive-title">Workspace ทำงานอยู่ในแท็บอื่น</h2>
            <p>
              แท็บนี้ดูข้อมูลได้อย่างเดียวและจะไม่เปิด routing หรือ media session
              จนกว่าคุณจะย้ายงานมาที่นี่
            </p>
            <button type="button" className="primary-action" onClick={moveWorkHere}>
              ย้ายงานมาที่แท็บนี้
            </button>
          </section>
        </div>
      ) : null}
    </div>
  );
}
