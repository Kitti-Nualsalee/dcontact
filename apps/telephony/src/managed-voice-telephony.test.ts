import assert from 'node:assert/strict';
import test from 'node:test';
import type { ManagedVoiceEvent } from '@d-contact/router';
import type { FreeSwitchEvent } from './freeswitch-normalizer.js';
import {
  isManagedOfferLeg,
  isManagedVoiceEnabled,
  KeyedSerialQueue,
  managedEventKey,
  routeManagedCall,
  routeManagedOfferLeg,
  TenantSipDomainDirectory,
  type ManagedVoiceRouting,
} from './managed-voice-telephony.js';

const tenantA = 'c0000000-0000-4000-8000-00000000000a';
const tenantB = 'c0000000-0000-4000-8000-00000000000b';
const caller = 'c0000000-0000-4000-8000-000000000001';
const bleg = 'c0000000-0000-4000-8000-000000000002';
const offerId = 'c0000000-0000-4000-8000-000000000003';
const agentId = 'c0000000-0000-4000-8000-000000000004';

function routing(managedDestinations: Record<string, string[]> = {}) {
  const handled: ManagedVoiceEvent[] = [];
  const errors: unknown[] = [];
  const calls = new Set<string>();
  const value: ManagedVoiceRouting & { handled: ManagedVoiceEvent[]; errors: unknown[] } = {
    nodeId: 'fs-local',
    calls,
    handled,
    errors,
    handle: async (event) => {
      handled.push(event);
      if (event.type === 'call.created')
        return managedDestinations[event.tenantId]?.includes(event.destination ?? '')
          ? { interactionId: 'i', status: 'QUEUED' }
          : null;
      return calls.has(event.callUuid) ? { interactionId: 'i', status: 'ACTIVE' } : null;
    },
    onError: (error) => errors.push(error),
  };
  return value;
}

function parked(destination: string, extra: FreeSwitchEvent = {}): FreeSwitchEvent {
  return {
    'Event-Name': 'CHANNEL_CREATE',
    'Unique-ID': caller,
    'Caller-Destination-Number': destination,
    'Caller-Caller-ID-Number': '0811111111',
    variable_domain_name: 'alpha.tenants.test',
    ...extra,
  };
}

test('the flag is off by default and enabled only by exactly true', () => {
  assert.equal(isManagedVoiceEnabled({}), false);
  assert.equal(isManagedVoiceEnabled({ TELEPHONY_MANAGED_VOICE_ENABLED: '1' }), false);
  assert.equal(isManagedVoiceEnabled({ TELEPHONY_MANAGED_VOICE_ENABLED: 'TRUE' }), false);
  assert.equal(isManagedVoiceEnabled({ TELEPHONY_MANAGED_VOICE_ENABLED: 'true' }), true);
});

test('a call to a number of a managed queue goes to the managed runtime and later events do not leak to legacy', async () => {
  const route = routing({ [tenantA]: ['2000'] });
  assert.equal(await routeManagedCall(parked('2000'), tenantA, route), 'managed');
  assert.equal(route.handled[0].type, 'call.created');
  assert.equal(route.handled[0].tenantId, tenantA);
  assert.equal(route.handled[0].destination, '2000');
  assert.equal(route.calls.has(caller), true);
  // DTMF/ANSWER of a managed call that the runtime does not use must not be sent to the legacy router
  assert.equal(
    await routeManagedCall({ 'Event-Name': 'DTMF', 'Unique-ID': caller }, tenantA, route),
    'ignored',
  );
  assert.equal(
    await routeManagedCall(
      { 'Event-Name': 'CHANNEL_HANGUP_COMPLETE', 'Unique-ID': caller },
      tenantA,
      route,
    ),
    'managed',
  );
  assert.equal(route.calls.has(caller), false);
});

