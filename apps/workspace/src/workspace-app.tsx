/**
 * Agent Workspace — D1.15 (#454): ข้อความผ่าน catalog `workspace`/`dphone`, CSS token ล้วน (`aw-*`),
 * ใน AppShell (flag `ui.shell.v2`) ไม่วาด chrome เดิมและใช้ dphone widget ลอยแทนแผงควบคุมสาย
 *
 * กติกาที่ห้ามละเมิด (ADR-026): dphone instance ถูกสร้างครั้งเดียวต่อการโหลดหน้าใน `AgentWorkspace`
 * การย่อ/ขยาย/ลาก/แยกหน้าต่าง/สลับภาษาเปลี่ยนแค่ UI — ไม่สร้าง SIP session, WebRTC หรือ WS ใหม่
 *
 * E1.12 (#486), #583: ทุก tenant — จุดรับงานคือผู้ถือ work-session lease ฝั่ง server
 * (ADR-026 ข้อ 2): ได้ lease ก่อนจึงต่อ WS (แนบ `leaseId`) และ register SIP; เสีย lease = หยุดรับงานใหม่ทันที
 * และถอน SIP register เมื่อไม่มีงานในมือ — สายที่คุยอยู่/wrap-up ไม่ถูกตัด (ADR-026 ข้อ 4)
 * flag ปิด = พฤติกรรมเดิมทุกประการ (leader election ของแท็บเป็นตัวตัดสิน)
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { WrapupRuntime } from './wrapup-runtime.js';
import { useLocale, useTranslation } from '@d-contact/i18n/react';
import { Button, useInShell } from '@d-contact/ui-react';
import {
  AgentApiError,
  type AgentWorkspaceApi,
  type AgentWorkspaceSnapshot,
  type WrapupResultV1,
  type WrapupIntentV1,
} from './agent-api.js';
import { EndedCallSnapshotReconciler } from './ended-call-snapshot.js';
import { createBrowserWorkspaceLeaderElection } from './leader-election.js';
import { BrowserDphone, type BrowserSipTransport, type DphoneState } from './dphone/dphone.js';
import type { SipJsTransportCallbacks } from './dphone/sip-js-transport.js';
import { createDphoneHost, type DphoneCommand, type DphoneView } from './dphone/dphone-bridge.js';
import {
  DPHONE_SIZES,
  DphoneDetachedBar,
  DphoneWidget,
  type DphoneSize,
} from './dphone/dphone-widget.js';
import { useShellTokens } from './shell/tokens.js';
import { WorkspaceOutboundGate, type WorkspaceGovernanceAlert } from './workspace-governance.js';
import {
  WorkSessionClient,
  type WorkSessionApi,
  type WorkSessionState,
  type WorkSessionSurface,
} from './work-session.js';
import { WorkSessionPanel } from './work-session-panel.js';
import './agent-workspace.css';
import './dphone/dphone.css';

type MediaReadiness = 'UNCHECKED' | 'CHECKING' | 'READY' | 'BLOCKED';
type Availability = 'OFFLINE' | 'AVAILABLE';
type WorkspaceMessage =
  | 'snapshotLoadFailed'
  | 'offerConfirmFailed'
  | 'autoplayBlocked'
  | 'micEnded'
  | 'micBlocked'
  | 'registerFailed'
  | 'availabilityFailed'
  | 'wrapupFailed';

export interface WorkspaceAppProps {
  sessionReady?: boolean;
  wrapupRuntime?: WrapupRuntime;
  identityKey?: string;
  recoveryRevision?: number;
  api?: AgentWorkspaceApi;
  tenantLabel?: string;
  onSignOut?: () => void;
  createDphone?: DphoneFactory;
  /** E1.12: REST ของ work-session lease — ไม่มี = พฤติกรรมเดิม (ไม่มี lease) */
  workSession?: WorkSessionApi;
  /** surface ที่ขอ lease (E1.9) — Workspace = `workspace` */
  workSessionSurface?: WorkSessionSurface;
  /**
   * E1.14: `embedded` = dphone ที่ถูกฝังใน host — แสดงเฉพาะ dphone, อุปกรณ์เสียง, ความพร้อม และ wrap-up
   * (ไม่มี shell/หน้าต่างแยก) โดยใช้ logic งานสายชุดเดียวกับ Workspace
   */
  variant?: 'workspace' | 'embedded';
  /** E1.14: เหตุการณ์ของงานสาย ให้ embed runtime ส่ง screen-pop/activity ให้ host */
  onCallEvent?: (event: WorkspaceCallEvent) => void;
  /** E1.14: lease ที่ถืออยู่ (undefined = ไม่ได้ถือ) — ใช้แนบ `x-work-session-lease-id` */
  onLeaseChange?: (leaseId: string | undefined) => void;
  /** #588: มีสายเรียกเข้า, สายในมือ หรือ wrap-up ที่ยังไม่บันทึก — shell ใช้ถามยืนยันก่อนออกจากระบบ */
  onWorkInHandChange?: (active: boolean) => void;
}

export type WorkspaceCallInteraction = NonNullable<AgentWorkspaceSnapshot['interaction']>;
export type WorkspaceCallEvent =
  | { type: 'offered' | 'answered'; interaction: WorkspaceCallInteraction }
  | { type: 'wrapup.completed'; interaction: WorkspaceCallInteraction; disposition: string };

export type DphoneFactory = (
  remoteAudio: HTMLAudioElement,
  callbacks: SipJsTransportCallbacks,
) => BrowserDphone;

export function createDeterministicDphone(callbacks: SipJsTransportCallbacks = {}): BrowserDphone {
  let session: string | undefined;
  const transport: BrowserSipTransport = {
    configure: async () => undefined,
    register: async () => {
      window.setTimeout(() => callbacks.onInvitation?.(), 0);
    },
    unregister: async () => undefined,
    accept: async () => {
      session = crypto.randomUUID();
      window.setTimeout(() => callbacks.onSessionEstablished?.(), 0);
    },
    reject: async () => undefined,
    hold: async () => undefined,
    resume: async () => undefined,
    sendDtmf: async () => undefined,
    hangup: async () => {
      session = undefined;
      callbacks.onSessionTerminated?.();
    },
    setMuted: () => undefined,
    sessionId: () => session,
  };
  return new BrowserDphone(transport);
}

/**
 * หลักฐานสำหรับ acceptance (dev/e2e เท่านั้น): SIP session และ WS connection ที่ใช้อยู่
 * Playwright อ่านก่อน/หลังย่อ-ขยาย-แยกหน้าต่าง-สลับภาษา แล้วต้องได้ค่าเดิม
 */
interface DphoneDiagnostics {
  sipSessionId(): string | undefined;
  wsConnectionId(): string | undefined;
  /** E1.12: work-session lease ที่ถืออยู่ (ถ้ามี) */
  workSessionLeaseId(): string | undefined;
}

