import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { c360FilterDigest, c360ScopeDigest, createC360CursorCodec } from '@d-contact/customer-360';
import { C360_SEARCH_LIMIT_PER_ACTOR, Customer360ReadController } from './customer-360-read-api.js';
import { deliverToIam, ownerCommit, setup, type Fixture } from './customer-360-test-fixtures.js';
import { contact, grant, head, point } from './customer-360-read-test-fixtures.js';

/**
 * Cus360 C2 (#792) S1: HTTP จริง → predicate ของ C1 → PostgreSQL/RLS ด้วย application role
 * ข้อมูลทดสอบทั้งหมด synthetic; point ใส่ผ่าน owner connection ใต้ command สังเคราะห์ (C3 ยังไม่มี writer)
 */

// ใช้ key ชุดเดียวกับ server เพื่อสร้าง cursor หมดอายุจริงในการทดสอบ
const CURSOR_KEY = randomBytes(32);
process.env.CUSTOMER_360_CURSOR_KEYS = `test:${CURSOR_KEY.toString('base64')}`;

interface SearchBody {
  items: {
    contactId: string;
    displayName: string | null;
    company: string | null;
    vip: boolean;
    identity: string;
    reviewRequired: boolean;
    matchedChannel?: { kind: string; masked: string };
  }[];
  nextCursor: string | null;
  scope: { state: string };
  accessibleCount?: { state: string; value: number | null };
  error: { code: string; retryable: boolean; fieldErrors?: { field: string; code: string }[] };
}

const search = async (f: Fixture, token: string, body: unknown = {}) => {
  const response = await f.request('customer-360/contacts/search', token, body);
  return {
    status: response.status,
    headers: response.headers,
    body: response.body as unknown as SearchBody,
  };
};
const profile = async (f: Fixture, token: string, contactId: string) => {
  const response = await f.request(`customer-360/contacts/${contactId}`, token);
  return {
    status: response.status,
    body: response.body as unknown as Record<string, unknown> & {
      error: { code: string };
      contact: { displayName: string };
      contactPoints: { kind: string; value: string; state: string }[];
      tags: { name: string; state: string }[];
      identity: { state: string; reviewRequired: boolean; canonicalContactId?: string };
      capabilities: { read: boolean; manage: boolean };
      revisions: { profile: string; tag: string; lineage: number | null };
    },
  };
};

const idsOf = (body: SearchBody) => body.items.map((item) => item.contactId);

