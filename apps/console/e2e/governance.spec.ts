import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Request } from '@playwright/test';
import { th } from './support/catalog';

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const MAIN_NAV = new RegExp(`${escapeRegExp(th('ui:shell.mainNav'))}|Main navigation`);
const BREADCRUMB = new RegExp(`${escapeRegExp(th('ui:shell.breadcrumb'))}|Current location`);

// the Governance page text comes from the catalog per the user's language (#662): the main suite checks Thai, and English is in the describe at the end of the file
test.use({ locale: 'th-TH' });

/**
 * CG4.9 (#192): Hybrid Governance Console end-to-end
 *
 * Mock only the D-Contact API (`/api/v1/contact-governance/**`) — any other request outside the Console's origin
 * counts as a provider/network call that must not happen; all data is synthetic with no PII
 */

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const DIGEST_C = 'c'.repeat(64);
const CONTACT_ID = 'c3c4d9a1-5b7e-4f2a-9c1d-3e5f7a9b1c13';
const HIGH_ID = '3d6f7a52-3f0b-4f25-9a8b-6c2b3f7a0a11';
const STANDARD_ID = '6a1e2b3c-4d5e-4f60-8a7b-9c0d1e2f3a22';
const APPROVED_ID = '7b2f3c4d-5e6f-4a71-9b8c-0d1e2f3a4b33';
const POLICY_ID = 'e1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a14';
const VERSION_2 = 'f2a3b4c5-d6e7-4f80-9a1b-2c3d4e5f6a55';
const VERSION_3 = 'a3b4c5d6-e7f8-4a91-8b2c-3d4e5f6a7b66';
const SCOPE_KEY = 'channel=LINE|contactKind=*|purpose=MARKETING|sourceType=*';

function exception(seriesId: string, overrides: Record<string, unknown> = {}) {
  return {
    seriesId,
    revisionId: `${seriesId.slice(0, 8)}-0000-4000-8000-000000000001`,
    revision: 1,
    contactId: CONTACT_ID,
    scopeKind: 'CONTACT_WIDE',
    channel: 'LINE',
    purpose: 'MARKETING',
    sourceType: 'JOURNEY',
    sourceId: 'journey-synthetic-1',
    allowedRuleCodes: ['QUIET_HOURS'],
    policyId: POLICY_ID,
    policyVersion: 1,
    policyContentDigest: DIGEST_A,
    registryVersion: 'CG4_RULE_REGISTRY_V1',
    startsAt: '2026-09-15T19:00:00.000Z',
    expiresAt: '2026-09-15T22:00:00.000Z',
    riskTier: 'STANDARD',
    reasonCode: 'CUSTOMER_CALLBACK',
    contentDigest: DIGEST_B,
    createdAt: '2026-09-15T18:00:00.000Z',
    evidenceRef: 'INC-4821',
    actorRef: 'maker-subject-synthetic',
    workflowState: 'PENDING',
    effectiveState: 'INACTIVE',
    aggregateVersion: 4,
    etag: `"cg4-exception:${seriesId}:1:bbbbbbbbbbbbbbbb"`,
    ...overrides,
  };
}

function policyVersion(id: string, version: number, overrides: Record<string, unknown> = {}) {
  return {
    policyId: POLICY_ID,
    policyVersionId: id,
    version,
    draftRevision: 1,
    scopeKey: SCOPE_KEY,
    lifecycleState: 'IN_REVIEW',
    contentDigest: DIGEST_A,
    schemaVersion: 1,
    registryVersion: 'CG4_RULE_REGISTRY_V1',
    evaluatorVersion: 'CG4_EVALUATOR_V1',
    diffClass: 'RELAXATION',
    effectiveFrom: '2026-09-15T00:00:00.000Z',
    makerActorRef: 'policy-maker-synthetic',
    createdAt: `2026-09-1${version}T00:00:00.000Z`,
    etag: `"cg4-policy:${POLICY_ID}:${version}:1"`,
    ...overrides,
  };
}

function artifact(baseHeadVersion: number) {
  return {
    artifactId: '0e1f2a3b-4c5d-4e6f-8a7b-8c9d0e1f2a77',
    policyId: POLICY_ID,
    policyVersion: 2,
    suiteVersion: 'TENANT_SYNTHETIC_V1',
    artifactDigest: DIGEST_C,
    contentDigest: DIGEST_A,
    baseHeadVersion,
    baseHeadDigest: DIGEST_B,
    diffClass: 'RELAXATION',
    outcome: 'PASSED',
    passed: 18,
    failed: 0,
    createdAt: '2026-09-14T01:00:00.000Z',
  };
}

function head(headVersion: number) {
  return {
    scopeKey: SCOPE_KEY,
    headVersion,
    headDigest: DIGEST_B,
    activePolicyId: POLICY_ID,
    activePolicyVersionId: VERSION_2,
    activePolicyVersion: 1,
    killSwitchActive: false,
    updatedAt: '2026-09-14T00:00:00.000Z',
    etag: `"cg4-scope:${SCOPE_KEY}:${headVersion}"`,
  };
}

type Reply = { status?: number; body: unknown };
type Handler = (request: Request) => Reply | Promise<Reply>;

interface Mock {
  requests: Request[];
  on(method: string, path: RegExp, handler: Handler): void;
}

/**
 * #654: the Navigation API that ConsoleShell calls — the default flag `ui.shell.v2` is off (the original page exactly);
 * `shellV2: true` = the Governance page is in the shell (area rail + submenu)
 */
const GOVERNANCE_PAGES = ['overview', 'exceptions', 'policies', 'audit'].map((id) => ({
  id,
  labelKey: `navigation.pages.contactGovernance.${id}`,
  path: `/?view=governance&section=${id}`,
}));

