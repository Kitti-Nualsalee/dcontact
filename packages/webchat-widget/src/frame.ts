/**
 * #1044: the chat itself, inside the iframe the loader creates (`/api/v1/webchat/frame`).
 *
 * The frame is served from the D-Contact origin, so its calls to the API are same-origin and the host
 * page cannot read the conversation. The view is rebuilt from `ChatController`'s state; the text the
 * visitor is typing lives in the textarea and is never touched by a re-render.
 */
import { createChatApi, type StoredSession } from './client.js';
import {
  ChatController,
  type ChatView,
  type SessionStore,
  type ViewMessage,
} from './controller.js';
import { pickLocale, translator, type WidgetLocale } from './messages.js';
import { WEBCHAT_SOURCE, isWebchatMessage, type FrameToHost } from './protocol.js';

const MAX_LENGTH = 2000;

const ICONS = {
  send: 'M4 12l16-8-6 16-3-7z',
  chevron: 'M6 9l6 6 6-6',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z',
  off: 'M4 5h16v11H9l-5 4zM9 8l6 5M15 8l-6 5',
  chat: 'M4 5h16v11H9l-5 4z',
  alert: 'M12 8v5M12 16.5v.5M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
} as const;

function icon(name: keyof typeof ICONS, size = 18): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

/** The page that embeds this frame. The browser only lets the widget's allowed origins be that page. */
const hostOrigin: string | null = (() => {
  if (window.parent === window) return null;
  const ancestor = window.location.ancestorOrigins?.[0];
  if (ancestor) return ancestor;
  try {
    return document.referrer ? new URL(document.referrer).origin : null;
  } catch {
    return null;
  }
})();

function toHost(message: FrameToHost) {
  // the session secret is sent only to a known origin; the other messages carry nothing private
  if (window.parent === window) return;
  if (hostOrigin) window.parent.postMessage(message, hostOrigin);
  else if (message.type !== 'session') window.parent.postMessage(message, '*');
}

/** The session is kept in this frame's storage and mirrored to the host page (see `protocol.ts`). */
function sessionStore(key: string): SessionStore & { adopt(value: string | null): void } {
  let memory: StoredSession | null = null;
  const parse = (value: string | null): StoredSession | null => {
    if (!value) return null;
    try {
      const parsed = JSON.parse(value) as Partial<StoredSession>;
      return typeof parsed.sessionId === 'string' && typeof parsed.token === 'string'
        ? { sessionId: parsed.sessionId, token: parsed.token }
        : null;
    } catch {
      return null;
    }
  };
  try {
    memory = parse(localStorage.getItem(key));
  } catch {
    // an embedded frame may have no storage at all; the host page keeps the copy
  }
  return {
    load: () => memory,
    save(session) {
      memory = session;
      const value = session ? JSON.stringify(session) : null;
      try {
        if (value) localStorage.setItem(key, value);
        else localStorage.removeItem(key);
      } catch {
        // see above
      }
      toHost({ source: WEBCHAT_SOURCE, type: 'session', value });
    },
    adopt(value) {
      if (!memory) memory = parse(value);
    },
  };
}