test('C2 S1: Admin เห็นเฉพาะ contact ที่มี custodian grant; list/detail/count ใช้ predicate เดียวกัน; tenant อื่นไม่เห็น', async () => {
  const f = await setup([Customer360ReadController]);
  try {
    const own = await contact(f, { displayName: 'สมชาย ใจดี', company: 'บริษัท ก' });
    const legacy = await contact(f, { displayName: 'Legacy Lee' });
    const hidden = await contact(f, { displayName: 'ซ่อน' });
    const ambiguous = await contact(f, { displayName: 'Ambiguous Amy' });
    await head(f, own, 'ACTIVE');
    await head(f, ambiguous, 'AMBIGUOUS');
    await grant(f, 'admin', own, 'MANAGE');
    await grant(f, 'admin', legacy, 'READ');
    await grant(f, 'admin', ambiguous, 'READ');
    const foreignContact = await contact(f, {
      displayName: 'ต่าง tenant',
      tenantId: f.otherTenantId,
    });

    const directory = await search(f, 'admin');
    assert.equal(directory.status, 200);
    assert.equal(directory.headers.get('cache-control'), 'no-store');
    assert.deepEqual(idsOf(directory.body).sort(), [own, legacy, ambiguous].sort());
    assert.deepEqual(directory.body.accessibleCount, { state: 'AVAILABLE', value: 3 });
    assert.equal(directory.body.scope.state, 'COMPLETE');
    const byId = new Map(directory.body.items.map((item) => [item.contactId, item]));
    assert.equal(byId.get(legacy)!.identity, 'LEGACY_MISSING_HEAD');
    assert.equal(byId.get(ambiguous)!.reviewRequired, true);
    assert.equal(byId.get(own)!.reviewRequired, false);
    assert.equal(JSON.stringify(directory.body).includes('ซ่อน'), false);

    // ทุกรายการใน list เปิด detail ได้; ที่ไม่อยู่ใน list ได้ 404 แบบเดียวกับไม่พบ
    for (const id of idsOf(directory.body))
      assert.equal((await profile(f, 'admin', id)).status, 200, id);
    const denied = await profile(f, 'admin', hidden);
    const missing = await profile(f, 'admin', randomUUID());
    const malformed = await profile(f, 'admin', 'not-a-uuid');
    for (const response of [denied, missing, malformed]) {
      assert.equal(response.status, 404);
      assert.deepEqual(response.body.error, denied.body.error);
    }
    assert.equal((await profile(f, 'admin', foreignContact)).status, 404);

    // Admin อีกคนไม่มี grant → ว่างและ count = 0 (ไม่ใช่ error); tenant อื่นไม่เห็นของ tenant แรก
    const other = await search(f, 'admin-two');
    assert.deepEqual(other.body.items, []);
    assert.deepEqual(other.body.accessibleCount, { state: 'AVAILABLE', value: 0 });
    const foreign = await search(f, 'foreign');
    assert.deepEqual(foreign.body.items, []);
    assert.equal(JSON.stringify(foreign.body).includes('สมชาย'), false);

    // detail
    const detail = await profile(f, 'admin', own);
    assert.equal(detail.body.contact.displayName, 'สมชาย ใจดี');
    assert.deepEqual(detail.body.capabilities, { read: true, manage: true });
    assert.equal(detail.body.identity.state, 'ACTIVE');
    const legacyDetail = await profile(f, 'admin', legacy);
    assert.deepEqual(legacyDetail.body.capabilities, { read: true, manage: false });
    assert.equal(legacyDetail.body.identity.state, 'LEGACY_MISSING_HEAD');
    assert.equal(legacyDetail.body.revisions.lineage, null);
    const ambiguousDetail = await profile(f, 'admin', ambiguous);
    assert.equal(ambiguousDetail.body.identity.reviewRequired, true);
    assert.equal(ambiguousDetail.body.capabilities.manage, false);
  } finally {
    await f.close();
  }
});

test('C2 S1: Agent, Compliance, unbound, disabled ไม่มี generic directory/profile; GET/search ไม่สร้าง head หรือหลักฐาน', async () => {
  const f = await setup([Customer360ReadController]);
  try {
    const legacy = await contact(f, { displayName: 'Legacy Only' });
    await grant(f, 'admin', legacy, 'READ');
    for (const token of ['agent', 'compliance', 'unbound', 'disabled'] as const) {
      assert.equal((await search(f, token)).status, 403, token);
      assert.equal((await profile(f, token, legacy)).status, 403, token);
    }
    const counts = async () => ({
      heads: await f.owner.c360IdentityHead.count(),
      commands: await f.owner.c360ProfileCommand.count(),
      receipts: await f.owner.c360ProfileCommandReceipt.count(),
      audits: await f.owner.c360ProfileAudit.count(),
      lineage: await f.owner.c360IdentityLineage.count(),
      grants: await f.owner.c360ContactCustodianGrant.count(),
      membership: await f.owner.c360SegmentMembershipChange.count(),
    });
    const before = await counts();
    assert.equal((await search(f, 'admin')).status, 200);
    assert.equal((await search(f, 'admin', { type: 'NAME', query: 'Legacy' })).status, 200);
    assert.equal((await profile(f, 'admin', legacy)).status, 200);
    assert.deepEqual(await counts(), before);
    // C4 เปิด PATCH แล้ว แต่ request ที่ไม่ถูกต้องต้องไม่สร้างผล; PUT/DELETE ยังไม่มี route
    assert.equal(
      (await f.request(`customer-360/contacts/${legacy}`, 'admin', {}, 'PATCH')).status,
      400,
    );
    assert.deepEqual(await counts(), before);
    for (const method of ['PUT', 'DELETE'])
      assert.equal(
        (await f.request(`customer-360/contacts/${legacy}`, 'admin', {}, method)).status,
        404,
        method,
      );
  } finally {
    await f.close();
  }
});