async function mockNavigation(page: Page, shellV2: boolean, pages = false) {
  await page.route('**/api/v1/me/navigation', (route) =>
    route.fulfill({
      status: 200,
      json: {
        groups: [
          { id: 'live', labelKey: 'navigation.groups.live' },
          { id: 'quality', labelKey: 'navigation.groups.quality' },
        ],
        apps: [
          {
            id: 'agent-workspace',
            groupId: 'live',
            labelKey: 'navigation.apps.agentWorkspace',
            hostApp: 'workspace',
            path: '/',
          },
          {
            id: 'contact-governance',
            groupId: 'quality',
            labelKey: 'navigation.apps.contactGovernance',
            hostApp: 'console',
            path: '/?view=governance',
          },
        ],
        areas: [
          {
            id: 'workspace',
            labelKey: 'navigation.areas.workspace',
            sections: [
              {
                id: 'work',
                labelKey: 'navigation.sections.work',
                items: [{ appId: 'agent-workspace' }],
              },
            ],
          },
          {
            id: 'governance',
            labelKey: 'navigation.areas.governance',
            sections: [
              {
                id: 'work',
                labelKey: 'navigation.sections.work',
                items: [
                  { appId: 'contact-governance', ...(pages ? { pages: GOVERNANCE_PAGES } : {}) },
                ],
              },
            ],
          },
        ],
        pins: { appIds: [], source: 'SYSTEM', revision: 0 },
        limits: { maxPins: 15 },
        features: { shellV2 },
      },
    }),
  );
}

async function mockGovernance(
  page: Page,
  options: { shellV2?: boolean; pages?: boolean } = {},
): Promise<Mock> {
  await mockNavigation(page, options.shellV2 === true, options.pages === true);
  const handlers: Array<[string, RegExp, Handler]> = [];
  const requests: Request[] = [];
  await page.route('**/api/v1/contact-governance/**', async (route) => {
    const request = route.request();
    requests.push(request);
    const path = new URL(request.url()).pathname.replace('/api/v1/contact-governance', '');
    // a handler registered later wins, so each test can override the default
    const match = [...handlers]
      .reverse()
      .find(([method, pattern]) => method === request.method() && pattern.test(path));
    const reply = match
      ? await match[2](request)
      : { status: 404, body: { code: 'RESOURCE_NOT_FOUND' } };
    await route.fulfill({
      status: reply.status ?? 200,
      contentType: 'application/json',
      body: JSON.stringify(reply.body),
    });
  });
  const mock: Mock = {
    requests,
    on: (method, path, handler) => handlers.push([method, path, handler]),
  };
  mock.on('GET', /^\/kill-switches$/, () => ({ body: { killSwitches: [] } }));
  mock.on('GET', /^\/metrics$/, () => ({ body: { asOf: '2026-09-20T00:00:00.000Z', items: [] } }));
  mock.on('GET', /^\/metrics\/policy-impact$/, () => ({
    body: { asOf: '2026-09-20T00:00:00.000Z', items: [] },
  }));
  mock.on('GET', /^\/alerts$/, () => ({ body: { asOf: '2026-09-20T00:00:00.000Z', items: [] } }));
  mock.on('GET', /^\/exports$/, () => ({ body: { items: [] } }));
  return mock;
}

/**
 * collect console errors and requests that go outside the origin; an HTTP error the test deliberately has the server return is
 * logged by Chromium as "Failed to load resource", which is only the expected result of that scenario
 */
function watchPage(page: Page, options: { allowHttpErrors?: boolean } = {}) {
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (options.allowHttpErrors && message.text().startsWith('Failed to load resource')) return;
    problems.push(message.text());
  });
  page.on('pageerror', (error) => problems.push(error.message));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin !== 'http://127.0.0.1:5174' && !url.protocol.startsWith('data')) {
      problems.push(`request outside the D-Contact origin: ${url.origin}`);
    }
  });
  return problems;
}

function exceptionRoutes(mock: Mock, detail: Record<string, unknown> = {}) {
  mock.on('GET', new RegExp(`^/contacts/${CONTACT_ID}/exceptions$`), () => ({
    body: {
      contactId: CONTACT_ID,
      exceptions: [
        exception(STANDARD_ID),
        exception(APPROVED_ID, { workflowState: 'APPROVED', riskTier: 'EMERGENCY' }),
        exception(HIGH_ID, { riskTier: 'HIGH', ...detail }),
      ],
    },
  }));
  mock.on('GET', new RegExp(`^/exceptions/${HIGH_ID}$`), () => ({
    body: exception(HIGH_ID, { riskTier: 'HIGH', ...detail }),
  }));
  mock.on('GET', new RegExp(`^/exceptions/${HIGH_ID}/approvals$`), () => ({
    body: { seriesId: HIGH_ID, revision: 1, approvals: [] },
  }));
  // other items in the queue must have detail too, otherwise selecting them gets a 404 that the test did not intend
  mock.on('GET', new RegExp(`^/exceptions/${STANDARD_ID}$`), () => ({
    body: exception(STANDARD_ID, detail),
  }));
  mock.on('GET', new RegExp(`^/exceptions/${STANDARD_ID}/approvals$`), () => ({
    body: { seriesId: STANDARD_ID, revision: 1, approvals: [] },
  }));
}

const workspaceUrl = (viewer = 'COMPLIANCE', seriesId?: string) =>
  `/?view=governance&section=exceptions&contactId=${CONTACT_ID}${seriesId ? `&seriesId=${seriesId}` : ''}&viewer=${viewer}`;

test('A: the queue is ordered by risk, approve by keyboard binds revision/digest/version and is not treated as ALLOW', async ({
  page,
}) => {
  const problems = watchPage(page);
  const mock = await mockGovernance(page);
  exceptionRoutes(mock);
  let approval: Request | undefined;
  mock.on('POST', new RegExp(`^/exceptions/${HIGH_ID}/approvals$`), (request) => {
    approval = request;
    return {
      body: {
        seriesId: HIGH_ID,
        revision: 1,
        quorum: { status: 'PENDING', required: 2, current: 1 },
      },
    };
  });

  await page.goto(workspaceUrl());
  const queue = page.getByRole('complementary', { name: th('governance:exceptions.queue.label') });
  await expect(queue.getByRole('button').first()).toContainText('▲ HIGH');
  await expect(queue.getByRole('button').first()).toHaveAttribute('aria-current', 'true');
  await expect(page.getByText(th('governance:guardrails.title'))).toBeVisible();
  await expect(page.getByText('Evidence: INC-4821')).toBeVisible();

  await page.getByRole('button', { name: th('governance:exceptions.checker.approve') }).focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', {
    name: th('governance:exceptions.dialog.approveTitle'),
  });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Evidence reference')).toBeFocused();
  await page.keyboard.type('TICKET-SYN-77');
  await page.keyboard.press('Enter');

  await expect(page.getByRole('status')).toContainText(
    th('governance:exceptions.message.recorded', { current: 1, required: 2 }),
  );
  expect(approval?.headers()['idempotency-key']).toEqual(expect.any(String));
  expect(approval?.postDataJSON()).toEqual({
    decision: 'APPROVE',
    expectedRevision: 1,
    expectedContentDigest: DIGEST_B,
    expectedVersion: 4,
    evidenceRef: 'TICKET-SYN-77',
  });
  await expect(
    page.getByRole('button', { name: th('governance:exceptions.checker.approve') }),
  ).toBeFocused();
  expect(problems).toEqual([]);
});