test('a legacy queue (not accepted by the runtime) goes back to the legacy router as before', async () => {
  const route = routing({ [tenantA]: ['2000'] });
  assert.equal(await routeManagedCall(parked('2001'), tenantA, route), 'legacy');
  // Another tenant with the same number not bound to a managed queue remains legacy
  assert.equal(await routeManagedCall(parked('2000'), tenantB, route), 'legacy');
  assert.equal(route.calls.size, 0);
  for (const name of ['CHANNEL_BRIDGE', 'CHANNEL_HANGUP_COMPLETE', 'DTMF', 'DETECTED_SPEECH'])
    assert.equal(
      await routeManagedCall(
        { 'Event-Name': name, 'Unique-ID': caller, 'Bridge-A-Unique-ID': caller },
        tenantA,
        route,
      ),
      'legacy',
    );
});

test('a CHANNEL_ANSWER that exists because managed subscribed is not sent to legacy', async () => {
  const route = routing();
  assert.equal(
    await routeManagedCall({ 'Event-Name': 'CHANNEL_ANSWER', 'Unique-ID': caller }, tenantA, route),
    'ignored',
  );
});

test('outbound delivery never goes through the managed runtime', async () => {
  const route = routing({ [tenantA]: ['2000'] });
  assert.equal(
    await routeManagedCall(
      parked('2000', { variable_dcontact_delivery_id: 'delivery-1' }),
      tenantA,
      route,
    ),
    'legacy',
  );
  assert.equal(route.handled.length, 0);
});

test('managed runtime fails: an unknown call continues on legacy, a managed call does not leak to legacy', async () => {
  const route = routing();
  route.handle = async () => {
    throw new Error('database unavailable');
  };
  assert.equal(await routeManagedCall(parked('2001'), tenantA, route), 'legacy');
  route.calls.add(caller);
  assert.equal(
    await routeManagedCall(
      { 'Event-Name': 'CHANNEL_HANGUP_COMPLETE', 'Unique-ID': caller },
      tenantA,
      route,
    ),
    'ignored',
  );
  // call.created fails twice (first attempt + retry) and one more for hangup
  assert.equal(route.errors.length, 3);
  // A channel already bound to another tenant: normalize rejects it and does not pass it across tenants to managed
  const mismatch = routing({ [tenantA]: ['2000'] });
  assert.equal(
    await routeManagedCall(
      parked('2000', { variable_dcontact_tenant_id: tenantB }),
      tenantA,
      mismatch,
    ),
    'legacy',
  );
  assert.equal(mismatch.handled.length, 0);
  assert.match(String(mismatch.errors[0]), /MANAGED_VOICE_EVENT_TENANT_MISMATCH/);
});

test('a new call whose runtime fails twice is hung up when its destination is managed, otherwise it stays legacy', async () => {
  const rejected: ManagedVoiceEvent[] = [];
  const route = routing();
  route.handle = async () => {
    throw new Error('database unavailable');
  };
  route.rejectFailedCall = async (event) => {
    rejected.push(event);
    return event.destination === '2000';
  };
  // Managed destination: the caller is hung up and nothing goes to legacy
  assert.equal(await routeManagedCall(parked('2000'), tenantA, route), 'ignored');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].type, 'call.created');
  assert.equal(rejected[0].callUuid, caller);
  assert.equal(route.calls.size, 0);
  // Later events of the rejected call are ignored: a PARK turned into CREATE must not reach the runtime or legacy again
  route.rejected = new Set();
  rejected.length = 0;
  assert.equal(await routeManagedCall(parked('2000'), tenantA, route), 'ignored');
  assert.deepEqual([...route.rejected], [caller]);
  const handledBefore = route.handled.length;
  assert.equal(await routeManagedCall(parked('2000'), tenantA, route), 'ignored');
  assert.equal(rejected.length, 1);
  assert.equal(route.handled.length, handledBefore);
  assert.equal(
    await routeManagedCall(
      { 'Event-Name': 'CHANNEL_HANGUP_COMPLETE', 'Unique-ID': caller },
      tenantA,
      route,
    ),
    'ignored',
  );
  assert.equal(route.rejected.size, 0);
  // Legacy destination: kept on legacy as before
  assert.equal(await routeManagedCall(parked('2001'), tenantA, route), 'legacy');
  // The check itself fails (e.g. the database is down for both): fall back to legacy and report the error
  route.rejectFailedCall = async () => {
    throw new Error('lookup failed');
  };
  const errors = route.errors.length;
  assert.equal(await routeManagedCall(parked('2000'), tenantA, route), 'legacy');
  assert.match(String(route.errors.at(-1)), /lookup failed/);
  assert.equal(route.errors.length, errors + 3);
  // Only new calls are checked: a later event of an unknown call still goes to legacy without a lookup
  rejected.length = 0;
  route.rejectFailedCall = async (event) => {
    rejected.push(event);
    return true;
  };
  assert.equal(
    await routeManagedCall(
      { 'Event-Name': 'CHANNEL_HANGUP_COMPLETE', 'Unique-ID': caller },
      tenantA,
      route,
    ),
    'legacy',
  );
  assert.equal(rejected.length, 0);
});

