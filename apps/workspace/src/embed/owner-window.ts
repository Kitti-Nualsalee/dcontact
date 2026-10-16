import {
  parseDphoneMessage,
  type DphoneToHostMessage,
  type HostToDphoneMessage,
} from '@d-contact/dphone-embed';
import { appI18n } from '../i18n/index.js';
import { mountRuntime } from './embedded-runtime-window.js';
import { HostChannel } from './host-channel.js';
import { OwnerConnection, type OwnerIdentity } from './owner-connection.js';
import { lockHostOrigin, type EmbedConfig, type HostOriginLock } from './origin-lock.js';

declare global {
  interface Window {
    __dphoneController?: Readonly<OwnerIdentity & { connectionId: string }>;
    __dphoneOwner?: Readonly<OwnerIdentity & { host: Window }>;
  }
}

const CHANNEL = 'dphone.owner.v1';

function envelope(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;
  if (message.channel !== CHANNEL || typeof message.kind !== 'string') return null;
  const fields =
    message.kind === 'probe'
      ? ['channel', 'kind']
      : ['attached', 'pulse', 'revoked', 'detach'].includes(message.kind)
        ? ['channel', 'kind', 'connectionId']
        : ['event', 'command'].includes(message.kind)
          ? ['channel', 'kind', 'connectionId', 'message']
          : null;
  if (
    !fields ||
    Object.keys(message).length !== fields.length ||
    !fields.every((field) => Object.hasOwn(message, field))
  )
    return null;
  if (
    message.kind !== 'probe' &&
    (typeof message.connectionId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(message.connectionId))
  )
    return null;
  return message;
}

function matches(left: OwnerIdentity | undefined, right: OwnerIdentity): boolean {
  return left?.tenant === right.tenant && left.hostOrigin === right.hostOrigin;
}

export function mountOwnerController(config: EmbedConfig, lock: HostOriginLock): void {
  if (!config.tenant || !config.auth) return;
  const identity = Object.freeze({ tenant: config.tenant, hostOrigin: lock.origin });
  const connectionId = crypto.randomUUID();
  Object.defineProperty(window, '__dphoneController', {
    value: Object.freeze({ ...identity, connectionId }),
  });
  let owner: Window | null = null;
  let connected = false;
  let lastPulse = 0;
  const root = document.getElementById('dphone-embed-root');
  if (!root) return;
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const open = document.createElement('button');
  open.type = 'button';
  const text = appI18n.getFixedT(null, 'dphone');
  open.textContent = text('embedOwner.open');
  status.textContent = text('embedOwner.waiting');
  root.append(status, open);
  const forward = (message: HostToDphoneMessage) => {
    if (!connected || !owner || owner.closed || lock.revoked) return false;
    owner.postMessage(
      { channel: CHANNEL, kind: 'command', connectionId, message },
      location.origin,
    );
    return true;
  };
  const host = new HostChannel({
    lock,
    host: window.parent,
    now: () => Date.now(),
    onCall: (message) => {
      if (!forward(message))
        host.send({
          v: 1,
          type: 'dphone.call.result',
          requestId: message.requestId,
          status: 'unavailable',
          blocked: true,
          reasonCode: 'PHONE_NOT_READY',
        });
    },
    onActivityAck: (interactionId) => forward({ v: 1, type: 'dphone.activity.ack', interactionId }),
  });
  window.addEventListener('message', (event) => {
    if (lock.accepts(event)) {
      host.handle(event);
      return;
    }
    if (event.origin !== location.origin || !event.source) return;
    const message = envelope(event.data);
    if (!message) return;
    const candidate = event.source as Window;
    try {
      if (
        !matches(candidate.__dphoneOwner, identity) ||
        candidate.__dphoneOwner?.host !== window.top ||
        candidate.parent !== candidate
      )
        return;
    } catch {
      return;
    }
    if (message.kind === 'probe' && !lock.revoked) {
      if (owner && !owner.closed && owner !== candidate) return;
      owner = candidate;
      candidate.postMessage(
        { v: 1, type: 'dphone.owner.attach', ...identity, connectionId },
        location.origin,
      );
      return;
    }
    if (candidate !== owner || message.connectionId !== connectionId) return;
    if (message.kind === 'revoked') {
      lock.revoke(identity.hostOrigin);
      connected = false;
      status.textContent = text('embedOwner.revoked');
      return;
    }
    if (lock.revoked) return;
    if (message.kind === 'attached' || message.kind === 'pulse') {
      connected = true;
      lastPulse = Date.now();
      status.textContent = text('embedOwner.connected');
    }
    if (message.kind === 'event' && connected) {
      const outgoing = parseDphoneMessage(message.message);
      if (outgoing) host.send(outgoing);
    }
  });
  open.addEventListener('click', () => {
    if (lock.revoked) return;
    if (owner && !owner.closed) {
      owner.focus();
      return;
    }
    const url = new URL(location.href);
    url.searchParams.set('owner', '1');
    owner = window.open(url.href, '_blank', 'popup,width=460,height=780');
    status.textContent = text(owner ? 'embedOwner.connecting' : 'embedOwner.blocked');
  });
  const timer = window.setInterval(() => {
    if (connected && (!owner || owner.closed || Date.now() - lastPulse > 4_000)) {
      connected = false;
      status.textContent = text('embedOwner.disconnected');
    }
  }, 1_000);
  window.addEventListener('pagehide', () => {
    window.clearInterval(timer);
    if (owner && !owner.closed)
      owner.postMessage({ channel: CHANNEL, kind: 'detach', connectionId }, location.origin);
  });
  const level = config.screenPopLevels?.[lock.origin] ?? 'off';
  host.ready({ screenPop: level !== 'off', clickToCall: true, activity: true }, level);
}

