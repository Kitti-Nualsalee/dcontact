/**
 * #1044: the script a tenant puts on its website:
 *   <script src="https://<d-contact>/api/v1/webchat/widget.js" data-tenant="…" data-widget="…" async></script>
 *
 * It draws the chat button and, on first use, an iframe from the D-Contact origin that holds the chat.
 * Nothing is drawn unless the API confirms this page's origin is allowed for the widget. Styles are set
 * as element properties (no <style>), so a host page with a strict CSP still shows the button.
 */
import { tokens } from '@d-contact/ui';
import { pickLocale, translator } from './messages.js';
import { WEBCHAT_SOURCE, isWebchatMessage, type HostToFrame } from './protocol.js';

declare global {
  interface Window {
    __dcWebchatLoaded?: boolean;
  }
}

/** the system stack: the widget loads no font on a tenant's site */
const FONT = "system-ui, -apple-system, 'Segoe UI', 'Noto Sans Thai', 'Leelawadee UI', sans-serif";
const ICON_CHAT = 'M4 5h16v11H9l-5 4z';
const ICON_CLOSE = 'M6 6l12 12M18 6L6 18';

function icon(path: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '26');
  svg.setAttribute('height', '26');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  shape.setAttribute('d', path);
  svg.append(shape);
  return svg;
}

function style(element: HTMLElement, values: Record<string, string>) {
  for (const [name, value] of Object.entries(values)) element.style.setProperty(name, value);
}

async function start(script: HTMLScriptElement) {
  const tenantId = script.dataset.tenant;
  const widgetId = script.dataset.widget;
  const preview = script.dataset.preview === '1';
  if (!tenantId || !widgetId || window.__dcWebchatLoaded) return;
  window.__dcWebchatLoaded = true;
  const api = new URL('.', script.src);
  let tenant = '';
  if (!preview) {
    try {
      const response = await fetch(new URL(`public/${tenantId}/${widgetId}/embed`, api), {
        credentials: 'omit',
        cache: 'no-store',
      });
      if (!response.ok) return;
      const body = (await response.json()) as { tenantName?: unknown };
      if (typeof body.tenantName === 'string') tenant = body.tenantName;
    } catch {
      return;
    }
  }

  const t = translator(pickLocale(navigator.languages ?? [navigator.language]));
  const storageKey = `dc-webchat:${widgetId}`;
  const stored = (() => {
    try {
      return localStorage.getItem(storageKey);
    } catch {
      return null;
    }
  })();

  const root = document.createElement('div');
  root.setAttribute('data-dc-webchat', '');
  style(root, {
    position: 'fixed',
    right: '20px',
    bottom: '20px',
    'z-index': '2147483000',
    display: 'flex',
    'flex-direction': 'column',
    'align-items': 'flex-end',
    gap: '12px',
    'font-family': FONT,
  });

  const button = document.createElement('button');
  button.type = 'button';
  style(button, {
    position: 'relative',
    height: '56px',
    'min-width': '56px',
    'border-radius': '999px',
    border: '0',
    padding: '0 22px',
    cursor: 'pointer',
    display: 'inline-flex',
    'align-items': 'center',
    'justify-content': 'center',
    gap: '10px',
    font: `600 16px/1 ${FONT}`,
    color: tokens.textOnBrand,
    background: tokens.surfaceBrand,
    'box-shadow': tokens.shadowFloating,
  });
  button.addEventListener('focus', () => button.style.setProperty('box-shadow', tokens.focusRing));
  button.addEventListener('blur', () =>
    button.style.setProperty('box-shadow', tokens.shadowFloating),
  );

  const badge = document.createElement('span');
  style(badge, {
    position: 'absolute',
    top: '-2px',
    right: '-2px',
    'min-width': '20px',
    height: '20px',
    padding: '0 5px',
    'box-sizing': 'border-box',
    'border-radius': '999px',
    font: `600 12px/20px ${FONT}`,
    color: tokens.textOnBrand,
    background: tokens.criticalSolid,
    display: 'none',
  });
  badge.setAttribute('aria-hidden', 'true');

  let frame: HTMLIFrameElement | undefined;
  let open = false;
  let unread = 0;

  function post(message: HostToFrame) {
    frame?.contentWindow?.postMessage(message, api.origin);
  }

  function render() {
    const label = document.createElement('span');
    label.textContent = t('launcher');
    // open: a round close button; closed: the labelled pill
    button.replaceChildren(...(open ? [icon(ICON_CLOSE)] : [icon(ICON_CHAT), label]), badge);
    button.style.setProperty('padding', open ? '0' : '0 22px');
    button.setAttribute('aria-expanded', String(open));
    button.setAttribute(
      'aria-label',
      open
        ? t('minimize')
        : unread > 0
          ? t('launcherUnread', { count: unread })
          : tenant
            ? t('launcherLabel', { tenant })
            : t('launcher'),
    );
    badge.textContent = unread > 9 ? '9+' : String(unread);
    badge.style.setProperty('display', !open && unread > 0 ? 'block' : 'none');
    if (frame) frame.style.setProperty('display', open ? 'block' : 'none');
  }

  function ensureFrame() {
    if (frame) return;
    frame = document.createElement('iframe');
    const source = new URL('frame', api);
    source.searchParams.set('tenant', tenantId!);
    source.searchParams.set('widget', widgetId!);
    if (preview) source.searchParams.set('preview', '1');
    frame.src = source.href;
    frame.title = tenant ? t('dialogLabel', { tenant }) : t('launcher');
    frame.setAttribute('allow', '');
    style(frame, {
      width: 'min(360px, calc(100vw - 40px))',
      height: 'min(560px, calc(100vh - 112px))',
      border: '0',
      'border-radius': '12px',
      background: tokens.surfaceRaised,
      'box-shadow': tokens.shadowFloating,
      'color-scheme': 'light',
    });
    root.prepend(frame);
  }

  function setOpen(next: boolean) {
    open = next;
    if (open) {
      ensureFrame();
      unread = 0;
    }
    render();
    post({ source: WEBCHAT_SOURCE, type: 'visibility', open });
  }

  window.addEventListener('message', (event) => {
    if (!frame || event.source !== frame.contentWindow || event.origin !== api.origin) return;
    if (!isWebchatMessage(event.data)) return;
    const message = event.data as { type: string; count?: unknown; value?: unknown };
    if (message.type === 'ready') {
      post({ source: WEBCHAT_SOURCE, type: 'session', value: stored });
      post({ source: WEBCHAT_SOURCE, type: 'visibility', open });
    } else if (message.type === 'minimize') {
      setOpen(false);
      button.focus();
    } else if (message.type === 'unread' && typeof message.count === 'number') {
      unread = open ? 0 : message.count;
      render();
    } else if (message.type === 'session') {
      try {
        if (typeof message.value === 'string') localStorage.setItem(storageKey, message.value);
        else localStorage.removeItem(storageKey);
      } catch {
        // storage is blocked on this page: the chat still works until the page is closed
      }
    }
  });

  button.addEventListener('click', () => setOpen(!open));
  root.append(button);
  render();
  document.body.append(root);
  // a visitor who was in a chat sees it again right after a page load
  if (stored) setOpen(true);
}

const current = document.currentScript;
if (current instanceof HTMLScriptElement) {
  const run = () => void start(current);
  if (document.body) run();
  else document.addEventListener('DOMContentLoaded', run, { once: true });
}