test('a B-leg with an offer goes to the managed runtime of the tenant on the channel, and a caller hangup after bridge closes the call', async () => {
  const route = routing();
  route.calls.add(caller);
  const answered: FreeSwitchEvent = {
    'Event-Name': 'CHANNEL_ANSWER',
    'Unique-ID': bleg,
    variable_dcontact_tenant_id: tenantB,
    variable_dcontact_node_id: 'fs-local',
    variable_dcontact_call_uuid: caller,
    variable_dcontact_offer_id: offerId,
    variable_dcontact_agent_id: agentId,
    variable_dcontact_bleg_uuid: bleg,
  };
  assert.equal(isManagedOfferLeg(answered), true);
  assert.equal(await routeManagedOfferLeg(answered, route), 'managed');
  assert.deepEqual(route.handled[0], {
    tenantId: tenantB,
    telephonyNodeId: 'fs-local',
    callUuid: caller,
    type: 'call.answered',
    offerId,
    agentId,
    blegUuid: bleg,
  });
  // A B-leg hangup does not yet close the customer call
  await routeManagedOfferLeg({ ...answered, 'Event-Name': 'CHANNEL_HANGUP_COMPLETE' }, route);
  assert.equal(route.calls.has(caller), true);
  await routeManagedOfferLeg(
    { ...answered, 'Event-Name': 'CHANNEL_HANGUP_COMPLETE', 'Unique-ID': caller },
    route,
  );
  assert.equal(route.calls.has(caller), false);
});

test('an offer leg without a tenant or with a mismatched node is not processed', async () => {
  const route = routing();
  const offer: FreeSwitchEvent = {
    'Event-Name': 'CHANNEL_ANSWER',
    'Unique-ID': bleg,
    variable_dcontact_offer_id: offerId,
  };
  assert.equal(await routeManagedOfferLeg(offer, route), 'ignored');
  await assert.rejects(
    routeManagedOfferLeg(
      { ...offer, variable_dcontact_tenant_id: tenantA, variable_dcontact_node_id: 'fs-other' },
      route,
    ),
    /MANAGED_VOICE_EVENT_NODE_MISMATCH/,
  );
  assert.equal(route.handled.length, 0);
  assert.equal(isManagedOfferLeg(parked('2000')), false);
});

test('TenantSipDomainDirectory uses the SIP domain of each ACTIVE tenant and caches per TTL', async () => {
  let now = 0;
  let findUnique = 0;
  const rows = [
    { id: tenantA, sipDomain: 'alpha.tenants.test', lifecycleStatus: 'ACTIVE' },
    { id: tenantB, sipDomain: 'beta.tenants.test', lifecycleStatus: 'SUSPENDED' },
  ];
  const directory = new TenantSipDomainDirectory(
    {
      tenant: {
        findMany: async () =>
          rows
            .filter((row) => row.lifecycleStatus === 'ACTIVE')
            .map(({ id, sipDomain }) => ({ id, sipDomain })),
        findUnique: async ({ where }) => {
          findUnique++;
          return rows.find((row) => row.id === where.id) ?? null;
        },
      },
    },
    1_000,
    () => now,
  );
  assert.deepEqual(await directory.activeTenantIds(), [tenantA]);
  assert.equal(await directory.sipDomain(tenantA), 'alpha.tenants.test');
  assert.equal(findUnique, 0);
  assert.equal(await directory.sipDomain(tenantB), undefined);
  // A suspended tenant can still have channels checked so cleanup commands of stuck calls work, but cannot originate
  assert.equal(await directory.sipDomain(tenantB, 'bind'), 'beta.tenants.test');
  assert.equal(await directory.sipDomain(tenantB, 'originate'), undefined);
  assert.equal(await directory.sipDomain('not-a-uuid'), undefined);
  assert.equal(findUnique, 1);
  rows[0].sipDomain = 'alpha2.tenants.test';
  assert.equal(await directory.sipDomain(tenantA), 'alpha.tenants.test');
  now = 1_001;
  assert.equal(await directory.sipDomain(tenantA), 'alpha2.tenants.test');
});

