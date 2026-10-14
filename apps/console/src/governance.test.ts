import assert from 'node:assert/strict';
import test from 'node:test';
import { createGovernanceApi, GovernanceApiError, type ExceptionSeries } from './governance-api.js';
import { appI18n } from './i18n/index.js';
import enCatalog from './i18n/locales/en/governance.json' with { type: 'json' };
import {
  governanceHref,
  parseGovernanceLocation,
  recoveryFor,
  referenceLabel,
  sortExceptionQueue,
  type Translate,
} from './governance-model.js';

const tTh = appI18n.getFixedT('th', 'governance') as unknown as Translate;
const tEn = appI18n.getFixedT('en', 'governance') as unknown as Translate;
const DIGEST = 'a'.repeat(64);
const SERIES_ID = '3d6f7a52-3f0b-4f25-9a8b-6c2b3f7a0a11';

function series(overrides: Partial<ExceptionSeries> = {}): ExceptionSeries {
  return {
    seriesId: SERIES_ID,
    revisionId: '9b0d2d1a-7c2e-4a0f-8f0e-2d4b6a8c0e12',
    revision: 2,
    contactId: 'c3c4d9a1-5b7e-4f2a-9c1d-3e5f7a9b1c13',
    scopeKind: 'CONTACT_WIDE',
    channel: 'LINE',
    purpose: 'MARKETING',
    sourceType: 'JOURNEY',
    sourceId: 'journey-1',
    allowedRuleCodes: ['QUIET_HOURS'],
    policyId: 'e1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a14',
    policyVersion: 1,
    policyContentDigest: DIGEST,
    registryVersion: 'CG4_RULE_REGISTRY_V1',
    startsAt: '2026-09-15T19:00:00.000Z',
    expiresAt: '2026-09-15T22:00:00.000Z',
    riskTier: 'STANDARD',
    reasonCode: 'CUSTOMER_CALLBACK',
    contentDigest: 'b'.repeat(64),
    createdAt: '2026-09-15T18:00:00.000Z',
    evidenceRef: { redacted: true, digest: '0123456789abcdef' },
    actorRef: { redacted: true, digest: 'fedcba9876543210' },
    workflowState: 'PENDING',
    effectiveState: 'INACTIVE',
    aggregateVersion: 4,
    etag: '"cg4-exception"',
    ...overrides,
  };
}

