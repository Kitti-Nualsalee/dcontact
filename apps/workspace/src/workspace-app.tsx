import { ExternalPhoneControlPanel } from './external-phone-control-panel.js';
import type { WorkspacePhoneControlMode } from './external-phone-control.js';
import {
  WORK_CUSTOMER_QUERY_ID,
  WorkCustomerPanel,
  type LinkedCustomer,
} from './work-customer-panel.js';
import { CasePanel, useCaseDrafts } from './case-panel.js';
import {
  WebchatCapacity,
  WebchatClosedPanel,
  WebchatClosedRows,
  WebchatOffers,
  WebchatRoomView,
  WebchatRows,
  WebchatWrapupPanel,
  useWebchat,
  type WebchatRoomTab,
} from './webchat/webchat-view.js';
import { useFloatingOverlapInset } from './floating-inset.js';
/**
 * Agent Workspace — D1.15 (#454): messages come from the `workspace`/`dphone` catalogs, CSS uses tokens only (`aw-*`),
 * inside AppShell (flag `ui.shell.v2`) it does not draw the old chrome and uses the floating dphone widget instead of the call control panel
 *
 * Rule that must not be broken (ADR-026): the dphone instance is created once per page load in `AgentWorkspace`;
 * collapsing/expanding/dragging/detaching the window and switching language only change the UI — no new SIP session, WebRTC or WS
 *
 * E1.12 (#486), #583: every tenant — the work point is the holder of the server-side work-session lease
 * (ADR-026 item 2): get the lease first, then connect the WS (with `leaseId`) and register SIP; losing the lease = stop taking new work immediately
 * and withdraw the SIP register when there is no work in hand — a call in progress/wrap-up is not cut (ADR-026 item 4)
 * flag off = exactly the old behavior (tab leader election decides)
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from 'react';
import { WrapupRuntime } from './wrapup-runtime.js';
import { useLocale, useTranslation } from '@d-contact/i18n/react';
import { Button, Tab, TabList, TabPanel, Tabs, useInShell } from '@d-contact/ui-react';
import {
  AgentApiError,
  type AgentWorkspaceApi,
  type AgentWorkspaceSnapshot,
  type AfterWork,
  type NotReadyReason,
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
import { PaneIcon, PaneSplitter, usePaneWidth, type PaneIconName } from './workspace-pane.js';
import { UtilityToolbar } from './utility-toolbar.js';
import { devicePreferences, micConstraint } from './device-preferences.js';
import { DeviceTestButton } from './device-test-panel.js';
import {
  StatusGate,
  StatusSelector,
  SupervisorNotice,
  fallbackReason,
  lastStatusChoice,
  rememberStatusChoice,
  type PrepFailure,
  type PrepStatus,
  type PrepStep,
  type StatusChoice,
} from './agent-status.js';
import './agent-workspace.css';
import './dphone/dphone.css';

/** V3: right panel tabs · main view · work list and the work selected in the list */
type InspectorTab = 'wrapup' | 'case' | 'details' | 'events' | 'readiness';
type MainTab = 'customer' | 'voice';
type ListTab = 'open' | 'closed';
type Selection = 'current' | 'recent';
type MediaReadiness = 'UNCHECKED' | 'CHECKING' | 'READY' | 'BLOCKED';
type Availability = 'OFFLINE' | 'AVAILABLE';
type WorkspaceMessage =
  | 'snapshotLoadFailed'
  | 'offerConfirmFailed'
  | 'autoplayBlocked'
  | 'micEnded'
  | 'micBlocked'
  | 'registerFailed'
  | 'extensionCallFailed'
  | 'extensionAudioBlocked'
  | 'availabilityFailed'
  | 'wrapupFailed';

