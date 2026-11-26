import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { c360FilterDigest, c360ScopeDigest, createC360CursorCodec } from '@d-contact/customer-360';
import { C360_SEARCH_LIMIT_PER_ACTOR, Customer360ReadController } from './customer-360-read-api.js';
import { deliverToIam, ownerCommit, setup, type Fixture } from './customer-360-test-fixtures.js';
import { contact, grant, head, point } from './customer-360-read-test-fixtures.js';

/**
 * Cus360 C2 (#792) S1: real HTTP → the C1 predicate → PostgreSQL/RLS with the application role
 * all test data is synthetic; points go in through the owner connection under a synthetic command (C3 has no writer yet)
 */

// use the same key as the server to create a genuinely expired cursor in the test
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

test('C2 S1: an Admin sees only contacts with a custodian grant; list/detail/count use the same predicate; another tenant sees nothing', async () => {
  const f = await setup([Customer360ReadController]);
  try {
    const own = await contact(f, { displayName: 'Somchai Jaidee', company: 'Company A' });
    const legacy = await contact(f, { displayName: 'Legacy Lee' });
    const hidden = await contact(f, { displayName: 'Concealed' });
    const ambiguous = await contact(f, { displayName: 'Ambiguous Amy' });
    await head(f, own, 'ACTIVE');
    await head(f, ambiguous, 'AMBIGUOUS');
    await grant(f, 'admin', own, 'MANAGE');
    await grant(f, 'admin', legacy, 'READ');
    await grant(f, 'admin', ambiguous, 'READ');
    const foreignContact = await contact(f, {
      displayName: 'Other tenant',
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
    assert.equal(JSON.stringify(directory.body).includes('Concealed'), false);

    // every item in the list opens a detail; one not in the list gets the same 404 as not found
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

    // another Admin has no grant → empty and count = 0 (not an error); another tenant does not see the first tenant's
    const other = await search(f, 'admin-two');
    assert.deepEqual(other.body.items, []);
    assert.deepEqual(other.body.accessibleCount, { state: 'AVAILABLE', value: 0 });
    const foreign = await search(f, 'foreign');
    assert.deepEqual(foreign.body.items, []);
    assert.equal(JSON.stringify(foreign.body).includes('Somchai'), false);

    // detail
    const detail = await profile(f, 'admin', own);
    assert.equal(detail.body.contact.displayName, 'Somchai Jaidee');
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

test('C2 S1: Agent, Compliance, unbound, disabled have no generic directory/profile; GET/search create no head or evidence', async () => {
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
    // C4 opened PATCH, but an invalid request must produce no effect; PUT/DELETE still have no route
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

test('C2 S1: NAME prefix, special characters are ordinary characters, PHONE/EMAIL are full-value, and shared/retired/review do not leak permission', async () => {
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
    // wildcard/regex/substring have no effect
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

    // PHONE/EMAIL: only ACTIVE points of a readable contact; a shared one and a hidden contact are not revealed
    await point(f, ids.Somchai, 'PHONE', '+12133734253');
    await point(f, sharedHidden, 'PHONE', '+12133734253');
    await point(f, ids.somsri, 'PHONE', '+66812345678', 'RETIRED');
    await point(f, ids.AxB, 'PHONE', '+66899999999', 'REVIEW_REQUIRED');
    await point(f, ids.Somchai, 'EMAIL', 'User.Name+Tag@example.com');
    await point(f, ids.somsri, 'EMAIL', 'user.name+tag@example.com');
    const phone = await search(f, 'admin', { type: 'PHONE', query: '+1 (213) 373-4253' });
    assert.deepEqual(idsOf(phone.body), [ids.Somchai]);
    assert.equal(phone.body.items[0]!.matchedChannel?.kind, 'PHONE');
    // the phone number must not leak in E.164 or formatted form; check long fragments only,
    // because a short one such as 373 may coincidentally appear in a random UUID or cursor
    const phoneText = JSON.stringify(phone.body);
    for (const fragment of ['2133734253', '3734253', '373-4253', '373 4253'])
      assert.equal(phoneText.includes(fragment), false, fragment);
    assert.equal(phoneText.includes('Hidden'), false);
    assert.deepEqual(
      idsOf((await search(f, 'admin', { type: 'PHONE', query: '+66 81 234 5678' })).body),
      [],
    );
    assert.deepEqual(
      idsOf((await search(f, 'admin', { type: 'PHONE', query: '+66 89 999 9999' })).body),
      [],
    );
    // an incomplete phone number is rejected before searching
    assert.equal((await search(f, 'admin', { type: 'PHONE', query: '+1 213 373 42' })).status, 400);
    const email = await search(f, 'admin', { type: 'EMAIL', query: ' User.Name+Tag@EXAMPLE.com ' });
    assert.deepEqual(idsOf(email.body), [ids.Somchai]);
    assert.equal(JSON.stringify(email.body).includes('example.com'), true);
    assert.equal(JSON.stringify(email.body).includes('User.Name'), false);

    // validation does not echo the entered value and does not guess-search
    for (const query of ['0812345678', '911', 'Call: +12133734253']) {
      // a short sentinel such as 911 may coincidentally match a random UUID requestId
      // use a fixed correlation so the whole-payload assertion checks only genuine input reflection
      const bad = await f.request(
        'customer-360/contacts/search',
        'admin',
        { type: 'PHONE', query },
        'POST',
        { 'x-request-id': 'fixture-no-reflection' },
      );
      assert.equal(
        (bad.body as unknown as { requestId: string }).requestId,
        'fixture-no-reflection',
      );
      assert.equal(bad.status, 400);
      assert.equal(bad.body.error.code, 'VALIDATION_FAILED');
      assert.equal(JSON.stringify(bad.body).includes(query), false);
    }
    assert.equal((await search(f, 'admin', { type: 'NAME', query: 'ab', extra: 1 })).status, 400);
    assert.equal((await search(f, 'admin', { type: 'EMAIL', query: 'not-an-email' })).status, 400);
    // a directory without a query is only for Admin/Supervisor; a Supervisor without scope gets empty
    assert.equal((await search(f, 'supervisor')).body.items.length, 0);
  } finally {
    await f.close();
  }
});

test('C2 S1: an opaque cursor paginates without repeats; tamper/cross actor/cross filter/expired/scope change are rejected', async () => {
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
    // newest-first, no repeats
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
    // another actor (even seeing the same items) and another filter cannot use this cursor
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

    // expired: a token issued with the same key as the server but an old clock → 410 typed expiry
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

    // revoke the grant of a first-page item between pages; the original cursor must be rejected
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

    // scope changes between pages (team move): the original cursor is unusable and the search must restart
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

test('C2 S1: a Supervisor reads via IAM VIEW; projection lag = INCOMPLETE/503 not empty or 0; an Admin custodian does not get the whole tenant', async () => {
  const f = await setup([Customer360ReadController]);
  try {
    await f.scopes.grant({
      tenantId: f.tenantId,
      teamId: f.teamId,
      segmentId: f.segmentId,
      permission: 'VIEW',
      correlationId: 'c2-s1-grant',
    });
    const outside = await contact(f, { displayName: 'Outside segment' });
    // the owner says f.contactId is already a member but IAM has not yet accepted the event → DEFER
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
    // a filter unrelated to the DEFER item is not made INCOMPLETE
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

    // an Admin in the same team reads via VIEW but gets no edit permission; an Admin does not get the whole tenant from the role
    const admin = await search(f, 'admin');
    assert.deepEqual(idsOf(admin.body), [f.contactId]);
    assert.equal((await profile(f, 'admin', f.contactId)).body.capabilities.manage, false);
    assert.equal((await profile(f, 'admin', outside)).status, 404);

    // the owner leaves the segment but IAM has not caught up → no data is returned from the old projection
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

test('C2 S1: a MERGED predecessor does not repeat in the directory, does not redirect, and opens the canonical ref only when current authorization allows', async () => {
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
    // the source grant does not follow to the target; the directory does not show a merged predecessor
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

test('C2 S1: the profile includes readable points (not RETIRED), attached tags and revisions', async () => {
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
        name: 'Important customer',
        nameKey: 'Important customer',
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
    assert.deepEqual(response.body.tags, [
      { id: tagId, name: 'Important customer', state: 'ACTIVE' },
    ]);
    assert.equal(typeof response.body.revisions.profile, 'string');
    assert.equal(response.body.revisions.lineage, 0);
    assert.deepEqual(response.body.capabilities, { read: true, manage: true });
    // the core profile carries no supplementary data (timeline / governance)
    assert.equal('timeline' in response.body, false);
    assert.equal('governance' in response.body, false);
  } finally {
    await f.close();
  }
});

test('C2 S1: the search rate limit per actor answers 429 with Retry-After and does not affect another actor', async () => {
  const f = await setup([Customer360ReadController]);
  try {
    let last = await search(f, 'admin');
    for (let i = 1; i < C360_SEARCH_LIMIT_PER_ACTOR; i += 1) last = await search(f, 'admin');
    assert.equal(last.status, 200);
    const limited = await search(f, 'admin');
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error.code, 'RATE_LIMITED');
    assert.equal(limited.body.error.retryable, true);
    // the real limiter value (what remains of the 60-second window), not the default 1
    const retryAfter = Number(limited.headers.get('retry-after'));
    assert.ok(retryAfter > 1 && retryAfter <= 60, `retry-after ${retryAfter}`);
    assert.equal((await search(f, 'admin-two')).status, 200);
  } finally {
    await f.close();
  }
});
