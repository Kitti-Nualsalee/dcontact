import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanCallbackUrl } from './auth.js';
import {
  EMPTY_DRAFT,
  RECOVERY_OPTIONS,
  currentStep,
  describeHistory,
  draftToRequestBody,
  errorMessage,
  fieldErrorsToDraft,
  isHandoffReady,
  parseRoute,
  readOnlyCopy,
  routePath,
  shouldPoll,
  validateDraft,
  type ActionHistoryItem,
  type TenantDraft,
} from './model.js';

const VALID: TenantDraft = {
  ...EMPTY_DRAFT,
  displayName: 'Nova Care Thailand',
  slug: 'Nova-Care',
  primaryDomain: 'novacare.co.th.',
  planCode: 'growth',
  bootstrapTemplateVersion: 'baseline-v1',
  firstAdminDisplayName: 'Narin',
  firstAdminEmail: 'narin@novacare.co.th',
};

test('validateDraft: ค่าถูกต้องผ่าน; slug/domain/email/plan ผิดแจ้งทุกช่อง', () => {
  assert.deepEqual(validateDraft(VALID), {});
  const errors = validateDraft({
    ...EMPTY_DRAFT,
    displayName: 'x',
    slug: 'bad--slug',
    primaryDomain: 'localhost',
    firstAdminEmail: 'not-an-email',
  });
  assert.deepEqual(Object.keys(errors).sort(), [
    'bootstrapTemplateVersion',
    'displayName',
    'firstAdminDisplayName',
    'firstAdminEmail',
    'planCode',
    'primaryDomain',
    'slug',
  ]);
  assert.ok(validateDraft({ ...VALID, slug: '-lead' }).slug);
});

test('draftToRequestBody: canonical เบื้องต้นและไม่มี tenant/status ให้ browser กำหนด', () => {
  const body = draftToRequestBody(VALID);
  assert.equal(body.slug, 'nova-care');
  assert.equal(body.primaryDomain, 'novacare.co.th');
  assert.deepEqual(Object.keys(body).sort(), [
    'bootstrapTemplateVersion',
    'displayName',
    'firstAdmin',
    'locale',
    'planCode',
    'primaryDomain',
    'slug',
    'timezone',
  ]);
});

test('fieldErrorsToDraft: ชื่อ field ของ API map กลับเข้า form', () => {
  assert.deepEqual(
    fieldErrorsToDraft({ 'firstAdmin.email': 'INVALID', timezone: 'INVALID', unknown: 'X' }),
    {
      firstAdminEmail: 'ระบบตรวจแล้วว่าค่านี้ไม่ถูกต้อง',
      timezone: 'ระบบตรวจแล้วว่าค่านี้ไม่ถูกต้อง',
    },
  );
});

test('recovery: Reconcile & resume แนะนำเป็นตัวแรก ตามด้วย Retry, Safe compensate, FAILED_FINAL', () => {
  assert.deepEqual(
    RECOVERY_OPTIONS.map((option) => [option.action, option.recommended, option.destructive]),
    [
      ['RECONCILE', true, false],
      ['RETRY_STEP', false, false],
      ['SAFE_COMPENSATE', false, true],
      ['MARK_FAILED_FINAL', false, true],
    ],
  );
});

test('สถานะ: poll เฉพาะ PENDING/RUNNING; พร้อมส่งมอบเฉพาะ SUCCEEDED', () => {
  assert.deepEqual(
    (['PENDING', 'RUNNING', 'ACTION_REQUIRED', 'SUCCEEDED', 'FAILED_FINAL'] as const).map(
      shouldPoll,
    ),
    [true, true, false, false, false],
  );
  assert.equal(isHandoffReady({ status: 'RUNNING' }), false);
  assert.equal(isHandoffReady({ status: 'SUCCEEDED' }), true);
  assert.equal(
    currentStep({
      steps: [
        {
          stepKey: 'TENANT_RECORD',
          state: 'SUCCEEDED',
          attempt: 0,
          errorCode: null,
          nextAttemptAt: null,
          finishedAt: null,
        },
        {
          stepKey: 'KEYCLOAK_ORGANIZATION',
          state: 'ACTION_REQUIRED',
          attempt: 2,
          errorCode: 'X',
          nextAttemptAt: null,
          finishedAt: null,
        },
      ],
    })?.stepKey,
    'KEYCLOAK_ORGANIZATION',
  );
});

test('route: มีแค่ requestId แบบ UUID — path อื่นกลับหน้า list; ไม่มีคำค้นหาใน URL', () => {
  const id = '0ecbd23a-3cb9-4992-8577-b3039abb5a07';
  assert.deepEqual(parseRoute(`/requests/${id}`), { name: 'request', requestId: id });
  assert.deepEqual(parseRoute('/requests/owner@example.test'), { name: 'list' });
  assert.deepEqual(parseRoute('/new'), { name: 'new' });
  assert.equal(routePath({ name: 'request', requestId: id }), `/requests/${id}`);
  assert.equal(routePath({ name: 'list' }), '/');
});

test('OIDC callback: ลบ code/state ออกจาก URL', () => {
  assert.equal(
    cleanCallbackUrl(
      new URL('http://localhost:5180/requests/x?code=secret&state=s&session_state=y&keep=1'),
    ),
    '/requests/x?keep=1',
  );
});

test('timeline/error: คำอธิบายมีแค่ code/state และ error code ที่ไม่รู้จักใช้ title ของ API', () => {
  const item: ActionHistoryItem = {
    id: 'a',
    requestId: 'r',
    action: 'STEP_ACTION_REQUIRED',
    outcome: 'SUCCEEDED',
    actor: { kind: 'SYSTEM', subject: 'provisioning-worker:x', role: null },
    stepKey: 'FIRST_ADMIN',
    attempt: 2,
    beforeState: null,
    afterState: null,
    reasonCode: null,
    comment: null,
    errorCode: 'FIRST_ADMIN_EMAIL_CONFLICT',
    correlationId: 'corr',
    occurredAt: '2026-09-24T00:00:00.000Z',
  };
  assert.equal(describeHistory(item), 'สร้าง First admin · attempt 2 · FIRST_ADMIN_EMAIL_CONFLICT');
  assert.equal(errorMessage({ code: 'REVISION_CONFLICT', title: 'x' }).includes('โหลดใหม่'), true);
  assert.equal(errorMessage({ code: 'SOMETHING_NEW', title: 'จาก API' }), 'จาก API');
});

test('A1.8 readOnlyCopy: แยก auditor, operator ที่ rollout ปิด และ operator นอก canary', () => {
  const base = { subject: 's', roles: ['platform_operator'], capabilities: [], expiresAt: '' };
  assert.equal(readOnlyCopy({ ...base, roles: ['platform_auditor'] }).banner, null);
  assert.match(
    readOnlyCopy({ ...base, mutations: 'DISABLED' }).banner ?? '',
    /ปิดการสร้างและแก้ไข/,
  );
  assert.match(readOnlyCopy({ ...base, mutations: 'NOT_ALLOWLISTED' }).chip, /canary/);
  assert.equal(errorMessage({ code: 'PROVISIONING_DISABLED', title: '' }).includes('ปิด'), true);
});