test('redaction: a Supervisor sees only the digest, has no decide button, and has no raw data in the URL', async ({
  page,
}) => {
  const problems = watchPage(page);
  const mock = await mockGovernance(page);
  exceptionRoutes(mock, {
    evidenceRef: { redacted: true, digest: '0123456789abcdef' },
    actorRef: { redacted: true, digest: 'fedcba9876543210' },
  });

  await page.goto(workspaceUrl('SUPERVISOR'));
  await expect(
    page.getByText(
      th('governance:exceptions.evidence.evidence', {
        ref: th('governance:reference.redacted', { tail: 'abcdef' }),
      }),
    ),
  ).toBeVisible();
  await expect(page.getByText(th('governance:exceptions.evidence.redacted'))).toBeVisible();
  await expect(
    page.getByRole('button', { name: th('governance:exceptions.checker.approve') }),
  ).toHaveCount(0);
  await expect(page.getByText(th('governance:exceptions.checker.readOnly'))).toBeVisible();
  await expect(page.locator('body')).not.toContainText('INC-4821');

  await page
    .getByRole('complementary', { name: th('governance:exceptions.queue.label') })
    .getByRole('button')
    .nth(1)
    .click();
  // wait for the selected item to fully load from the API so that console errors of that request are counted too
  await expect(page.getByText('EXCEPTION 6a1e2b3c…')).toBeVisible();
  expect(new URL(page.url()).search).toMatch(
    /^\?view=governance&section=exceptions&contactId=[0-9a-f-]{36}&seriesId=[0-9a-f-]{36}$/,
  );
  expect(problems).toEqual([]);
});

test('stale approval: block the action until the canonical state is reloaded', async ({ page }) => {
  const problems = watchPage(page, { allowHttpErrors: true });
  const mock = await mockGovernance(page);
  exceptionRoutes(mock);
  mock.on('POST', new RegExp(`^/exceptions/${HIGH_ID}/approvals$`), () => ({
    status: 422,
    body: { code: 'APPROVAL_STALE' },
  }));

  await page.goto(workspaceUrl());
  await page.getByRole('button', { name: th('governance:exceptions.checker.approve') }).click();
  await page.getByLabel('Evidence reference').fill('TICKET-SYN-78');
  await page.getByRole('button', { name: th('governance:exceptions.dialog.approveTitle') }).click();

  const alert = page
    .getByRole('alert')
    .filter({ hasText: th('governance:recovery.title.STALE_APPROVAL') });
  await expect(alert).toBeVisible();
  await expect(
    page.getByRole('button', { name: th('governance:exceptions.checker.approve') }),
  ).toBeDisabled();
  await alert.getByRole('button', { name: th('governance:recovery.reload') }).click();
  await expect(alert).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: th('governance:exceptions.checker.approve') }),
  ).toBeEnabled();
  expect(problems).toEqual([]);
});

test('version conflict: show expected/current and do not resend the command by itself', async ({
  page,
}) => {
  const problems = watchPage(page, { allowHttpErrors: true });
  const mock = await mockGovernance(page);
  exceptionRoutes(mock, { workflowState: 'APPROVED', effectiveState: 'ACTIVE' });
  let revokes = 0;
  mock.on('POST', new RegExp(`^/exceptions/${HIGH_ID}/revoke$`), () => {
    revokes += 1;
    return {
      status: 409,
      body: { code: 'VERSION_CONFLICT', expectedVersion: 4, actualVersion: 5 },
    };
  });

  // the item awaiting a decision is at the head of the queue, so open the approved series directly with the opaque ID
  await page.goto(workspaceUrl('COMPLIANCE', HIGH_ID));
  await page.getByRole('button', { name: 'Revoke exception' }).click();
  await page.getByLabel('Reason code').fill('COMPLIANCE_WITHDRAWN');
  await page.getByLabel('Evidence reference').fill('TICKET-SYN-79');
  await page
    .getByRole('button', { name: th('governance:exceptions.dialog.revokeConfirm') })
    .click();

  await expect(page.getByRole('alert').filter({ hasText: 'Version conflict' })).toContainText(
    th('governance:recovery.message.versions', { expected: 4, actual: 5 }).trim(),
  );
  await expect(page.getByRole('button', { name: 'Revoke exception' })).toBeDisabled();
  expect(revokes).toBe(1);
  expect(problems).toEqual([]);
});

test('uncertain result: resend only with the original Idempotency-Key', async ({ page }) => {
  const problems = watchPage(page, { allowHttpErrors: true });
  const mock = await mockGovernance(page);
  exceptionRoutes(mock);
  const keys: string[] = [];
  mock.on('POST', new RegExp(`^/exceptions/${HIGH_ID}/approvals$`), (request) => {
    keys.push(request.headers()['idempotency-key'] ?? '');
    return keys.length === 1
      ? { status: 503, body: { code: 'GOVERNANCE_STATE_UNAVAILABLE' } }
      : {
          body: {
            seriesId: HIGH_ID,
            revision: 1,
            quorum: { status: 'PENDING', required: 2, current: 1 },
          },
        };
  });

  await page.goto(workspaceUrl());
  await page.getByRole('button', { name: th('governance:exceptions.checker.approve') }).click();
  await page.getByLabel('Evidence reference').fill('TICKET-SYN-80');
  await page.getByRole('button', { name: th('governance:exceptions.dialog.approveTitle') }).click();
  const alert = page
    .getByRole('alert')
    .filter({ hasText: th('governance:recovery.title.OUTCOME_UNKNOWN') });
  await expect(alert).toBeVisible();
  await expect(
    page.getByRole('button', { name: th('governance:exceptions.checker.approve') }),
  ).toBeDisabled();

  await alert.getByRole('button', { name: th('governance:recovery.retry') }).click();
  await page.getByLabel('Evidence reference').fill('TICKET-SYN-80');
  await page.getByRole('button', { name: th('governance:exceptions.dialog.approveTitle') }).click();
  await expect(page.getByRole('status')).toContainText(
    th('governance:exceptions.message.recorded', { current: 1, required: 2 }),
  );
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
  expect(problems).toEqual([]);
});

