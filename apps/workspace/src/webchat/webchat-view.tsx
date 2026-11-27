/**
 * #1044: web chat in the Agent Workspace — the offer cards and rooms of the work list, the room in the
 * main column and the wrap-up of an ended chat. State lives in `WebchatStore`; these components only
 * draw it, so switching rooms or receiving a message never remounts the page (docs/ui-principles.md item 4).
 */
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useLocale, useTranslation } from '@d-contact/i18n/react';
import {
  Button,
  ChatTranscript,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  toastQueue,
  type ChatTranscriptMessage,
} from '@d-contact/ui-react';
import type { WrapupIntentV1, WrapupResultV1 } from '../agent-api.js';
import { PaneIcon } from '../workspace-pane.js';
import type { WebchatApi, WebchatChannel, WebchatChat, WebchatMessage } from './webchat-api.js';
import {
  WEBCHAT_MAX_LENGTH,
  WebchatStore,
  unreadOf,
  waitingSince,
  type ClosedChat,
  type WebchatRoom,
  type WebchatState,
} from './webchat-store.js';
import './webchat.css';

export type WebchatRoomTab = 'conversation' | 'customer';

const IDLE_WARNING_MS = 120_000;
const OFFER_LOW_SECONDS = 10;

function clockDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Creates the store while web chat is available and keeps it reading the Agent's chats. */
export function useWebchat(options: {
  api?: WebchatApi;
  enabled: boolean;
  submitWrapup?: (intent: WrapupIntentV1) => Promise<WrapupResultV1>;
}): { store: WebchatStore; state: WebchatState } | undefined {
  const { api, enabled, submitWrapup } = options;
  const store = useMemo(
    () =>
      enabled && api && submitWrapup
        ? new WebchatStore({
            api,
            submitWrapup,
            newId: () => crypto.randomUUID(),
            now: () => new Date(),
            visible: () => document.visibilityState === 'visible' && document.hasFocus(),
          })
        : undefined,
    [api, enabled, submitWrapup],
  );
  useEffect(() => {
    if (!store) return;
    store.start();
    // coming back to the page reads the room in view
    const seen = () => store.markRead();
    window.addEventListener('focus', seen);
    document.addEventListener('visibilitychange', seen);
    return () => {
      store.stop();
      window.removeEventListener('focus', seen);
      document.removeEventListener('visibilitychange', seen);
    };
  }, [store]);
  const state = useSyncExternalStore(
    store?.subscribe ?? noSubscription,
    store?.snapshot ?? noState,
  );
  return store && state ? { store, state } : undefined;
}
const noSubscription = () => () => undefined;
const noState = () => undefined;

/** A web chat visitor is anonymous and shown by code; a LINE customer is shown by their LINE name. */
function useVisitorName() {
  const { t } = useTranslation('workspace');
  return (label: string, channel: WebchatChannel = 'WEBCHAT') =>
    channel === 'LINE' ? label : t('chat.visitor', { code: label });
}

/** The channel tag of a chat: Web Chat or LINE, from the channel tokens. */
function ChannelBadge({ channel }: { channel: WebchatChannel }) {
  const { t } = useTranslation('workspace');
  return channel === 'LINE' ? (
    <span className="aw-channel aw-channel-line">{t('layout.channelLine')}</span>
  ) : (
    <span className="aw-channel aw-channel-webchat">{t('layout.channelWebchat')}</span>
  );
}

const LINE_OTHER_TYPES = ['sticker', 'image', 'video', 'audio', 'file', 'location'];

/** What stands in for a LINE message that is not text: one text per known type and a generic one. */
function otherText(other: string, t: (key: never) => string): string {
  return t(
    (LINE_OTHER_TYPES.includes(other) ? `chat.other.${other}` : 'chat.other.unknown') as never,
  );
}

/** "Chats 2/3" next to the status selector, so the Agent sees how many more chats may arrive. */
export function WebchatCapacity({ state }: { state: WebchatState }) {
  const { t } = useTranslation('workspace');
  const count = state.rooms.length;
  if (!state.ready) return null;
  return (
    <span className="aw-chat-capacity">
      <PaneIcon name="chat" size={16} />
      <span>{t('chat.capacity', { count, max: state.maxChats })}</span>
      {count >= state.maxChats ? (
        <span className="aw-chat-capacity-full">· {t('chat.capacityFull')}</span>
      ) : null}
    </span>
  );
}

