import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Customer360ReadController } from './customer-360-read-api.js';
import { deliverToIam, ownerCommit, setup, type Fixture } from './customer-360-test-fixtures.js';
import { contact, grant, interaction } from './customer-360-read-test-fixtures.js';

/**
 * Cus360 C2 (#792) S2: timeline และ governance summary เป็น section แยกจาก core profile
 * owner error / สิทธิ์ประวัติที่พิสูจน์ไม่ได้ต้องไม่กลายเป็น empty หรือ allowed
 */

process.env.CUSTOMER_360_CURSOR_KEYS = `sections:${randomBytes(32).toString('base64')}`;

interface Section {
  state: string;
  asOf: string;
  reason?: string;
  data?: {
    items: { startedAt: string; endedAt: string | null; channel: string; state: string }[];
    nextCursor: string | null;
    coverage: string;
  };
  // governance (flat)
  requires?: string[];
  contactPermission?: string;
  context?: { channel: string; purpose: string };
  preference?: { decision: string; version: number } | null;
  callbackPending?: boolean;
  activeExceptionCount?: number;
  activeRestrictionCount?: number;
  items?: unknown;
  error?: { code: string };
}

const timeline = async (f: Fixture, token: string, contactId: string, query = '') => {
  const response = await f.request(`customer-360/contacts/${contactId}/timeline${query}`, token);
  return { status: response.status, body: response.body as unknown as Section };
};
const governance = async (f: Fixture, token: string, contactId: string, body?: unknown) => {
  const response = await f.request(
    `customer-360/contacts/${contactId}/governance-summary`,
    token,
    body ?? {},
  );
  return { status: response.status, body: response.body as unknown as Section };
};

test('C2 S2 timeline: คืนเฉพาะวัน-เวลา/ช่องทาง/สถานะของสายที่พิสูจน์สิทธิ์ได้ และ LIMITED เมื่อมีสายที่พิสูจน์ไม่ได้', async () => {
  const f = await setup([Customer360ReadController]);
  try {
    const target = await contact(f, { displayName: 'Timeline One' });
    const emptyContact = await contact(f, { displayName: 'Timeline Empty' });
    const foreignOnly = await contact(f, { displayName: 'Timeline Foreign Calls' });
    for (const id of [target, emptyContact, foreignOnly]) await grant(f, 'admin', id, 'READ');
    // admin รับสายเอง 3 สาย; agent รับ 2 สาย (ไม่มี historical team attribution ให้ admin); webchat และงานไม่มีเจ้าของ
    for (let i = 0; i < 3; i += 1) await interaction(f, target, 'admin');
    await interaction(f, target, 'agent');
    await interaction(f, target, 'agent');
    await interaction(f, target, 'admin', 'WEBCHAT');
    await interaction(f, target, null);
    await interaction(f, foreignOnly, 'agent');

    const first = await timeline(f, 'admin', target, '?limit=2');
    assert.equal(first.status, 200);
    assert.equal(first.body.state, 'READY');
    assert.equal(first.body.data!.items.length, 2);
    assert.equal(first.body.data!.coverage, 'LIMITED');
    assert.ok(first.body.data!.nextCursor);
    for (const item of first.body.data!.items) {
      assert.deepEqual(Object.keys(item).sort(), ['channel', 'endedAt', 'startedAt', 'state']);
      assert.equal(item.channel, 'VOICE');
    }
    const second = await timeline(
      f,
      'admin',
      target,
      `?limit=2&cursor=${encodeURIComponent(first.body.data!.nextCursor!)}`,
    );
    assert.equal(second.body.data!.items.length, 1);
    assert.equal(second.body.data!.nextCursor, null);
    const all = [...first.body.data!.items, ...second.body.data!.items].map((i) => i.startedAt);
    assert.deepEqual(all, [...all].sort().reverse());
    assert.equal(new Set(all).size, 3);
    const serialized = JSON.stringify([first.body, second.body]);
    for (const secret of ['SECRET-NOTE', 'SECRET-WRAP-CODE', 'WEBCHAT', 'wrap', 'transcript'])
      assert.equal(serialized.includes(secret), false, secret);

    // ไม่มีสายเลย = ว่างจริง (COMPLETE); มีแต่สายที่พิสูจน์ไม่ได้ = ว่างแต่ LIMITED (ไม่ใช่ empty/allowed)
    const none = await timeline(f, 'admin', emptyContact);
    assert.equal(none.body.state, 'READY');
    assert.deepEqual(none.body.data, { items: [], nextCursor: null, coverage: 'COMPLETE' });
    const unproven = await timeline(f, 'admin', foreignOnly);
    assert.deepEqual(unproven.body.data, { items: [], nextCursor: null, coverage: 'LIMITED' });

    // cursor: tamper และใช้ข้าม contact/actor ไม่ได้; limit ผิดรูปแบบ
    const token = first.body.data!.nextCursor!;
    for (const bad of [`${token.slice(0, -3)}AAA`, 'junk', 'v1.sections.AAAA']) {
      const rejected = await timeline(f, 'admin', target, `?cursor=${encodeURIComponent(bad)}`);
      assert.equal(rejected.status, 400, bad);
      assert.equal(rejected.body.error!.code, 'CURSOR_INVALID');
    }
    assert.equal(
      (await timeline(f, 'admin', emptyContact, `?cursor=${encodeURIComponent(token)}`)).status,
      400,
    );
    await grant(f, 'admin-two', target, 'READ');
    assert.equal(
      (await timeline(f, 'admin-two', target, `?cursor=${encodeURIComponent(token)}`)).status,
      400,
    );
    for (const limit of ['0', '101', 'abc', '-1', '1.5'])
      assert.equal((await timeline(f, 'admin', target, `?limit=${limit}`)).status, 400, limit);
  } finally {
    await f.close();
  }
});

