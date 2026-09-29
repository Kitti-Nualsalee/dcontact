/**
 * E1.11 (#485): entry ของ dphone ที่ถูกฝัง — โหลดจาก shell `/dphone/embed` ของ API
 *
 * ตรวจและล็อก host origin ก่อน แล้ว (E1.13 #487) เริ่ม auth แบบ popup PKCE เฉพาะเมื่อล็อกได้
 * runtime ของสาย (postMessage v1, lease, screen-pop, click-to-call) อยู่ใน E1.14 และต่อจาก
 * `window.__dphoneEmbed` — `auth.fetch()` แนบ token ให้โดยไม่เปิดเผย token นอก iframe
 */
import { resolveLocale } from '@d-contact/i18n';
import { appI18n } from '../i18n/index.js';
import { ActivityOutbox } from './activity-outbox.js';
import { mountAuthBar } from './auth-bar.js';
import { EmbedRuntime } from './embed-runtime.js';
import { mountEmbeddedApp } from './embedded-app.js';
import { HostChannel } from './host-channel.js';
import { createDeterministicDphone } from '../workspace-app.js';
import { browserAuthDeps, EmbeddedAuth } from './embedded-auth.js';
import {
  lockHostOrigin,
  parseEmbedConfig,
  resolveHostOrigin,
  type HostOriginLock,
} from './origin-lock.js';

declare global {
  interface Window {
    __dphoneEmbed?: {
      lock: HostOriginLock | null;
      tenant: string | null;
      auth: EmbeddedAuth | null;
      runtime?: EmbedRuntime;
    };
  }
}

const config = parseEmbedConfig(document.getElementById('dphone-embed-config')?.textContent);
const lock =
  window.parent === window
    ? null // เปิดตรง (ไม่ได้ถูกฝัง) ไม่ใช่ใช้งานแบบ embed
    : lockHostOrigin(
        config,
        resolveHostOrigin({
          ancestorOrigins: window.location.ancestorOrigins,
          referrer: document.referrer,
        }),
        window.parent,
      );

const auth =
  lock && config?.auth && config.tenant
    ? new EmbeddedAuth(
        {
          issuer: config.auth.issuer,
          clientId: config.auth.clientId,
          tenant: config.tenant,
          origin: window.location.origin,
        },
        browserAuthDeps(window),
      )
    : null;

document.documentElement.dataset.embedState = lock ? 'locked' : 'blocked';
window.__dphoneEmbed = { lock, tenant: config?.tenant ?? null, auth };

if (auth) {
  const locale = resolveLocale({ browser: navigator.languages });
  void appI18n.changeLanguage(locale);
  document.documentElement.lang = locale;
  window.addEventListener('message', (event) => void auth.handleMessage(event));
  // popup ถูกปิดเองโดยไม่มี callback → กลับไปให้กดเข้าสู่ระบบได้อีกครั้ง
  window.addEventListener('focus', () => void auth.popupClosed());
  const root = document.getElementById('dphone-embed-root');
  if (root) mountAuthBar(root, auth, appI18n);
  void auth.start();

  // E1.14: postMessage v1 กับ host ที่ล็อกไว้ + screen-pop / activity / click-to-call
  const hostLock = lock!;
  const screenPopLevel = config?.screenPopLevels?.[hostLock.origin] ?? 'off';
  let runtime: EmbedRuntime | undefined;
  let outbox: ActivityOutbox | undefined;
  const channel = new HostChannel({
    lock: hostLock,
    host: window.parent,
    now: () => Date.now(),
    onCall: (request) => runtime?.prefillFromHost(request),
    onActivityAck: (interactionId) => outbox?.ack(interactionId),
  });
  outbox = new ActivityOutbox({
    storage: window.sessionStorage,
    storageKey: `dphone.embed.activity.${config!.tenant}`,
    send: (message) => channel.send(message),
    setTimeout: (callback, ms) => window.setTimeout(callback, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
  });
  runtime = new EmbedRuntime({
    apiBaseUrl: window.location.origin,
    hostOrigin: hostLock.origin,
    screenPopLevel,
    authorizedFetch: (url, init) => auth.fetch(url, init),
    send: (message) => channel.send(message),
    enqueueActivity: (message) => outbox!.enqueue(message),
    requestId: () => crypto.randomUUID(),
    now: () => new Date(),
  });
  window.__dphoneEmbed.runtime = runtime;
  window.addEventListener('message', (event) => channel.handle(event));
  channel.ready(
    { screenPop: screenPopLevel !== 'off', clickToCall: true, activity: true },
    screenPopLevel,
  );
  // reload host แล้ว activity ที่ยังไม่ ack ถูกส่งซ้ำ (idempotent ด้วย interactionId)
  outbox.resendAll();

  const app = document.createElement('div');
  app.className = 'dphone-embed-app';
  root?.append(app);
  mountEmbeddedApp(app, {
    auth,
    runtime,
    lock: hostLock,
    apiBaseUrl: window.location.origin,
    tenant: config!.tenant!,
    // e2e: SIP จำลองแบบเดียวกับ spec ของ Workspace (D1.15)
    ...(import.meta.env.MODE === 'e2e'
      ? { createDphone: (_audio, callbacks) => createDeterministicDphone(callbacks) }
      : {}),
  });
}
