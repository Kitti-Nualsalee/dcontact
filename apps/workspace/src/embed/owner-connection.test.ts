import assert from 'node:assert/strict';
import test from 'node:test';
import { OwnerConnection, type ControllerWindow } from './owner-connection.js';

const identity = { tenant: 'demo', hostOrigin: 'https://crm.example.test' };
const origin = 'https://dphone.example.test';
const connectionId = 'a29f24fe-2fd6-4289-a6c9-034ac532efd2';
const source: ControllerWindow = { postMessage() {} };
const replacement: ControllerWindow = { postMessage() {} };
const request = {
  v: 1,
  type: 'dphone.owner.attach',
  ...identity,
  connectionId,
};
const event = { origin, source, data: request };
const command = { origin, source, connectionId };

function connection(authorize = async () => true) {
  return new OwnerConnection({ identity, dphoneOrigin: origin, authorize });
}

test('a connection must get authorization before accepting commands, and binds origin/source/id on every message', async () => {
  const owner = connection();
  assert.equal(owner.accepts(command), false);
  assert.equal(await owner.attach(event), true);
  assert.equal(owner.accepts(command), true);
  assert.equal(owner.accepts({ ...command, source: replacement }), false);
  assert.equal(owner.accepts({ ...command, origin: identity.hostOrigin }), false);
  assert.equal(owner.accepts({ ...command, connectionId: 'stale' }), false);
});

test('reject a wrong schema/tenant/host/origin/source before calling authorization', async () => {
  let checks = 0;
  const owner = connection(async () => {
    checks += 1;
    return true;
  });
  for (const data of [
    null,
    [],
    {},
    { ...request, v: 2 },
    { ...request, tenant: 'other' },
    { ...request, hostOrigin: 'https://other.example.test' },
    { ...request, connectionId: 'invalid' },
    { ...request, token: 'unexpected' },
  ]) {
    assert.equal(await owner.attach({ ...event, data }), false);
  }
  assert.equal(await owner.attach({ ...event, source: null }), false);
  assert.equal(await owner.attach({ ...event, origin: identity.hostOrigin }), false);
  assert.equal(checks, 0);
});

test('authorization rejection or network error must fail closed', async () => {
  for (const authorize of [
    async () => false,
    async () => {
      throw new Error('offline');
    },
  ]) {
    const owner = connection(authorize);
    assert.equal(await owner.attach(event), false);
    assert.equal(owner.accepts(command), false);
  }
});

test('reattach re-checks authorization and the old controller cannot send commands', async () => {
  let checks = 0;
  const owner = connection(async () => {
    checks += 1;
    return true;
  });
  await owner.attach(event);
  await owner.attach({ ...event, source: replacement });
  assert.equal(checks, 2);
  assert.equal(owner.accepts(command), false);
  assert.equal(owner.accepts({ ...command, source: replacement }), true);
  owner.detach(source);
  assert.equal(owner.accepts({ ...command, source: replacement }), true);
});

test('a slow authorization answer must not return an old connection over a new one', async () => {
  let complete!: (allowed: boolean) => void;
  let checks = 0;
  const owner = connection(() => {
    checks += 1;
    return checks === 1
      ? new Promise<boolean>((resolve) => {
          complete = resolve;
        })
      : Promise.resolve(true);
  });
  const pending = owner.attach(event);
  assert.equal(await owner.attach({ ...event, source: replacement }), true);
  complete(true);
  assert.equal(await pending, false);
  assert.equal(owner.accepts(command), false);
  assert.equal(owner.accepts({ ...command, source: replacement }), true);
});

test('revoke while awaiting authorization returns no connection and does not cut media through this module', async () => {
  let complete!: (allowed: boolean) => void;
  const owner = connection(
    () =>
      new Promise<boolean>((resolve) => {
        complete = resolve;
      }),
  );
  const pending = owner.attach(event);
  owner.revoke();
  complete(true);
  assert.equal(await pending, false);
  assert.equal(owner.accepts(command), false);
  assert.equal(await owner.attach(event), false);
});

test('detach of the current controller closes only the connection', async () => {
  const owner = connection();
  await owner.attach(event);
  owner.detach(source);
  assert.equal(owner.accepts(command), false);
  assert.equal(await owner.attach(event), true);
});

test('detach while awaiting authorization must not accept a controller that already closed', async () => {
  let complete!: (allowed: boolean) => void;
  const owner = connection(
    () =>
      new Promise<boolean>((resolve) => {
        complete = resolve;
      }),
  );
  const pending = owner.attach(event);
  owner.detach(source);
  complete(true);
  assert.equal(await pending, false);
  assert.equal(owner.accepts(command), false);
});

test('an old detach nonce of the same WindowProxy does not cancel a new connection', async () => {
  const owner = connection();
  await owner.attach(event);
  owner.detach(source, 'stale-document');
  assert.equal(owner.accepts(command), true);
  owner.detach(source, '');
  assert.equal(owner.accepts(command), true);
  owner.detach(source, connectionId);
  assert.equal(owner.accepts(command), false);
});
