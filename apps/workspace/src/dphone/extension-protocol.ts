import type { SipCredentialLease } from './dphone.js';

export const PORT_NAME = 'dcontact.dphone.v1';
const commands = ['register', 'unregister'] as const;
const callCommands = ['accept', 'reject', 'hangup'] as const;
const events = ['registrationLost', 'autoplayBlocked'] as const;
const callEvents = ['invitation', 'established', 'terminated'] as const;

export type ExtensionRequest =
  | { type: 'request'; id: number; command: 'configure'; lease: SipCredentialLease }
  | { type: 'request'; id: number; command: (typeof commands)[number] }
  | { type: 'request'; id: number; command: (typeof callCommands)[number]; callId: number };
export type ExtensionMessage =
  | { type: 'ready' }
  | { type: 'reply'; id: number; ok: boolean }
  | { type: 'event'; event: (typeof events)[number] }
  | { type: 'event'; event: (typeof callEvents)[number]; callId: number };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function nonempty(value: unknown, max = 256): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}
function requestId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function validSocket(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return false;
    return (
      url.protocol === 'wss:' ||
      (url.protocol === 'ws:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    );
  } catch {
    return false;
  }
}
function parseLease(value: unknown): SipCredentialLease | undefined {
  if (!record(value)) return;
  const {
    leaseId,
    extension,
    authorizationUsername,
    authorizationPassword,
    sipDomain,
    wssUrl,
    telephonyNodeId,
    iceServers,
    expiresAt,
  } = value;
  if (
    !nonempty(leaseId, 36) ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(leaseId) ||
    !nonempty(extension, 64) ||
    !/^[a-z0-9_.+*-]+$/i.test(extension) ||
    !nonempty(authorizationUsername) ||
    !nonempty(authorizationPassword, 1024) ||
    !nonempty(sipDomain) ||
    !/^[a-z0-9][a-z0-9.-]*$/i.test(sipDomain) ||
    !nonempty(wssUrl, 2048) ||
    !validSocket(wssUrl) ||
    !nonempty(telephonyNodeId) ||
    !nonempty(expiresAt, 64) ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    Date.parse(expiresAt) <= Date.now() ||
    !Array.isArray(iceServers) ||
    iceServers.length > 16
  )
    return;
  const parsedIce: SipCredentialLease['iceServers'] = [];
  for (const item of iceServers) {
    if (!record(item)) return;
    const { urls, username, credential } = item;
    if (
      !Array.isArray(urls) ||
      urls.length === 0 ||
      urls.length > 16 ||
      !urls.every((url) => nonempty(url, 2048) && /^(?:stun|stuns|turn|turns):/i.test(url)) ||
      (username !== undefined && !nonempty(username, 1024)) ||
      (credential !== undefined && !nonempty(credential, 1024))
    )
      return;
    parsedIce.push({
      urls,
      ...(username === undefined ? {} : { username }),
      ...(credential === undefined ? {} : { credential }),
    });
  }
  return {
    leaseId,
    extension,
    authorizationUsername,
    authorizationPassword,
    sipDomain,
    wssUrl,
    telephonyNodeId,
    iceServers: parsedIce,
    expiresAt,
  };
}

export function parseExtensionRequest(value: unknown): ExtensionRequest | undefined {
  if (!record(value) || value.type !== 'request' || !requestId(value.id)) return;
  if (value.command === 'configure') {
    const lease = parseLease(value.lease);
    return lease ? { type: 'request', id: value.id, command: 'configure', lease } : undefined;
  }
  const command = commands.find((item) => item === value.command);
  if (command) return { type: 'request', id: value.id, command };
  const callCommand = callCommands.find((item) => item === value.command);
  if (callCommand && requestId(value.callId))
    return { type: 'request', id: value.id, command: callCommand, callId: value.callId };
}

export function parseExtensionMessage(value: unknown): ExtensionMessage | undefined {
  if (!record(value)) return;
  if (value.type === 'ready') return { type: 'ready' };
  if (value.type === 'reply' && requestId(value.id) && typeof value.ok === 'boolean')
    return { type: 'reply', id: value.id, ok: value.ok };
  if (value.type === 'event') {
    const event = events.find((item) => item === value.event);
    if (event) return { type: 'event', event };
    const callEvent = callEvents.find((item) => item === value.event);
    if (callEvent && requestId(value.callId))
      return { type: 'event', event: callEvent, callId: value.callId };
  }
}
