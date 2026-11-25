import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryWebStorage } from 'oidc-client-ts';
import {
  allowPlatformSessionRestore,
  beginPlatformSessionRestore,
  cleanCallbackUrl,
  hasAttemptedPlatformSessionRestore,
  pausePlatformSessionRestore,
} from './auth.js';
import {
  EMPTY_DRAFT,
  RECOVERY_OPTIONS,
  currentStep,
  draftToRequestBody,
  errorMessageKey,
  actionLabel,
  actorLabelKey,
  blockedReasonKey,
  statusPresentation,
  stepPresentation,
  deliveryMessageKey,
  outcomeMessageKey,
  fieldErrorsToDraft,
  isHandoffReady,
  parseRoute,
  readOnlyCopy,
  routePath,
  shouldPoll,
  validateDraft,
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

test('validateDraft: valid values pass; a wrong slug/domain/email/plan reports every field', () => {
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

test('draftToRequestBody: basic canonicalization and no tenant/status for the browser to set', () => {
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

test('fieldErrorsToDraft: the API field names map back into the form', () => {
  assert.deepEqual(
    fieldErrorsToDraft({ 'firstAdmin.email': 'INVALID', timezone: 'INVALID', unknown: 'X' }),
    {
      firstAdminEmail: 'validation.serverInvalid',
      timezone: 'validation.serverInvalid',
    },
  );
});

test('recovery: Reconcile & resume is recommended first, followed by Retry, Safe compensate, FAILED_FINAL', () => {
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

test('status: poll only PENDING/RUNNING; ready for handoff only SUCCEEDED', () => {
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

test('route: only a UUID requestId — any other path returns to the list; no search term in the URL', () => {
  const id = '0ecbd23a-3cb9-4992-8577-b3039abb5a07';
  assert.deepEqual(parseRoute(`/requests/${id}`), { name: 'request', requestId: id });
  assert.deepEqual(parseRoute('/requests/owner@example.test'), { name: 'list' });
  assert.deepEqual(parseRoute('/new'), { name: 'new' });
  assert.equal(routePath({ name: 'request', requestId: id }), `/requests/${id}`);
  assert.equal(routePath({ name: 'list' }), '/');
});

test('OIDC callback: removes code/state from the URL', () => {
  assert.equal(
    cleanCallbackUrl(
      new URL('http://localhost:5180/requests/x?code=secret&state=s&session_state=y&keep=1'),
    ),
    '/requests/x?keep=1',
  );
});

test('OIDC refresh: the marker has no token and does not redirect in a loop when the session expires', () => {
  const storage = new InMemoryWebStorage();
  assert.equal(beginPlatformSessionRestore(storage), true);
  assert.equal(hasAttemptedPlatformSessionRestore(storage), true);
  assert.equal(storage.length, 1);
  assert.equal(storage.getItem(storage.key(0)!), '1');
  assert.equal(beginPlatformSessionRestore(storage), false);
  allowPlatformSessionRestore(storage);
  assert.equal(beginPlatformSessionRestore(storage), true);
  pausePlatformSessionRestore(storage);
  assert.equal(beginPlatformSessionRestore(storage), false);
});

test('OIDC callback error: removes error/state so it is not processed again after a refresh', () => {
  assert.equal(
    cleanCallbackUrl(
      new URL(
        'https://platform-uat.osd.co.th/?error=login_required&error_description=x&state=s&keep=1',
      ),
    ),
    '/?keep=1',
  );
});

test('unknown error/state/action use generic keys and do not read the raw server title', () => {
  assert.equal(errorMessageKey({ code: 'REVISION_CONFLICT' }), 'errors.REVISION_CONFLICT');
  for (const code of [undefined, null, '', 'NEW_ERROR', '__proto__', 'constructor']) {
    assert.equal(errorMessageKey({ code }), 'errors.generic');
  }
  for (const code of [undefined, '', 'NEW_VALUE', '__proto__', 'constructor']) {
    assert.equal(actionLabel(code), 'actions.unknown');
    assert.equal(actorLabelKey(code), 'actors.unknown');
    assert.equal(blockedReasonKey(code), 'blocked.unknown');
    assert.equal(statusPresentation(code).label, 'statuses.unknown');
    assert.equal(statusPresentation(code).tone, 'warning');
    assert.equal(stepPresentation(code).title, 'steps.unknown.title');
    assert.equal(deliveryMessageKey(code), 'invitation.delivery.unknown');
    assert.equal(outcomeMessageKey(code), 'outcomes.unknown');
  }
  assert.equal(isHandoffReady({ status: 'UNKNOWN' as never }), false);
  assert.equal(shouldPoll('UNKNOWN' as never), false);
  assert.deepEqual(
    fieldErrorsToDraft({
      'firstAdmin.email': 'RAW_SERVER_SECRET',
      timezone: 'TENANT_DOMAIN_CONFLICT',
      unknown: 'INVALID',
      constructor: 'INVALID',
      ['__proto__']: 'INVALID',
    }),
    {
      firstAdminEmail: 'validation.serverInvalid',
      timezone: 'errors.TENANT_DOMAIN_CONFLICT',
    },
  );
});

test('A1.8 readOnlyCopy: separates the auditor, an operator with rollout off, and an operator outside the canary', () => {
  const base = { subject: 's', roles: ['platform_operator'], capabilities: [], expiresAt: '' };
  assert.equal(readOnlyCopy({ ...base, roles: ['platform_auditor'] }).banner, null);
  assert.equal(readOnlyCopy({ ...base, mutations: 'DISABLED' }).banner, 'readOnly.disabledBanner');
  assert.equal(readOnlyCopy({ ...base, mutations: 'NOT_ALLOWLISTED' }).chip, 'identity.canary');
  assert.equal(errorMessageKey({ code: 'PROVISIONING_DISABLED' }), 'errors.PROVISIONING_DISABLED');
});