test('C2 S2 timeline/governance: สิทธิ์ลูกค้าตรงกับ core profile — DENY=404 เหมือนไม่พบ, DEFER=503, Agent/Compliance 403, ไม่มีข้อมูลเสริมหลุด', async () => {
  const f = await setup([Customer360ReadController]);
  try {
    const hidden = await contact(f, { displayName: 'Hidden Person' });
    await interaction(f, hidden, 'admin');
    for (const call of [
      (token: string, id: string) => timeline(f, token, id),
      (token: string, id: string) => governance(f, token, id, { channel: 'VOICE', purpose: 'X' }),
    ]) {
      const denied = await call('admin', hidden);
      const missing = await call('admin', randomUUID());
      assert.equal(denied.status, 404);
      assert.equal(missing.status, 404);
      assert.deepEqual(denied.body.error, missing.body.error);
      assert.equal(JSON.stringify(denied.body).includes('Hidden'), false);
      assert.equal((await call('admin', 'not-a-uuid')).status, 404);
      for (const token of ['agent', 'compliance', 'unbound', 'disabled'])
        assert.equal((await call(token, hidden)).status, 403, token);
    }

    // projection lag ของ Supervisor → 503 ทั้งสอง section (ไม่ใช่ empty)
    await f.scopes.grant({
      tenantId: f.tenantId,
      teamId: f.teamId,
      segmentId: f.segmentId,
      permission: 'VIEW',
      correlationId: 'c2-s2-grant',
    });
    await ownerCommit(f, 'GOLD');
    await interaction(f, f.contactId, 'supervisor');
    const lagTimeline = await timeline(f, 'supervisor', f.contactId);
    const lagGovernance = await governance(f, 'supervisor', f.contactId, {
      channel: 'VOICE',
      purpose: 'SERVICE',
    });
    for (const lag of [lagTimeline, lagGovernance]) {
      assert.equal(lag.status, 503);
      assert.equal(lag.body.error!.code, 'SCOPE_UNAVAILABLE');
    }
    await deliverToIam(f);
    const ready = await timeline(f, 'supervisor', f.contactId);
    assert.equal(ready.body.data!.items.length, 1);
    assert.equal(ready.body.data!.coverage, 'COMPLETE');
  } finally {
    await f.close();
  }
});