function policyRoutes(
  mock: Mock,
  options: { version: Record<string, unknown>; baseHead: number; currentHead: number },
) {
  const current = policyVersion(VERSION_2, 2, options.version);
  mock.on('GET', new RegExp(`^/policies/${POLICY_ID}/versions$`), () => ({
    body: {
      policyId: POLICY_ID,
      versions: [policyVersion(VERSION_3, 1, { lifecycleState: 'SUPERSEDED' }), current],
    },
  }));
  mock.on('GET', new RegExp(`^/policy-versions/${VERSION_2}$`), () => ({ body: current }));
  mock.on('GET', new RegExp(`^/policy-versions/${VERSION_2}/tests$`), () => ({
    body: { policyVersionId: VERSION_2, artifacts: [artifact(options.baseHead)] },
  }));
  mock.on('GET', new RegExp(`^/policy-versions/${VERSION_2}/approvals$`), () => ({
    body: { policyVersionId: VERSION_2, approvals: [] },
  }));
  mock.on('GET', /^\/policy-scopes\/.+\/effective$/, () => ({ body: head(options.currentHead) }));
}

const studioUrl = `/?view=governance&section=policies&policyId=${POLICY_ID}&versionId=${VERSION_2}&viewer=COMPLIANCE`;

test('B: a policy head that changed after testing blocks approval before reaching the server', async ({
  page,
}) => {
  const problems = watchPage(page);
  const mock = await mockGovernance(page);
  policyRoutes(mock, { version: {}, baseHead: 3, currentHead: 4 });

  await page.goto(studioUrl);
  await expect(
    page.getByRole('alert').filter({ hasText: th('governance:policies.headMismatch.title') }),
  ).toContainText('head v3');
  await expect(
    page.getByRole('button', { name: th('governance:policies.release.recordApproval') }),
  ).toBeDisabled();
  await expect(
    page
      .getByRole('list', { name: th('governance:policies.steps.label') })
      .locator('[aria-current="step"]'),
  ).toContainText('Approvals');
  expect(mock.requests.filter((request) => request.method() === 'POST')).toHaveLength(0);
  expect(problems).toEqual([]);
});

test('B: publish binds the approval/test/head digest and does not claim the acknowledgement is complete', async ({
  page,
}) => {
  const problems = watchPage(page);
  const mock = await mockGovernance(page);
  policyRoutes(mock, {
    version: { lifecycleState: 'APPROVED', approvalDigest: DIGEST_C, testArtifactDigest: DIGEST_C },
    baseHead: 4,
    currentHead: 4,
  });
  let publish: Request | undefined;
  mock.on('POST', new RegExp(`^/policy-versions/${VERSION_2}/publish$`), (request) => {
    publish = request;
    return {
      body: {
        policyId: POLICY_ID,
        version: 2,
        lifecycleState: 'SCHEDULED',
        activateAt: '2026-09-15T14:00:00.000Z',
        quorum: { status: 'MET', required: 2, current: 2 },
      },
    };
  });

  await page.goto(studioUrl);
  await page.getByRole('button', { name: th('governance:policies.release.publish') }).click();
  const dialog = page.getByRole('dialog', { name: th('governance:policies.dialog.publishTitle') });
  await expect(dialog).toContainText(th('governance:vocabulary.developmentComplete'));
  await dialog.getByLabel('Evidence reference').fill('CHG-SYN-12');
  await dialog
    .getByRole('button', { name: th('governance:policies.dialog.publishConfirm') })
    .click();

  await expect(page.getByRole('status')).toContainText(
    th('governance:policies.message.published', {
      state: 'SCHEDULED',
      activate: th('governance:policies.message.activate', { at: '2026-09-15T14:00:00.000Z' }),
    }),
  );
  expect(publish?.postDataJSON()).toEqual({
    expectedContentDigest: DIGEST_A,
    expectedTestArtifactDigest: DIGEST_C,
    expectedApprovalDigest: DIGEST_C,
    expectedScopeHeadVersion: 4,
    expectedScopeHeadDigest: DIGEST_B,
    evidenceRef: 'CHG-SYN-12',
  });
  expect(problems).toEqual([]);
});

test('B: rollback creates a new version instead of switching back', async ({ page }) => {
  const problems = watchPage(page);
  const mock = await mockGovernance(page);
  policyRoutes(mock, { version: { lifecycleState: 'ACTIVE' }, baseHead: 4, currentHead: 4 });
  mock.on('POST', new RegExp(`^/policies/${POLICY_ID}/rollbacks$`), () => ({
    status: 201,
    body: { policyId: POLICY_ID, policyVersionId: VERSION_3, version: 3, lifecycleState: 'DRAFT' },
  }));
  mock.on('GET', new RegExp(`^/policy-versions/${VERSION_3}(/tests|/approvals)?$`), (request) =>
    request.url().endsWith('/tests')
      ? { body: { policyVersionId: VERSION_3, artifacts: [] } }
      : request.url().endsWith('/approvals')
        ? { body: { policyVersionId: VERSION_3, approvals: [] } }
        : { body: policyVersion(VERSION_3, 3, { lifecycleState: 'DRAFT', diffClass: undefined }) },
  );

  await page.goto(studioUrl);
  await page.getByRole('button', { name: th('governance:policies.release.rollback') }).click();
  await page.getByLabel('Reason code').fill('INCIDENT_ROLLBACK');
  await page.getByLabel('Evidence reference').fill('CHG-SYN-13');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: th('governance:policies.dialog.rollbackConfirm') })
    .click();

  await expect(page.getByRole('status')).toContainText(
    th('governance:policies.message.rollback', { version: 3 }),
  );
  await expect(page).toHaveURL(new RegExp(`versionId=${VERSION_3}`));
  await expect(page.getByRole('heading', { level: 1 })).toContainText('v3');
  expect(problems).toEqual([]);
});

