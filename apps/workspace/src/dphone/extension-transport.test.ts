import assert from 'node:assert/strict';
import test from 'node:test';
import type { SipCredentialLease } from './dphone.js';
import {
  parseExtensionMessage,
  parseExtensionRequest,
  type ExtensionRequest,
} from './extension-protocol.js';
import { DPhoneExtensionTransport, type ExtensionPort } from './extension-transport.js';

const lease: SipCredentialLease = {
  leaseId: '12345678-1234-4123-8123-123456789abc',
  extension: '1000',
  authorizationUsername: '1000',
  authorizationPassword: 'ephemeral',
  sipDomain: 'trial.test',
  wssUrl: 'ws://localhost:5066',
  telephonyNodeId: 'trial',
  iceServers: [],
  expiresAt: '2099-01-01T00:00:00.000Z',
};

function portFixture() {
  let receive: ((data: unknown) => void) | undefined;
  let disconnect: (() => void) | undefined;
  const requests: ExtensionRequest[] = [];
  const port: ExtensionPort = {
    postMessage: (message) => {
      requests.push(message);
    },
    disconnect: () => disconnect?.(),
    onMessage: {
      addListener: (listener) => {
        receive = listener;
      },
    },
    onDisconnect: {
      addListener: (listener) => {
        disconnect = listener;
      },
    },
  };
  const emit = (value: unknown) => receive?.(value);
  return {
    port,
    requests,
    emit,
    reply: (id: number, ok = true) => emit({ type: 'reply', id, ok }),
  };
}

test('control requests accept a lease for WSS or loopback WS and reject expired or unsafe data', () => {
  const configure = { type: 'request', id: 1, command: 'configure', lease };
  assert.deepEqual(parseExtensionRequest(configure), configure);
  for (const wssUrl of [
    'ws://remote.test',
    'https://remote.test',
    'wss://user:secret@remote.test',
  ]) {
    assert.equal(parseExtensionRequest({ ...configure, lease: { ...lease, wssUrl } }), undefined);
  }
  assert.equal(
    parseExtensionRequest({ ...configure, lease: { ...lease, expiresAt: '2020-01-01' } }),
    undefined,
  );
  assert.equal(parseExtensionRequest({ type: 'request', id: 1, command: 'dial' }), undefined);
  assert.equal(parseExtensionMessage({ type: 'event', event: 'WRAPUP' }), undefined);
});

test('D-Phone handshake, command replies and call events use the same port', async () => {
  const { port, requests, emit, reply } = portFixture();
  const events: string[] = [];
  const phone = new DPhoneExtensionTransport(() => port, {
    onInvitation: () => events.push('incoming'),
    onSessionEstablished: () => events.push('answered'),
    onSessionTerminated: () => events.push('ended'),
    onControlDisconnected: () => events.push('disconnected'),
  });
  const configuring = phone.configure(lease);
  assert.equal(requests.length, 0);
  emit({ type: 'ready' });
  await Promise.resolve();
  reply(1);
  await configuring;
  const registering = phone.register();
  reply(2);
  await registering;
  emit({ type: 'event', event: 'invitation', callId: 1 });
  emit({ type: 'event', event: 'terminated', callId: 2 });
  const answering = phone.accept();
  emit({ type: 'event', event: 'established', callId: 1 });
  reply(3);
  await answering;
  const ending = phone.hangup();
  emit({ type: 'event', event: 'terminated', callId: 1 });
  reply(4);
  await ending;
  const stopping = phone.unregister();
  reply(5);
  await stopping;
  assert.deepEqual(
    requests.map(({ command }) => command),
    ['configure', 'register', 'accept', 'hangup', 'unregister'],
  );
  assert.deepEqual(events, ['incoming', 'answered', 'ended']);
  assert.deepEqual(
    requests.filter((request) => 'callId' in request).map((request) => request.callId),
    [1, 1],
  );
});

test('unexpected port loss rejects pending calls and invalidates the controller', async () => {
  const { port, emit, reply } = portFixture();
  let disconnected = 0;
  const phone = new DPhoneExtensionTransport(() => port, {
    onControlDisconnected: () => disconnected++,
  });
  const configuring = phone.configure(lease);
  emit({ type: 'ready' });
  await Promise.resolve();
  reply(1);
  await configuring;
  const registering = phone.register();
  port.disconnect();
  await assert.rejects(registering, /disconnected/);
  await assert.rejects(phone.accept(), /no current call/);
  assert.equal(disconnected, 1);
});