function start(root: HTMLElement) {
  const tenantId = root.dataset.tenant ?? '';
  const widgetId = root.dataset.widget ?? '';
  const locale: WidgetLocale = pickLocale(navigator.languages ?? [navigator.language]);
  const t = translator(locale);
  document.documentElement.lang = locale;

  const store = sessionStore(`dc-webchat:${widgetId}`);
  const controller = new ChatController({
    api: createChatApi(new URL('.', window.location.href).href, tenantId, widgetId),
    store,
    origin: root.dataset.preview === '1' ? 'preview' : (hostOrigin ?? 'unknown'),
    locale,
    newId: () => crypto.randomUUID(),
    now: () => new Date(),
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });

  // ── static structure ──
  const dialog = el('section', 'dcw');
  dialog.setAttribute('role', 'dialog');
  const header = el('header', 'dcw-head');
  const titles = el('div', 'dcw-titles');
  const title = el('strong', 'dcw-title');
  const status = el('span', 'dcw-status');
  titles.append(title, status);
  const endButton = el('button', 'dcw-head-button', t('end'));
  endButton.type = 'button';
  const minimize = el('button', 'dcw-icon-button');
  minimize.type = 'button';
  minimize.setAttribute('aria-label', t('minimize'));
  minimize.append(icon('chevron', 20));
  header.append(titles, endButton, minimize);

  const banner = el('div', 'dcw-banner');
  banner.setAttribute('role', 'status');
  const body = el('div', 'dcw-body');
  const log = el('div', 'dcw-log');
  log.setAttribute('role', 'log');
  log.setAttribute('aria-live', 'polite');
  log.tabIndex = 0;
  const jump = el('button', 'dcw-jump');
  jump.type = 'button';
  jump.hidden = true;
  const placeholder = el('div', 'dcw-placeholder');
  body.append(log, placeholder, jump);

  const footer = el('footer', 'dcw-foot');
  const composer = el('form', 'dcw-composer');
  const field = el('textarea', 'dcw-input');
  field.rows = 1;
  field.setAttribute('aria-label', t('composer.label'));
  const send = el('button', 'dcw-send');
  send.type = 'submit';
  send.setAttribute('aria-label', t('send'));
  send.append(icon('send'));
  const row = el('div', 'dcw-composer-row');
  row.append(field, send);
  const meta = el('div', 'dcw-composer-meta');
  const hint = el('span', 'dcw-hint', t('composer.hint'));
  const count = el('span', 'dcw-count');
  meta.append(hint, count);
  const notice = el('p', 'dcw-notice');
  notice.setAttribute('role', 'alert');
  composer.append(row, meta, notice);
  const endedBox = el('div', 'dcw-ended');
  const endedText = el('p', 'dcw-ended-text');
  const restart = el('button', 'dcw-primary');
  restart.type = 'button';
  restart.append(icon('chat', 16), document.createTextNode(t('startNew')));
  endedBox.append(endedText, restart);
  footer.append(composer, endedBox);

  // the confirmation covers only the chat window, never the host page
  const sheet = el('div', 'dcw-sheet');
  sheet.hidden = true;
  const sheetCard = el('div', 'dcw-sheet-card');
  sheetCard.setAttribute('role', 'alertdialog');
  sheetCard.setAttribute('aria-modal', 'true');
  const sheetTitle = el('strong', 'dcw-sheet-title', t('endTitle'));
  sheetTitle.id = 'dcw-end-title';
  sheetCard.setAttribute('aria-labelledby', sheetTitle.id);
  const sheetBody = el('p', 'dcw-sheet-body', t('endBody'));
  const confirmEnd = el('button', 'dcw-primary', t('endConfirm'));
  confirmEnd.type = 'button';
  const cancelEnd = el('button', 'dcw-secondary', t('endCancel'));
  cancelEnd.type = 'button';
  sheetCard.append(sheetTitle, sheetBody, confirmEnd, cancelEnd);
  sheet.append(sheetCard);

  dialog.append(header, banner, body, footer, sheet);
  root.replaceChildren(dialog);

  // ── behaviour ──
  let open = false;
  let unread = 0;
  let seen = 0;
  let pinned = true;
  let view = controller.current();

  const time = (iso: string) =>
    new Date(iso).toLocaleTimeString(locale === 'th' ? 'th-TH' : 'en-GB', {
      hour: '2-digit',
      minute: '2-digit',
    });

  function systemText(message: ViewMessage): string {
    switch (message.event) {
      case 'AGENT_JOINED':
        return t('system.joined');
      case 'AGENT_ENDED':
        return t('system.agentEnded');
      case 'CUSTOMER_ENDED':
        return t('system.youEnded');
      case 'IDLE_TIMEOUT':
        return t('system.idleClosed', { minutes: Math.round(view.idleTimeoutSec / 60) });
      default:
        return t('system.left');
    }
  }

  function messageNode(message: ViewMessage): HTMLElement {
    if (message.from === 'system') {
      const line = el('div', 'dcw-system');
      line.append(el('span', undefined, systemText(message)));
      return line;
    }
    const mine = message.from === 'visitor';
    const item = el('div', `dcw-message ${mine ? 'dcw-mine' : 'dcw-theirs'}`);
    if (message.pending === 'failed') item.classList.add('dcw-failed');
    item.append(el('p', 'dcw-bubble', message.text ?? ''));
    const metaLine = el('div', 'dcw-message-meta');
    if (message.pending === 'failed') {
      const failed = el('span', 'dcw-failed-label');
      failed.append(icon('alert', 14), document.createTextNode(t('sendFailed')));
      const retry = el('button', 'dcw-link', t('retry'));
      retry.type = 'button';
      retry.addEventListener('click', () => void controller.retry(message.id));
      metaLine.append(failed, retry);
    } else if (message.pending === 'sending') {
      metaLine.append(el('span', undefined, t('sending')));
    } else {
      metaLine.append(
        el('span', undefined, mine ? time(message.at) : `${t('agent')} · ${time(message.at)}`),
      );
    }
    // screen readers hear who spoke; sighted users read it from the side and colour of the bubble
    const speaker = el('span', 'dcw-sr', `${mine ? t('you') : t('agent')}: `);
    item.prepend(speaker);
    item.append(metaLine);
    return item;
  }

  function greetingNode(): HTMLElement {
    const card = el('div', 'dcw-welcome');
    const text = (locale === 'en' ? view.greeting.en : view.greeting.th) || view.greeting.th;
    card.append(el('p', 'dcw-welcome-text', text || t('welcomeDefault')));
    card.append(el('p', 'dcw-welcome-safety', t('safety')));
    return card;
  }

  function fullState(kind: 'offline' | 'disabled' | 'loading') {
    placeholder.replaceChildren();
    if (kind === 'loading') {
      placeholder.append(
        el('span', 'dcw-spinner'),
        el('p', 'dcw-placeholder-body', t('status.loading')),
      );
      return;
    }
    const tenant = view.tenantName;
    placeholder.append(icon(kind === 'offline' ? 'moon' : 'off', 30));
    placeholder.append(el('strong', 'dcw-placeholder-title', t(`${kind}.title`)));
    placeholder.append(el('p', 'dcw-placeholder-body', t(`${kind}.body`, { tenant })));
    if (kind === 'offline') {
      const again = el('button', 'dcw-secondary', t('offline.retry'));
      again.type = 'button';
      again.addEventListener('click', () => void controller.recheck());
      placeholder.append(again);
    }
  }

  function updateComposer() {
    const length = [...field.value.replace(/\r\n?/g, '\n').trim()].length;
    const tooLong = length > MAX_LENGTH;
    const canType = ['ready', 'waiting', 'active'].includes(view.phase);
    field.disabled = !canType;
    field.placeholder = t(canType ? 'composer.placeholder' : 'composer.placeholderDisabled');
    field.classList.toggle('dcw-invalid', tooLong);
    field.setAttribute('aria-invalid', String(tooLong));
    count.textContent = t('composer.count', { count: length });
    count.classList.toggle('dcw-over', tooLong);
    hint.textContent = tooLong ? t('composer.tooLong') : t('composer.hint');
    hint.classList.toggle('dcw-over', tooLong);
    // a lost connection keeps the draft but holds the send until the chat is reachable again
    send.disabled = !canType || length === 0 || tooLong || view.reconnecting;
    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight, 120)}px`;
  }

  function render(next: ChatView) {
    view = next;
    const tenant = view.tenantName;
    title.textContent = tenant || t('status.ready');
    dialog.setAttribute('aria-label', t('dialogLabel', { tenant }));
    const statusKey = view.reconnecting
      ? 'reconnecting'
      : view.phase === 'waiting'
        ? 'waiting'
        : view.phase === 'active'
          ? 'chatting'
          : view.phase === 'ended' || view.phase === 'unavailable'
            ? 'ended'
            : view.phase === 'offline'
              ? 'offline'
              : view.phase === 'loading'
                ? 'loading'
                : 'ready';
    status.textContent = t(`status.${statusKey}`);
    endButton.hidden = !['waiting', 'active'].includes(view.phase);
    if (endButton.hidden) sheet.hidden = true;

    banner.className = 'dcw-banner';
    if (view.reconnecting) {
      banner.classList.add('dcw-banner-warn');
      banner.replaceChildren(el('span', 'dcw-spinner'), el('span', undefined, t('reconnecting')));
    } else if (view.phase === 'waiting') {
      banner.replaceChildren(el('span', 'dcw-spinner'), el('span', undefined, t('waiting')));
    } else {
      banner.replaceChildren();
    }
    banner.hidden = banner.childElementCount === 0;

    const blocking =
      view.phase === 'offline' ? 'offline' : view.phase === 'unavailable' ? 'disabled' : null;
    const loading = view.phase === 'loading';
    placeholder.hidden = !blocking && !loading;
    log.hidden = !placeholder.hidden;
    if (blocking) fullState(blocking);
    else if (loading) fullState('loading');

    if (!log.hidden) {
      const nodes: HTMLElement[] = [greetingNode(), ...view.messages.map(messageNode)];
      log.replaceChildren(...nodes);
      const arrived = view.messages.filter(
        (message) => !message.pending && message.from !== 'visitor',
      );
      if (arrived.length > seen) {
        if (!open) unread += arrived.length - seen;
        else if (!pinned) {
          jump.hidden = false;
          jump.textContent = t('newMessages', { count: arrived.length - seen });
        }
      }
      if (open && pinned) seen = arrived.length;
      if (pinned) log.scrollTop = log.scrollHeight;
      if (!open) toHost({ source: WEBCHAT_SOURCE, type: 'unread', count: unread });
    }

    const ended = view.phase === 'ended';
    composer.hidden = ended || view.phase === 'unavailable';
    endedBox.hidden = !ended;
    endedText.textContent = t(view.endReason === 'IDLE_TIMEOUT' ? 'ended.idle' : 'ended.agent');
    notice.textContent = view.notice ? t(`error.${view.notice}`) : '';
    notice.hidden = !view.notice;
    updateComposer();
  }

  log.addEventListener('scroll', () => {
    pinned = log.scrollHeight - log.scrollTop - log.clientHeight < 32;
    if (pinned) {
      jump.hidden = true;
      seen = view.messages.filter(
        (message) => !message.pending && message.from !== 'visitor',
      ).length;
    }
  });
  jump.addEventListener('click', () => {
    log.scrollTop = log.scrollHeight;
    jump.hidden = true;
  });

  function submit() {
    if (send.disabled) return;
    const text = field.value;
    field.value = '';
    pinned = true;
    updateComposer();
    void controller.send(text);
  }
  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    submit();
  });
  field.addEventListener('input', updateComposer);
  field.addEventListener('keydown', (event) => {
    // Enter while composing Thai or another IME text confirms the text; it must not send
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  });

  endButton.addEventListener('click', () => {
    sheet.hidden = false;
    confirmEnd.focus();
  });
  const closeSheet = () => {
    sheet.hidden = true;
    endButton.focus();
  };
  cancelEnd.addEventListener('click', closeSheet);
  confirmEnd.addEventListener('click', () => {
    sheet.hidden = true;
    void controller.end();
  });
  sheet.addEventListener('keydown', (event) => {
    if (event.key === 'Tab') {
      // two buttons: keep focus inside the confirmation while it is open
      event.preventDefault();
      (document.activeElement === confirmEnd ? cancelEnd : confirmEnd).focus();
    }
  });
  restart.addEventListener('click', () => {
    seen = 0;
    void controller.restart().then(() => field.focus());
  });
  minimize.addEventListener('click', () => toHost({ source: WEBCHAT_SOURCE, type: 'minimize' }));
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!sheet.hidden) closeSheet();
    else toHost({ source: WEBCHAT_SOURCE, type: 'minimize' });
  });

  let started = false;
  const begin = () => {
    if (started) return;
    started = true;
    controller.subscribe(render);
    void controller.init();
  };
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || !isWebchatMessage(event.data)) return;
    const message = event.data as { type: string; open?: unknown; value?: unknown };
    if (message.type === 'session') {
      store.adopt(typeof message.value === 'string' ? message.value : null);
      begin();
    } else if (message.type === 'visibility') {
      open = message.open === true;
      if (open) {
        unread = 0;
        pinned = true;
        render(view);
        toHost({ source: WEBCHAT_SOURCE, type: 'unread', count: 0 });
        if (!field.disabled) field.focus();
      }
    }
  });
  toHost({ source: WEBCHAT_SOURCE, type: 'ready' });
  // opened directly (not through the loader): there is no host page to wait for
  if (window.parent === window) {
    open = true;
    begin();
  } else setTimeout(begin, 500);
}

const root = document.getElementById('dcw-root');
if (root) start(root);