test('C: the audit timeline and safety case come from the canonical history', async ({ page }) => {
  const problems = watchPage(page);
  const mock = await mockGovernance(page);
  exceptionRoutes(mock, { revision: 2, workflowState: 'APPROVED', effectiveState: 'ACTIVE' });
  mock.on('GET', new RegExp(`^/exceptions/${HIGH_ID}/history$`), () => ({
    body: {
      seriesId: HIGH_ID,
      revisions: [
        exception(HIGH_ID, { riskTier: 'HIGH' }),
        exception(HIGH_ID, {
          riskTier: 'HIGH',
          revision: 2,
          createdAt: '2026-09-15T18:30:00.000Z',
        }),
      ],
    },
  }));
  mock.on('GET', new RegExp(`^/exceptions/${HIGH_ID}/approvals$`), () => ({
    body: {
      seriesId: HIGH_ID,
      revision: 2,
      approvals: [
        {
          approverRef: { redacted: true, digest: '1111222233334444' },
          // the response uses the server enum (`APPROVED`/`REJECTED`) — the request uses `APPROVE`/`REJECT` (#672)
          decision: 'APPROVED',
          capability: 'cg.exception.approve.high',
          capabilitySource: 'DIRECT',
          directCompliance: true,
          emergencyAuthority: false,
          authorizationEpoch: 7,
          scopeVersion: 1,
          decidedAt: '2026-09-15T19:10:00.000Z',
        },
      ],
    },
  }));

  await page.goto(`/?view=governance&section=audit&seriesId=${HIGH_ID}&viewer=TENANT_ADMIN`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Trace · exception');
  const timeline = page.getByRole('region', { name: 'Canonical timeline' });
  await expect(timeline.getByRole('listitem')).toHaveCount(3);
  await expect(timeline).toContainText('✓ Checker approve');
  await expect(timeline).toContainText(th('governance:reference.redacted', { tail: '334444' }));
  await expect(page.getByRole('region', { name: 'Safety case' })).toContainText('▲ HIGH');
  expect(problems).toEqual([]);
});

test('#672: an approval the server recorded as APPROVED/REJECTED shows on the correct side and counts approvals correctly', async ({
  page,
}) => {
  const problems = watchPage(page);
  const mock = await mockGovernance(page);
  exceptionRoutes(mock);
  const approval = (decision: string, digest: string) => ({
    approverRef: { redacted: true, digest },
    decision,
    capability: 'cg.exception.approve.high',
    capabilitySource: 'DIRECT',
    directCompliance: true,
    emergencyAuthority: false,
    authorizationEpoch: 7,
    scopeVersion: 1,
    decidedAt: '2026-09-15T19:10:00.000Z',
  });
  mock.on('GET', new RegExp(`^/exceptions/${HIGH_ID}/approvals$`), () => ({
    body: {
      seriesId: HIGH_ID,
      revision: 1,
      approvals: [
        approval('APPROVED', '1111222233334444'),
        approval('REJECTED', '5555666677778888'),
      ],
    },
  }));

  await page.goto(workspaceUrl());
  const checker = page.getByRole('complementary', { name: 'Maker–Checker' });
  await expect(checker).toContainText(`${th('governance:exceptions.checker.recorded')} 1`);
  const list = checker.getByRole('list');
  await expect(list.getByRole('listitem').nth(0)).toContainText('✓ APPROVE');
  await expect(list.getByRole('listitem').nth(1)).toContainText('✕ REJECT');
  expect(problems).toEqual([]);
});

test('mobile: no horizontal overflow, nav works by keyboard, and it opens only by an opaque ID', async ({
  page,
}) => {
  const problems = watchPage(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const mock = await mockGovernance(page);
  exceptionRoutes(mock);

  await page.goto('/?view=governance&viewer=COMPLIANCE');
  await expect(page.getByRole('navigation', { name: 'Contact Governance' })).toBeVisible();
  await page.getByRole('textbox', { name: 'ID' }).fill('someone@example.com');
  await page.getByRole('button', { name: th('governance:common.open'), exact: true }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: th('governance:openById.error') }),
  ).toBeVisible();
  expect(new URL(page.url()).search).not.toContain('example.com');

  await page.getByRole('textbox', { name: 'ID' }).fill(CONTACT_ID);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    th('governance:exceptions.queue.label'),
  );
  await expect(page.locator('#gov-main')).toBeFocused();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  expect(problems).toEqual([]);
});

test('CG5: filter alert, export validation, and a Supervisor has no export permission', async ({
  page,
}) => {
  const problems = watchPage(page);
  const mock = await mockGovernance(page);
  mock.on('GET', /^\/alerts$/, () => ({
    body: {
      asOf: '2026-09-20T00:00:00.000Z',
      items: [
        {
          id: HIGH_ID,
          ruleCode: 'CG5_BLOCK_RATE_SHIFT',
          state: 'OPEN',
          severity: 'CRITICAL',
          channel: 'LINE',
          purpose: 'MARKETING',
          teamId: 'team-1',
          value: '8',
          threshold: '3',
          consecutiveHits: 2,
          openedAt: null,
          ackedAt: null,
          resolvedAt: null,
          version: 1,
          updatedAt: '2026-09-20T00:00:00.000Z',
        },
      ],
    },
  }));
  await page.goto('/?view=governance&viewer=COMPLIANCE');
  await page.getByLabel(th('governance:cg5.alerts.status')).selectOption('OPEN');
  await expect(page.getByText('CG5_BLOCK_RATE_SHIFT')).toBeVisible();
  await expect(page.getByText(th('governance:cg5.export.reasonRequired'))).toBeVisible();
  const beforeSupervisor = mock.requests.length;
  await page.goto('/?view=governance&viewer=SUPERVISOR');
  await expect(page.getByText(th('governance:cg5.export.supervisorNote'))).toBeVisible();
  await expect(page.getByText('CG5_BLOCK_RATE_SHIFT')).toBeVisible();
  const supervisorPaths = mock.requests
    .slice(beforeSupervisor)
    .map((request) => new URL(request.url()).pathname);
  expect(supervisorPaths).not.toContain('/api/v1/contact-governance/exports');
  expect(supervisorPaths).not.toContain('/api/v1/contact-governance/metrics/policy-impact');
  expect(problems).toEqual([]);
});