declare global {
  interface Window {
    __dcontactDphone?: DphoneDiagnostics;
  }
}

const SIZE_KEY = 'dcontact.dphone.size';
const DTMF_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

function loadSize(): DphoneSize {
  try {
    const saved = localStorage.getItem(SIZE_KEY);
    if (saved && (DPHONE_SIZES as readonly string[]).includes(saved)) return saved as DphoneSize;
  } catch {
    // ขนาดเป็นความสะดวก ไม่ใช่ข้อมูลสำคัญ
  }
  return 'compact';
}

/** token มาก่อนเนื้อหา แล้ว mount `AgentWorkspace` ครั้งเดียว (dphone ต้องไม่ถูกสร้างซ้ำ) */
export function WorkspaceApp(props: WorkspaceAppProps) {
  const tokensReady = useShellTokens();
  if (!tokensReady) return null;
  return <AgentWorkspace {...props} />;
}

function AgentWorkspace({
  sessionReady = true,
  wrapupRuntime,
  identityKey = 'standalone-document',
  recoveryRevision,
  api,
  tenantLabel = 'acme.d-contact.io',
  onSignOut,
  createDphone,
  workSession,
  workSessionSurface = 'workspace',
  variant = 'workspace',
  onCallEvent,
  onLeaseChange,
  onWorkInHandChange,
}: WorkspaceAppProps) {
  const embedded = variant === 'embedded';
  const { t } = useTranslation('workspace');
  const { t: td } = useTranslation('dphone');
  const { locale } = useLocale();
  // embedded ไม่มี shell แต่ใช้ widget ของ shell ใหม่ (D1.15) เหมือนกัน
  const inShellFrame = useInShell();
  const inShell = inShellFrame || variant === 'embedded';
  const leaderElection = useMemo(
    () => createBrowserWorkspaceLeaderElection(crypto.randomUUID()),
    [],
  );
  const [workingTab, setWorkingTab] = useState<boolean>();
  const [mediaReadiness, setMediaReadiness] = useState<MediaReadiness>('UNCHECKED');
  const [availability, setAvailability] = useState<Availability>('OFFLINE');
  const [availabilityPending, setAvailabilityPending] = useState(false);
  const [availabilityError, setAvailabilityError] = useState<WorkspaceMessage>();
  const availabilityGeneration = useRef(0);
  const mediaReadinessRef = useRef(mediaReadiness);
  mediaReadinessRef.current = mediaReadiness;
  // ข้อความเก็บเป็น key แล้วแปลตอน render — สลับภาษาแล้วเปลี่ยนตาม
  const [mediaError, setMediaError] = useState<WorkspaceMessage>();
  const [snapshot, setSnapshot] = useState<AgentWorkspaceSnapshot>();
  const [snapshotError, setSnapshotError] = useState<WorkspaceMessage>();
  const [dphoneState, setDphoneState] = useState<DphoneState>({ phase: 'OFFLINE' });
  const [dphoneError, setDphoneError] = useState<WorkspaceMessage>();
  const [muted, setMuted] = useState(false);
  const fallbackRuntime = useMemo(() => {
    const runtime = new WrapupRuntime();
    runtime.setOwner(identityKey);
    return runtime;
  }, [identityKey]);
  const runtime = wrapupRuntime ?? fallbackRuntime;
  useSyncExternalStore(runtime.subscribe, runtime.version);
  const draft = runtime.select(identityKey, snapshot?.interaction);
  const wrapupState = draft.read();
  const wrapupDisposition = wrapupState.disposition;
  const wrapupPending = wrapupState.pending;
  const wrapupError = wrapupState.error;
  const wrapupNote = wrapupState.note;
  const wrapupUnknown = wrapupState.unknown;
  const completed = wrapupState.result ? wrapupState : runtime.latestCompleted(identityKey);
  const savedWrapup = completed?.result;
  const wrapupAlreadyCompleted = completed?.alreadyCompleted;
  const setWrapupDisposition = (disposition?: string) => draft.update({ disposition });
  const setWrapupPending = (pending: boolean) => draft.update({ pending });
  const setWrapupError = (error?: 'wrapupFailed') => draft.update({ error });
  const setWrapupNote = (note: string) => draft.update({ note });
  const setWrapupUnknown = (unknown: boolean) => draft.update({ unknown });
  const setSavedWrapup = (result: WrapupResultV1) => draft.update({ result });
  const setWrapupAlreadyCompleted = (alreadyCompleted: boolean) =>
    draft.update({ alreadyCompleted });
  const wrapupTarget = wrapupState.interaction ?? snapshot?.interaction;
  const [reconciledRevision, setReconciledRevision] = useState<number>();
  const [networkRevision, setNetworkRevision] = useState(0);
  const acceptingSession =
    sessionReady && (recoveryRevision === undefined || reconciledRevision === recoveryRevision);
  const [governanceAlert, setGovernanceAlert] = useState<WorkspaceGovernanceAlert>();
  const [liveRetry, setLiveRetry] = useState(0);
  const [dphoneSize, setDphoneSize] = useState<DphoneSize>(loadSize);
  const [detached, setDetached] = useState(false);
  const mediaStream = useRef<MediaStream | undefined>(undefined);
  const remoteAudio = useRef<HTMLAudioElement | null>(null);
  const dphone = useRef<BrowserDphone | undefined>(undefined);
  const endedCallSnapshot = useRef<EndedCallSnapshotReconciler | undefined>(undefined);
  const liveConnectionId = useRef<string | undefined>(undefined);
  const popup = useRef<Window | null>(null);
  // id ของหน้าต่างแยกที่ tab นี้เปิด — host รับ hello/bye/คำสั่งเฉพาะจาก id นี้
  const remoteId = useRef<string | undefined>(undefined);
  const governanceGate = useMemo(() => new WorkspaceOutboundGate(), []);
  // E1.12: work-session lease — `disabled` = ไม่ได้ส่ง `workSession` มา (test/harness เท่านั้น)
  // #583: ทุก tenant บังคับ lease แล้ว จึงไม่มีสถานะ "tenant ไม่บังคับ" จาก server
  const leaseClient = useRef<WorkSessionClient | undefined>(undefined);
  const [lease, setLease] = useState<WorkSessionState | { phase: 'disabled' }>(
    workSession ? { phase: 'idle' } : { phase: 'disabled' },
  );
  const [socketLeaseId, setSocketLeaseId] = useState<string>();
  const enforced = lease.phase !== 'disabled';
  const leaseHeld = lease.phase === 'held';
  const inCall =
    dphoneState.phase === 'CONNECTING' ||
    dphoneState.phase === 'ACTIVE' ||
    dphoneState.phase === 'HELD' ||
    ((dphoneState.phase === 'RECONNECTING' || dphoneState.phase === 'RECOVERY_REQUIRED') &&
      Boolean(dphoneState.interactionId));
  // งานในมือ = สาย หรือ interaction ที่ยังต้องทำต่อ (ACTIVE/WRAPUP) — server ไม่ปล่อย lease ระหว่างนี้
  const workInHand =
    inCall ||
    wrapupPending ||
    wrapupUnknown ||
    snapshot?.interaction?.state === 'ACTIVE' ||
    snapshot?.interaction?.state === 'WRAPUP';
  // รับงานใหม่ได้: flag เปิด = ถือ lease; flag ปิด = working tab (เดิม)
  const ownsWork =
    acceptingSession && !wrapupPending && !wrapupUnknown && (enforced ? leaseHeld : workingTab);
  // เก็บ SIP/WS/หน้าต่าง dphone ไว้: flag เปิด = ถือ lease หรือยังมีงานในมือ; flag ปิด = working tab (เดิม)
  const mediaOwner = enforced ? leaseHeld || workInHand : workingTab;
  // #588: ออกจากระบบตอนนี้จะตัดสาย, พลาดสายที่ offer มาหรือกำลังเรียกเข้า หรือทิ้ง wrap-up ที่ยังไม่บันทึก
  // (offer นับจาก snapshot ด้วย — tab ที่ไม่ได้ถือ media หรือ INVITE ยังมาไม่ถึงจะไม่มี RINGING)
  const signOutLosesWork =
    workInHand || dphoneState.phase === 'RINGING' || snapshot?.interaction?.state === 'ASSIGNED';
  const onWorkInHandChangeRef = useRef(onWorkInHandChange);
  onWorkInHandChangeRef.current = onWorkInHandChange;
  useEffect(() => {
    onWorkInHandChangeRef.current?.(signOutLosesWork);
  }, [signOutLosesWork]);
  // unmount แล้วไม่มีงานในมือของหน้านี้ — ไม่ให้ shell ค้างสถานะ "มีงาน"
  useEffect(() => () => onWorkInHandChangeRef.current?.(false), []);
  const onCallEventRef = useRef(onCallEvent);
  onCallEventRef.current = onCallEvent;
  // E1.14: offered/answered ครั้งเดียวต่อ interaction+state (snapshot ถูกโหลดซ้ำได้หลายครั้ง)
  const announced = useRef<string | undefined>(undefined);
  const interactionKey = snapshot?.interaction
    ? `${snapshot.interaction.id}:${snapshot.interaction.state}`
    : undefined;
  useEffect(() => {
    const interaction = snapshot?.interaction;
    if (!interaction || !interactionKey || announced.current === interactionKey) return;
    announced.current = interactionKey;
    if (interaction.state === 'ASSIGNED')
      onCallEventRef.current?.({ type: 'offered', interaction });
    if (interaction.state === 'ACTIVE') onCallEventRef.current?.({ type: 'answered', interaction });
  }, [interactionKey, snapshot]);
  const ownsWorkRef = useRef(ownsWork);
  ownsWorkRef.current = ownsWork;
  const workInHandRef = useRef(workInHand);
  workInHandRef.current = workInHand;

  useEffect(() => {
    if (!api) return;
    let active = true;
    void api
      .snapshot()
      .then((nextSnapshot) => {
        if (!active || !draft.valid()) return;
        setSnapshot(nextSnapshot);
        setSnapshotError(undefined);
      })
      .catch(() => {
        if (active) setSnapshotError('snapshotLoadFailed');
      });
    return () => {
      active = false;
    };
  }, [api]);

  useEffect(() => {
    const reconnect = () => {
      setReconciledRevision(undefined);
      setNetworkRevision((revision) => revision + 1);
    };
    window.addEventListener('online', reconnect);
    return () => window.removeEventListener('online', reconnect);
  }, []);

  useEffect(() => {
    if (!api || !sessionReady || recoveryRevision === undefined) return;
    let active = true;
    void (async () => {
      if (draft.read().intent) await checkWrapupResult();
      const next = await api.snapshot();
      if (!active || !draft.valid()) return;
      setSnapshot(next);
      setSnapshotError(undefined);
      setReconciledRevision(recoveryRevision);
    })().catch(() => {
      if (active && draft.valid()) setSnapshotError('snapshotLoadFailed');
    });
    return () => {
      active = false;
    };
  }, [api, sessionReady, recoveryRevision, networkRevision]);

  // WS ของ routing: flag เปิดต่อหลังได้ lease เท่านั้น (แนบ leaseId) และ heartbeat ผ่าน socket นี้
  const liveKey = enforced ? socketLeaseId : workingTab ? 'working-tab' : undefined;
  useEffect(() => {
    if (!api?.subscribeLive || !liveKey) return;
    let disposed = false;
    const connection = api.subscribeLive(
      {
        onEvent: (event) => {
          if (leaseClient.current?.handleSocketEvent(event)) return;
          const alert = governanceGate.apply(event);
          if (alert) setGovernanceAlert(alert);
        },
        onDisconnect: (code) => {
          if (disposed) return;
          leaseClient.current?.handleSocketClosed(code);
          setGovernanceAlert(governanceGate.markDisconnected());
        },
      },
      enforced ? { leaseId: liveKey } : undefined,
    );
    const send = connection.send?.bind(connection);
    const detach =
      enforced && send
        ? leaseClient.current?.attachSocket({ send: (message) => send(message) })
        : undefined;
    liveConnectionId.current = connection.id;
    return () => {
      disposed = true;
      detach?.();
      liveConnectionId.current = undefined;
      connection.close();
    };
  }, [api, enforced, governanceGate, liveRetry, liveKey]);

  useEffect(() => {
    if (!api || !createDphone || !remoteAudio.current) return;
    const reconciler = new EndedCallSnapshotReconciler({
      snapshot: () => api.snapshot(),
      apply: (nextSnapshot) => {
        setSnapshot(nextSnapshot);
        setSnapshotError(undefined);
      },
      onExhausted: () => setSnapshotError('snapshotLoadFailed'),
    });
    endedCallSnapshot.current = reconciler;
    let disposed = false;
    const phone = createDphone(remoteAudio.current, {
      onInvitation: () => {
        if (disposed) return;
        reconciler.cancel();
        void api
          ?.snapshot()
          .then(async (nextSnapshot) => {
            setSnapshot(nextSnapshot);
            const interaction = nextSnapshot.interaction;
            if (interaction?.state !== 'ASSIGNED') return;
            setDphoneState(await phone.receiveInvitation(interaction.id));
          })
          .catch(() => setSnapshotError('offerConfirmFailed'));
      },
      onSessionEstablished: () => setDphoneState(phone.connected()),
      onSessionTerminated: () => {
        if (disposed) return;
        const current = phone.current();
        const interactionId = 'interactionId' in current ? current.interactionId : undefined;
        setDphoneState(phone.terminated());
        setMuted(false);
        if (interactionId) void reconciler.start(interactionId);
      },
      onRegistrationLost: () => {
        availabilityGeneration.current += 1;
        void phone.registrationLost().then(setDphoneState);
      },
      onAutoplayBlocked: () => setDphoneError('autoplayBlocked'),
    });
    dphone.current = phone;
    return () => {
      disposed = true;
      reconciler.cancel();
      endedCallSnapshot.current = undefined;
      dphone.current = undefined;
      void phone.stop();
    };
  }, [api, createDphone]);

  useEffect(() => {
    if (import.meta.env.MODE === 'production') return;
    window.__dcontactDphone = {
      sipSessionId: () => dphone.current?.sessionId(),
      wsConnectionId: () => liveConnectionId.current,
      workSessionLeaseId: () => leaseClient.current?.leaseId(),
    };
    return () => {
      delete window.__dcontactDphone;
    };
  }, []);

  useEffect(() => {
    setWorkingTab(leaderElection.start());
    const heartbeat = window.setInterval(() => setWorkingTab(leaderElection.heartbeat()), 1_000);
    return () => {
      window.clearInterval(heartbeat);
      leaderElection.stop();
    };
  }, [leaderElection]);

  // E1.12: สร้าง client ของ lease ต่อ effect (StrictMode mount ซ้ำได้ client ใหม่ ไม่มีคำตอบค้างจากตัวเก่า)
  // ลำดับ: หลัง leader election เริ่มแล้ว — leader ของ origin เป็นผู้ขอ lease อัตโนมัติ (ลดภาระเท่านั้น)
  useEffect(() => {
    if (!workSession) return;
    const client = new WorkSessionClient({
      surface: workSessionSurface,
      api: workSession,
      busy: () => workInHandRef.current,
    });
    leaseClient.current = client;
    const unsubscribe = client.subscribe(setLease);
    void client.start({ autoAcquire: sessionReady && leaderElection.isWorkingTab() });
    // ปิดหน้าจริง (ไม่ใช่เข้า bfcache) → ปล่อย lease ให้ที่อื่นรับงานต่อได้ทันที
    const exit = (event: PageTransitionEvent) => {
      if (!event.persisted) client.releaseOnExit();
    };
    window.addEventListener('pagehide', exit);
    return () => {
      window.removeEventListener('pagehide', exit);
      unsubscribe();
      client.stop();
      if (leaseClient.current === client) leaseClient.current = undefined;
    };
  }, [leaderElection, workSession, workSessionSurface]);

  useEffect(() => {
    leaseClient.current?.setAutoAcquire(sessionReady && Boolean(workingTab));
  }, [workingTab, sessionReady]);

  // ได้ lease = ที่นี่เป็นจุดรับงาน: ประกาศ leader ใน origin ให้แท็บอื่นไม่ขอ lease ซ้อน
  const heldLeaseId = lease.phase === 'held' ? lease.lease.leaseId : undefined;
  const onLeaseChangeRef = useRef(onLeaseChange);
  onLeaseChangeRef.current = onLeaseChange;
  useEffect(() => onLeaseChangeRef.current?.(heldLeaseId), [heldLeaseId]);
  useEffect(() => {
    if (!enforced) return;
    if (heldLeaseId) {
      leaderElection.claim();
      setWorkingTab(true);
      setSocketLeaseId(heldLeaseId);
      return;
    }
    // เสีย lease: หยุดรับงานใหม่ทันที; WS เดิมอยู่ต่อจนงานในมือจบ (server ไม่ส่ง offer ให้แล้ว)
    setAvailability('OFFLINE');
    if (!workInHand) setSocketLeaseId(undefined);
    availabilityGeneration.current += 1;
  }, [enforced, heldLeaseId, leaderElection, workInHand]);

  useEffect(() => {
    if (mediaOwner !== false) return;
    for (const track of mediaStream.current?.getTracks() ?? []) track.stop();
    mediaStream.current = undefined;
    setMediaReadiness('UNCHECKED');
    setAvailability('OFFLINE');
    void dphone.current?.stop().then(setDphoneState);
  }, [mediaOwner]);

  useEffect(
    () => () => {
      for (const track of mediaStream.current?.getTracks() ?? []) track.stop();
    },
    [],
  );

  async function checkMediaReadiness() {
    if (!ownsWork) return;
    availabilityGeneration.current += 1;
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
            availabilityGeneration.current += 1;
            mediaReadinessRef.current = 'BLOCKED';
            setAvailability('OFFLINE');
            setMediaReadiness('BLOCKED');
            setMediaError('micEnded');
            void dphone.current?.stop().then(setDphoneState);
          },
          { once: true },
        );
      }
      setMediaReadiness('READY');
    } catch {
      setAvailability('OFFLINE');
      setMediaReadiness('BLOCKED');
      setMediaError('micBlocked');
      setDphoneState({ phase: 'OFFLINE' });
      return;
    }

    if (api && dphone.current) {
      setDphoneError(undefined);
      try {
        const workSessionLeaseId = leaseClient.current?.leaseId();
        if (!workSessionLeaseId) throw new Error('work-session lease is required for SIP');
        const sipLease = await api.sipCredentials(workSessionLeaseId);
        // register SIP เฉพาะเมื่อยังเป็นจุดรับงาน (flag เปิด = ยังถือ work-session lease) ณ ตอนนี้
        if (!ownsWorkRef.current) {
          setDphoneState({ phase: 'OFFLINE' });
          return;
        }
        setDphoneState({ phase: 'REGISTERING', telephonyNodeId: sipLease.telephonyNodeId });
        setDphoneState(
          await dphone.current.start(sipLease, { ownsWorkingTab: true, mediaReady: true }),
        );
      } catch {
        setAvailability('OFFLINE');
        setDphoneState({ phase: 'OFFLINE' });
        setDphoneError('registerFailed');
      }
    }
  }

  async function becomeAvailable() {
    if (
      availabilityPending ||
      !ownsWork ||
      mediaReadiness !== 'READY' ||
      (api && dphoneState.phase !== 'READY')
    )
      return;
    setAvailabilityPending(true);
    setAvailabilityError(undefined);
    const generation = availabilityGeneration.current;
    try {
      if (api) {
        const leaseId = leaseClient.current?.leaseId();
        if (!leaseId) throw new Error('work-session lease is required');
        await api.becomeAvailable(leaseId);
        const phonePhase = dphone.current?.current().phase;
        if (
          generation !== availabilityGeneration.current ||
          !ownsWorkRef.current ||
          leaseClient.current?.leaseId() !== leaseId ||
          mediaReadinessRef.current !== 'READY' ||
          !phonePhase ||
          !['READY', 'RINGING', 'CONNECTING', 'ACTIVE', 'HELD'].includes(phonePhase)
        )
          return;
      }
      setAvailability('AVAILABLE');
    } catch {
      setAvailability('OFFLINE');
      setAvailabilityError('availabilityFailed');
    } finally {
      setAvailabilityPending(false);
    }
  }

  async function acceptCall() {
    if (
      !acceptingSession ||
      wrapupPending ||
      wrapupUnknown ||
      !dphone.current ||
      dphoneState.phase !== 'RINGING'
    )
      return;
    setDphoneState(await dphone.current.accept());
  }

  function toggleMute() {
    if (!dphone.current) return;
    const next = !muted;
    dphone.current.setMuted(next);
    setMuted(next);
  }

  async function toggleHold() {
    if (!dphone.current) return;
    if (dphoneState.phase === 'ACTIVE') {
      setDphoneState(await dphone.current.hold());
      return;
    }
    if (dphoneState.phase === 'HELD') setDphoneState(await dphone.current.resume());
  }

  async function sendDtmf(value: string) {
    if (!dphone.current || dphoneState.phase !== 'ACTIVE') return;
    setDphoneState(await dphone.current.sendDtmf(value));
  }

  async function hangup() {
    if (!dphone.current) return;
    const phone = dphone.current;
    const reconciler = endedCallSnapshot.current;
    const stillCurrent = reconciler?.checkpoint();
    const current = phone.current();
    const interactionId = 'interactionId' in current ? current.interactionId : undefined;
    const nextState = await phone.hangup();
    if (dphone.current !== phone || !stillCurrent?.()) return;
    setDphoneState(nextState);
    setMuted(false);
    if (interactionId) void reconciler?.start(interactionId);
  }

  async function acceptWrapupResult(result: WrapupResultV1, ownCommand: boolean) {
    if (!draft.valid()) return;
    setSavedWrapup(result);
    setWrapupAlreadyCompleted(!ownCommand);
    setWrapupUnknown(false);
    draft.update({ intent: undefined });
    setWrapupDisposition(undefined);
    setWrapupNote('');
    const interaction = draft.read().interaction;
    if (ownCommand && interaction?.id === result.interactionId && !draft.read().reported) {
      draft.update({ reported: true });
      const event: WorkspaceCallEvent = {
        type: 'wrapup.completed',
        interaction,
        disposition: result.disposition,
      };
      void Promise.resolve()
        .then(() => onCallEventRef.current?.(event))
        .catch(() => undefined);
    }
    try {
      const next = await api!.snapshot();
      if (draft.valid()) setSnapshot(next);
    } catch {
      if (draft.valid()) setSnapshotError('snapshotLoadFailed');
    }
  }

  async function submitWrapup() {
    const interaction = wrapupTarget;
    if (
      !sessionReady ||
      !api ||
      !interaction ||
      interaction.state !== 'WRAPUP' ||
      !wrapupDisposition
    )
      return;
    if (interaction.voiceWrapupPolicy === 'VOICE_NOTE_V1') {
      if (
        draft.read().inFlight ||
        snapshot?.capabilities?.voiceWrapupV1 !== 1 ||
        !api.submitWrapupV1
      )
        return;
      const note = wrapupNote.replace(/\r\n/g, '\n').trim();
      if (
        !note ||
        [...note].length > 2000 ||
        /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(note)
      )
        return;
      const intent: WrapupIntentV1 = draft.read().intent ?? {
        interactionId: interaction.id,
        disposition: wrapupDisposition,
        note,
        commandId: crypto.randomUUID(),
      };
      draft.update({ intent, interaction, inFlight: true });
      setWrapupPending(true);
      setWrapupError(undefined);
      try {
        const result = await api.submitWrapupV1(intent);
        if (
          result.interactionId !== intent.interactionId ||
          result.note !== intent.note ||
          result.disposition !== intent.disposition
        )
          throw new Error('Unexpected wrapup result');
        await acceptWrapupResult(result, true);
      } catch (error) {
        if (
          error instanceof AgentApiError &&
          !wrapupUnknown &&
          error.status >= 400 &&
          error.status < 500 &&
          error.code !== 'INTERACTION_ALREADY_COMPLETED'
        ) {
          draft.update({ intent: undefined });
          setWrapupUnknown(false);
          setWrapupError('wrapupFailed');
        } else {
          setWrapupUnknown(true);
        }
      } finally {
        draft.update({ inFlight: false });
        setWrapupPending(false);
      }
      return;
    }
    setWrapupPending(true);
    setWrapupError(undefined);
    try {
      await api.submitWrapup({
        interactionId: interaction.id,
        disposition: wrapupDisposition,
        commandId: crypto.randomUUID(),
      });
      onCallEventRef.current?.({
        type: 'wrapup.completed',
        interaction,
        disposition: wrapupDisposition,
      });
      setSnapshot(await api.snapshot());
      setWrapupDisposition(undefined);
    } catch {
      setWrapupError('wrapupFailed');
    } finally {
      setWrapupPending(false);
    }
  }

  async function checkWrapupResult() {
    const intent = draft.read().intent;
    if (!intent || !api?.wrapupResult || !api.wrapupCommand || draft.read().inFlight) return;
    draft.update({ inFlight: true });
    setWrapupPending(true);
    draft.update({ reconciling: true });
    try {
      let commandCommitted = false;
      try {
        await api.wrapupCommand(intent.interactionId, intent.commandId);
        commandCommitted = true;
      } catch (error) {
        if (
          !(error instanceof AgentApiError) ||
          error.status !== 404 ||
          error.code !== 'COMMAND_NOT_FOUND'
        )
          throw error;
      }
      const result = await api.wrapupResult(intent.interactionId);
      if (result.interactionId !== intent.interactionId)
        throw new Error('Unexpected wrapup result');
      if (!commandCommitted) {
        try {
          await api.wrapupCommand(intent.interactionId, intent.commandId);
          commandCommitted = true;
        } catch (error) {
          if (
            !(error instanceof AgentApiError) ||
            error.status !== 404 ||
            error.code !== 'COMMAND_NOT_FOUND'
          )
            throw error;
        }
      }
      if (
        commandCommitted &&
        (result.note !== intent.note || result.disposition !== intent.disposition)
      )
        throw new Error('Unexpected wrapup result');
      await acceptWrapupResult(result, commandCommitted);
    } catch {
      setWrapupUnknown(true);
    } finally {
      draft.update({ reconciling: false });
      draft.update({ inFlight: false });
      setWrapupPending(false);
    }
  }

  function moveWorkHere() {
    leaderElection.claim();
    setWorkingTab(true);
  }

  // ── dphone: คำสั่งจาก widget หรือหน้าต่างแยกเข้าทางเดียวกัน ──────────────────────────────
  const commandRef = useRef<(command: DphoneCommand) => void>(() => undefined);
  commandRef.current = (command) => {
    if (command.type === 'accept') void acceptCall();
    else if (command.type === 'toggleMute') toggleMute();
    else if (command.type === 'toggleHold') void toggleHold();
    else if (command.type === 'hangup') void hangup();
    else void sendDtmf(command.value);
  };
  const dispatch = (command: DphoneCommand) => commandRef.current(command);

  const view: DphoneView = {
    phase: dphoneState.phase,
    caller: snapshot?.interaction?.caller ?? null,
    queueName: snapshot?.interaction?.queue?.name ?? null,
    muted,
    locale,
  };

  // host ของหน้าต่างแยก — เฉพาะจุดรับงานในโหมด shell (flag ปิด = working tab เดิม; เปิด = ผู้ถือ lease
  // หรือยังมีสายในมือ) เสียจุดรับงานตอนว่าง → ปิดสะพานและหน้าต่างแยก
  const host = useRef<ReturnType<typeof createDphoneHost>>(undefined);
  useEffect(() => {
    if (!inShell || !mediaOwner) return;
    const bridge = createDphoneHost({
      onCommand: (command) => commandRef.current(command),
      // bye ไม่ล้าง id: หน้าต่างแยกที่ reload จะส่ง hello ด้วย id เดิมและต่อกลับได้
      onRemotePresence: (present) => setDetached(present),
      expectedRemote: () => remoteId.current,
    });
    host.current = bridge;
    return () => {
      bridge.recall();
      bridge.close();
      host.current = undefined;
      setDetached(false);
    };
  }, [inShell, mediaOwner]);

  const viewKey = JSON.stringify(view);
  useEffect(() => {
    host.current?.publish(JSON.parse(viewKey) as DphoneView);
  }, [viewKey, detached]);

  // หน้าต่างแยกถูกปิดโดยไม่ได้ส่ง bye (เช่น browser ปิดทันที) — widget กลับมาที่หน้าเอง
  useEffect(() => {
    if (!detached) return;
    const timer = window.setInterval(() => {
      if (popup.current?.closed) {
        popup.current = null;
        remoteId.current = undefined;
        setDetached(false);
      }
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [detached]);

  function detach() {
    const id = crypto.randomUUID();
    const url = new URL('/dphone', window.location.origin);
    const tenant = new URL(window.location.href).searchParams.get('tenant');
    if (tenant) url.searchParams.set('tenant', tenant);
    url.searchParams.set('remote', id);
    remoteId.current = id;
    popup.current = window.open(url, 'dcontact-dphone', 'popup=yes,width=380,height=640');
    // popup ถูกบล็อก: คง widget ไว้ในหน้าเดิม ไม่มีอะไรเปลี่ยน
    if (popup.current) setDetached(true);
    else remoteId.current = undefined;
  }

  function attach() {
    host.current?.recall();
    popup.current?.close();
    popup.current = null;
    remoteId.current = undefined;
    setDetached(false);
  }

  function changeSize(next: DphoneSize) {
    setDphoneSize(next);
    try {
      localStorage.setItem(SIZE_KEY, next);
    } catch {
      // ดู loadSize
    }
  }

  const readinessLabel = t(`readiness.${mediaReadiness}`);

  const statusStrip = (
    <div className="aw-status-strip" aria-label={t('status.label')}>
      <span
        className={'aw-chip ' + (ownsWork ? 'aw-chip-success' : 'aw-chip-neutral')}
        role="status"
        aria-label={t('status.owner')}
      >
        {enforced
          ? leaseHeld
            ? t('lease.chip.held')
            : lease.phase === 'idle' || lease.phase === 'checking' || lease.phase === 'acquiring'
              ? t('status.checking')
              : t('lease.chip.standby')
          : workingTab === undefined
            ? t('status.checking')
            : workingTab
              ? t('status.working')
              : t('status.passive')}
      </span>
      <span
        className={
          'aw-chip ' + (mediaReadiness === 'READY' ? 'aw-chip-success' : 'aw-chip-warning')
        }
      >
        {readinessLabel}
      </span>
      <span
        className={
          'aw-chip ' + (availability === 'AVAILABLE' ? 'aw-chip-success' : 'aw-chip-neutral')
        }
      >
        {availability === 'AVAILABLE' ? t('status.available') : t('status.offline')}
      </span>
      <span
        className={
          'aw-chip ' + (dphoneState.phase === 'READY' ? 'aw-chip-success' : 'aw-chip-neutral')
        }
        role="status"
        aria-label={t('status.dphone')}
      >
        {td(`phase.${dphoneState.phase}`)}
      </span>
      {/* #588: ใน shell ใหม่ออกจากระบบที่เมนูผู้ใช้บนแถบบนที่เดียว */}
      {onSignOut && !inShellFrame ? (
        <Button size="sm" variant="ghost" onPress={onSignOut}>
          {t('status.signOut')}
        </Button>
      ) : null}
    </div>
  );

  const identity = (
    <div className="aw-identity">
      <span className="aw-tenant">{tenantLabel}</span>
      {snapshot ? <strong>{snapshot.agent.displayName}</strong> : null}
    </div>
  );

  const offerPanel =
    !inShell && snapshot?.interaction?.state === 'ASSIGNED' ? (
      <article className="aw-panel aw-offer" aria-labelledby="incoming-offer-title">
        <div>
          <p className="aw-step">{t('offer.step')}</p>
          <h2 id="incoming-offer-title">{t('offer.title')}</h2>
          <strong className="aw-caller">
            {snapshot.interaction.caller ?? t('offer.noNumber')}
          </strong>
        </div>
        <dl className="aw-facts">
          <div>
            <dt>{t('offer.queue')}</dt>
            <dd>{snapshot.interaction.queue?.name ?? t('offer.unknownQueue')}</dd>
          </div>
          <div>
            <dt>{t('offer.authority')}</dt>
            <dd>{t('offer.version', { version: snapshot.interaction.version })}</dd>
          </div>
        </dl>
        <div className="aw-actions">
          <Button
            variant="primary"
            isDisabled={dphoneState.phase !== 'RINGING'}
            onPress={() => void acceptCall()}
          >
            {td('accept')}
          </Button>
        </div>
      </article>
    ) : null;

  const controlsPanel =
    !inShell && (dphoneState.phase === 'ACTIVE' || dphoneState.phase === 'HELD') ? (
      <article className="aw-panel" aria-labelledby="call-controls-title">
        <div>
          <p className="aw-step">{t('controls.step')}</p>
          <h2 id="call-controls-title">{t('controls.title')}</h2>
        </div>
        <div className="aw-actions">
          <Button onPress={toggleMute}>{muted ? td('unmute') : td('mute')}</Button>
          <Button onPress={() => void toggleHold()}>
            {dphoneState.phase === 'HELD' ? td('resume') : td('hold')}
          </Button>
          <Button variant="danger" onPress={() => void hangup()}>
            {td('hangup')}
          </Button>
        </div>
        <div className="aw-dtmf" role="group" aria-label={td('dtmfPad')}>
          {DTMF_KEYS.map((value) => (
            <button
              type="button"
              key={value}
              aria-label={td('dtmf', { value })}
              disabled={dphoneState.phase !== 'ACTIVE'}
              onClick={() => void sendDtmf(value)}
            >
              {value}
            </button>
          ))}
        </div>
      </article>
    ) : null;

  const requiresWrapupV1 = wrapupTarget?.voiceWrapupPolicy === 'VOICE_NOTE_V1';
  const normalizedNote = wrapupNote.replace(/\r\n/g, '\n').trim();
  const noteLength = [...normalizedNote].length;
  const validNote =
    noteLength >= 1 &&
    noteLength <= 2000 &&
    !/\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
      normalizedNote,
    );
  const wrapupV1Supported = snapshot?.capabilities?.voiceWrapupV1 === 1 && !!api?.submitWrapupV1;
  const wrapupPanel = (
    <>
      {savedWrapup ? (
        <article className="aw-panel" aria-live="polite">
          <h2>{t('wrapup.saved')}</h2>
          {wrapupAlreadyCompleted ? <p>{t('wrapup.alreadyCompleted')}</p> : null}
          <p>
            {savedWrapup.disposition === 'CUSTOMER_ASSISTED'
              ? t('wrapup.assisted')
              : t('wrapup.followUp')}
          </p>
          <p className="aw-wrapup-note">{savedWrapup.note}</p>
          <time dateTime={savedWrapup.recordedAt}>
            {new Date(savedWrapup.recordedAt).toLocaleString(locale)}
          </time>
        </article>
      ) : null}
      {wrapupTarget?.state === 'WRAPUP' && savedWrapup?.interactionId !== wrapupTarget.id ? (
        <article className="aw-panel" aria-labelledby="wrapup-title">
          <div>
            <p className="aw-step">{t('wrapup.step')}</p>
            <h2 id="wrapup-title">{t('wrapup.title')}</h2>
            <p className="aw-copy">{t('wrapup.copy')}</p>
            {wrapupUnknown || wrapupPending ? (
              <p>{t('wrapup.recoveringInteraction', { interactionId: wrapupTarget.id })}</p>
            ) : null}
          </div>
          <div className="aw-segmented" role="group" aria-label={t('wrapup.choose')}>
            <button
              type="button"
              aria-pressed={wrapupDisposition === 'CUSTOMER_ASSISTED'}
              disabled={wrapupPending || wrapupUnknown}
              onClick={() => setWrapupDisposition('CUSTOMER_ASSISTED')}
            >
              {t('wrapup.assisted')}
            </button>
            <button
              type="button"
              aria-pressed={wrapupDisposition === 'FOLLOW_UP_REQUIRED'}
              disabled={wrapupPending || wrapupUnknown}
              onClick={() => setWrapupDisposition('FOLLOW_UP_REQUIRED')}
            >
              {t('wrapup.followUp')}
            </button>
          </div>
          {requiresWrapupV1 ? (
            <>
              <label htmlFor="wrapup-note">{t('wrapup.note')}</label>
              <textarea
                id="wrapup-note"
                value={wrapupNote}
                disabled={wrapupPending || wrapupUnknown || !wrapupV1Supported}
                aria-describedby="wrapup-note-help"
                onChange={(event) => setWrapupNote(event.target.value)}
              />
              <p id="wrapup-note-help">{t('wrapup.noteCount', { count: noteLength })}</p>
              {!validNote ? <p>{t('wrapup.noteRequired')}</p> : null}
              {!wrapupV1Supported ? <p role="alert">{t('wrapup.upgradeRequired')}</p> : null}
            </>
          ) : null}
          <Button
            variant="primary"
            isDisabled={
              !wrapupDisposition ||
              !sessionReady ||
              wrapupPending ||
              (requiresWrapupV1 && (!wrapupV1Supported || !validNote))
            }
            onPress={() => void submitWrapup()}
          >
            {t('wrapup.submit')}
          </Button>
          {wrapupPending && !wrapupState.reconciling ? (
            <p role="status">{t('wrapup.pending')}</p>
          ) : null}
          {wrapupState.reconciling ? <p role="status">{t('wrapup.reconciling')}</p> : null}
          {wrapupUnknown ? <p role="status">{t('wrapup.unknown')}</p> : null}
          {wrapupUnknown && api?.wrapupResult && api.wrapupCommand ? (
            <Button isDisabled={wrapupPending} onPress={() => void checkWrapupResult()}>
              {t('wrapup.checkResult')}
            </Button>
          ) : null}
          {wrapupError ? (
            <p role="alert" className="aw-error">
              {t(wrapupError)}
            </p>
          ) : null}
        </article>
      ) : null}
    </>
  );

  const mediaPanel = (
    <article className="aw-panel">
      <div className="aw-panel-heading">
        <div>
          <p className="aw-step">{t('media.step')}</p>
          <h2>{t('media.title')}</h2>
        </div>
        <span
          className={'aw-readiness aw-readiness-' + mediaReadiness.toLowerCase()}
          role="status"
          aria-label={t('media.indicator')}
        >
          {readinessLabel}
        </span>
      </div>
      <p className="aw-copy">{t('media.copy')}</p>
      <div className="aw-device">
        <div className="aw-device-icon" aria-hidden="true">
          {t('media.device')}
        </div>
        <div>
          <strong>{t('media.mic')}</strong>
          <span>{t('media.micHint')}</span>
        </div>
      </div>
      {mediaError ? (
        <p className="aw-error" role="alert">
          {t(mediaError)}
        </p>
      ) : null}
      <Button
        isDisabled={!ownsWork || mediaReadiness === 'CHECKING'}
        onPress={() => void checkMediaReadiness()}
      >
        {mediaReadiness === 'CHECKING' ? t('media.checking') : t('media.check')}
      </Button>
    </article>
  );

  const availabilityPanel = (
    <article className="aw-panel">
      <div className="aw-panel-heading">
        <div>
          <p className="aw-step">{t('availability.step')}</p>
          <h2>{t('availability.title')}</h2>
        </div>
        <span className={'aw-dot aw-dot-' + availability.toLowerCase()} aria-hidden="true" />
      </div>
      <div className="aw-availability" aria-live="polite">
        <strong>
          {availability === 'AVAILABLE' ? t('availability.ready') : t('availability.notReady')}
        </strong>
        <span>
          {availability === 'AVAILABLE'
            ? t('availability.readyHint')
            : t('availability.notReadyHint')}
        </span>
      </div>
      <Button
        variant="primary"
        isDisabled={
          availabilityPending ||
          !ownsWork ||
          mediaReadiness !== 'READY' ||
          availability === 'AVAILABLE' ||
          Boolean(api && dphoneState.phase !== 'READY')
        }
        onPress={becomeAvailable}
      >
        {t(availabilityPending ? 'availability.pending' : 'availability.open')}
      </Button>
      {availabilityError ? (
        <p className="aw-warning" role="status">
          {t(availabilityError)}
        </p>
      ) : null}
    </article>
  );

  const content = (
    <>
      <div className="aw-page-heading">
        <div>
          <p className="aw-eyebrow">{t('heading.eyebrow')}</p>
          <h1>{t('heading.title')}</h1>
          <p>{t('heading.lede')}</p>
        </div>
        <span className="aw-phase-badge">{t('heading.phase')}</span>
      </div>

      {enforced && !leaseHeld && workInHand ? (
        <p className="aw-warning" role="alert">
          {t('lease.inHand')}
        </p>
      ) : null}

      {governanceAlert ? (
        <section
          className={'aw-governance aw-governance-' + governanceAlert.state.toLowerCase()}
          role="alert"
        >
          <div>
            <strong>
              {governanceAlert.state === 'READY' ? t('governance.ready') : t('governance.required')}
            </strong>
            <p>{governanceAlert.message}</p>
          </div>
          {governanceAlert.state !== 'READY' ? (
            <Button onPress={() => setLiveRetry((value) => value + 1)}>
              {t('governance.retry')}
            </Button>
          ) : null}
        </section>
      ) : null}

      <section className="aw-grid" aria-label={t('grid')}>
        {sessionReady && recoveryRevision !== undefined && !acceptingSession ? (
          <article className="aw-panel" role="status">
            <p>{t('wrapup.reconciling')}</p>
            <Button onPress={() => setNetworkRevision((revision) => revision + 1)}>
              {t('recovery.retry')}
            </Button>
          </article>
        ) : null}
        {offerPanel}
        {controlsPanel}

        {wrapupPanel}

        {snapshotError ? (
          <p className="aw-warning" role="status">
            {t(snapshotError)}
          </p>
        ) : null}

        {dphoneError ? (
          <p className="aw-warning" role="alert">
            {t(dphoneError)}
          </p>
        ) : null}

        {mediaPanel}

        {availabilityPanel}

        <article className="aw-panel">
          <p className="aw-step">{t('authority.step')}</p>
          <h2>{t('authority.title')}</h2>
          <dl className="aw-facts">
            <div>
              <dt>{t('authority.interaction')}</dt>
              <dd>{snapshot?.interaction?.state ?? t('authority.routerApi')}</dd>
            </div>
            <div>
              <dt>{t('authority.media')}</dt>
              <dd>{readinessLabel}</dd>
            </div>
            <div>
              <dt>{t('authority.presence')}</dt>
              <dd>{snapshot?.agent.state ?? availability}</dd>
            </div>
          </dl>
          <p className="aw-note">{t('authority.note')}</p>
        </article>
      </section>
    </>
  );

  const leasePanel =
    sessionReady && enforced && !leaseHeld && !workInHand ? (
      <WorkSessionPanel
        state={lease}
        onAcquire={() => {
          leaderElection.claim();
          setWorkingTab(true);
          void leaseClient.current?.acquire();
        }}
        onTakeover={() => {
          leaderElection.claim();
          setWorkingTab(true);
          void leaseClient.current?.takeover();
        }}
        onRefresh={() => void leaseClient.current?.refresh()}
      />
    ) : null;

  // E1.14: dphone ที่ถูกฝัง — component และ logic งานสายชุดเดียวกับ Workspace แต่ไม่มี shell/หน้าต่างแยก
  if (embedded) {
    return (
      <div className="aw-root aw-embedded">
        {statusStrip}
        {mediaOwner ? (
          <DphoneWidget
            view={view}
            size={dphoneSize}
            onSizeChange={changeSize}
            onCommand={dispatch}
          />
        ) : null}
        {wrapupPanel}
        {dphoneError ? (
          <p className="aw-warning" role="alert">
            {t(dphoneError)}
          </p>
        ) : null}
        {snapshotError ? (
          <p className="aw-warning" role="status">
            {t(snapshotError)}
          </p>
        ) : null}
        {mediaReadiness !== 'READY' ? mediaPanel : null}
        {availability !== 'AVAILABLE' ? availabilityPanel : null}
        <audio ref={remoteAudio} autoPlay className="aw-remote-audio" />
        {leasePanel}
      </div>
    );
  }

  return (
    <div className={inShell ? 'aw-root aw-in-shell' : 'aw-root aw-legacy'}>
      {inShell ? (
        <>
          <header className="aw-content-header">
            {identity}
            {statusStrip}
          </header>
          {content}
        </>
      ) : (
        <>
          <aside className="aw-rail" aria-label={t('legacy.railLabel')}>
            <img className="aw-rail-mark" src="/d-contact-icon-64.png" alt={t('legacy.logoAlt')} />
            <button type="button" aria-label={t('legacy.overview')}>
              01
            </button>
            <button type="button" className="aw-active" aria-label={t('legacy.agentWorkspace')}>
              02
            </button>
            <button type="button" aria-label={t('legacy.supervisor')}>
              03
            </button>
          </aside>
          <aside className="aw-nav">
            <div className="aw-brand">
              <img src="/d-contact-icon-64.png" alt="" />
              {t('legacy.brand')}
            </div>
            <p className="aw-nav-label">{t('legacy.navLabel')}</p>
            <button type="button" className="aw-nav-item aw-active">
              {t('legacy.inbox')}
            </button>
            <button type="button" className="aw-nav-item">
              {t('legacy.history')}
            </button>
            <p className="aw-pilot">{t('legacy.pilot')}</p>
          </aside>
          <section className="aw-workspace">
            <header className="aw-topbar">
              {identity}
              {statusStrip}
            </header>
            <main className="aw-main">{content}</main>
          </section>
        </>
      )}

      {inShell && mediaOwner ? (
        detached ? (
          <DphoneDetachedBar view={view} onAttach={attach} />
        ) : (
          <DphoneWidget
            floating
            view={view}
            size={dphoneSize}
            onSizeChange={changeSize}
            onCommand={dispatch}
            onDetach={detach}
          />
        )
      ) : null}

      <audio ref={remoteAudio} autoPlay className="aw-remote-audio" />

      {leasePanel}

      {!enforced && workingTab === false ? (
        <div className="aw-passive-overlay">
          <section className="aw-passive-card" aria-labelledby="passive-title">
            <p className="aw-eyebrow">{t('passive.eyebrow')}</p>
            <h2 id="passive-title">{t('passive.title')}</h2>
            <p>{t('passive.body')}</p>
            <Button variant="primary" onPress={moveWorkHere}>
              {t('passive.move')}
            </Button>
          </section>
        </div>
      ) : null}
    </div>
  );
}
