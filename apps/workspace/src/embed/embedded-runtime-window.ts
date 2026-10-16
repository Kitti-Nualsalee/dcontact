import { appI18n } from '../i18n/index.js';
import { createDeterministicDphone } from '../workspace-app.js';
import { ActivityOutbox } from './activity-outbox.js';
import { mountAuthBar } from './auth-bar.js';
import { browserAuthDeps, EmbeddedAuth } from './embedded-auth.js';
import { mountEmbeddedApp } from './embedded-app.js';
import { EmbedRuntime } from './embed-runtime.js';
import { HostChannel, type HostWindow } from './host-channel.js';
import type { EmbedConfig, HostOriginLock } from './origin-lock.js';

export function mountRuntime(config: EmbedConfig, lock: HostOriginLock, host: HostWindow) {
  if (!config.auth || !config.tenant) return null;
  const deps = browserAuthDeps(window);
  if (config.ownerWindow) {
    const storage = deps.storage;
    const prefix = `dphone.owner.${lock.origin}.`;
    deps.storage = {
      getItem: (key) => storage.getItem(`${prefix}${key}`),
      setItem: (key, value) => storage.setItem(`${prefix}${key}`, value),
      removeItem: (key) => storage.removeItem(`${prefix}${key}`),
    };
  }
  const auth = new EmbeddedAuth(
    { ...config.auth, tenant: config.tenant, origin: window.location.origin },
    deps,
  );
  window.__dphoneEmbed = { lock, tenant: config.tenant, auth };
  window.addEventListener('message', (event) => void auth.handleMessage(event));
  window.addEventListener('focus', () => void auth.popupClosed());
  const root = document.getElementById('dphone-embed-root');
  if (root) mountAuthBar(root, auth, appI18n);
  void auth.start();
  const screenPopLevel = config.screenPopLevels?.[lock.origin] ?? 'off';
  let runtime: EmbedRuntime;
  let outbox: ActivityOutbox;
  const channel = new HostChannel({
    lock,
    host,
    now: () => Date.now(),
    onCall: (request) => runtime.prefillFromHost(request),
    onActivityAck: (interactionId) => outbox.ack(interactionId),
  });
  outbox = new ActivityOutbox({
    storage: window.sessionStorage,
    storageKey: `dphone.embed.activity.${config.tenant}${config.ownerWindow ? `.${lock.origin}` : ''}`,
    send: (message) => channel.send(message),
    setTimeout: (callback, ms) => window.setTimeout(callback, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
  });
  runtime = new EmbedRuntime({
    apiBaseUrl: window.location.origin,
    hostOrigin: lock.origin,
    screenPopLevel,
    authorizedFetch: (url, init) => auth.fetch(url, init),
    send: (message) => channel.send(message),
    enqueueActivity: (message) => outbox.enqueue(message),
    requestId: () => crypto.randomUUID(),
    now: () => new Date(),
  });
  window.__dphoneEmbed.runtime = runtime;
  const reconnect = () => {
    channel.ready(
      { screenPop: screenPopLevel !== 'off', clickToCall: true, activity: true },
      screenPopLevel,
    );
    outbox.resendAll();
  };
  const app = document.createElement('div');
  app.className = 'dphone-embed-app';
  root?.append(app);
  mountEmbeddedApp(app, {
    auth,
    runtime,
    lock,
    apiBaseUrl: window.location.origin,
    tenant: config.tenant,
    ...(import.meta.env.MODE === 'e2e'
      ? { createDphone: (_audio, callbacks) => createDeterministicDphone(callbacks) }
      : {}),
  });
  return {
    receive: (event: { origin: string; source: unknown; data: unknown }) => channel.handle(event),
    reconnect,
  };
}