test('อ่านทุก request แบบ no-store: canonical state ต้องไม่มาจาก HTTP cache (#672)', async () => {
  const inits: Array<RequestInit | undefined> = [];
  const api = createGovernanceApi({
    baseUrl: 'https://api.example/',
    accessToken: () => 'token-in-memory',
    fetch: async (_url, init) => {
      inits.push(init);
      return new Response(JSON.stringify({ seriesId: SERIES_ID, approvals: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  await api.exceptionApprovals(SERIES_ID);
  assert.equal(inits[0]?.cache, 'no-store');
});

test('response ของ approvals ใช้ enum ของ server (APPROVED/REJECTED) คนละคำกับ request (#672)', async () => {
  const api = createGovernanceApi({
    baseUrl: 'https://api.example/',
    accessToken: () => 'token-in-memory',
    fetch: async () =>
      new Response(
        JSON.stringify({
          seriesId: SERIES_ID,
          approvals: [{ decision: 'APPROVED' }, { decision: 'REJECTED' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  });
  const approvals = await api.exceptionApprovals(SERIES_ID);
  assert.deepEqual(
    approvals.map((approval) => approval.decision),
    ['APPROVED', 'REJECTED'],
  );
});

test('command ผูก revision/digest/version ที่เห็นจริง ส่ง Idempotency-Key และไม่ส่ง tenant/actor', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const api = createGovernanceApi({
    baseUrl: 'https://api.example/',
    accessToken: () => 'token-in-memory',
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          seriesId: SERIES_ID,
          revision: 2,
          quorum: { status: 'PENDING', required: 2, current: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });
  const result = await api.decideException({
    series: series(),
    decision: 'APPROVE',
    evidenceRef: 'TICKET-1',
    idempotencyKey: 'intent-key-1',
  });
  assert.equal(result.quorum.current, 1);
  assert.equal(
    requests[0]?.url,
    `https://api.example/api/v1/contact-governance/exceptions/${SERIES_ID}/approvals`,
  );
  assert.deepEqual(requests[0]?.init?.headers, {
    authorization: 'Bearer token-in-memory',
    'content-type': 'application/json',
    'idempotency-key': 'intent-key-1',
  });
  const body = JSON.parse(requests[0]?.init?.body as string) as Record<string, unknown>;
  assert.deepEqual(body, {
    decision: 'APPROVE',
    expectedRevision: 2,
    expectedContentDigest: 'b'.repeat(64),
    expectedVersion: 4,
    evidenceRef: 'TICKET-1',
  });
  for (const forbidden of ['tenantId', 'actorRef', 'capability', 'role', 'makerSubjectId']) {
    assert.equal(forbidden in body, false, `${forbidden} ต้องไม่อยู่ใน body`);
  }
});

test('error ของ server เก็บ code และ expected/actual version ไว้ และ effective scope 404 คืน undefined', async () => {
  const api = createGovernanceApi({
    baseUrl: 'https://api.example',
    accessToken: () => 'token',
    fetch: async (url) =>
      String(url).includes('/policy-scopes/')
        ? new Response(JSON.stringify({ code: 'RESOURCE_NOT_FOUND' }), { status: 404 })
        : new Response(
            JSON.stringify({ code: 'VERSION_CONFLICT', expectedVersion: 4, actualVersion: 5 }),
            { status: 409 },
          ),
  });
  assert.equal(
    await api.effectiveScope('channel=LINE|contactKind=*|purpose=*|sourceType=*'),
    undefined,
  );
  await assert.rejects(api.exception(SERIES_ID), (error: unknown) => {
    assert.ok(error instanceof GovernanceApiError);
    assert.equal(error.code, 'VERSION_CONFLICT');
    assert.deepEqual(error.details, { expectedVersion: 4, actualVersion: 5 });
    return true;
  });
});

test('ไม่มี access token ไม่ส่ง request ใดเลย', async () => {
  let called = false;
  const api = createGovernanceApi({
    baseUrl: 'https://api.example',
    accessToken: () => undefined,
    fetch: async () => {
      called = true;
      return new Response('{}');
    },
  });
  await assert.rejects(api.killSwitches(), GovernanceApiError);
  assert.equal(called, false);
});

test('publish ที่ยังไม่มี approval digest ถูกปฏิเสธก่อนถึง server', async () => {
  const api = createGovernanceApi({
    baseUrl: 'https://api.example',
    accessToken: () => 'token',
    fetch: async () => {
      throw new Error('ต้องไม่ถูกเรียก');
    },
  });
  await assert.rejects(
    api.publishPolicy({
      version: { policyVersionId: SERIES_ID, contentDigest: DIGEST } as never,
      artifact: { artifactDigest: DIGEST } as never,
      head: { headVersion: 1, headDigest: DIGEST } as never,
      evidenceRef: 'TICKET-2',
      idempotencyKey: 'k',
    }),
    (error: unknown) => error instanceof GovernanceApiError && error.code === 'APPROVAL_REQUIRED',
  );
});

test('คิวเรียงรายการที่รอตัดสินก่อน แล้วความเสี่ยงสูงก่อน แล้วหมดอายุก่อน', () => {
  const ordered = sortExceptionQueue([
    series({ seriesId: 'approved', workflowState: 'APPROVED', riskTier: 'EMERGENCY' }),
    series({
      seriesId: 'standard-late',
      riskTier: 'STANDARD',
      expiresAt: '2026-09-16T00:00:00.000Z',
    }),
    series({ seriesId: 'high', riskTier: 'HIGH' }),
    series({
      seriesId: 'standard-early',
      riskTier: 'STANDARD',
      expiresAt: '2026-09-15T20:00:00.000Z',
    }),
  ]);
  assert.deepEqual(
    ordered.map((item) => item.seriesId),
    ['high', 'standard-early', 'standard-late', 'approved'],
  );
});

test('reference ที่ปกปิดแสดงเป็น digest เท่านั้น', () => {
  assert.equal(
    referenceLabel({ redacted: true, digest: '0123456789abcdef' }, tTh),
    'ปกปิด · digest …abcdef',
  );
  assert.equal(
    referenceLabel({ redacted: true, digest: '0123456789abcdef' }, tEn),
    'Redacted · digest …abcdef',
  );
  assert.equal(referenceLabel('TICKET-9', tTh), 'TICKET-9');
  assert.equal(referenceLabel(undefined, tTh), '—');
});

test('recovery ของ stale/conflict ต้องโหลดใหม่ ส่วนผลไม่แน่ชัดส่งซ้ำได้ด้วย key เดิมเท่านั้น', () => {
  assert.deepEqual(
    [recoveryFor(new GovernanceApiError(422, 'APPROVAL_STALE'), tTh)].map((state) => [
      state.kind,
      state.recovery,
    ]),
    [['STALE_APPROVAL', 'RELOAD']],
  );
  const conflict = recoveryFor(
    new GovernanceApiError(409, 'VERSION_CONFLICT', { expectedVersion: 4, actualVersion: 6 }),
    tTh,
  );
  assert.equal(conflict.kind, 'VERSION_CONFLICT');
  assert.match(conflict.message, /v4.*v6/);
  assert.equal(
    recoveryFor(new GovernanceApiError(409, 'POLICY_HEAD_CONFLICT'), tTh).kind,
    'HEAD_CONFLICT',
  );
  assert.equal(
    recoveryFor(new GovernanceApiError(403, 'SELF_APPROVAL_FORBIDDEN'), tTh).recovery,
    'NONE',
  );
  assert.deepEqual(
    [recoveryFor(new GovernanceApiError(503, 'GOVERNANCE_STATE_UNAVAILABLE'), tTh)].map((state) => [
      state.kind,
      state.recovery,
    ]),
    [['OUTCOME_UNKNOWN', 'SAME_KEY']],
  );
  assert.equal(recoveryFor(new TypeError('Failed to fetch'), tTh).recovery, 'SAME_KEY');
});

test('ข้อความ recovery มาจาก catalog ตามภาษา และ logic (kind/recovery) ไม่ขึ้นกับภาษา', () => {
  const conflict = new GovernanceApiError(409, 'VERSION_CONFLICT', {
    expectedVersion: 4,
    actualVersion: 6,
  });
  const th = recoveryFor(conflict, tTh);
  const en = recoveryFor(conflict, tEn);
  assert.deepEqual([th.kind, th.recovery], [en.kind, en.recovery]);
  assert.equal(
    th.message,
    'ข้อมูลถูกเปลี่ยนจากที่อื่นแล้ว (คาด v4 แต่ปัจจุบันเป็น v6) ระบบไม่รวมการแก้ไขให้อัตโนมัติ: โหลด canonical version ก่อนตัดสินใหม่',
  );
  assert.equal(
    en.message,
    'The data was changed elsewhere (expected v4, now v6). The system does not merge edits automatically: load the canonical version before deciding again.',
  );
  const lifecycle = recoveryFor(
    new GovernanceApiError(422, 'QUORUM_NOT_MET', { required: 2, current: 1 }),
    tEn,
  );
  assert.equal(lifecycle.message, 'This step is not available: QUORUM_NOT_MET (1/2)');
});

test('catalog อังกฤษของ Governance ไม่มีอักษรไทยเหลืออยู่', () => {
  const thai = /[฀-๿]/;
  const bad: string[] = [];
  const walk = (node: unknown, path: string) => {
    if (typeof node === 'string') {
      if (thai.test(node)) bad.push(path);
    } else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) walk(value, `${path}.${key}`);
    }
  };
  walk(enCatalog, 'en');
  assert.deepEqual(bad, []);
});

test('URL รับเฉพาะ opaque UUID และทิ้งค่าอื่น เช่น อีเมลหรือเบอร์โทร', () => {
  const location = parseGovernanceLocation(
    new URL(
      `https://console.local/?view=governance&section=exceptions&contactId=someone@example.com&seriesId=${SERIES_ID}&policyId=0812345678`,
    ),
  );
  assert.deepEqual(location, { section: 'exceptions', seriesId: SERIES_ID });
  assert.equal(
    governanceHref({ section: 'audit', seriesId: SERIES_ID, contactId: 'not-a-uuid' }),
    `?view=governance&section=audit&seriesId=${SERIES_ID}`,
  );
  assert.equal(
    parseGovernanceLocation(new URL('https://console.local/?section=evil')).section,
    'overview',
  );
});