test('CG5: ACK version conflict reloads the alert without resending the ACK by itself', async ({
  page,
}) => {
  const problems = watchPage(page, { allowHttpErrors: true });
  const mock = await mockGovernance(page);
  let acknowledgements = 0;
  let alertReads = 0;
  mock.on('GET', /^\/alerts$/, () => {
    alertReads += 1;
    return {
      body: {
        asOf: '2026-09-20T00:00:00.000Z',
        items: [
          {
            id: HIGH_ID,
            ruleCode: 'CG5_ALERT_CONFLICT',
            state: 'OPEN',
            severity: 'WARNING',
            channel: null,
            purpose: null,
            teamId: null,
            value: '3',
            threshold: '2',
            consecutiveHits: 1,
            openedAt: null,
            ackedAt: null,
            resolvedAt: null,
            version: 1,
            updatedAt: '2026-09-20T00:00:00.000Z',
          },
        ],
      },
    };
  });
  mock.on('POST', new RegExp(`^/alerts/${HIGH_ID}/ack$`), () => {
    acknowledgements += 1;
    return { status: 409, body: { code: 'CG5_ALERT_VERSION_CONFLICT' } };
  });
  await page.goto('/?view=governance&viewer=COMPLIANCE');
  await page.getByRole('button', { name: th('governance:cg5.alerts.acknowledge') }).click();
  const alert = page.getByRole('alert').filter({ hasText: 'CG5_ALERT_VERSION_CONFLICT' });
  await expect(alert).toContainText(th('governance:cg5.alerts.reload'));
  expect(acknowledgements).toBe(1);
  const readsBeforeReload = alertReads;
  await alert.getByRole('button', { name: th('governance:cg5.alerts.reload') }).click();
  await expect.poll(() => alertReads).toBeGreaterThan(readsBeforeReload);
  expect(acknowledgements).toBe(1);
  expect(problems).toEqual([]);
});

function cg5Alert(id: string, severity: 'WARNING' | 'CRITICAL', state = 'OPEN') {
  return {
    id,
    ruleCode: `CG5_UX01_${severity}`,
    state,
    severity,
    channel: null,
    purpose: null,
    teamId: null,
    value: '5',
    threshold: '3',
    consecutiveHits: 2,
    openedAt: null,
    ackedAt: null,
    resolvedAt: null,
    version: 1,
    updatedAt: new Date().toISOString(),
  };
}

test('CG5-UX01: the freshness bar is separated by source and warns only when some source exceeds the SLO', async ({
  page,
}) => {
  const problems = watchPage(page);
  const mock = await mockGovernance(page);
  let metricsAsOf = new Date().toISOString();
  mock.on('GET', /^\/metrics$/, () => ({ body: { asOf: metricsAsOf, items: [] } }));
  mock.on('GET', /^\/alerts$/, () => ({ body: { asOf: new Date().toISOString(), items: [] } }));
  await page.goto('/?view=governance&viewer=COMPLIANCE');
  const freshness = page.getByRole('region', { name: th('governance:cg5.freshness.title') });
  await expect(freshness).toContainText('Decision projection:');
  await expect(freshness).toContainText('Alert state:');
  await expect(freshness).not.toContainText(th('governance:cg5.freshness.notReady'));
  await expect(freshness.getByRole('alert')).toHaveCount(0);

  // the projection is stuck longer than the SLO but the alert state is still fresh: must warn, without hiding each source's time
  metricsAsOf = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  await page.reload();
  await expect(freshness.getByRole('alert')).toContainText(
    th('governance:cg5.freshness.lag', { detail: '' }).trim(),
  );
  await expect(freshness).not.toContainText(th('governance:cg5.freshness.notReady'));
  expect(problems).toEqual([]);
});

test('CG5-UX01: during backfill show not ready, not numbers that are incomplete', async ({
  page,
}) => {
  const problems = watchPage(page, { allowHttpErrors: true });
  const mock = await mockGovernance(page);
  mock.on('GET', /^\/metrics$/, () => ({
    status: 503,
    body: { code: 'CG5_PROJECTION_NOT_READY', state: 'BACKFILL_RUNNING' },
  }));
  mock.on('GET', /^\/metrics\/policy-impact$/, () => ({
    status: 503,
    body: { code: 'CG5_PROJECTION_NOT_READY', state: 'BACKFILL_RUNNING' },
  }));
  await page.goto('/?view=governance&viewer=COMPLIANCE');
  const freshness = page.getByRole('region', { name: th('governance:cg5.freshness.title') });
  await expect(freshness).toContainText(
    th('governance:cg5.freshness.decision', { value: th('governance:cg5.freshness.notReady') }),
  );
  await expect(freshness.getByRole('alert')).toContainText('CG5_PROJECTION_NOT_READY');
  const cards = page.locator('.cg5-cards strong');
  await expect(cards).toHaveCount(4);
  for (const card of await cards.all()) {
    await expect(card).toHaveText(th('governance:cg5.cardNotReady'));
  }
  expect(problems).toEqual([]);
});