test('C2 S2 owner error: Voice owner ล้ม = section UNAVAILABLE (200) และ core profile ยังอ่านได้ ไม่เป็น empty', async () => {
  const f = await setup([Customer360ReadController]);
  try {
    const id = await contact(f, { displayName: 'Owner Down' });
    await grant(f, 'admin', id, 'READ');
    await interaction(f, id, 'admin');
    assert.equal((await timeline(f, 'admin', id)).body.data!.items.length, 1);

    await f.owner.$executeRawUnsafe('REVOKE SELECT ON interactions FROM dcontact_app');
    try {
      const down = await timeline(f, 'admin', id);
      assert.equal(down.status, 200);
      assert.equal(down.body.state, 'UNAVAILABLE');
      assert.equal(down.body.reason, 'OWNER_UNAVAILABLE');
      assert.equal(down.body.data, undefined);
      assert.equal(JSON.stringify(down.body).includes('items'), false);
      const core = await f.request(`customer-360/contacts/${id}`, 'admin');
      assert.equal(core.status, 200);
      // ลูกค้าที่ไม่มีสิทธิ์ยังได้ 404 ไม่ใช่ UNAVAILABLE (ไม่เปิดเผยสถานะ owner ของ resource นอกสิทธิ์)
      assert.equal((await timeline(f, 'admin', randomUUID())).status, 404);
    } finally {
      await f.owner.$executeRawUnsafe('GRANT SELECT ON interactions TO dcontact_app');
    }
    assert.equal((await timeline(f, 'admin', id)).body.state, 'READY');
  } finally {
    await f.close();
  }
});