function previewOf(message: WebchatMessage | null, t: (key: never) => string): string {
  if (!message) return '';
  if (message.from !== 'system')
    return message.other ? otherText(message.other, t) : (message.text ?? '');
  const key =
    message.event === 'AGENT_JOINED'
      ? undefined
      : message.event === 'IDLE_TIMEOUT'
        ? 'chat.system.idleClosedShort'
        : message.event === 'AGENT_ENDED'
          ? 'chat.closed.agent'
          : message.event === 'CUSTOMER_ENDED'
            ? 'chat.system.customerEnded'
            : 'chat.system.customerLeft';
  return key ? t(key as never) : '';
}

/** Offers above the list. An offer never takes focus or covers the room the Agent is working in. */
export function WebchatOffers({
  store,
  state,
  now,
  onAccepted,
}: {
  store: WebchatStore;
  state: WebchatState;
  now: number;
  onAccepted: () => void;
}) {
  const { t } = useTranslation('workspace');
  const visitor = useVisitorName();
  const firstSeen = useRef(new Map<string, number>());
  const [announcement, setAnnouncement] = useState('');
  const [accepting, setAccepting] = useState<string>();
  useEffect(() => {
    for (const offer of state.offers) {
      if (firstSeen.current.has(offer.interactionId)) continue;
      firstSeen.current.set(offer.interactionId, Date.now());
      // announced once when the offer arrives, not every second of the countdown
      const seconds = offer.offerExpiresAt
        ? Math.max(0, Math.round((Date.parse(offer.offerExpiresAt) - Date.now()) / 1000))
        : 0;
      setAnnouncement(
        t('chat.offer.announce', { visitor: visitor(offer.visitorLabel, offer.channel), seconds }),
      );
    }
  }, [state.offers, t, visitor]);

  async function accept(offer: WebchatChat) {
    setAccepting(offer.interactionId);
    const taken = await store.accept(offer.interactionId);
    setAccepting(undefined);
    if (taken) onAccepted();
  }

  if (state.offers.length === 0 && state.missed.length === 0 && !state.notice)
    return (
      <p className="aw-visually-hidden" aria-live="polite">
        {announcement}
      </p>
    );
  return (
    <div className="aw-chat-offers" role="region" aria-label={t('chat.offer.region')}>
      <p className="aw-visually-hidden" aria-live="polite">
        {announcement}
      </p>
      {state.offers.map((offer) => {
        const expires = offer.offerExpiresAt ? Date.parse(offer.offerExpiresAt) : now;
        const started = firstSeen.current.get(offer.interactionId) ?? now;
        const remaining = Math.max(0, expires - now);
        const seconds = Math.ceil(remaining / 1000);
        const progress = expires > started ? Math.min(1, remaining / (expires - started)) : 0;
        const preview = previewOf(offer.lastMessage, t as never);
        return (
          <article
            key={offer.interactionId}
            className="aw-chat-offer"
            data-low={seconds <= OFFER_LOW_SECONDS ? 'true' : undefined}
            style={{ '--aw-offer-progress': String(progress) } as CSSProperties}
          >
            <div className="aw-work-row">
              <strong>
                {t('chat.offer.title', { visitor: visitor(offer.visitorLabel, offer.channel) })}
              </strong>
              <span
                className="aw-work-time aw-chat-offer-time"
                role="timer"
                aria-label={t('chat.offer.remaining', { seconds })}
              >
                {clockDuration(remaining)}
              </span>
            </div>
            <p className="aw-chat-preview">
              <ChannelBadge channel={offer.channel} />{' '}
              {[offer.queueName, preview ? `“${preview}”` : ''].filter(Boolean).join(' · ')}
            </p>
            <div className="aw-chat-offer-actions">
              <Button
                variant="primary"
                size="sm"
                isDisabled={accepting === offer.interactionId}
                aria-keyshortcuts="Alt+Shift+A"
                onPress={() => void accept(offer)}
              >
                {t('chat.offer.accept')}
              </Button>
              <span className="aw-work-meta">
                {t('chat.offer.after', { count: state.rooms.length + 1, max: state.maxChats })}
              </span>
            </div>
            <span className="aw-chat-offer-bar" aria-hidden="true" />
          </article>
        );
      })}
      {state.notice === 'offerTaken' ? (
        <p className="aw-chat-missed" role="status">
          <span>{t('chat.offer.taken')}</span>
          <Button size="sm" variant="ghost" onPress={() => store.clearNotice()}>
            {t('chat.offer.dismiss')}
          </Button>
        </p>
      ) : null}
      {state.missed.map((missed) => (
        <p key={missed.interactionId} className="aw-chat-missed" role="status">
          <span>
            {t('chat.offer.missed', { visitor: visitor(missed.visitorLabel, missed.channel) })}
          </span>
          <Button
            size="sm"
            variant="ghost"
            onPress={() => store.dismissMissed(missed.interactionId)}
          >
            {t('chat.offer.dismiss')}
          </Button>
        </p>
      ))}
    </div>
  );
}