test('C2 S1: NAME prefix, ตัวอักษรพิเศษเป็นตัวอักษรธรรมดา, PHONE/EMAIL เต็มค่า และ shared/retired/review ไม่หลุดสิทธิ์', async () => {
  const f = await setup([Customer360ReadController]);
  try {
    const names = [
      '100%_Done',
      'Somchai',
      'somsri',
      'Anan\\Tee',
      'A_B',
      'AxB',
      'Cafe\u0301 legacy',
    ];
    const ids: Record<string, string> = {};
    for (const name of names) {
      ids[name] = await contact(f, { displayName: name });
      await grant(f, 'admin', ids[name], 'READ');
    }
    const sharedHidden = await contact(f, { displayName: 'Hidden Sharer' });
    const names_ = async (query: string) =>
      idsOf((await search(f, 'admin', { type: 'NAME', query })).body);
    assert.deepEqual(await names_('som'), [ids.somsri, ids.Somchai]);
    assert.deepEqual(await names_('SOMS'), [ids.somsri]);
    // wildcard/regex/substring ไม่มีผล
    assert.deepEqual(await names_('%'.padEnd(2, '%')), []);
    assert.deepEqual(await names_('100%'), [ids['100%_Done']]);
    assert.deepEqual(await names_('A_'), [ids.A_B]);
    assert.deepEqual(await names_('.*'), []);
    assert.deepEqual(await names_('chai'), []);
    assert.deepEqual(await names_('Café'), [ids['Cafe\u0301 legacy']]);
    assert.deepEqual(await names_('Anan\\'), [ids['Anan\\Tee']]);
    assert.equal(
      (await search(f, 'admin', { type: 'NAME', query: 'x' })).body.error.fieldErrors?.[0]?.code,
      'NAME_TOO_SHORT',
    );

    // PHONE/EMAIL: เฉพาะ point ACTIVE ของ contact ที่อ่านได้; shared กับ contact ที่ซ่อนอยู่ไม่เปิดเผย
    await point(f, ids.Somchai, 'PHONE', '+12133734253');
    await point(f, sharedHidden, 'PHONE', '+12133734253');
    await point(f, ids.somsri, 'PHONE', '+66812345678', 'RETIRED');
    await point(f, ids.AxB, 'PHONE', '+66899999999', 'REVIEW_REQUIRED');
    await point(f, ids.Somchai, 'EMAIL', 'User.Name+Tag@example.com');
    await point(f, ids.somsri, 'EMAIL', 'user.name+tag@example.com');
    const phone = await search(f, 'admin', { type: 'PHONE', query: '+1 (213) 373-4253' });
    assert.deepEqual(idsOf(phone.body), [ids.Somchai]);
    assert.equal(phone.body.items[0]!.matchedChannel?.kind, 'PHONE');
    assert.equal(JSON.stringify(phone.body).includes('373'), false);
    assert.equal(JSON.stringify(phone.body).includes('Hidden'), false);
    assert.deepEqual(
      idsOf((await search(f, 'admin', { type: 'PHONE', query: '+66 81 234 5678' })).body),
      [],
    );
    assert.deepEqual(
      idsOf((await search(f, 'admin', { type: 'PHONE', query: '+66 89 999 9999' })).body),
      [],
    );
    // เบอร์ที่ไม่สมบูรณ์ถูกปฏิเสธก่อนค้นหา
    assert.equal((await search(f, 'admin', { type: 'PHONE', query: '+1 213 373 42' })).status, 400);
    const email = await search(f, 'admin', { type: 'EMAIL', query: ' User.Name+Tag@EXAMPLE.com ' });
    assert.deepEqual(idsOf(email.body), [ids.Somchai]);
    assert.equal(JSON.stringify(email.body).includes('example.com'), true);
    assert.equal(JSON.stringify(email.body).includes('User.Name'), false);

    // validation ไม่สะท้อนค่าที่กรอกและไม่ค้นแบบเดา
    for (const query of ['0812345678', '911', 'Call: +12133734253']) {
      const bad = await search(f, 'admin', { type: 'PHONE', query });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.error.code, 'VALIDATION_FAILED');
      assert.equal(JSON.stringify(bad.body).includes(query), false);
    }
    assert.equal((await search(f, 'admin', { type: 'NAME', query: 'ab', extra: 1 })).status, 400);
    assert.equal((await search(f, 'admin', { type: 'EMAIL', query: 'not-an-email' })).status, 400);
    // directory ที่ไม่ใส่ query ได้เฉพาะ Admin/Supervisor; Supervisor ที่ไม่มี scope ได้ว่าง
    assert.equal((await search(f, 'supervisor')).body.items.length, 0);
  } finally {
    await f.close();
  }
});