export function mountOwner(config: EmbedConfig): void {
  if (new URL(location.href).searchParams.get('owner') !== '1' || !config.tenant || !config.auth)
    return;
  let initial: Window;
  let host: Window;
  let identity: OwnerIdentity;
  try {
    initial = window.opener;
    if (!initial || initial.location.origin !== location.origin || !initial.__dphoneController)
      return;
    identity = {
      tenant: initial.__dphoneController.tenant,
      hostOrigin: initial.__dphoneController.hostOrigin,
    };
    if (
      identity.tenant !== config.tenant ||
      !config.allowedHostOrigins.includes(identity.hostOrigin)
    )
      return;
    host = initial.top!;
    if (host === initial) return;
  } catch {
    return;
  }
  Object.defineProperty(window, '__dphoneOwner', { value: Object.freeze({ ...identity, host }) });
  let controller: Window | null = null;
  let connectionId = '';
  let runtime: ReturnType<typeof mountRuntime> = null;
  const validController = (source: Window, expectedId?: string) => {
    try {
      return (
        !source.closed &&
        source !== host &&
        source.top === host &&
        source.location.origin === location.origin &&
        matches(source.__dphoneController, identity) &&
        (!expectedId || source.__dphoneController?.connectionId === expectedId)
      );
    } catch {
      return false;
    }
  };
  const connection = new OwnerConnection({
    identity,
    dphoneOrigin: location.origin,
    authorize: async (source, _identity, expectedId) => {
      if (!validController(source as Window, expectedId)) return false;
      const url = new URL('/dphone/embed/owner-policy', location.origin);
      url.searchParams.set('tenant', identity.tenant);
      url.searchParams.set('hostOrigin', identity.hostOrigin);
      const response = await fetch(url, {
        cache: 'no-store',
        credentials: 'omit',
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return false;
      const policy: unknown = await response.json();
      return Boolean(
        policy &&
        typeof policy === 'object' &&
        'allowed' in policy &&
        policy.allowed === true &&
        validController(source as Window, expectedId),
      );
    },
  });
  const send = (kind: string, message?: DphoneToHostMessage) => {
    if (
      !controller ||
      !validController(controller, connectionId) ||
      !connection.accepts({ origin: location.origin, source: controller, connectionId })
    )
      return;
    controller.postMessage(
      { channel: CHANNEL, kind, connectionId, ...(message ? { message } : {}) },
      location.origin,
    );
  };
  const virtualHost = {
    postMessage: (message: unknown) => {
      const outgoing = parseDphoneMessage(message);
      if (outgoing) send('event', outgoing);
    },
  };
  const lock = lockHostOrigin(config, identity.hostOrigin, virtualHost)!;
  const revoke = lock.revoke;
  lock.revoke = (origin) => {
    if (origin === identity.hostOrigin && !lock.revoked) {
      send('revoked');
      connection.revoke();
    }
    return revoke(origin);
  };
  window.addEventListener('message', async (event) => {
    if (event.origin !== location.origin || !event.source || lock.revoked) return;
    const source = event.source as Window;
    const incoming = envelope(event.data);
    if (incoming?.kind === 'detach' && typeof incoming.connectionId === 'string') {
      connection.detach(source, incoming.connectionId);
      if (controller === source && connectionId === incoming.connectionId) controller = null;
      return;
    }
    if (!validController(source)) return;
    if (event.data?.type === 'dphone.owner.attach') {
      if (!(await connection.attach({ origin: event.origin, source, data: event.data }))) return;
      controller = source;
      connectionId = event.data.connectionId;
      send('attached');
      runtime ??= mountRuntime(config, lock, virtualHost);
      document.documentElement.dataset.embedState = 'owner';
      runtime?.reconnect();
      return;
    }
    const message = incoming;
    if (
      !message ||
      typeof message.connectionId !== 'string' ||
      !validController(source, message.connectionId) ||
      !connection.accepts({ origin: event.origin, source, connectionId: message.connectionId })
    )
      return;
    if (message.kind === 'command')
      runtime?.receive({ origin: identity.hostOrigin, source: virtualHost, data: message.message });
  });
  const probe = () => {
    if (lock.revoked) return;
    if (connection.pending) return;
    if (
      controller &&
      validController(controller, connectionId) &&
      connection.accepts({ origin: location.origin, source: controller, connectionId })
    ) {
      send('pulse');
      return;
    }
    if (controller) connection.detach(controller);
    controller = null;
    try {
      const pending = [host];
      let inspected = 0;
      while (pending.length && inspected < 256) {
        const parent = pending.shift()!;
        inspected += 1;
        for (let index = 0; index < parent.frames.length && pending.length < 256; index += 1) {
          const candidate = parent.frames[index];
          if (!candidate) continue;
          if (validController(candidate))
            candidate.postMessage({ channel: CHANNEL, kind: 'probe' }, location.origin);
          else pending.push(candidate);
        }
      }
    } catch {}
  };
  probe();
  const timer = window.setInterval(probe, 1_000);
  window.addEventListener('pagehide', () => window.clearInterval(timer));
  window.addEventListener('beforeunload', (event) => {
    event.preventDefault();
    event.returnValue = '';
  });
}