test('CG5-UX01: the alert filter goes to the real API and includes suppressed rows', async ({
  page,
}) => {
  const problems = watchPage(page);
  const mock = await mockGovernance(page);
  const all = [
    cg5Alert(HIGH_ID, 'CRITICAL'),
    cg5Alert(STANDARD_ID, 'WARNING'),
    cg5Alert(APPROVED_ID, 'WARNING', 'SUPPRESSED'),
  ];
  mock.on('GET', /^\/alerts$/, (request) => {
    const query = new URL(request.url()).searchParams;
    const states = query.get('state')?.split(',');
    const severities = query.get('severity')?.split(',');
    return {
      body: {
        asOf: new Date().toISOString(),
        items: all.filter(
          (alert) =>
            (!states || states.includes(alert.state)) &&
            (!severities || severities.includes(alert.severity)),
        ),
      },
    };
  });
  await page.goto('/?view=governance&viewer=COMPLIANCE');
  const list = page.locator('.cg5-alerts');
  await expect(list.locator('li')).toHaveCount(3);
  await expect(list).toContainText(th('governance:cg5.alerts.statusSuppressed'));

  await page.getByLabel(th('governance:cg5.alerts.severity')).selectOption('CRITICAL');
  await expect(list.locator('li')).toHaveCount(1);
  await expect(list).toContainText('CG5_UX01_CRITICAL');

  await page.getByLabel(th('governance:cg5.alerts.severity')).selectOption('ALL');
  await page.getByLabel(th('governance:cg5.alerts.status')).selectOption('SUPPRESSED');
  await expect(list.locator('li')).toHaveCount(1);
  await expect(list.locator('li.cg5-suppressed')).toHaveCount(1);

  const alertQueries = mock.requests
    .map((request) => new URL(request.url()))
    .filter((url) => url.pathname.endsWith('/alerts'))
    .map((url) => url.search);
  expect(alertQueries.some((search) => search.includes('severity=CRITICAL'))).toBe(true);
  expect(alertQueries.some((search) => search.includes('state=SUPPRESSED'))).toBe(true);
  expect(problems).toEqual([]);
});

/**
 * #654: the Governance page in ConsoleShell (flag `ui.shell.v2` on) — the Governance area rail is current,
 * no duplicate chrome is drawn (header/skip link/`<main>` nested) and usage inside the page is the same as before
 */
