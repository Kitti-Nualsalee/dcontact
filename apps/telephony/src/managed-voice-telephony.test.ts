import assert from 'node:assert/strict';
import test from 'node:test';
import type { ManagedVoiceEvent } from '@d-contact/router';
import type { FreeSwitchEvent } from './freeswitch-normalizer.js';
import {
  isManagedOfferLeg,
  isManagedVoiceEnabled,
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

test('flag ปิดโดยปริยาย เปิดเฉพาะค่า true ตรงตัว', () => {
  assert.equal(isManagedVoiceEnabled({}), false);
  assert.equal(isManagedVoiceEnabled({ TELEPHONY_MANAGED_VOICE_ENABLED: '1' }), false);
  assert.equal(isManagedVoiceEnabled({ TELEPHONY_MANAGED_VOICE_ENABLED: 'TRUE' }), false);
  assert.equal(isManagedVoiceEnabled({ TELEPHONY_MANAGED_VOICE_ENABLED: 'true' }), true);
});

test('สายเข้าเบอร์ของคิว managed ไป managed runtime และ event ต่อจากนั้นไม่หลุดไป legacy', async () => {
  const route = routing({ [tenantA]: ['2000'] });
  assert.equal(await routeManagedCall(parked('2000'), tenantA, route), 'managed');
  assert.equal(route.handled[0].type, 'call.created');
  assert.equal(route.handled[0].tenantId, tenantA);
  assert.equal(route.handled[0].destination, '2000');
  assert.equal(route.calls.has(caller), true);
  // DTMF/ANSWER ของสาย managed ที่ runtime ไม่ใช้ ต้องไม่ถูกส่งให้ legacy router
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

test('คิว legacy (runtime ไม่รับ) กลับไป legacy router ตามเดิม', async () => {
  const route = routing({ [tenantA]: ['2000'] });
  assert.equal(await routeManagedCall(parked('2001'), tenantA, route), 'legacy');
  // tenant อื่นที่เบอร์เดียวกันไม่ได้ผูกคิว managed ก็ยังเป็น legacy
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

test('CHANNEL_ANSWER ที่มีเพราะ managed subscribe ไม่ส่งให้ legacy', async () => {
  const route = routing();
  assert.equal(
    await routeManagedCall({ 'Event-Name': 'CHANNEL_ANSWER', 'Unique-ID': caller }, tenantA, route),
    'ignored',
  );
});

test('outbound delivery ไม่ผ่าน managed runtime เลย', async () => {
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

test('managed runtime ล้ม: สายที่ไม่รู้จักให้ legacy ทำต่อ สาย managed ไม่หลุดไป legacy', async () => {
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
  assert.equal(route.errors.length, 2);
  // ช่องสายที่ถูกผูก tenant อื่นไว้แล้ว: normalize ปฏิเสธและไม่ส่งข้าม tenant ให้ managed
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

test('B-leg ที่มี offer ไป managed ของ tenant บนช่องสาย และ caller hangup หลัง bridge ปิดสาย', async () => {
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
  // B-leg hangup ยังไม่ปิดสายของลูกค้า
  await routeManagedOfferLeg({ ...answered, 'Event-Name': 'CHANNEL_HANGUP_COMPLETE' }, route);
  assert.equal(route.calls.has(caller), true);
  await routeManagedOfferLeg(
    { ...answered, 'Event-Name': 'CHANNEL_HANGUP_COMPLETE', 'Unique-ID': caller },
    route,
  );
  assert.equal(route.calls.has(caller), false);
});

test('offer leg ที่ไม่มี tenant หรือ node ไม่ตรง ไม่ถูกประมวล', async () => {
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

test('TenantSipDomainDirectory ใช้ SIP domain ของแต่ละ tenant ที่ ACTIVE และแคชตาม TTL', async () => {
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
  assert.equal(await directory.sipDomain('not-a-uuid'), undefined);
  assert.equal(findUnique, 1);
  rows[0].sipDomain = 'alpha2.tenants.test';
  assert.equal(await directory.sipDomain(tenantA), 'alpha.tenants.test');
  now = 1_001;
  assert.equal(await directory.sipDomain(tenantA), 'alpha2.tenants.test');
});