test('C2 S1: cursor แบบ opaque แบ่งหน้าไม่ซ้ำ; tamper/ข้าม actor/ข้าม filter/หมดอายุ/scope เปลี่ยน ถูกปฏิเสธ', async () => {
  const f = await setup([Customer360ReadController]);
  try {
    const created: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const id = await contact(f, { displayName: `Page ${i}` });
      await grant(f, 'admin', id, 'READ');
      await grant(f, 'admin-two', id, 'READ');
      created.push(id);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Awaited<ReturnType<typeof search>> = await search(f, 'admin', {
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      assert.equal(page.status, 200);
      if (cursor === null)
        assert.deepEqual(page.body.accessibleCount, { state: 'AVAILABLE', value: 5 });
      else assert.equal(page.body.accessibleCount, undefined);
      seen.push(...idsOf(page.body));
      cursor = page.body.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    assert.equal(pages, 3);
    // newest-first, ไม่ซ้ำ
    assert.deepEqual(seen, [...created].reverse());

    const first = await search(f, 'admin', { limit: 2 });
    const token = first.body.nextCursor!;
    assert.match(token, /^v1\.test\./);
    for (const id of created) assert.equal(token.includes(id), false);
    const tampered = `${token.slice(0, -4)}${token.endsWith('AAAA') ? 'BBBB' : 'AAAA'}`;
    for (const bad of [tampered, 'v1.test.AAAA', 'junk']) {
      const rejected = await search(f, 'admin', { limit: 2, cursor: bad });
      assert.equal(rejected.status, 400);
      assert.equal(rejected.body.error.code, 'CURSOR_INVALID');
    }
    // actor อื่น (แม้เห็นรายการเดียวกัน) และ filter อื่นใช้ cursor นี้ไม่ได้
    assert.equal(
      (await search(f, 'admin-two', { limit: 2, cursor: token })).body.error.code,
      'CURSOR_INVALID',
    );
    assert.equal(
      (await search(f, 'admin', { type: 'NAME', query: 'Page', limit: 2, cursor: token })).body
        .error.code,
      'CURSOR_INVALID',
    );
    assert.equal((await search(f, 'admin', { cursor: token })).status, 200);

    // หมดอายุ: ออก token ด้วย key เดียวกับ server แต่นาฬิกาเก่า → 410 typed expiry
    const admin = f.actors.get('admin')!;
    const actor = {
      tenantId: f.tenantId,
      userId: admin.id,
      role: 'ADMIN' as const,
      teamId: f.teamId,
    };
    const old = createC360CursorCodec(
      [{ id: 'test', key: CURSOR_KEY }],
      () => Date.now() - 16 * 60_000,
    ).seal({
      kind: 'directory',
      tenantId: actor.tenantId,
      userId: actor.userId,
      filter: c360FilterDigest(['DIRECTORY', '']),
      scope: c360ScopeDigest(actor),
      position: ['2026-11-01T00:00:00.000100', created[0]!],
    });
    const expired = await search(f, 'admin', { cursor: old });
    assert.equal(expired.status, 410);
    assert.equal(expired.body.error.code, 'CURSOR_EXPIRED');

    // ถอน grant ของรายการหน้าแรกระหว่างหน้า ต้องปฏิเสธ cursor เดิม
    const revokeGrant = await f.owner.c360ContactCustodianGrant.findFirstOrThrow({
      where: { tenantId: f.tenantId, contactId: created[4], granteeUserId: admin.id },
    });
    await f.owner.c360ContactCustodianRevocation.create({
      data: {
        id: randomUUID(),
        tenantId: f.tenantId,
        grantId: revokeGrant.id,
        actorIdentityKey: revokeGrant.actorIdentityKey,
        commandId: revokeGrant.commandId,
        reason: 'test revoke',
        evidenceRef: 'fixture-evidence',
      },
    });
    const revoked = await search(f, 'admin', { limit: 2, cursor: token });
    assert.equal(revoked.status, 400);
    assert.equal(revoked.body.error.code, 'CURSOR_INVALID');

    // scope เปลี่ยนระหว่างหน้า (ย้ายทีม): cursor เดิมใช้ไม่ได้ ต้องค้นใหม่
    const otherTeam = randomUUID();
    await f.owner.team.create({ data: { id: otherTeam, tenantId: f.tenantId, name: 'Other' } });
    await f.owner.user.update({ where: { id: admin.id }, data: { teamId: otherTeam } });
    const moved = await search(f, 'admin', { limit: 2, cursor: token });
    assert.ok([400, 403].includes(moved.status), `status ${moved.status}`);
    assert.equal(JSON.stringify(moved.body).includes('Page'), false);
  } finally {
    await f.close();
  }
});

test('C2 S1: Supervisor อ่านผ่าน IAM VIEW; projection lag = INCOMPLETE/503 ไม่ใช่ว่างหรือ 0; Admin custodian ไม่ได้สิทธิ์ทั้ง tenant', async () => {
  const f = await setup([Customer360ReadController]);
  try {
    await f.scopes.grant({
      tenantId: f.tenantId,
      teamId: f.teamId,
      segmentId: f.segmentId,
      permission: 'VIEW',
      correlationId: 'c2-s1-grant',
    });
    const outside = await contact(f, { displayName: 'นอก segment' });
    // owner บอกว่า f.contactId เป็นสมาชิกแล้วแต่ IAM ยังไม่รับ event → DEFER
    await ownerCommit(f, 'GOLD');
    const lagging = await search(f, 'supervisor');
    assert.equal(lagging.status, 200);
    assert.deepEqual(lagging.body.items, []);
    assert.equal(lagging.body.scope.state, 'INCOMPLETE');
    assert.deepEqual(lagging.body.accessibleCount, { state: 'UNAVAILABLE', value: null });
    assert.equal((await profile(f, 'supervisor', f.contactId)).status, 503);
    assert.equal(
      (await profile(f, 'supervisor', f.contactId)).body.error.code,
      'SCOPE_UNAVAILABLE',
    );
    // filter ที่ไม่เกี่ยวกับรายการ DEFER ไม่ถูกทำเป็น INCOMPLETE
    assert.equal(
      (await search(f, 'supervisor', { type: 'NAME', query: 'zzzz' })).body.scope.state,
      'COMPLETE',
    );

    await deliverToIam(f);
    const fresh = await search(f, 'supervisor');
    assert.deepEqual(idsOf(fresh.body), [f.contactId]);
    assert.equal(fresh.body.scope.state, 'COMPLETE');
    assert.deepEqual(fresh.body.accessibleCount, { state: 'AVAILABLE', value: 1 });
    const detail = await profile(f, 'supervisor', f.contactId);
    assert.deepEqual(detail.body.capabilities, { read: true, manage: false });
    assert.equal((await profile(f, 'supervisor', outside)).status, 404);

    // Admin ในทีมเดียวกันอ่านผ่าน VIEW ได้แต่ไม่ได้สิทธิ์แก้; Admin ไม่ได้ทั้ง tenant จาก role
    const admin = await search(f, 'admin');
    assert.deepEqual(idsOf(admin.body), [f.contactId]);
    assert.equal((await profile(f, 'admin', f.contactId)).body.capabilities.manage, false);
    assert.equal((await profile(f, 'admin', outside)).status, 404);

    // owner ออกจาก segment แต่ IAM ยังไม่ตามทัน → ไม่คืนข้อมูลจาก projection เก่า
    await ownerCommit(f, 'SILVER');
    const stale = await search(f, 'supervisor');
    assert.deepEqual(stale.body.items, []);
    assert.equal(stale.body.scope.state, 'INCOMPLETE');
    await deliverToIam(f);
    const left = await search(f, 'supervisor');
    assert.deepEqual(left.body.items, []);
    assert.equal(left.body.scope.state, 'COMPLETE');
  } finally {
    await f.close();
  }
});

test('C2 S1: MERGED predecessor ไม่ซ้ำใน directory, ไม่ redirect, เปิด canonical ref เมื่อ current authorization อนุญาตเท่านั้น', async () => {
  const f = await setup([Customer360ReadController]);
  try {
    const source = await contact(f, { displayName: 'Predecessor' });
    const target = await contact(f, { displayName: 'Canonical' });
    await grant(f, 'admin', source, 'MANAGE');
    await f.memberships.recordIdentityTransition({
      tenantId: f.tenantId,
      commandId: `identity:${randomUUID()}`,
      operation: 'MERGE',
      sourceContactId: source,
      targetContactId: target,
      expectedSourceLineageRevision: 0,
      correlationId: 'c2-s1-merge',
    });
    // grant ของ source ไม่ตามไป target; directory ไม่แสดง predecessor ที่ merged แล้ว
    assert.deepEqual((await search(f, 'admin')).body.items, []);
    assert.deepEqual(
      (await search(f, 'admin', { type: 'NAME', query: 'Predecessor' })).body.items,
      [],
    );
    const merged = await profile(f, 'admin', source);
    assert.equal(merged.status, 200);
    assert.equal(merged.body.identity.state, 'MERGED');
    assert.equal(merged.body.identity.canonicalContactId, undefined);
    assert.deepEqual(merged.body.capabilities, { read: true, manage: false });
    assert.equal(JSON.stringify(merged.body).includes(target), false);
    assert.equal(JSON.stringify(merged.body).includes('Canonical'), false);
    assert.equal((await profile(f, 'admin', target)).status, 404);

    await grant(f, 'admin', target, 'READ');
    const withTarget = await profile(f, 'admin', source);
    assert.equal(withTarget.body.identity.canonicalContactId, target);
    const listed = await search(f, 'admin');
    assert.deepEqual(idsOf(listed.body), [target]);
  } finally {
    await f.close();
  }
});

test('C2 S1: profile รวม point ที่เปิดอ่านได้ (ไม่รวม RETIRED), tag ที่ผูกอยู่ และ revisions', async () => {
  const f = await setup([Customer360ReadController]);
  try {
    const id = await contact(f, { displayName: 'Profile One', company: 'Acme' });
    await head(f, id, 'ACTIVE');
    await grant(f, 'admin', id, 'MANAGE');
    await point(f, id, 'PHONE', '+12133734253');
    await point(f, id, 'PHONE', '+66800000000', 'RETIRED');
    await point(f, id, 'EMAIL', 'a@example.com', 'REVIEW_REQUIRED', 'A@Example.COM');
    const tagId = randomUUID();
    const commandId = randomUUID();
    await f.owner.c360ProfileCommand.create({
      data: {
        tenantId: f.tenantId,
        actorIdentityKey: 'operator-fixture',
        commandId,
        action: 'TAG_SEED',
        resourceType: 'TAG',
        payloadDigest: '1'.repeat(64),
        normalizationContractVersion: 'fixture',
      },
    });
    await f.owner.c360Tag.create({
      data: {
        id: tagId,
        tenantId: f.tenantId,
        name: 'ลูกค้าสำคัญ',
        nameKey: 'ลูกค้าสำคัญ',
        actorIdentityKey: 'operator-fixture',
        commandId,
      },
    });
    await f.owner.c360ContactTag.create({
      data: {
        tenantId: f.tenantId,
        contactId: id,
        tagId,
        actorIdentityKey: 'operator-fixture',
        commandId,
      },
    });
    const response = await profile(f, 'admin', id);
    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.contactPoints.map((p) => `${p.kind}:${p.value}:${p.state}`),
      ['EMAIL:A@Example.COM:REVIEW_REQUIRED', 'PHONE:+12133734253:ACTIVE'],
    );
    assert.deepEqual(response.body.tags, [{ id: tagId, name: 'ลูกค้าสำคัญ', state: 'ACTIVE' }]);
    assert.equal(typeof response.body.revisions.profile, 'string');
    assert.equal(response.body.revisions.lineage, 0);
    assert.deepEqual(response.body.capabilities, { read: true, manage: true });
    // core profile ไม่มี supplementary data (timeline / governance) ติดมา
    assert.equal('timeline' in response.body, false);
    assert.equal('governance' in response.body, false);
  } finally {
    await f.close();
  }
});

test('C2 S1: rate limit ของ search ต่อ actor ตอบ 429 พร้อม Retry-After และไม่กระทบ actor อื่น', async () => {
  const f = await setup([Customer360ReadController]);
  try {
    let last = await search(f, 'admin');
    for (let i = 1; i < C360_SEARCH_LIMIT_PER_ACTOR; i += 1) last = await search(f, 'admin');
    assert.equal(last.status, 200);
    const limited = await search(f, 'admin');
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error.code, 'RATE_LIMITED');
    assert.equal(limited.body.error.retryable, true);
    // ค่าจริงของ limiter (เหลือของ window 60 วินาที) ไม่ใช่ค่าเริ่มต้น 1
    const retryAfter = Number(limited.headers.get('retry-after'));
    assert.ok(retryAfter > 1 && retryAfter <= 60, `retry-after ${retryAfter}`);
    assert.equal((await search(f, 'admin-two')).status, 200);
  } finally {
    await f.close();
  }
});