test('#654: flag on → Governance is in the shell: current area rail, a single main, no duplicate header', async ({
  page,
}) => {
  const problems = watchPage(page);
  const mock = await mockGovernance(page, { shellV2: true });
  exceptionRoutes(mock);
  await page.goto(workspaceUrl());

  const rail = page.getByRole('navigation', { name: MAIN_NAV });
  await expect(rail).toBeVisible();
  await expect(rail.locator('a[aria-current=page]')).toHaveAttribute('data-area', 'governance');
  // an API that does not send `pages` yet (#658): the shell submenu has one item and the in-page tabs are all still there
  await expect(page.getByRole('navigation', { name: 'Governance', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Contact Governance' })).toBeVisible();
  // landmarks: a single main (the shell's), the page draws no header/skip link of its own
  await expect(page.locator('main')).toHaveCount(1);
  await expect(page.locator('.gov-header')).toHaveCount(0);
  await expect(page.locator('.gov-skip')).toHaveCount(0);
  await expect(
    page.getByText(th('governance:viewer.label', { viewer: th('governance:viewer.compliance') })),
  ).toBeVisible();
  await expect(page.locator('#gov-main')).toBeAttached();

  // usage inside the page is the same as before: switching tabs changes the URL/content, and focus moves to the new content
  await page.getByRole('button', { name: 'Audit' }).click();
  await expect(page).toHaveURL(/section=audit/);
  await expect(page.locator('#gov-main')).toBeFocused();

  const axe = await new AxeBuilder({ page }).include('nav').include('header').analyze();
  expect(
    axe.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => v.id),
  ).toEqual([]);
  expect(problems).toEqual([]);
});

test('#654: flag off → Governance is the original page (its own header, skip link and main, no rail)', async ({
  page,
}) => {
  const mock = await mockGovernance(page, { shellV2: false });
  exceptionRoutes(mock);
  await page.goto(workspaceUrl());
  await expect(page.locator('.gov-header')).toBeVisible();
  await expect(page.locator('main#gov-main')).toHaveCount(1);
  await expect(page.getByRole('navigation', { name: MAIN_NAV })).toHaveCount(0);
});

test.describe('shell submenu and English content (#658, #662)', () => {
  test.use({ locale: 'en-US' });

  /**
   * #658: the Governance tabs are items in the shell submenu (the server sends `pages`) —
   * highlighted per page, switching pages without reloading, and back/forward correct
   */
  test('#658: flag on + pages → a 4-item submenu replaces the in-page tabs, highlights the right page, switches pages without reloading', async ({
    page,
  }) => {
    const problems = watchPage(page);
    const mock = await mockGovernance(page, { shellV2: true, pages: true });
    exceptionRoutes(mock);
    await page.goto('/?view=governance&section=overview&viewer=COMPLIANCE');

    const subNav = page.getByRole('navigation', { name: 'Governance', exact: true });
    await expect(subNav.getByRole('link')).toHaveText([
      'Overview',
      'Exceptions',
      'Policies',
      'Audit',
    ]);
    await expect(subNav.locator('a[aria-current=page]')).toHaveText('Overview');
    // the original in-page tabs are not drawn again
    await expect(page.getByRole('navigation', { name: 'Contact Governance' })).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Policies & Exceptions' })).toHaveCount(0);
    // the breadcrumb says the current page
    await expect(page.getByRole('navigation', { name: BREADCRUMB })).toContainText('Overview');

    // pressing a submenu item = changing page in place (same document, no reload), with URL and focus following
    await page.evaluate(() => {
      (window as unknown as { __doc: number }).__doc = 1;
    });
    await subNav.getByRole('link', { name: 'Audit' }).click();
    await expect(page).toHaveURL(/section=audit/);
    await expect(subNav.locator('a[aria-current=page]')).toHaveText('Audit');
    await expect(page.locator('#gov-main')).toBeFocused();
    expect(await page.evaluate(() => (window as unknown as { __doc?: number }).__doc)).toBe(1);

    await subNav.getByRole('link', { name: 'Exceptions' }).click();
    await expect(subNav.locator('a[aria-current=page]')).toHaveText('Exceptions');

    // the back button: the menu follows the content
    await page.goBack();
    await expect(subNav.locator('a[aria-current=page]')).toHaveText('Audit');
    await page.goBack();
    await expect(subNav.locator('a[aria-current=page]')).toHaveText('Overview');

    // the link is still a real href (can open in a new tab/copy the link)
    await expect(subNav.getByRole('link', { name: 'Policies' })).toHaveAttribute(
      'href',
      '/?view=governance&section=policies',
    );
    expect(problems).toEqual([]);
  });

  test('#658: opening section=policies directly → the submenu highlights Policies and the rail is still the Governance area', async ({
    page,
  }) => {
    const mock = await mockGovernance(page, { shellV2: true, pages: true });
    exceptionRoutes(mock);
    await page.goto('/?view=governance&section=policies&viewer=COMPLIANCE');
    const subNav = page.getByRole('navigation', { name: 'Governance', exact: true });
    await expect(subNav.locator('a[aria-current=page]')).toHaveText('Policies');
    const rail = page.getByRole('navigation', { name: MAIN_NAV });
    await expect(rail.locator('a[aria-current=page]')).toHaveAttribute('data-area', 'governance');
  });

  test('#658: flag off → still the original in-page tabs even when the server sends pages', async ({
    page,
  }) => {
    const mock = await mockGovernance(page, { shellV2: false, pages: true });
    exceptionRoutes(mock);
    await page.goto(workspaceUrl());
    await expect(page.getByRole('navigation', { name: 'Contact Governance' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: MAIN_NAV })).toHaveCount(0);
  });

  /**
   * #662: the whole page text comes from the catalog — English must have no Thai left (except real data from the API, which this suite has none)
   */
  const THAI = /[\u0E00-\u0E7F]/;
  async function expectNoThai(page: Page) {
    // content of the Governance page only — the user's name in the e2e harness is Thai (not text of this page)
    expect(await page.locator('#gov-main').innerText()).not.toMatch(THAI);
  }

  test('#662: English — overview and CG5 dashboard', async ({ page }) => {
    const problems = watchPage(page);
    const mock = await mockGovernance(page, { shellV2: true, pages: true });
    exceptionRoutes(mock);
    await page.goto('/?view=governance&section=overview&viewer=COMPLIANCE');
    await expect(page.getByRole('heading', { name: 'Active kill switches' })).toBeVisible();
    await expect(page.getByText('No active kill switches')).toBeVisible();
    await expect(page.getByText('Data freshness').first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Compliance export' })).toBeVisible();
    await expect(page.getByText('Development Complete ≠ Release Enabled')).toContainText(
      'approving or publishing in the Console does not enable provider traffic',
    );
    await expect(page.getByLabel('ID type')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Order export' })).toBeDisabled();
    await expectNoThai(page);
    expect(problems).toEqual([]);
  });

  test('#662: English — Exceptions: queue, dialog, command result messages and recovery', async ({
    page,
  }) => {
    const problems = watchPage(page);
    const mock = await mockGovernance(page);
    exceptionRoutes(mock);
    mock.on('POST', new RegExp(`^/exceptions/${HIGH_ID}/approvals$`), () => ({
      body: {
        seriesId: HIGH_ID,
        revision: 1,
        quorum: { status: 'PENDING', required: 2, current: 1 },
      },
    }));
    await page.goto(workspaceUrl());
    await expect(page.getByRole('complementary', { name: 'Exception queue' })).toBeVisible();
    await expect(page.getByText('🔒 Guardrails that cannot be overridden')).toBeVisible();
    await expectNoThai(page);

    await page.getByRole('button', { name: 'Approve as checker' }).click();
    const dialog = page.getByRole('dialog', { name: 'Confirm Approve' });
    await expect(dialog).toContainText('the server rejects the command if anything changes');
    await dialog.getByLabel('Evidence reference').fill('TICKET-SYN-77');
    await dialog.getByRole('button', { name: 'Confirm Approve' }).click();
    await expect(page.getByRole('status')).toContainText(
      'Approval recorded (quorum 1/2) — not yet ALLOW and not yet Activate',
    );
    await expectNoThai(page);
    expect(problems).toEqual([]);
  });

  test('#662: English — version conflict recovery', async ({ page }) => {
    const problems = watchPage(page, { allowHttpErrors: true });
    const mock = await mockGovernance(page);
    exceptionRoutes(mock);
    mock.on('POST', new RegExp(`^/exceptions/${HIGH_ID}/approvals$`), () => ({
      status: 409,
      body: { code: 'VERSION_CONFLICT', expectedVersion: 4, actualVersion: 6 },
    }));
    await page.goto(workspaceUrl());
    await page.getByRole('button', { name: 'Approve as checker' }).click();
    const dialog = page.getByRole('dialog', { name: 'Confirm Approve' });
    await dialog.getByLabel('Evidence reference').fill('TICKET-SYN-77');
    await dialog.getByRole('button', { name: 'Confirm Approve' }).click();
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('Version conflict');
    await expect(alert).toContainText('expected v4, now v6');
    await expect(
      alert.getByRole('button', { name: 'Load the latest canonical state' }),
    ).toBeVisible();
    await expectNoThai(page);
    expect(problems).toEqual([]);
  });

  test('#662: English — Policies studio and Audit/safety case', async ({ page }) => {
    const problems = watchPage(page);
    const mock = await mockGovernance(page);
    exceptionRoutes(mock, { revision: 2, workflowState: 'APPROVED', effectiveState: 'ACTIVE' });
    policyRoutes(mock, { version: { lifecycleState: 'APPROVED' }, baseHead: 4, currentHead: 4 });
    mock.on('GET', new RegExp(`^/exceptions/${HIGH_ID}/history$`), () => ({
      body: { seriesId: HIGH_ID, revisions: [exception(HIGH_ID, { riskTier: 'HIGH' })] },
    }));

    await page.goto(studioUrl);
    await expect(page.getByRole('list', { name: 'Policy steps' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Release packet' })).toBeVisible();
    await expect(page.getByText('Changes compared with the active head')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Publish / schedule Activate' })).toBeVisible();
    await expectNoThai(page);

    await page.getByRole('button', { name: 'Publish / schedule Activate' }).click();
    const dialog = page.getByRole('dialog', { name: 'Confirm Publish' });
    await expect(dialog).toContainText("Change the scope's policy head from v4");
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    await page.goto(`/?view=governance&section=audit&seriesId=${HIGH_ID}&viewer=TENANT_ADMIN`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Trace · exception');
    await expect(page.getByRole('region', { name: 'Safety case' })).toContainText(
      'Never overridden by any exception',
    );
    await expect(
      page.getByRole('button', { name: "Go to this item's approval workspace" }),
    ).toBeVisible();
    await expectNoThai(page);
    expect(problems).toEqual([]);
  });
});