test('C2 S2 governance: context-required → ready ไม่ใช่ allowed; read ไม่มี side effect; owner ล้ม = UNAVAILABLE', async () => {
  const f = await setup([Customer360ReadController]);
  try {
    const id = await contact(f, { displayName: 'Governed' });
    await f.owner.c360IdentityHead.create({
      data: {
        tenantId: f.tenantId,
        contactId: id,
        canonicalContactId: id,
        state: 'ACTIVE',
        stateDigest: 'e'.repeat(64),
      },
    });
    await grant(f, 'admin', id, 'READ');
    const sideEffects = async () => ({
      audit: await f.owner.cgAuditLog.count(),
      reservations: await f.owner.cgReservation.count(),
      attempts: await f.owner.cgAttempt.count(),
      touches: await f.owner.cgTouch.count(),
      decisions: await f.owner.cgDecisionLog.count(),
      outbox: await f.owner.cgEventOutbox.count(),
      heads: await f.owner.cgContactStateHead.count(),
    });
    const before = await sideEffects();

    for (const body of [undefined, {}]) {
      const required = await governance(f, 'admin', id, body);
      assert.equal(required.status, 200);
      assert.equal(required.body.state, 'CONTEXT_REQUIRED');
      assert.deepEqual(required.body.requires, ['channel', 'purpose']);
      assert.ok(required.body.asOf);
    }
    for (const bad of [
      { channel: 'VOICE' },
      { purpose: 'X' },
      { channel: 'SMS', purpose: 'X' },
      { channel: 'VOICE', purpose: '' },
      { channel: 'VOICE', purpose: 'x'.repeat(65) },
      { channel: 'VOICE', purpose: 'X', other: 1 },
    ])
      assert.equal((await governance(f, 'admin', id, bad)).status, 400, JSON.stringify(bad));

    const ready = await governance(f, 'admin', id, { channel: 'VOICE', purpose: 'SERVICE' });
    assert.equal(ready.body.state, 'READY');
    assert.equal(ready.body.contactPermission, 'NOT_EVALUATED');
    assert.deepEqual(ready.body.context, { channel: 'VOICE', purpose: 'SERVICE' });
    assert.equal(ready.body.preference, null);
    assert.equal(ready.body.activeRestrictionCount, 0);

    await f.owner.cgPreference.create({
      data: {
        id: randomUUID(),
        tenantId: f.tenantId,
        seriesId: randomUUID(),
        version: 1,
        contactId: id,
        channel: 'VOICE',
        purpose: 'SERVICE',
        scopeHash: 'a'.repeat(64),
        decision: 'BLOCK',
        sourceKind: 'CUSTOMER',
        occurredAt: new Date(Date.now() - 60_000),
        effectiveFrom: new Date(Date.now() - 60_000),
        mutationKind: 'SET',
        requestHash: 'b'.repeat(64),
        evidenceRef: 'fixture',
        actorClass: 'SYSTEM',
      },
    });
    await f.owner.cgRestriction.create({
      data: {
        tenantId: f.tenantId,
        contactId: id,
        type: 'DNC',
        scope: 'CONTACT',
        reasonCode: 'FIXTURE',
        source: 'fixture',
        createdBy: 'fixture',
      },
    });
    const blocked = await governance(f, 'admin', id, { channel: 'VOICE', purpose: 'SERVICE' });
    assert.equal(blocked.body.state, 'READY');
    assert.deepEqual(blocked.body.preference, { decision: 'BLOCK', version: 1 });
    assert.equal(blocked.body.activeRestrictionCount, 1);
    assert.equal(blocked.body.contactPermission, 'NOT_EVALUATED');
    // restriction ระดับ tenant (contactId null) ที่ผูก channel EMAIL: นับเฉพาะบริบทที่ channel ตรง; null = ทุกค่า
    await f.owner.cgRestriction.create({
      data: {
        tenantId: f.tenantId,
        type: 'REGULATORY',
        channel: 'EMAIL',
        scope: 'TENANT',
        reasonCode: 'FIXTURE',
        source: 'fixture',
        createdBy: 'fixture',
      },
    });
    await f.owner.cgRestriction.create({
      data: {
        tenantId: f.tenantId,
        type: 'REGULATORY',
        purpose: 'SERVICE',
        scope: 'TENANT',
        reasonCode: 'FIXTURE',
        source: 'fixture',
        createdBy: 'fixture',
      },
    });
    const emailCtx = await governance(f, 'admin', id, { channel: 'EMAIL', purpose: 'SERVICE' });
    assert.equal(emailCtx.body.activeRestrictionCount, 3); // contact DNC + tenant EMAIL + tenant purpose SERVICE
    const voiceCtx = await governance(f, 'admin', id, { channel: 'VOICE', purpose: 'SERVICE' });
    assert.equal(voiceCtx.body.activeRestrictionCount, 2); // contact DNC + tenant purpose SERVICE (EMAIL ไม่นับ)
    const voiceOther = await governance(f, 'admin', id, { channel: 'VOICE', purpose: 'OTHER' });
    assert.equal(voiceOther.body.activeRestrictionCount, 1); // เฉพาะ contact DNC (channel/purpose null)
    const other = await governance(f, 'admin', id, { channel: 'VOICE', purpose: 'MARKETING' });
    assert.equal(other.body.preference, null);
    assert.deepEqual(await sideEffects(), before);

    // owner CG ล้ม
    await f.owner.$executeRawUnsafe('REVOKE SELECT ON cg_preferences FROM dcontact_app');
    try {
      const down = await governance(f, 'admin', id, { channel: 'VOICE', purpose: 'SERVICE' });
      assert.equal(down.status, 200);
      assert.equal(down.body.state, 'UNAVAILABLE');
      assert.equal(down.body.reason, 'OWNER_UNAVAILABLE');
      assert.equal(down.body.preference, undefined);
      assert.equal(down.body.contactPermission, undefined);
      // ไม่ระบุ context ไม่ต้องแตะ owner จึงยังตอบ CONTEXT_REQUIRED
      assert.equal((await governance(f, 'admin', id)).body.state, 'CONTEXT_REQUIRED');
    } finally {
      await f.owner.$executeRawUnsafe('GRANT SELECT ON cg_preferences TO dcontact_app');
    }

    // identity ยังไม่ canonical → unavailable ไม่ใช่ allowed
    const ambiguous = await contact(f, { displayName: 'Amb' });
    await f.owner.c360IdentityHead.create({
      data: {
        tenantId: f.tenantId,
        contactId: ambiguous,
        canonicalContactId: ambiguous,
        state: 'AMBIGUOUS',
        stateDigest: 'a'.repeat(64),
      },
    });
    await grant(f, 'admin', ambiguous, 'READ');
    const notCanonical = await governance(f, 'admin', ambiguous, {
      channel: 'VOICE',
      purpose: 'SERVICE',
    });
    assert.equal(notCanonical.body.state, 'UNAVAILABLE');
    assert.equal(notCanonical.body.reason, 'IDENTITY_NOT_CANONICAL');
  } finally {
    await f.close();
  }
});