/** The Agent's rooms as rows of the work list, in the order they arrived. */
export function WebchatRows({
  state,
  now,
  selectedId,
  onSelect,
}: {
  state: WebchatState;
  now: number;
  /** null when the main column shows something else (a call, a closed item) */
  selectedId: string | null;
  onSelect: (interactionId: string) => void;
}) {
  const { t } = useTranslation('workspace');
  const visitor = useVisitorName();
  return (
    <>
      {state.rooms.map((room) => {
        const { chat } = room;
        const unread = unreadOf(room);
        const waiting = waitingSince(room);
        const stateLabel = t(`chat.state.${chat.state === 'WRAPUP' ? 'WRAPUP' : 'ACTIVE'}`);
        const name = visitor(chat.visitorLabel, chat.channel);
        return (
          <li key={chat.interactionId} className="aw-v3-item aw-chat-item">
            <button
              type="button"
              aria-current={selectedId === chat.interactionId ? 'true' : undefined}
              aria-label={[
                t('chat.itemLabel', { visitor: name, state: stateLabel }),
                unread ? t('chat.unread', { count: unread }) : '',
              ]
                .filter(Boolean)
                .join(', ')}
              onClick={() => onSelect(chat.interactionId)}
            >
              <span className="aw-v3-item-icon">
                <PaneIcon name="chat" />
              </span>
              <span className="aw-v3-item-copy">
                <span className="aw-work-row">
                  <strong>{name}</strong>
                  <span className="aw-work-time" data-waiting={waiting ? 'true' : undefined}>
                    {waiting
                      ? t('chat.waiting', { duration: clockDuration(now - Date.parse(waiting)) })
                      : chat.answeredAt
                        ? clockDuration(
                            (chat.endedAt ? Date.parse(chat.endedAt) : now) -
                              Date.parse(chat.answeredAt),
                          )
                        : ''}
                  </span>
                </span>
                <span className="aw-chat-preview-row">
                  <span className="aw-chat-preview" data-unread={unread ? 'true' : undefined}>
                    {previewOf(chat.lastMessage, t as never)}
                  </span>
                  {unread ? (
                    <span className="aw-chat-unread" aria-hidden="true">
                      {unread > 99 ? '99+' : unread}
                    </span>
                  ) : null}
                </span>
                <span className="aw-chat-tags">
                  <ChannelBadge channel={chat.channel} />
                  <span className="aw-chat-state" data-state={chat.state.toLowerCase()}>
                    {stateLabel}
                  </span>
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </>
  );
}

function transcriptOf(
  room: WebchatRoom,
  texts: {
    visitor: string;
    self: string;
    sending: string;
    failed: string;
    deliverySending: string;
    notDelivered: string;
    started: string;
    other: (kind: string) => string;
    system: (event: WebchatMessage['event']) => string;
  },
  clock: (iso: string) => string,
): ChatTranscriptMessage[] {
  const messages: ChatTranscriptMessage[] = [
    {
      id: `started:${room.chat.interactionId}`,
      side: 'system',
      text: texts.started,
      time: clock(room.chat.queuedAt),
    },
  ];
  for (const message of room.messages) {
    if (message.from === 'system')
      messages.push({
        id: message.id,
        side: 'system',
        text: texts.system(message.event),
        time: clock(message.at),
      });
    else
      messages.push({
        id: message.id,
        side: message.from === 'agent' ? 'self' : 'other',
        author: message.from === 'agent' ? texts.self : texts.visitor,
        time: message.pending ? undefined : clock(message.at),
        text: message.other ? texts.other(message.other) : (message.text ?? ''),
        ...(message.other ? { placeholder: true } : {}),
        ...(message.pending
          ? {
              status: message.pending,
              statusLabel: message.pending === 'failed' ? texts.failed : texts.sending,
            }
          : message.delivery
            ? {
                status: message.delivery === 'FAILED' ? 'failed' : 'sending',
                statusLabel:
                  message.delivery === 'FAILED' ? texts.notDelivered : texts.deliverySending,
              }
            : {}),
      });
  }
  return messages;
}

/** The room in the main column: who it is, the conversation, and the composer or the reason it ended. */
export function WebchatRoomView({
  store,
  room,
  now,
  online,
  agentName,
  tab,
  onTabChange,
  customerPanel,
  customerLinked,
  focusToken,
  onGoWrapup,
  actions,
}: {
  store: WebchatStore;
  room: WebchatRoom;
  now: number;
  online: boolean;
  agentName: string;
  tab: WebchatRoomTab;
  onTabChange: (tab: WebchatRoomTab) => void;
  /** the Customer 360 panel of this work; undefined when the deployment has none */
  customerPanel?: ReactNode;
  customerLinked: boolean;
  /** changes when the composer should take focus (room accepted or selected) */
  focusToken: number;
  onGoWrapup: () => void;
  /** extra actions in the header, e.g. opening a case */
  actions?: ReactNode;
}) {
  const { t } = useTranslation('workspace');
  const { locale } = useLocale();
  const visitor = useVisitorName();
  const { chat } = room;
  const name = visitor(chat.visitorLabel, chat.channel);
  const line = chat.channel === 'LINE';
  const [confirming, setConfirming] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const endButton = useRef<HTMLSpanElement>(null);
  const clock = (iso: string) =>
    new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  const active = chat.state === 'ACTIVE';
  const length = [...room.draft.replace(/\r\n?/g, '\n').trim()].length;
  const tooLong = length > WEBCHAT_MAX_LENGTH;
  const canSend = active && online && length > 0 && !tooLong;

  useEffect(() => setConfirming(false), [chat.interactionId, chat.state]);
  useEffect(() => {
    if (active && tab === 'conversation') field.current?.focus();
    // the token and the room decide when to focus; typing must not steal it back
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusToken, chat.interactionId]);
  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 132)}px`;
  }, [room.draft, chat.interactionId]);

  const system = (event: WebchatMessage['event']) =>
    event === 'AGENT_JOINED'
      ? t('chat.system.joined', { agent: agentName })
      : event === 'AGENT_ENDED'
        ? t('chat.system.agentEnded', { agent: agentName })
        : event === 'IDLE_TIMEOUT'
          ? t('chat.system.idleClosedShort')
          : event === 'CUSTOMER_ENDED'
            ? t('chat.system.customerEnded')
            : t('chat.system.customerLeft');
  const transcript = transcriptOf(
    room,
    {
      visitor: line ? t('chat.sender.customerLine') : t('chat.sender.customer'),
      self: t('chat.sender.self'),
      sending: t('chat.sending'),
      failed: t('chat.sendFailed'),
      deliverySending: t('chat.delivery.sending'),
      notDelivered: t('chat.delivery.failed'),
      other: (kind) => otherText(kind, t as never),
      started: line
        ? t('chat.system.startedLine', { account: chat.origin })
        : chat.origin === 'preview'
          ? t('chat.system.startedPreview')
          : t('chat.system.started', { origin: originLabel(chat.origin) }),
      system,
    },
    clock,
  );
  const idleRemaining = chat.idleClosesAt ? Date.parse(chat.idleClosesAt) - now : undefined;
  const duration = chat.answeredAt
    ? clockDuration((chat.endedAt ? Date.parse(chat.endedAt) : now) - Date.parse(chat.answeredAt))
    : undefined;
  const closedReason =
    chat.endReason === 'AGENT_ENDED'
      ? t('chat.closed.agent')
      : chat.endReason === 'IDLE_TIMEOUT'
        ? t('chat.closed.idle')
        : t('chat.closed.customerLeft');

  function submit() {
    if (!canSend) return;
    void store.send(chat.interactionId);
  }

  const conversation = (
    <div className="aw-chat-conversation">
      {room.historyFailed ? (
        <div className="aw-chat-banner" data-tone="critical" role="alert">
          <span>{t('chat.historyFailed')}</span>
          <Button size="sm" onPress={() => void store.retryHistory(chat.interactionId)}>
            {t('chat.historyRetry')}
          </Button>
        </div>
      ) : null}
      {!room.loaded && !room.historyFailed ? (
        <div className="aw-chat-skeleton" role="status" aria-label={t('chat.loading')}>
          <span />
          <span data-side="self" />
          <span />
        </div>
      ) : (
        <ChatTranscript
          className="aw-chat-transcript"
          label={t('chat.log', { visitor: name })}
          messages={transcript}
          live
          newMessagesLabel={(count) => t('chat.newMessages', { count })}
          renderFailedActions={(message) =>
            // a message LINE did not deliver has no local copy to send again or delete
            room.messages.find((entry) => entry.id === message.id)?.pending ? (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  onPress={() => void store.retry(chat.interactionId, message.id)}
                >
                  {t('chat.retrySend')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onPress={() => store.discard(chat.interactionId, message.id)}
                >
                  {t('chat.discard')}
                </Button>
              </>
            ) : null
          }
        />
      )}
      {active && idleRemaining !== undefined && idleRemaining <= IDLE_WARNING_MS ? (
        <p className="aw-chat-banner" data-tone="attention" role="status">
          {t('chat.idleWarning', { remaining: clockDuration(idleRemaining) })}
        </p>
      ) : null}
      {active ? (
        <form
          className="aw-chat-composer"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <textarea
            ref={field}
            rows={2}
            value={room.draft}
            aria-label={t('chat.composer.label')}
            aria-invalid={tooLong}
            aria-describedby="aw-chat-composer-hint"
            placeholder={t('chat.composer.placeholder')}
            onChange={(event) => store.setDraft(chat.interactionId, event.target.value)}
            onKeyDown={(event) => {
              // Enter while composing Thai or another IME text confirms the text; it must not send
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit();
              }
            }}
          />
          <div className="aw-chat-composer-meta">
            <span id="aw-chat-composer-hint" data-invalid={tooLong ? 'true' : undefined}>
              {tooLong ? t('chat.composer.tooLong') : t('chat.composer.hint')}
            </span>
            <span className="aw-work-time" data-invalid={tooLong ? 'true' : undefined}>
              {t('chat.composer.count', { count: length })}
            </span>
            <Button type="submit" variant="primary" isDisabled={!canSend}>
              {t('chat.send')}
            </Button>
          </div>
        </form>
      ) : (
        <div className="aw-chat-closed" role="status">
          <strong>{closedReason}</strong>
          <span>{t('chat.closed.hint')}</span>
          <Button variant="primary" onPress={onGoWrapup}>
            {t('chat.closed.goWrapup')}
          </Button>
        </div>
      )}
    </div>
  );

  return (
    <div className="aw-v3-view aw-chat-room">
      <div className="aw-v3-context">
        <strong className="aw-call-caller">{name}</strong>
        <ChannelBadge channel={chat.channel} />
        <span className="aw-v3-context-meta aw-chat-meta">
          {t('chat.header.meta', {
            queue: chat.queueName ?? t('offer.unknownQueue'),
            time: clock(chat.answeredAt ?? chat.queuedAt),
          })}
        </span>
        {actions}
        {active ? (
          <span
            ref={endButton}
            className="aw-chat-end"
            role="group"
            aria-label={confirming ? t('chat.endConfirm') : undefined}
            onKeyDown={(event) => {
              if (event.key !== 'Escape' || !confirming) return;
              setConfirming(false);
              requestAnimationFrame(() => endButton.current?.querySelector('button')?.focus());
            }}
          >
            {confirming ? (
              <>
                <span>{t('chat.endConfirm')}</span>
                <Button
                  size="sm"
                  variant="danger"
                  autoFocus
                  isDisabled={room.ending}
                  onPress={() => void store.end(chat.interactionId)}
                >
                  {t('chat.end')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onPress={() => {
                    setConfirming(false);
                    requestAnimationFrame(() =>
                      endButton.current?.querySelector('button')?.focus(),
                    );
                  }}
                >
                  {t('chat.endCancel')}
                </Button>
              </>
            ) : (
              <Button size="sm" variant="secondary" onPress={() => setConfirming(true)}>
                {t('chat.end')}
              </Button>
            )}
          </span>
        ) : null}
      </div>
      <div className="aw-v3-phonebar" data-state={active ? 'active' : 'wrapup'}>
        <span className="aw-v3-phonebar-icon">
          <PaneIcon name="chat" size={20} />
        </span>
        <span className="aw-call-row">
          <strong>{active ? t('chat.bar.active') : t('chat.bar.closed')}</strong>
        </span>
        <span className="aw-call-meta">
          {!active
            ? closedReason
            : chat.visitorOnline === false
              ? t('chat.bar.visitorAway')
              : customerLinked
                ? ''
                : t('chat.bar.unlinkedHint')}
        </span>
        {duration ? (
          <span className="aw-call-duration" role="timer">
            {t('chat.duration', { duration })}
          </span>
        ) : null}
      </div>
      {customerPanel ? (
        <Tabs
          className="aw-v3-tabs aw-v3-main-tabs aw-chat-tabs"
          selectedKey={tab}
          onSelectionChange={(key) => onTabChange(key as WebchatRoomTab)}
        >
          <TabList aria-label={t('chat.tab.label')}>
            <Tab id="conversation">{t('chat.tab.conversation')}</Tab>
            <Tab id="customer">{t('chat.tab.customer')}</Tab>
          </TabList>
          <TabPanel id="conversation" className="aw-chat-panel" shouldForceMount>
            {conversation}
          </TabPanel>
          <TabPanel id="customer" className="aw-v3-body" shouldForceMount>
            {customerPanel}
          </TabPanel>
        </Tabs>
      ) : (
        <div className="aw-chat-panel">{conversation}</div>
      )}
    </div>
  );
}

/** `https://shop.example` reads better without the scheme; anything unexpected is shown as it is. */
function originLabel(origin: string): string {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
}

/** The wrap-up tab while a chat is in view: the form once it has ended, the facts of the chat before that. */
export function WebchatWrapupPanel({
  store,
  room,
  sessionReady,
  customerLinked,
  focusToken,
}: {
  store: WebchatStore;
  room: WebchatRoom;
  sessionReady: boolean;
  customerLinked: boolean;
  /** changes when the first outcome should take focus ("go to wrap-up") */
  focusToken: number;
}) {
  const { t } = useTranslation('workspace');
  const visitor = useVisitorName();
  const { chat, wrapup } = room;
  const name = visitor(chat.visitorLabel, chat.channel);
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (focusToken > 0) first.current?.focus();
  }, [focusToken]);
  const noteLength = [...wrapup.note.replace(/\r\n/g, '\n').trim()].length;
  const validNote = noteLength >= 1 && noteLength <= WEBCHAT_MAX_LENGTH;
  const locked = wrapup.pending || wrapup.error === 'unknown';

  async function save() {
    const result = await store.submitWrapup(chat.interactionId);
    if (result)
      toastQueue.add(
        { title: t('chat.wrapup.saved', { visitor: name }), tone: 'success' },
        { timeout: 5000 },
      );
  }

  const facts = (
    <dl className="aw-v3-facts aw-chat-facts">
      <div>
        <dt>{t('layout.main.channel')}</dt>
        <dd>{chat.channel === 'LINE' ? t('layout.channelLine') : t('layout.channelWebchat')}</dd>
      </div>
      <div>
        <dt>{t('layout.main.queue')}</dt>
        <dd>{chat.queueName ?? t('offer.unknownQueue')}</dd>
      </div>
      <div>
        <dt>{t('chat.facts.customer')}</dt>
        <dd data-missing={customerLinked ? undefined : 'true'}>
          {customerLinked ? t('chat.tab.customer') : t('chat.facts.customerNone')}
        </dd>
      </div>
      <div className="aw-v3-facts-wide">
        <dt>{t('layout.main.interaction')}</dt>
        <dd className="aw-v3-mono">{chat.interactionId}</dd>
      </div>
    </dl>
  );

  if (chat.state !== 'WRAPUP')
    return (
      <section className="aw-chat-wrapup-wait">
        <p className="aw-copy">
          {t(chat.channel === 'LINE' ? 'chat.wrapup.notYetLine' : 'chat.wrapup.notYet', {
            visitor: name,
          })}
        </p>
        {facts}
      </section>
    );
  return (
    <article className="aw-panel" aria-labelledby="aw-chat-wrapup-title">
      <div>
        <p className="aw-step">{t('chat.wrapup.step', { visitor: name })}</p>
        <h2 id="aw-chat-wrapup-title">{t('chat.wrapup.title')}</h2>
        <p className="aw-copy">{t('chat.wrapup.copy')}</p>
      </div>
      <div className="aw-segmented" role="group" aria-label={t('wrapup.choose')}>
        <button
          ref={first}
          type="button"
          aria-pressed={wrapup.disposition === 'CUSTOMER_ASSISTED'}
          disabled={locked}
          onClick={() => store.setWrapup(chat.interactionId, { disposition: 'CUSTOMER_ASSISTED' })}
        >
          {t('wrapup.assisted')}
        </button>
        <button
          type="button"
          aria-pressed={wrapup.disposition === 'FOLLOW_UP_REQUIRED'}
          disabled={locked}
          onClick={() => store.setWrapup(chat.interactionId, { disposition: 'FOLLOW_UP_REQUIRED' })}
        >
          {t('wrapup.followUp')}
        </button>
      </div>
      <label htmlFor="aw-chat-wrapup-note">{t('wrapup.note')}</label>
      <textarea
        id="aw-chat-wrapup-note"
        className="aw-chat-note"
        value={wrapup.note}
        disabled={locked}
        aria-describedby="aw-chat-wrapup-note-help"
        onChange={(event) => store.setWrapup(chat.interactionId, { note: event.target.value })}
      />
      <p id="aw-chat-wrapup-note-help">{t('wrapup.noteCount', { count: noteLength })}</p>
      {!validNote && wrapup.note ? <p>{t('wrapup.noteRequired')}</p> : null}
      <Button
        variant="primary"
        isDisabled={!wrapup.disposition || !validNote || !sessionReady || wrapup.pending}
        onPress={() => void save()}
      >
        {wrapup.error === 'unknown' ? t('chat.wrapup.retry') : t('wrapup.submit')}
      </Button>
      {wrapup.pending ? <p role="status">{t('wrapup.pending')}</p> : null}
      {wrapup.error === 'unknown' ? <p role="status">{t('wrapup.unknown')}</p> : null}
      {wrapup.error === 'failed' ? (
        <p role="alert" className="aw-error">
          {t('chat.wrapup.failed')}
        </p>
      ) : null}
    </article>
  );
}

/** A chat closed in this session, opened from the "closed" tab: what was saved for it. */
export function WebchatClosedPanel({ closed }: { closed: ClosedChat }) {
  const { t } = useTranslation('workspace');
  const { locale } = useLocale();
  return (
    <article className="aw-panel" aria-live="polite">
      <h2>{t('wrapup.saved')}</h2>
      <p>
        {closed.result.disposition === 'CUSTOMER_ASSISTED'
          ? t('wrapup.assisted')
          : t('wrapup.followUp')}
      </p>
      <p className="aw-wrapup-note">{closed.result.note}</p>
      <time dateTime={closed.result.recordedAt}>
        {new Date(closed.result.recordedAt).toLocaleString(locale)}
      </time>
    </article>
  );
}

/** Rows of the "closed" tab for chats wrapped up in this session. */
export function WebchatClosedRows({
  state,
  selectedId,
  onSelect,
}: {
  state: WebchatState;
  selectedId: string | null;
  onSelect: (interactionId: string) => void;
}) {
  const { t } = useTranslation('workspace');
  const { locale } = useLocale();
  const visitor = useVisitorName();
  return (
    <>
      {[...state.closed].reverse().map((closed) => (
        <li key={closed.interactionId} className="aw-v3-item">
          <button
            type="button"
            aria-current={selectedId === closed.interactionId ? 'true' : undefined}
            onClick={() => onSelect(closed.interactionId)}
          >
            <span className="aw-v3-item-icon">
              <PaneIcon name="chat" />
            </span>
            <span className="aw-v3-item-copy">
              <strong>{visitor(closed.visitorLabel, closed.channel)}</strong>
              <span className="aw-work-meta">
                {t('layout.list.closedMeta', {
                  time: new Date(closed.result.recordedAt).toLocaleTimeString(locale, {
                    hour: '2-digit',
                    minute: '2-digit',
                  }),
                })}
              </span>
              <ChannelBadge channel={closed.channel} />
            </span>
          </button>
        </li>
      ))}
    </>
  );
}