test('a new call whose runtime fails temporarily is retried once before going back to legacy', async () => {
  const route = routing({ [tenantA]: ['2000'] });
  const handle = route.handle;
  let failures = 1;
  route.handle = async (event) => {
    if (failures-- > 0) throw new Error('serialization failure');
    return handle(event);
  };
  assert.equal(await routeManagedCall(parked('2000'), tenantA, route), 'managed');
  assert.equal(route.calls.has(caller), true);
  assert.equal(route.errors.length, 1);
});

test('a hangup whose processing fails still removes the call from the set managed holds (no leak)', async () => {
  const route = routing();
  route.calls.add(caller);
  route.handle = async () => {
    throw new Error('database unavailable');
  };
  assert.equal(
    await routeManagedCall(
      { 'Event-Name': 'CHANNEL_HANGUP_COMPLETE', 'Unique-ID': caller },
      tenantA,
      route,
    ),
    'ignored',
  );
  assert.equal(route.calls.has(caller), false);
  route.calls.add(caller);
  await assert.rejects(
    routeManagedOfferLeg(
      {
        'Event-Name': 'CHANNEL_HANGUP_COMPLETE',
        'Unique-ID': caller,
        variable_dcontact_tenant_id: tenantA,
        variable_dcontact_call_uuid: caller,
        variable_dcontact_offer_id: offerId,
      },
      route,
    ),
  );
  assert.equal(route.calls.has(caller), false);
});

test('managedEventKey: the managed Agent leg uses the same key as the customer call', () => {
  assert.equal(managedEventKey(undefined), 'control');
  assert.equal(managedEventKey({ 'Event-Name': 'BACKGROUND_JOB' }), 'background-job');
  assert.equal(managedEventKey({ 'Event-Name': 'CHANNEL_CREATE', 'Unique-ID': caller }), caller);
  assert.equal(
    managedEventKey({
      'Event-Name': 'CHANNEL_ANSWER',
      'Unique-ID': bleg,
      variable_dcontact_call_uuid: caller,
    }),
    caller,
  );
  assert.equal(
    managedEventKey({
      'Event-Name': 'CHANNEL_BRIDGE',
      'Unique-ID': bleg,
      'Bridge-A-Unique-ID': caller,
    }),
    caller,
  );
});

test('KeyedSerialQueue orders work within the same call, but a slow call does not block other calls', async () => {
  const order: string[] = [];
  const errors: unknown[] = [];
  const queue = new KeyedSerialQueue((error) => errors.push(error));
  let releaseSlow!: () => void;
  const slow = new Promise<void>((resolve) => (releaseSlow = resolve));
  const legacy = queue.run('legacy-call', async () => {
    order.push('legacy:hangup-start');
    await slow; // e.g. a slow audio archive upload to S3
    order.push('legacy:hangup-end');
  });
  const legacyNext = queue.run('legacy-call', async () => {
    order.push('legacy:next');
  });
  await queue.run('managed-call', async () => {
    order.push('managed:created');
  });
  await queue.run('managed-call', async () => {
    throw new Error('ignored event');
  });
  await queue.run('managed-call', async () => {
    order.push('managed:answered');
  });
  assert.deepEqual(order, ['legacy:hangup-start', 'managed:created', 'managed:answered']);
  releaseSlow();
  await Promise.all([legacy, legacyNext]);
  assert.deepEqual(order.slice(3), ['legacy:hangup-end', 'legacy:next']);
  assert.equal(errors.length, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queue.size, 0);
});