export interface WorkspaceAppProps {
  phoneControlMode?: WorkspacePhoneControlMode;
  sessionReady?: boolean;
  wrapupRuntime?: WrapupRuntime;
  identityKey?: string;
  recoveryRevision?: number;
  api?: AgentWorkspaceApi;
  tenantLabel?: string;
  onSignOut?: () => void;
  createDphone?: DphoneFactory;
  /** E1.12: REST for the work-session lease — absent = old behavior (no lease) */
  workSession?: WorkSessionApi;
  /** surface that asks for the lease (E1.9) — Workspace = `workspace` */
  workSessionSurface?: WorkSessionSurface;
  /**
   * E1.14: `embedded` = dphone embedded in a host — shows only dphone, audio devices, readiness and wrap-up
   * (no shell/detached window) using the same call-work logic as Workspace
   */
  variant?: 'workspace' | 'embedded';
  /** E1.14: call-work events, for the embed runtime to send screen-pop/activity to the host */
  onCallEvent?: (event: WorkspaceCallEvent) => void;
  /** E1.14: lease currently held (undefined = not held) — used to attach `x-work-session-lease-id` */
  onLeaseChange?: (leaseId: string | undefined) => void;
  /** #588: there is an incoming call, a call in hand or an unsaved wrap-up — the shell uses it to confirm before sign-out */
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
 * Evidence for acceptance (dev/e2e only): the SIP session and WS connection in use.
 * Playwright reads it before/after collapse-expand-detach-language switch and must get the same value
 */
interface DphoneDiagnostics {
  sipSessionId(): string | undefined;
  wsConnectionId(): string | undefined;
  /** E1.12: work-session lease currently held (if any) */
  workSessionLeaseId(): string | undefined;
}

declare global {
  interface Window {
    __dcontactDphone?: DphoneDiagnostics;
  }
}

const SIZE_KEY = 'dcontact.dphone.size';
const DTMF_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

function loadSize(): DphoneSize {
  try {
    const saved = localStorage.getItem(SIZE_KEY);
    if (saved && (DPHONE_SIZES as readonly string[]).includes(saved)) return saved as DphoneSize;
  } catch {
    // size is a convenience, not important data
  }
  return 'compact';
}

/** the token comes before the content, then `AgentWorkspace` is mounted once (dphone must not be created again) */
export function WorkspaceApp(props: WorkspaceAppProps) {
  const tokensReady = useShellTokens();
  if (!tokensReady) return null;
  return <AgentWorkspace {...props} />;
}

function AgentWorkspace({
  phoneControlMode = 'browser',
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
  const extensionControl = !embedded && phoneControlMode === 'chrome-extension';
  const externalControl = !embedded && phoneControlMode === 'external-simulator';
  const { t, i18n } = useTranslation('workspace');
  const { t: td } = useTranslation('dphone');
  const { locale } = useLocale();
  // embedded has no shell but uses the new shell's widget (D1.15) just the same
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
  // messages are stored as keys and translated at render — they follow a language switch
  const [mediaError, setMediaError] = useState<WorkspaceMessage>();
  const [snapshot, setSnapshot] = useState<AgentWorkspaceSnapshot>();
  // #938 status picker page after login and the status selector (enabled when the server supports agentStatusV1 from #937)
  const [reasons, setReasons] = useState<NotReadyReason[]>([]);
  const [gate, setGate] = useState<'pending' | 'open' | 'done'>('pending');
  const [gateInitial] = useState<StatusChoice>(lastStatusChoice);
  const [prep, setPrep] = useState<{
    preparing: boolean;
    steps: Partial<Record<PrepStep, PrepStatus>>;
    failure?: PrepFailure;
  }>({ preparing: false, steps: {} });
  const [statusPending, setStatusPending] = useState(false);
  const [statusError, setStatusError] = useState<PrepFailure | 'change' | 'chatBusy'>();
  const [acknowledgedChange, setAcknowledgedChange] = useState<string | null>();
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
  // V3: the right panel picks the tab that needs doing next when the work state changes (the user can still switch it)
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('readiness');
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [mainTab, setMainTab] = useState<MainTab>('customer');
  // #956 case draft per work, and the customer linked to the current work (reported from WorkCustomerPanel)
  const caseDrafts = useCaseDrafts();
  const [workCustomer, setWorkCustomer] = useState<{
    workId: string;
    customer: LinkedCustomer | null | undefined;
  }>();
  const [caseFocus, setCaseFocus] = useState(0);
  const inspectorRef = useRef<HTMLElement>(null);
  useFloatingOverlapInset(inspectorRef, inspectorOpen);
  const [listTab, setListTab] = useState<ListTab>('open');
  const [selection, setSelection] = useState<Selection>('current');
  const listWidth = usePaneWidth('dcontact.workspace.listWidth', 260, 200, 360);
  const inspectorWidth = usePaneWidth('dcontact.workspace.inspectorWidth', 340, 280, 480);
  const [now, setNow] = useState(() => Date.now());
  const mediaStream = useRef<MediaStream | undefined>(undefined);
  const remoteAudio = useRef<HTMLAudioElement | null>(null);
  const dphone = useRef<BrowserDphone | undefined>(undefined);
  const endedCallSnapshot = useRef<EndedCallSnapshotReconciler | undefined>(undefined);
  const liveConnectionId = useRef<string | undefined>(undefined);
  const popup = useRef<Window | null>(null);
  // id of the detached window this tab opened — the host accepts hello/bye/commands only from this id
  const remoteId = useRef<string | undefined>(undefined);
  const governanceGate = useMemo(() => new WorkspaceOutboundGate(), []);
  // E1.12: work-session lease — `disabled` = `workSession` was not passed in (test/harness only)
  // #583: every tenant enforces the lease now, so there is no "tenant does not enforce" state from the server
  const leaseClient = useRef<WorkSessionClient | undefined>(undefined);
  const [lease, setLease] = useState<WorkSessionState | { phase: 'disabled' }>(
    workSession ? { phase: 'idle' } : { phase: 'disabled' },
  );
  const [socketLeaseId, setSocketLeaseId] = useState<string>();
  const [disconnectedPhoneLease, setDisconnectedPhoneLease] = useState<string>();
  const [customerInvalidation, setCustomerInvalidation] = useState(0);
  const customerLease = useRef<string | undefined>(undefined);
  const enforced = lease.phase !== 'disabled';
  const leaseHeld = lease.phase === 'held';
  // #1044 web chat: the Agent's rooms live in their own store; this page only decides what is in view
  const webchatEnabled = !embedded && snapshot?.capabilities?.webchatV1 === 1;
  const webchat = useWebchat({
    api: api?.webchat,
    enabled: webchatEnabled,
    submitWrapup: api?.submitWrapupV1,
  });
  const webchatRef = useRef(webchat);
  webchatRef.current = webchat;
  const chatState = webchat?.state;
  const chatRoom = chatState?.rooms.find(
    (room) => room.chat.interactionId === chatState.selectedId,
  );
  const chatClosed = chatRoom
    ? undefined
    : chatState?.closed.find((closed) => closed.interactionId === chatState.selectedId);
  const chatInView = Boolean(chatRoom || chatClosed);
  const chatRooms = chatState?.rooms.length ?? 0;
  const chatOffers = chatState?.offers.length ?? 0;
  // a system state (offered, busy, wrapping up) reads as chat work when it comes from chats, not a call
  const agentStateLabel = (state: NonNullable<AgentWorkspaceSnapshot['agent']>['state']) =>
    chatRooms + chatOffers > 0 &&
    !snapshot?.interaction &&
    (state === 'RESERVED' || state === 'BUSY' || state === 'ACW')
      ? t(`chat.agentState.${state}`)
      : t(`agentState.${state}`);
  const [chatTab, setChatTab] = useState<WebchatRoomTab>('conversation');
  const [chatFocus, setChatFocus] = useState(0);
  const [chatWrapupFocus, setChatWrapupFocus] = useState(0);
  const inCall =
    dphoneState.phase === 'CONNECTING' ||
    dphoneState.phase === 'ACTIVE' ||
    dphoneState.phase === 'HELD' ||
    ((dphoneState.phase === 'RECONNECTING' || dphoneState.phase === 'RECOVERY_REQUIRED') &&
      Boolean(dphoneState.interactionId));
  // work in hand = a call or an interaction that still needs work (ACTIVE/WRAPUP) — the server does not release the lease meanwhile
  const workInHand =
    inCall ||
    wrapupPending ||
    wrapupUnknown ||
    snapshot?.interaction?.state === 'ACTIVE' ||
    snapshot?.interaction?.state === 'WRAPUP' ||
    // #1044 a chat in hand (talking or waiting for its result) is work the server keeps the lease for
    chatRooms > 0;
  const statusV1 =
    snapshot?.capabilities?.agentStatusV1 === 1 &&
    inShellFrame &&
    !externalControl &&
    !extensionControl &&
    Boolean(api?.setAgentState);
  useEffect(() => {
    if (!statusV1 || !api?.notReadyReasons) return;
    let cancelled = false;
    void api
      .notReadyReasons()
      .then((list) => {
        if (!cancelled) setReasons(list);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [statusV1, api]);
  // while idle, read the snapshot periodically so the state a Supervisor changed and the time in state match the server
  useEffect(() => {
    if (!statusV1 || gate !== 'done' || workInHand || !api) return;
    const timer = window.setInterval(() => {
      void api
        .snapshot()
        .then(setSnapshot)
        .catch(() => undefined);
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [statusV1, gate, workInHand, api]);
  // work in hand when the page opens (including reload during a call) = skip the status picker — UI principle 4
  // #1044 chats in hand count as work too, so wait until they are known
  const chatsKnown = !webchatEnabled || !api?.webchat || chatState?.ready === true;
  useEffect(() => {
    if (statusV1 && gate === 'pending' && chatsKnown) setGate(workInHand ? 'done' : 'open');
  }, [statusV1, gate, workInHand, chatsKnown]);
  // can take new work: flag on = holds the lease; flag off = working tab (old)
  const ownsWork =
    acceptingSession && !wrapupPending && !wrapupUnknown && (enforced ? leaseHeld : workingTab);
  // keep SIP/WS/dphone window: flag on = holds the lease or still has work in hand; flag off = working tab (old)
  const mediaOwner = enforced ? leaseHeld || workInHand : workingTab;
  // #588: signing out now would cut a call, miss an offered or ringing call, or drop an unsaved wrap-up
  // (an offer is also counted from the snapshot — a tab that does not hold media, or whose INVITE has not arrived, has no RINGING)
  const signOutLosesWork =
    workInHand ||
    dphoneState.phase === 'RINGING' ||
    snapshot?.interaction?.state === 'ASSIGNED' ||
    chatOffers > 0;
  const onWorkInHandChangeRef = useRef(onWorkInHandChange);
  onWorkInHandChangeRef.current = onWorkInHandChange;
  useEffect(() => {
    onWorkInHandChangeRef.current?.(signOutLosesWork);
  }, [signOutLosesWork]);
  // after unmount this page has no work in hand — do not leave the shell stuck in the "has work" state
  useEffect(() => () => onWorkInHandChangeRef.current?.(false), []);
  const onCallEventRef = useRef(onCallEvent);
  onCallEventRef.current = onCallEvent;
  // offered/answered once per interaction+state (the snapshot can be loaded many times)
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
  // V3: entered WRAPUP/outcome saved → summary (open the panel), audio device not ready (e.g. reload during a call)
  // or controlling the call with an external softphone or no work → readiness, otherwise → details + Customer 360
  // the user can still switch tabs or close the panel
  const readinessFirst = externalControl || mediaReadiness !== 'READY';
  const wrapupFormOpen =
    wrapupTarget?.state === 'WRAPUP' && savedWrapup?.interactionId !== wrapupTarget.id;
  const detailFocus = wrapupFormOpen
    ? `wrapup:${wrapupTarget.id}`
    : savedWrapup && savedWrapup.interactionId === wrapupTarget?.id
      ? `wrapup:saved:${savedWrapup.interactionId}`
      : snapshot?.interaction && !readinessFirst
        ? `details:${snapshot.interaction.id}`
        : snapshot
          ? 'readiness'
          : undefined;
  useEffect(() => {
    if (!detailFocus) return;
    const tab = detailFocus.split(':')[0] as InspectorTab;
    setInspectorTab(tab);
    setSelection('current');
    setListTab('open');
    if (tab === 'wrapup' || tab === 'readiness') setInspectorOpen(true);
    if (tab === 'details') setMainTab('customer');
  }, [detailFocus]);
  const callRunning = Boolean(snapshot?.interaction?.answeredAt && !snapshot.interaction.endedAt);
  // #1044 offers count down and rooms show waiting time, so the clock also runs while chats are in hand
  const clockRunning = callRunning || chatRooms > 0 || chatOffers > 0;
  useEffect(() => {
    if (!clockRunning) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [clockRunning]);
  // #1044 the Agent's state follows the chats in hand; read it again when they change
  const chatSignature = chatState
    ? `${chatState.offers.length}|${chatState.rooms.map((room) => `${room.chat.interactionId}:${room.chat.state}`).join(',')}`
    : undefined;
  const chatSignatureSeen = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (chatSignature === undefined || chatSignatureSeen.current === chatSignature) return;
    const first = chatSignatureSeen.current === undefined;
    chatSignatureSeen.current = chatSignature;
    if (!first) void refreshSnapshot();
    // refreshSnapshot reads only the stable `api`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatSignature]);
  // the room in view ended: bring its wrap-up forward, as for a call
  const chatRoomKey = chatRoom
    ? `${chatRoom.chat.interactionId}:${chatRoom.chat.state}`
    : undefined;
  useEffect(() => {
    if (!chatRoomKey) return;
    if (chatRoomKey.endsWith(':WRAPUP')) {
      setInspectorTab('wrapup');
      setInspectorOpen(true);
    }
    setListTab('open');
  }, [chatRoomKey]);
  // Alt+Up / Alt+Down move between rooms and Alt+Shift+A accepts the newest offer, also while typing
  useEffect(() => {
    if (!webchatEnabled) return;
    const onKey = (event: KeyboardEvent) => {
      const chats = webchatRef.current;
      if (!chats || !event.altKey || event.ctrlKey || event.metaKey) return;
      if (!event.shiftKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        if (chats.state.rooms.length === 0) return;
        event.preventDefault();
        chats.store.selectRelative(event.key === 'ArrowDown' ? 1 : -1);
        setChatFocus((value) => value + 1);
      } else if (event.shiftKey && event.code === 'KeyA') {
        const offer = chats.state.offers.at(-1);
        if (!offer) return;
        event.preventDefault();
        void chats.store.accept(offer.interactionId).then((taken) => {
          if (taken) setChatFocus((value) => value + 1);
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [webchatEnabled]);
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

  // Media may connect before the Router confirms ACTIVE. Re-read the snapshot only during this handoff window
  // to open the customer panel once the owner confirms the same work
  useEffect(() => {
    if (
      !api ||
      !sessionReady ||
      (!extensionControl && (!api.customer || snapshot?.capabilities?.workCustomerV1 !== 1)) ||
      dphoneState.phase !== 'ACTIVE' ||
      snapshot?.interaction?.state !== 'ASSIGNED' ||
      snapshot.interaction.id !== dphoneState.interactionId
    )
      return;
    const interactionId = dphoneState.interactionId;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh(attempt: number) {
      try {
        const current = await api!.snapshot();
        if (cancelled) return;
        if (current.interaction?.id === interactionId && current.interaction.state !== 'ASSIGNED') {
          setSnapshot(current);
          return;
        }
      } catch {
        // reading Cus360 does not affect Voice and can be retried during this handoff window
      }
      if (!cancelled && attempt < 11) timer = setTimeout(() => void refresh(attempt + 1), 500);
    }
    void refresh(0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, sessionReady, snapshot, dphoneState, extensionControl]);

  // routing WS: with the flag on, connect only after getting the lease (with leaseId) and heartbeat over this socket
  const liveKey = enforced ? socketLeaseId : workingTab ? 'working-tab' : undefined;
  useEffect(() => {
    if (!api?.subscribeLive || !liveKey) return;
    let disposed = false;
    const connection = api.subscribeLive(
      {
        onEvent: (event) => {
          if (
            event &&
            typeof event === 'object' &&
            'type' in event &&
            event.type === 'customer.auth'
          ) {
            setCustomerInvalidation((value) => value + 1);
            return;
          }
          if (
            event &&
            typeof event === 'object' &&
            'type' in event &&
            event.type === 'webchat.changed'
          ) {
            // #1044 the event carries no chat data: read the chats again
            void webchatRef.current?.store.refresh();
            return;
          }
          if (leaseClient.current?.handleSocketEvent(event)) return;
          const alert = governanceGate.apply(event);
          if (alert) setGovernanceAlert(alert);
        },
        onDisconnect: (code) => {
          if (disposed) return;
          setCustomerInvalidation((value) => value + 1);
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
    if (externalControl || !api || !createDphone || !remoteAudio.current) return;
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
    let invitationGeneration = 0;
    const phone = createDphone(remoteAudio.current, {
      onInvitation: () => {
        if (disposed) return;
        reconciler.cancel();
        const invitation = ++invitationGeneration;
        const invitationIsCurrent = () =>
          !disposed && (!extensionControl || invitation === invitationGeneration);
        void api
          ?.snapshot()
          .then(async (nextSnapshot) => {
            if (!invitationIsCurrent()) return;
            setSnapshot(nextSnapshot);
            const interaction = nextSnapshot.interaction;
            if (interaction?.state !== 'ASSIGNED' || (extensionControl && !ownsWorkRef.current)) {
              if (extensionControl) await phone.rejectInvitation();
              return;
            }
            setDphoneState(await phone.receiveInvitation(interaction.id));
          })
          .catch(() => {
            if (!invitationIsCurrent()) return;
            if (extensionControl) void phone.rejectInvitation().catch(() => undefined);
            setSnapshotError('offerConfirmFailed');
          });
      },
      onSessionEstablished: () => {
        if (!disposed) setDphoneState(phone.connected());
      },
      onSessionTerminated: () => {
        if (disposed) return;
        invitationGeneration += 1;
        const current = phone.current();
        const interactionId = 'interactionId' in current ? current.interactionId : undefined;
        setDphoneState(phone.terminated());
        setMuted(false);
        if (interactionId) void reconciler.start(interactionId);
      },
      onControlDisconnected: () => {
        if (disposed) return;
        invitationGeneration += 1;
        const current = phone.current();
        const interactionId = 'interactionId' in current ? current.interactionId : undefined;
        if (current.phase !== 'OFFLINE' && current.phase !== 'REGISTERING') {
          setDisconnectedPhoneLease(leaseClient.current?.leaseId());
        }
        availabilityGeneration.current += 1;
        mediaReadinessRef.current = 'BLOCKED';
        setMediaReadiness('BLOCKED');
        setAvailability('OFFLINE');
        void phone.stop().then((state) => {
          if (!disposed) setDphoneState(state);
        });
        if (interactionId) void reconciler.start(interactionId);
      },
      onRegistrationLost: () => {
        if (disposed) return;
        availabilityGeneration.current += 1;
        void phone.registrationLost().then(setDphoneState);
      },
      onAutoplayBlocked: () =>
        setDphoneError(extensionControl ? 'extensionAudioBlocked' : 'autoplayBlocked'),
    });
    dphone.current = phone;
    return () => {
      disposed = true;
      reconciler.cancel();
      endedCallSnapshot.current = undefined;
      dphone.current = undefined;
      void phone.stop();
    };
  }, [api, createDphone, externalControl, extensionControl]);

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

  // create the lease client per effect (StrictMode mounts twice and gets a new client, with no pending answers from the old one)
  // order: after leader election has started — the origin's leader requests the lease automatically (only reduces load)
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
    // real page close (not entering bfcache) → release the lease so somewhere else can take over immediately
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

  // got the lease = this is the work point: announce leader in the origin so other tabs do not request a duplicate lease
  const heldLeaseId = lease.phase === 'held' ? lease.lease.leaseId : undefined;
  useEffect(() => {
    if (!disconnectedPhoneLease || workInHand) return;
    if (heldLeaseId !== disconnectedPhoneLease) {
      setDisconnectedPhoneLease(undefined);
      return;
    }
    void leaseClient.current?.releaseIdle().then((released) => {
      if (released)
        setDisconnectedPhoneLease((current) =>
          current === disconnectedPhoneLease ? undefined : current,
        );
    });
  }, [disconnectedPhoneLease, heldLeaseId, workInHand]);
  if (heldLeaseId) customerLease.current = heldLeaseId;
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
    // lost the lease: stop taking new work immediately; the old WS stays until the work in hand ends (the server no longer sends offers)
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

  /** return the result to the prepare-to-take-calls step of the status picker (#938) so it knows whether the mic or the phone failed */
  async function checkMediaReadiness(): Promise<'ok' | 'mic' | 'phone' | 'skipped'> {
    if (
      externalControl ||
      !ownsWork ||
      (extensionControl &&
        (signOutLosesWork ||
          disconnectedPhoneLease ||
          mediaReadinessRef.current === 'CHECKING' ||
          dphone.current?.current().phase !== 'OFFLINE'))
    )
      return 'skipped';
    if (extensionControl) mediaReadinessRef.current = 'CHECKING';
    availabilityGeneration.current += 1;
    setMediaReadiness('CHECKING');
    setMediaError(undefined);
    try {
      if (!extensionControl) {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: micConstraint(devicePreferences.devices()),
        });
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
      }
      if (!extensionControl) setMediaReadiness('READY');
    } catch {
      setAvailability('OFFLINE');
      setMediaReadiness('BLOCKED');
      setMediaError('micBlocked');
      setDphoneState({ phase: 'OFFLINE' });
      return 'mic';
    }

    if (api && dphone.current) {
      setDphoneError(undefined);
      try {
        const workSessionLeaseId = leaseClient.current?.leaseId();
        if (!workSessionLeaseId) throw new Error('work-session lease is required for SIP');
        const sipLease = await api.sipCredentials(workSessionLeaseId);
        // register SIP only if this is still the work point (flag on = still holds the work-session lease) right now
        if (!ownsWorkRef.current || leaseClient.current?.leaseId() !== workSessionLeaseId) {
          if (extensionControl) setMediaReadiness('UNCHECKED');
          setDphoneState({ phase: 'OFFLINE' });
          return 'phone';
        }
        setDphoneState({ phase: 'REGISTERING', telephonyNodeId: sipLease.telephonyNodeId });
        const phone = dphone.current;
        const state = await phone.start(sipLease, { ownsWorkingTab: true, mediaReady: true });
        if (
          extensionControl &&
          (dphone.current !== phone ||
            !ownsWorkRef.current ||
            leaseClient.current?.leaseId() !== workSessionLeaseId)
        ) {
          await phone.stop();
          if (dphone.current === phone) setMediaReadiness('UNCHECKED');
          return 'phone';
        }
        setDphoneState(state);
        if (extensionControl) setMediaReadiness('READY');
        return state.phase === 'READY' ? 'ok' : 'phone';
      } catch {
        setAvailability('OFFLINE');
        setDphoneState({ phase: 'OFFLINE' });
        if (extensionControl) {
          setMediaReadiness('BLOCKED');
          await dphone.current?.stop();
        }
        setDphoneError('registerFailed');
        return 'phone';
      }
    }
    return 'ok';
  }

  async function becomeAvailable() {
    if (
      externalControl ||
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

  async function refreshSnapshot() {
    if (!api) return;
    try {
      setSnapshot(await api.snapshot());
    } catch {
      // the regular snapshot round will retry by itself
    }
  }

  /**
   * #938 minimal prepare-to-take-calls steps: work point → mic → phone → open for calls
   * used both when choosing Ready on the status picker page and when changing to Ready in the status selector
   */
  async function goReady(
    mark: (step: PrepStep, status: PrepStatus) => void,
  ): Promise<PrepFailure | undefined> {
    mark('lease', 'run');
    const leaseId = leaseClient.current?.leaseId();
    if (!api || !leaseId || !ownsWorkRef.current) {
      mark('lease', 'fail');
      return 'lease';
    }
    mark('lease', 'done');
    if (mediaReadinessRef.current !== 'READY' || dphone.current?.current().phase !== 'READY') {
      mark('mic', 'run');
      const outcome = await checkMediaReadiness();
      if (outcome === 'mic') {
        mark('mic', 'fail');
        return 'mic';
      }
      mark('mic', 'done');
      mark('phone', 'run');
      if (outcome !== 'ok' || dphone.current?.current().phase !== 'READY') {
        mark('phone', 'fail');
        return 'phone';
      }
    } else mark('mic', 'done');
    mark('phone', 'done');
    mark('ready', 'run');
    try {
      await api.becomeAvailable(leaseId);
      setAvailability('AVAILABLE');
    } catch {
      mark('ready', 'fail');
      return 'ready';
    }
    mark('ready', 'done');
    return undefined;
  }

  /** Not Ready keeps the phone, Offline releases the phone and mic (owner decision item 5) */
  async function applyStatus(
    choice: StatusChoice,
    mark: (step: PrepStep, status: PrepStatus) => void = () => undefined,
  ): Promise<PrepFailure | 'change' | undefined> {
    if (!api?.setAgentState) return 'change';
    if (choice.state === 'AVAILABLE') {
      const failure = await goReady(mark);
      if (!failure) rememberStatusChoice(choice);
      void refreshSnapshot();
      return failure;
    }
    const leaseId = leaseClient.current?.leaseId();
    if (!leaseId) return 'lease';
    try {
      await api.setAgentState(leaseId, choice);
    } catch {
      return 'change';
    }
    availabilityGeneration.current += 1;
    setAvailability('OFFLINE');
    if (choice.state === 'OFFLINE') {
      if (dphone.current) setDphoneState(await dphone.current.stop());
      for (const track of mediaStream.current?.getTracks() ?? []) track.stop();
      mediaStream.current = undefined;
      setMediaReadiness('UNCHECKED');
    }
    rememberStatusChoice(choice);
    void refreshSnapshot();
    return undefined;
  }

  async function enterFromGate(choice: StatusChoice) {
    setPrep({ preparing: true, steps: {} });
    const failure = await applyStatus(choice, (step, status) =>
      setPrep((current) => ({ ...current, steps: { ...current.steps, [step]: status } })),
    );
    if (failure) {
      setPrep((current) => ({
        ...current,
        preparing: false,
        failure: failure === 'change' ? 'ready' : failure,
      }));
      return;
    }
    setPrep({ preparing: false, steps: {} });
    setGate('done');
  }

  async function changeStatus(choice: StatusChoice) {
    // #1044 chats in hand are finished first; the after-work status stops new ones meanwhile
    if (choice.state !== 'AVAILABLE' && (webchatRef.current?.state.rooms.length ?? 0) > 0) {
      setStatusError('chatBusy');
      return;
    }
    setStatusPending(true);
    setStatusError(undefined);
    const failure = await applyStatus(choice);
    setStatusPending(false);
    if (failure) setStatusError(failure);
  }

  async function changeAfterWork(afterWork: AfterWork) {
    if (!api?.setAfterWork) return;
    setStatusPending(true);
    setStatusError(undefined);
    try {
      await api.setAfterWork(afterWork);
      await refreshSnapshot();
    } catch {
      setStatusError('change');
    } finally {
      setStatusPending(false);
    }
  }

  async function acceptCall() {
    if (
      !acceptingSession ||
      wrapupPending ||
      wrapupUnknown ||
      (extensionControl && (!ownsWorkRef.current || !leaseClient.current?.leaseId())) ||
      !dphone.current ||
      dphone.current.current().phase !== 'RINGING'
    )
      return;
    try {
      setDphoneError(undefined);
      setDphoneState(await dphone.current.accept());
    } catch {
      setDphoneError(extensionControl ? 'extensionCallFailed' : 'offerConfirmFailed');
    }
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
    let nextState: DphoneState;
    try {
      setDphoneError(undefined);
      nextState = await phone.hangup();
    } catch {
      setDphoneError(extensionControl ? 'extensionCallFailed' : 'offerConfirmFailed');
      return;
    }
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

  // ── dphone: commands from the widget or the detached window enter the same way ──────────────────────────────
  const commandRef = useRef<(command: DphoneCommand) => void>(() => undefined);
  commandRef.current = (command) => {
    if (command.type === 'accept') void acceptCall();
    else if (command.type === 'hangup') void hangup();
    else if (extensionControl) return;
    else if (command.type === 'toggleMute') toggleMute();
    else if (command.type === 'toggleHold') void toggleHold();
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

  // host of the detached window — only the work point in shell mode (flag off = old working tab; on = holder of the lease
  // or still has a call in hand); losing the work point while idle → close the bridge and the detached window
  const host = useRef<ReturnType<typeof createDphoneHost>>(undefined);
  useEffect(() => {
    if (externalControl || extensionControl || !inShell || !mediaOwner) return;
    const bridge = createDphoneHost({
      onCommand: (command) => commandRef.current(command),
      // bye does not clear the id: a detached window that reloads sends hello with the same id and reconnects
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
  }, [inShell, mediaOwner, externalControl, extensionControl]);

  const viewKey = JSON.stringify(view);
  useEffect(() => {
    host.current?.publish(JSON.parse(viewKey) as DphoneView);
  }, [viewKey, detached]);

  // the detached window was closed without sending bye (e.g. the browser closed immediately) — the widget returns to the page itself
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
    // popup blocked: keep the widget in the current page, nothing changes
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
      // see loadSize
    }
  }

  const readinessLabel = externalControl ? td('external.badge') : t(`readiness.${mediaReadiness}`);

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
      {statusV1 ? null : (
        <span
          className={
            'aw-chip ' + (availability === 'AVAILABLE' ? 'aw-chip-success' : 'aw-chip-neutral')
          }
        >
          {availability === 'AVAILABLE' ? t('status.available') : t('status.offline')}
        </span>
      )}
      {!externalControl ? (
        <span
          className={
            'aw-chip ' + (dphoneState.phase === 'READY' ? 'aw-chip-success' : 'aw-chip-neutral')
          }
          role="status"
          aria-label={t('status.dphone')}
        >
          {td(`phase.${dphoneState.phase}`)}
        </span>
      ) : null}
      {/* #588: in the new shell, sign-out is only in the user menu on the top bar */}
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
    !externalControl &&
    !extensionControl &&
    !inShell &&
    snapshot?.interaction?.state === 'ASSIGNED' ? (
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
    !externalControl &&
    !extensionControl &&
    !inShell &&
    (dphoneState.phase === 'ACTIVE' || dphoneState.phase === 'HELD') ? (
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
  const historyHref = (() => {
    if (!savedWrapup) return;
    const base =
      (import.meta.env.VITE_CONSOLE_URL as string | undefined) ??
      (import.meta.env.DEV ? 'http://localhost:5174' : undefined);
    if (!base) return;
    try {
      const url = new URL('/', base);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
      url.searchParams.set('view', 'agent-history');
      url.searchParams.set('interaction', savedWrapup.interactionId);
      url.searchParams.set(
        'tenant',
        new URL(window.location.href).searchParams.get('tenant') ?? tenantLabel,
      );
      return url.href;
    } catch {
      return;
    }
  })();
  const savedPanel = savedWrapup ? (
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
      {historyHref ? (
        <a href={historyHref} target="_blank" rel="noopener noreferrer">
          {t('wrapup.history')}
        </a>
      ) : null}
    </article>
  ) : null;
  const wrapupForm =
    wrapupTarget?.state === 'WRAPUP' && savedWrapup?.interactionId !== wrapupTarget.id ? (
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
        {wrapupDisposition === 'FOLLOW_UP_REQUIRED' &&
        api?.openCase &&
        caseDrafts.get(wrapupTarget.id).phase !== 'created' ? (
          <div className="aw-case-banner" data-tone="brand" role="status">
            <p>{t('case.wrapupHint')}</p>
            <Button size="sm" variant="secondary" onPress={openCaseTab}>
              {t('case.goToCase')}
            </Button>
          </div>
        ) : null}
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
    ) : null;
  const wrapupPanel = (
    <>
      {savedPanel}
      {wrapupForm}
    </>
  );

  const externalPhonePanel = (
    <ExternalPhoneControlPanel enabled={Boolean(sessionReady && ownsWork && !signOutLosesWork)} />
  );

  const mediaPanel = (
    <article className="aw-panel">
      <div className="aw-panel-heading">
        <div>
          <p className="aw-step">{t('media.step')}</p>
          <h2>{extensionControl ? td('chrome.title') : t('media.title')}</h2>
        </div>
        <span
          className={'aw-readiness aw-readiness-' + mediaReadiness.toLowerCase()}
          role="status"
          aria-label={t('media.indicator')}
        >
          {readinessLabel}
        </span>
      </div>
      <p className="aw-copy">{extensionControl ? td('chrome.description') : t('media.copy')}</p>
      {!extensionControl ? (
        <div className="aw-device">
          <div className="aw-device-icon" aria-hidden="true">
            {t('media.device')}
          </div>
          <div>
            <strong>{t('media.mic')}</strong>
            <span>{t('media.micHint')}</span>
          </div>
        </div>
      ) : null}
      {mediaError ? (
        <p className="aw-error" role="alert">
          {t(mediaError)}
        </p>
      ) : null}
      <Button
        isDisabled={
          !ownsWork ||
          mediaReadiness === 'CHECKING' ||
          (extensionControl &&
            (signOutLosesWork ||
              Boolean(disconnectedPhoneLease) ||
              dphoneState.phase !== 'OFFLINE'))
        }
        onPress={() => void checkMediaReadiness()}
      >
        {mediaReadiness === 'CHECKING'
          ? t('media.checking')
          : extensionControl
            ? td('chrome.connect')
            : t('media.check')}
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
            : extensionControl
              ? td('chrome.availabilityHint')
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

  const alerts = (
    <>
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
            <p>{t(`governance.alerts.${governanceAlert.messageKey}`)}</p>
          </div>
          {governanceAlert.state !== 'READY' ? (
            <Button onPress={() => setLiveRetry((value) => value + 1)}>
              {t('governance.retry')}
            </Button>
          ) : null}
        </section>
      ) : null}
    </>
  );

  const recoveryPanel =
    sessionReady && recoveryRevision !== undefined && !acceptingSession ? (
      <article className="aw-panel" role="status">
        <p>{t('wrapup.reconciling')}</p>
        <Button onPress={() => setNetworkRevision((revision) => revision + 1)}>
          {t('recovery.retry')}
        </Button>
      </article>
    ) : null;

  const snapshotWarning = snapshotError ? (
    <p className="aw-warning" role="status">
      {t(snapshotError)}
    </p>
  ) : null;

  const dphoneWarning = dphoneError ? (
    <p className="aw-warning" role="alert">
      {t(dphoneError)}
    </p>
  ) : null;

  const authorityPanel = (
    <article className="aw-panel">
      <p className="aw-step">{t('authority.step')}</p>
      <h2>{t('authority.title')}</h2>
      <dl className="aw-facts">
        <div>
          <dt>{t('authority.interaction')}</dt>
          <dd>
            {snapshot?.interaction?.state
              ? t(`layout.state.${snapshot.interaction.state}`)
              : t('authority.noWork')}
          </dd>
        </div>
        <div>
          <dt>
            {externalControl || extensionControl ? td('external.mediaLabel') : t('authority.media')}
          </dt>
          <dd>{readinessLabel}</dd>
        </div>
        <div>
          <dt>{t('authority.presence')}</dt>
          <dd>{t(`agentState.${snapshot?.agent.state ?? availability}`)}</dd>
        </div>
      </dl>
      <p className="aw-note">{t('authority.note')}</p>
    </article>
  );

  // old chrome when the flag is off — exactly the old page structure
  const content = (
    <>
      <div className="aw-page-heading">
        <div>
          <p className="aw-eyebrow">{t('heading.eyebrow')}</p>
          <h1>{t('heading.title')}</h1>
          <p>
            {externalControl
              ? td('external.description')
              : extensionControl
                ? td('chrome.description')
                : t('heading.lede')}
          </p>
        </div>
        <span className="aw-phase-badge">{t('heading.phase')}</span>
      </div>

      {alerts}

      <section className="aw-grid" aria-label={t('grid')}>
        {recoveryPanel}
        {offerPanel}
        {controlsPanel}

        {wrapupPanel}

        {snapshotWarning}

        {dphoneWarning}

        {externalControl ? externalPhonePanel : mediaPanel}

        {!externalControl ? availabilityPanel : null}

        {authorityPanel}
      </section>
    </>
  );

  // V3: Agent Workspace layout per mockups/d-contact-agent-workspace-v3.html with real data only
  // work list · current work (call bar + Customer 360/Voice) · summary/details/events/readiness panel · right tool bar
  // the call control buttons stay on the floating dphone as before (owner choice 20 Nov 2026) and parts without a backend
  // (AI assistant, Apps, multi-Channel, Transfer) get no placeholder (E1 item E)
  const current = snapshot?.interaction ?? undefined;
  const callSeconds =
    current?.answeredAt !== null && current?.answeredAt !== undefined
      ? Math.max(
          0,
          Math.floor(
            ((current.endedAt ? Date.parse(current.endedAt) : now) -
              Date.parse(current.answeredAt)) /
              1_000,
          ),
        )
      : undefined;
  const callDuration = callSeconds === undefined ? undefined : formatDuration(callSeconds);
  const clock = (iso: string) =>
    new Date(iso).toLocaleTimeString(locale, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  const timeline = current
    ? [
        current.state === 'ASSIGNED' && current.offerExpiresAt
          ? {
              key: 'offered',
              at: current.offerExpiresAt,
              text: t('layout.event.offered', { time: clock(current.offerExpiresAt) }),
            }
          : undefined,
        current.answeredAt
          ? { key: 'answered', at: current.answeredAt, text: t('layout.event.answered') }
          : undefined,
        current.endedAt
          ? { key: 'ended', at: current.endedAt, text: t('layout.event.ended') }
          : undefined,
      ].filter((event) => event !== undefined)
    : [];
  const caller = current ? (current.caller ?? t('offer.noNumber')) : undefined;
  const queueName = current?.queue?.name ?? t('offer.unknownQueue');
  const customerAvailable = Boolean(api?.customer && snapshot?.capabilities?.workCustomerV1 === 1);
  const activeMainTab: MainTab = customerAvailable ? mainTab : 'voice';
  const viewingRecent = selection === 'recent' && Boolean(savedWrapup);
  const dispositionLabel = (disposition: string) =>
    disposition === 'CUSTOMER_ASSISTED' ? t('wrapup.assisted') : t('wrapup.followUp');
  const showInspector = (tab: InspectorTab) => {
    setInspectorTab(tab);
    setInspectorOpen(true);
  };
  const controlHint = externalControl ? td('external.serverWork') : t('layout.inDphone');

  const workList = (
    <section
      className="aw-v3-list"
      aria-labelledby="aw-work-title"
      style={{ '--aw-pane-width': `${listWidth.value}px` } as CSSProperties}
    >
      <h2 id="aw-work-title" className="aw-v3-pane-title">
        {t('layout.work')}
      </h2>
      <Tabs
        className="aw-v3-tabs aw-v3-list-tabs"
        selectedKey={listTab}
        onSelectionChange={(key) => setListTab(key as ListTab)}
      >
        <TabList aria-label={t('layout.list.label')}>
          <Tab id="open">{t('layout.list.open', { count: (current ? 1 : 0) + chatRooms })}</Tab>
          <Tab id="closed">
            {t('layout.list.closed', {
              count: (savedWrapup ? 1 : 0) + (chatState?.closed.length ?? 0),
            })}
          </Tab>
        </TabList>
        <TabPanel id="open" className="aw-v3-list-panel">
          {webchat && chatState ? (
            <WebchatOffers
              store={webchat.store}
              state={chatState}
              now={now}
              onAccepted={() => {
                setChatTab('conversation');
                setChatFocus((value) => value + 1);
              }}
            />
          ) : null}
          {chatState && chatRooms >= chatState.maxChats ? (
            <p className="aw-copy aw-chat-full">
              {t('chat.offer.full', { max: chatState.maxChats })}
            </p>
          ) : null}
          {chatState && chatRooms > 0 ? (
            <ul className="aw-v3-items" aria-label={t('chat.rooms')}>
              <WebchatRows
                state={chatState}
                now={now}
                selectedId={chatInView ? chatState.selectedId : null}
                onSelect={(interactionId) => {
                  webchat?.store.select(interactionId);
                  setChatFocus((value) => value + 1);
                }}
              />
            </ul>
          ) : null}
          {current ? (
            <ul className="aw-v3-items">
              <li className="aw-v3-item">
                <button
                  type="button"
                  aria-current={!viewingRecent && !chatInView ? 'true' : undefined}
                  onClick={() => {
                    setSelection('current');
                    webchat?.store.select(null);
                  }}
                >
                  <span className="aw-v3-item-icon">
                    <PaneIcon name="phone" />
                  </span>
                  <span className="aw-v3-item-copy">
                    <span className="aw-work-row">
                      <strong>{caller}</strong>
                      {callDuration ? <span className="aw-work-time">{callDuration}</span> : null}
                    </span>
                    <span className="aw-work-meta">
                      {t(`layout.state.${current.state}`)} · {queueName}
                    </span>
                    <span className="aw-channel">{t('layout.channelVoice')}</span>
                  </span>
                </button>
              </li>
            </ul>
          ) : chatRooms + chatOffers > 0 ? null : (
            <div className="aw-empty">
              <strong>{t('layout.workEmpty')}</strong>
              <span>{externalControl ? td('external.workHint') : t('layout.workEmptyHint')}</span>
            </div>
          )}
        </TabPanel>
        <TabPanel id="closed" className="aw-v3-list-panel">
          {chatState?.closed.length ? (
            <ul className="aw-v3-items">
              <WebchatClosedRows
                state={chatState}
                selectedId={chatClosed ? chatState.selectedId : null}
                onSelect={(interactionId) => {
                  webchat?.store.select(interactionId);
                  showInspector('wrapup');
                }}
              />
            </ul>
          ) : null}
          {savedWrapup ? (
            <ul className="aw-v3-items">
              <li className="aw-v3-item">
                <button
                  type="button"
                  aria-current={viewingRecent && !chatInView ? 'true' : undefined}
                  onClick={() => {
                    setSelection('recent');
                    webchat?.store.select(null);
                    showInspector('wrapup');
                  }}
                >
                  <span className="aw-v3-item-icon">
                    <PaneIcon name="phone" />
                  </span>
                  <span className="aw-v3-item-copy">
                    <strong>{dispositionLabel(savedWrapup.disposition)}</strong>
                    <span className="aw-work-meta">
                      {t('layout.list.closedMeta', {
                        time: new Date(savedWrapup.recordedAt).toLocaleTimeString(locale, {
                          hour: '2-digit',
                          minute: '2-digit',
                        }),
                      })}
                    </span>
                    <span className="aw-channel">{t('layout.channelVoice')}</span>
                  </span>
                </button>
              </li>
            </ul>
          ) : chatState?.closed.length ? null : (
            <p className="aw-copy">{t('layout.list.closedEmpty')}</p>
          )}
        </TabPanel>
      </Tabs>
    </section>
  );

  const callFacts = current ? (
    <section className="aw-v3-section" aria-labelledby="aw-call-facts">
      <h3 id="aw-call-facts" className="aw-detail-title">
        {t('layout.main.callFacts')}
      </h3>
      <dl className="aw-v3-facts">
        <div>
          <dt>{t('layout.main.direction')}</dt>
          <dd>{t(`layout.direction.${current.direction}`)}</dd>
        </div>
        <div>
          <dt>{t('layout.main.queue')}</dt>
          <dd>{queueName}</dd>
        </div>
        <div>
          <dt>{t('layout.main.state')}</dt>
          <dd>{t(`layout.state.${current.state}`)}</dd>
        </div>
        <div>
          <dt>{t('layout.main.channel')}</dt>
          <dd>{t('layout.channelVoice')}</dd>
        </div>
        <div className="aw-v3-facts-wide">
          <dt>{t('layout.main.interaction')}</dt>
          <dd className="aw-v3-mono">{current.id}</dd>
        </div>
      </dl>
      {!externalControl ? <p className="aw-copy">{t('layout.main.controlsHint')}</p> : null}
    </section>
  ) : null;

  // #956 a case can be opened only during the call or wrap-up, and when the API supports it
  // if the open-case command has an unknown result and the work outcome was saved, keep the tab so the same command can be resent
  // (the server returns the original result from the receipt if it was committed, or WORK_NOT_ACTIVE if it never was)
  const unresolvedCaseWork =
    savedWrapup && caseDrafts.get(savedWrapup.interactionId).phase === 'unknown'
      ? { id: savedWrapup.interactionId }
      : undefined;
  const activeCaseWork: { id: string } | undefined = chatRoom
    ? // #1044 a chat is passed on by opening a case; there is no transfer in round one
      { id: chatRoom.chat.interactionId }
    : chatInView
      ? undefined
      : current && ['ACTIVE', 'WRAPUP'].includes(current.state)
        ? current
        : undefined;
  const caseWork: { id: string } | undefined = api?.openCase
    ? (activeCaseWork ?? unresolvedCaseWork)
    : undefined;
  function openCaseTab() {
    setInspectorOpen(true);
    setInspectorTab('case');
    setCaseFocus((value) => value + 1);
  }
  function pickCustomerForCase() {
    setMainTab('customer');
    setChatTab('customer');
    requestAnimationFrame(() => document.getElementById(WORK_CUSTOMER_QUERY_ID)?.focus());
  }
  function caseConsoleHref(caseId: string) {
    const base =
      (import.meta.env.VITE_CONSOLE_URL as string | undefined) ??
      (import.meta.env.DEV ? 'http://localhost:5174' : undefined);
    if (!base) return;
    try {
      const url = new URL('/', base);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
      url.searchParams.set('view', 'team-cases');
      url.searchParams.set('case', caseId);
      url.searchParams.set(
        'tenant',
        new URL(window.location.href).searchParams.get('tenant') ?? tenantLabel,
      );
      return url.href;
    } catch {
      return;
    }
  }

  const chatCustomerLinked =
    Boolean(chatRoom) &&
    workCustomer?.workId === chatRoom?.chat.interactionId &&
    Boolean(workCustomer?.customer);
  const chatView =
    webchat && chatState && chatRoom ? (
      <WebchatRoomView
        store={webchat.store}
        room={chatRoom}
        now={now}
        online={chatState.online && sessionReady}
        agentName={snapshot?.agent.displayName ?? ''}
        tab={chatTab}
        onTabChange={setChatTab}
        customerLinked={chatCustomerLinked}
        focusToken={chatFocus}
        onGoWrapup={() => {
          showInspector('wrapup');
          setChatWrapupFocus((value) => value + 1);
        }}
        actions={
          caseWork ? (
            <Button size="sm" variant="secondary" onPress={openCaseTab}>
              {t('case.open')}
            </Button>
          ) : undefined
        }
        customerPanel={
          customerAvailable && api?.customer ? (
            customerLease.current ? (
              <WorkCustomerPanel
                key={`${identityKey}:${chatRoom.chat.interactionId}`}
                api={api.customer}
                workId={chatRoom.chat.interactionId}
                leaseId={customerLease.current}
                invalidationRevision={customerInvalidation}
                identityKey={identityKey ?? 'unknown'}
                sessionReady={sessionReady}
                onCustomerChange={(customer) =>
                  setWorkCustomer({ workId: chatRoom.chat.interactionId, customer })
                }
              />
            ) : (
              <p className="aw-copy">{t('chat.customerPending')}</p>
            )
          ) : undefined
        }
      />
    ) : chatClosed ? (
      <div className="aw-v3-view">
        <div className="aw-v3-context">
          <strong className="aw-call-caller">
            {t('chat.savedView.title', {
              visitor: t('chat.visitor', { code: chatClosed.visitorLabel }),
            })}
          </strong>
          <span className="aw-v3-context-meta">{chatClosed.interactionId}</span>
        </div>
        <div className="aw-v3-body">
          <p className="aw-copy">{t('chat.savedView.hint')}</p>
        </div>
      </div>
    ) : null;

  const currentView = (
    <div className="aw-v3-view" hidden={viewingRecent || chatInView}>
      <div className="aw-v3-context">
        <strong className="aw-call-caller">{caller ?? t('layout.noCurrent')}</strong>
        {current ? <span className="aw-v3-context-meta">{current.id}</span> : null}
        {caseWork && activeCaseWork ? (
          <Button size="sm" variant="secondary" onPress={openCaseTab}>
            {t('case.open')}
          </Button>
        ) : null}
      </div>
      {current ? (
        <div className="aw-v3-phonebar" data-state={current.state.toLowerCase()}>
          <span className="aw-v3-phonebar-icon">
            <PaneIcon name="phone" size={20} />
          </span>
          <span className="aw-call-row">
            <strong>{t(`layout.state.${current.state}`)}</strong>
            <span className="aw-channel">{t('layout.channelVoice')}</span>
          </span>
          <span className="aw-call-meta">
            {t(`layout.direction.${current.direction}`)} · {queueName} · {controlHint}
          </span>
          {callDuration ? (
            <span className="aw-call-duration" role="timer">
              {t('layout.duration', { duration: callDuration })}
            </span>
          ) : null}
        </div>
      ) : null}
      {current ? (
        <Tabs
          className="aw-v3-tabs aw-v3-main-tabs"
          selectedKey={activeMainTab}
          onSelectionChange={(key) => setMainTab(key as MainTab)}
        >
          <TabList aria-label={t('layout.main.label')}>
            {customerAvailable ? <Tab id="customer">{t('layout.main.customer')}</Tab> : null}
            <Tab id="voice">{t('layout.main.voice')}</Tab>
          </TabList>
          {customerAvailable ? (
            <TabPanel id="customer" className="aw-v3-body" shouldForceMount>
              {api?.customer &&
              ['ACTIVE', 'WRAPUP'].includes(current.state) &&
              customerLease.current ? (
                <WorkCustomerPanel
                  key={`${identityKey}:${current.id}`}
                  api={api.customer}
                  workId={current.id}
                  leaseId={customerLease.current!}
                  invalidationRevision={customerInvalidation}
                  identityKey={identityKey ?? 'unknown'}
                  sessionReady={sessionReady}
                  onCustomerChange={(customer) => setWorkCustomer({ workId: current.id, customer })}
                />
              ) : (
                <p className="aw-copy">{t('layout.main.customerPending')}</p>
              )}
            </TabPanel>
          ) : null}
          <TabPanel id="voice" className="aw-v3-body">
            {callFacts}
          </TabPanel>
        </Tabs>
      ) : (
        <div className="aw-v3-idle">
          <span className="aw-v3-idle-icon">
            <PaneIcon name="readiness" size={28} />
          </span>
          <strong>{t('layout.noCurrent')}</strong>
          <span>
            {externalControl
              ? td('external.emptyHint')
              : extensionControl
                ? td('chrome.description')
                : statusV1
                  ? t(
                      snapshot?.agent.state === 'AVAILABLE'
                        ? webchatEnabled
                          ? 'chat.idle.hint'
                          : 'agentStatus.idleReadyHint'
                        : 'agentStatus.idleHint',
                    )
                  : t('layout.noCurrentHint')}
          </span>
          {!statusV1 && (!inspectorOpen || inspectorTab !== 'readiness') ? (
            <Button onPress={() => showInspector('readiness')}>
              {t('layout.inspector.openReadiness')}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );

  const recentView = savedWrapup ? (
    <div className="aw-v3-view" hidden={!viewingRecent || chatInView}>
      <div className="aw-v3-context">
        <strong className="aw-call-caller">{t('layout.recent.title')}</strong>
        <span className="aw-v3-context-meta">{savedWrapup.interactionId}</span>
        <Button size="sm" variant="ghost" onPress={() => setSelection('current')}>
          {t('layout.recent.back')}
        </Button>
      </div>
      <div className="aw-v3-body">
        <p className="aw-copy">{t('layout.recent.hint')}</p>
        {viewingRecent && customerAvailable && api?.customer ? (
          <WorkCustomerPanel
            key={`${identityKey}:completed:${savedWrapup.interactionId}`}
            api={api.customer}
            workId={savedWrapup.interactionId}
            leaseId=""
            identityKey={identityKey ?? 'unknown'}
            sessionReady={sessionReady}
            readOnly
          />
        ) : null}
      </div>
    </div>
  ) : null;

  const mainColumn = (
    <section className="aw-v3-main" aria-labelledby="aw-current-title">
      <h2 id="aw-current-title" className="aw-visually-hidden">
        {t('layout.current')}
      </h2>
      {chatView}
      {currentView}
      {recentView}
    </section>
  );

  const wrapupContent =
    webchat && chatRoom ? (
      <WebchatWrapupPanel
        store={webchat.store}
        room={chatRoom}
        sessionReady={sessionReady}
        customerLinked={chatCustomerLinked}
        focusToken={chatWrapupFocus}
      />
    ) : chatClosed ? (
      <WebchatClosedPanel closed={chatClosed} />
    ) : viewingRecent ? (
      savedPanel
    ) : (
      (wrapupForm ??
      (savedWrapup && (!current || savedWrapup.interactionId === current.id)
        ? savedPanel
        : null) ?? (
        <p className="aw-copy">{current ? t('layout.wrapupEmpty') : t('layout.wrapupNone')}</p>
      ))
    );

  const inspectorTabs: Array<{ id: InspectorTab; icon: PaneIconName }> = [
    { id: 'wrapup', icon: 'notes' },
    ...(caseWork ? [{ id: 'case' as const, icon: 'notes' as const }] : []),
    { id: 'details', icon: 'details' },
    { id: 'events', icon: 'events' },
    { id: 'readiness', icon: 'readiness' },
  ];

  const inspector = inspectorOpen ? (
    <aside
      ref={inspectorRef}
      className="aw-v3-inspector"
      aria-label={t('layout.inspector.label')}
      style={{ '--aw-pane-width': `${inspectorWidth.value}px` } as CSSProperties}
    >
      <div className="aw-v3-inspector-head">
        <h2 className="aw-v3-pane-title">{t('layout.inspector.title')}</h2>
        <Button
          size="sm"
          variant="ghost"
          aria-label={t('layout.inspector.close')}
          onPress={() => setInspectorOpen(false)}
        >
          <PaneIcon name="panel" />
        </Button>
      </div>
      <Tabs
        className="aw-v3-tabs aw-v3-inspector-tabs"
        selectedKey={inspectorTab === 'case' && !caseWork ? 'wrapup' : inspectorTab}
        onSelectionChange={(key) => setInspectorTab(key as InspectorTab)}
      >
        <TabList aria-label={t('layout.inspector.label')}>
          {inspectorTabs.map((tab) => (
            <Tab key={tab.id} id={tab.id}>
              {t(`layout.inspector.tabs.${tab.id}`)}
            </Tab>
          ))}
        </TabList>
        <TabPanel id="wrapup" className="aw-v3-inspector-body">
          {wrapupContent}
        </TabPanel>
        {caseWork && api ? (
          <TabPanel id="case" className="aw-v3-inspector-body">
            <CasePanel
              api={api}
              workId={caseWork.id}
              customer={workCustomer?.workId === caseWork.id ? workCustomer.customer : undefined}
              workClosed={savedWrapup?.interactionId === caseWork.id}
              self={{
                userId: snapshot?.agent.id ?? '',
                displayName: snapshot?.agent.displayName ?? '',
              }}
              draft={caseDrafts.get(caseWork.id)}
              onDraftChange={(change) => caseDrafts.update(caseWork.id, change)}
              consoleHref={caseConsoleHref}
              onPickCustomer={pickCustomerForCase}
              focusToken={caseFocus}
            />
          </TabPanel>
        ) : null}
        <TabPanel id="details" className="aw-v3-inspector-body">
          {authorityPanel}
        </TabPanel>
        <TabPanel id="events" className="aw-v3-inspector-body">
          <h3 className="aw-detail-title">{t('layout.timeline')}</h3>
          {timeline.length ? (
            <ol className="aw-timeline">
              {timeline.map((event) => (
                <li key={event.key}>
                  <time dateTime={event.at}>{clock(event.at)}</time>
                  <span className={'aw-timeline-dot aw-timeline-' + event.key} aria-hidden="true" />
                  <span>{event.text}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="aw-copy">{t('layout.timelineEmpty')}</p>
          )}
        </TabPanel>
        <TabPanel id="readiness" className="aw-v3-inspector-body">
          <section className="aw-v3-readiness" aria-labelledby="aw-readiness-title">
            <h3 id="aw-readiness-title" className="aw-visually-hidden">
              {t('layout.readiness')}
            </h3>
            {statusV1 ? (
              // #938 change status in the top-right selector, test devices with the bottom-left button — this tab keeps only system status
              <dl className="aw-readiness-summary">
                <div>
                  <dt>{t('status.owner')}</dt>
                  <dd>{ownsWork ? t('lease.chip.held') : t('lease.chip.standby')}</dd>
                </div>
                <div>
                  <dt>{t('agentStatus.summary.mic')}</dt>
                  <dd>{readinessLabel}</dd>
                </div>
                <div>
                  <dt>{t('status.dphone')}</dt>
                  <dd>{td(`phase.${dphoneState.phase}`)}</dd>
                </div>
                <div>
                  <dt>{t('agentStatus.selectorLabel')}</dt>
                  <dd>{agentStateLabel(snapshot?.agent.state ?? 'OFFLINE')}</dd>
                </div>
              </dl>
            ) : (
              <>
                {externalControl ? externalPhonePanel : mediaPanel}
                {!externalControl ? availabilityPanel : null}
              </>
            )}
          </section>
        </TabPanel>
      </Tabs>
    </aside>
  ) : null;

  // the work panel comes before the tool bar in the DOM in left-to-right reading order; the tool bar is a single Tab stop (roving)
  const utilityRail = (
    <UtilityToolbar
      label={t('layout.utility')}
      items={[
        {
          id: 'panel',
          // the label already says the action (open/close) so aria-expanded is not added, to avoid the screen reader reading it twice
          label: inspectorOpen ? t('layout.inspector.close') : t('layout.inspector.open'),
          icon: <PaneIcon name="panel" size={20} />,
          onPress: () => setInspectorOpen((open) => !open),
        },
        ...inspectorTabs.map((tab) => ({
          id: tab.id,
          label: t(`layout.inspector.tabs.${tab.id}`),
          icon: <PaneIcon name={tab.icon} size={20} />,
          pressed: inspectorOpen && inspectorTab === tab.id,
          onPress: () => showInspector(tab.id),
        })),
      ]}
    />
  );

  const shellContent = (
    <>
      <div className="aw-v3-alerts">
        {alerts}
        {recoveryPanel}
        {snapshotWarning}
        {dphoneWarning}
      </div>
      <div className="aw-v3">
        {workList}
        <PaneSplitter
          label={t('layout.resize.list')}
          hint={t('layout.resize.hint')}
          width={listWidth}
        />
        {mainColumn}
        {inspector ? (
          <PaneSplitter
            label={t('layout.resize.inspector')}
            hint={t('layout.resize.hint')}
            width={inspectorWidth}
            edge="end"
          />
        ) : null}
        {inspector}
        {utilityRail}
      </div>
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

  // E1.14: embedded dphone — the same components and call-work logic as Workspace but no shell/detached window
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
    <div className={inShell ? 'aw-root aw-in-shell aw-v3-root' : 'aw-root aw-legacy'}>
      {inShell ? (
        <>
          <header className="aw-content-header">
            <div className="aw-shell-heading">
              <h1>{t('heading.title')}</h1>
              {identity}
            </div>
            <div className="aw-header-status">
              {chatState && gate !== 'open' ? <WebchatCapacity state={chatState} /> : null}
              {statusV1 && gate === 'done' && snapshot ? (
                <StatusSelector
                  state={snapshot.agent.state}
                  systemLabel={
                    snapshot.agent.state === 'RESERVED' ||
                    snapshot.agent.state === 'BUSY' ||
                    snapshot.agent.state === 'ACW'
                      ? agentStateLabel(snapshot.agent.state)
                      : undefined
                  }
                  reasonCode={snapshot.agent.reasonCode}
                  since={snapshot.agent.stateSince}
                  reasons={reasons}
                  afterWork={snapshot.agent.afterWork ?? { state: 'AVAILABLE' }}
                  changedBy={snapshot.agent.changedBy}
                  pending={statusPending}
                  onChange={(choice) => void changeStatus(choice)}
                  onAfterWork={(afterWork) => void changeAfterWork(afterWork)}
                />
              ) : null}
              {statusStrip}
            </div>
          </header>
          {statusError ? (
            <p className="aw-warning aw-status-error" role="alert">
              {statusError === 'chatBusy'
                ? `${t('chat.notReadyBlocked')} · ${t('chat.notReadyBlockedHint', { count: chatRooms })}`
                : statusError === 'change'
                  ? t('agentStatus.changeFailed')
                  : t(`agentStatus.failure.${statusError}.title`)}
            </p>
          ) : null}
          {statusV1 && gate === 'open' && snapshot ? (
            <StatusGate
              agentName={snapshot.agent.displayName}
              reasons={reasons}
              initial={gateInitial}
              preparing={prep.preparing}
              steps={prep.steps}
              failure={prep.failure}
              onEnter={(choice) => void enterFromGate(choice)}
              onFallback={() => {
                const reasonCode = fallbackReason(reasons);
                if (reasonCode) void enterFromGate({ state: 'BREAK', reasonCode });
              }}
            />
          ) : (
            <>
              {statusV1 &&
              snapshot?.agent.changedBy === 'SUPERVISOR' &&
              acknowledgedChange !== (snapshot.agent.stateSince ?? null) ? (
                <SupervisorNotice
                  name={snapshot.agent.changedByName}
                  state={snapshot.agent.state}
                  reasonLabel={
                    snapshot.agent.reasonCode
                      ? (reasons.find((reason) => reason.code === snapshot.agent.reasonCode)?.[
                          i18n.language.startsWith('en') ? 'labelEn' : 'labelTh'
                        ] ?? snapshot.agent.reasonCode)
                      : undefined
                  }
                  note={snapshot.agent.changeNote}
                  since={snapshot.agent.stateSince}
                  onAcknowledge={() => setAcknowledgedChange(snapshot.agent.stateSince ?? null)}
                />
              ) : null}
              {shellContent}
            </>
          )}
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

      {(inShell || extensionControl) && mediaOwner && !externalControl ? (
        detached ? (
          <DphoneDetachedBar view={view} onAttach={attach} />
        ) : (
          <DphoneWidget
            floating
            view={view}
            size={extensionControl && dphoneSize === 'expanded' ? 'compact' : dphoneSize}
            onSizeChange={changeSize}
            onCommand={dispatch}
            onDetach={extensionControl ? undefined : detach}
            basicControls={extensionControl}
          />
        )
      ) : null}

      {inShellFrame && !externalControl && !extensionControl ? (
        <DeviceTestButton inCall={inCall || dphoneState.phase === 'RINGING'} />
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
