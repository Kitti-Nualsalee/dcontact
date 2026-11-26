import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { th } from '../e2e/support/catalog';

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const ERRORS_RE = new RegExp(
  th('journeys:diagnostics.errors', { count: '{N}' }).split('{N}').map(escapeRegExp).join('\\d+'),
);
const GO_TO_RE = new RegExp(
  `^${escapeRegExp(th('journeys:diagnostics.goTo', { node: '{N}' }).split('{N}')[0]!)}`,
);
const COMPILED_RE = new RegExp(
  escapeRegExp(th('journeys:review.compiled', { digest: '{N}' }).split('{N}')[0]!),
);
import {
  api,
  gateState,
  login,
  reloadSession,
  type GateState,
  type Persona,
  type Session,
} from './gate';

/**
 * U1.7 (#435): acceptance gate of the UAT first slice on a real backend — no `page.route` or any mock
 *
 * Console (Vite, same-origin `/api/v1`) → API entry `uat-main` profile `uat` → Postgres (app role + RLS),
 * real Keycloak (password + TOTP + Organization) and an S3-style evidence store
 *
 * test names start with the check ID of `scripts/u1-acceptance.mjs` — the runner counts check status from these names
 * the whole file runs as one serial chain: round 1 runs fully → start a new round → round 2 is ABANDONED →
 * round 3 reruns fully again
 */

test.describe.configure({ mode: 'serial' });

const state: GateState = gateState();
const tenantA = state.fixture.tenants.a;
const JOURNEY_NAME = 'U1 gate synthetic journey';
const sessions = {} as Record<Persona, Session>;

interface RunView {
  runId: string;
  sequence: number;
  lifecycle: 'ACTIVE' | 'COMPLETED' | 'ABANDONED';
  revision: number;
  journeyId: string;
  fixturePack: { environment: string; packVersion: string; digest: string; buildSha: string };
  stepResults: Array<{ stepId: string; outcome: string; recordedByRef: string }>;
}

interface Bundle {
  schema: string;
  manifest: { runId: string; sequence: number; lifecycle: string; buildSha: string };
  stepResults: unknown[];
  screenshots: Array<{ evidenceId: string; stepId: string; sha256: string }>;
  auditRefs: Array<{ action: string }>;
  scan: { status: string; findings: unknown[] };
  verdict: string;
  digest: string;
}

/** what each round accumulates: a screenshot per step (uploaded through the evidence API at the end of the round) and the actual values seen */
interface RunEvidence {
  run: RunView;
  shots: Map<string, { persona: Persona; buffer: Buffer }>;
  actual: Map<string, string>;
  compileDigest?: string;
  reviewId?: string;
  bundle?: Bundle;
}

const runs: RunEvidence[] = [];
const evidenceOut = { bundles: [] as Bundle[] };

function persistEvidence() {
  writeFileSync(join(state.outputDir, 'evidence.json'), JSON.stringify(evidenceOut));
}

function panelOf(page: Page) {
  return page.getByRole('region', { name: th('journeys:uat.heading') });
}

/** screenshot after a step — kept as a CI artifact file and uploaded through the run's evidence API */
async function capture(evidence: RunEvidence, stepId: string, persona: Persona, actual: string) {
  const page = sessions[persona].page;
  // evidence must not show the OIDC code/state (#379)
  expect(page.url()).not.toMatch(/[?&](code|state|session_state)=/);
  const buffer = await page.screenshot({ fullPage: false });
  const file = join(state.screenshotDir, `run-${evidence.run.sequence}-${stepId}.png`);
  writeFileSync(file, buffer);
  evidence.shots.set(stepId, { persona, buffer });
  evidence.actual.set(stepId, actual);
}

async function currentRun(persona: Persona = 'maker'): Promise<RunView> {
  const response = await api(state, sessions[persona], 'GET', 'uat-runs/current');
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body as unknown as RunView;
}

async function journeyState(persona: Persona, journeyId: string) {
  const response = await api(
    state,
    sessions[persona],
    'GET',
    `journey-authoring/journeys/${journeyId}`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body as unknown as {
    head: {
      version: number;
      currentDraftRevision: number;
      currentDraftDigest: string;
      activeVersion: number | null;
      lifecycle: string;
    };
    draft: {
      document: {
        trigger: { nodeId: string; type: string };
        nodes: Array<{ nodeId: string; type: string }>;
        edges: Array<{ source: { nodeId: string }; target: { nodeId: string } }>;
      };
    };
    review: { reviewId: string; state: string; compileDigest: string } | null;
  };
}

/**
 * the Console session lives in memory (reload = must sign in again), so walk inside the app instead of `goto`
 * use the Console's buttons when present; a Journey that is not of the current round opens through a history entry like the
 * Console's Back/Forward (`pushState` + `popstate`) — no reload and the token is untouched
 */
async function toList(persona: Persona) {
  const page = sessions[persona].page;
  const back = page.getByRole('button', { name: th('journeys:editor.back') });
  if (await back.isVisible()) await back.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Journey authoring' })).toBeVisible();
  return page;
}

async function openRunJourney(persona: Persona = 'maker') {
  const page = await toList(persona);
  await panelOf(page)
    .getByRole('button', { name: th('journeys:uat.openRunJourney') })
    .first()
    .click();
  await expect(page.getByRole('heading', { level: 1, name: JOURNEY_NAME })).toBeVisible();
  return page;
}

async function openJourney(persona: Persona, journeyId: string, tenantSlug = tenantA.slug) {
  const page = await toList(persona);
  await page.evaluate((href) => {
    window.history.pushState(null, '', href);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, `/?view=journeys&tenant=${tenantSlug}&journey=${journeyId}`);
  return page;
}

/** `Start new round` through the maker's UAT panel, then return the run the server confirmed */
async function startRunFromConsole(expectedSequence: number): Promise<RunEvidence> {
  const page = sessions.maker.page;
  const panel = panelOf(page);
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: th('journeys:uat.startNewRun') }).click();
  const confirm = page.getByRole('alertdialog', { name: th('journeys:uat.confirmTitle') });
  await expect(confirm.getByLabel(th('journeys:uat.packEnvironment'))).toHaveValue(
    state.fixture.fixturePack.environment,
  );
  await expect(confirm.getByLabel(th('journeys:uat.packVersion'))).toHaveValue(
    state.fixture.fixturePack.packVersion,
  );
  await confirm.getByRole('button', { name: th('journeys:uat.startNewRun') }).click();
  await expect(
    panel
      .getByRole('definition')
      .filter({ hasText: th('journeys:uat.sequenceValue', { sequence: expectedSequence }) }),
  ).toBeVisible();
  // Console opens the new round's Journey by itself
  await expect(page.getByRole('heading', { level: 1, name: JOURNEY_NAME })).toBeVisible();
  const run = await currentRun();
  expect(run).toMatchObject({ sequence: expectedSequence, lifecycle: 'ACTIVE' });
  expect(run.fixturePack).toMatchObject({
    environment: state.fixture.fixturePack.environment,
    packVersion: state.fixture.fixturePack.packVersion,
    digest: state.fixture.fixturePack.digest,
    buildSha: state.buildSha,
  });
  expect(new URL(page.url()).searchParams.get('journey')).toBe(run.journeyId);
  // the build SHA and fixture digest are shown from the server on the panel (the tester does not type them — #379)
  await expect(
    panel.getByRole('definition').filter({ hasText: state.buildSha.slice(0, 12) }),
  ).toBeVisible();
  await expect(
    panel
      .getByRole('definition')
      .filter({ hasText: state.fixture.fixturePack.digest.slice(0, 12) }),
  ).toBeVisible();
  const evidence: RunEvidence = { run, shots: new Map(), actual: new Map() };
  runs.push(evidence);
  return evidence;
}

/** save the draft, then wait until the Console shows the revision the server really answered (not the message of the previous save) */
async function saveDraft(page: Page): Promise<number> {
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' && new URL(response.url()).pathname.endsWith('/draft'),
  );
  await page.getByRole('button', { name: th('journeys:editor.save') }).click();
  const response = await saved;
  expect(response.status()).toBe(200);
  const { draftRevision } = (await response.json()) as { draftRevision: number };
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: th('journeys:editor.saved', { revision: draftRevision }) }),
  ).toBeVisible();
  await expect(page.getByText(th('journeys:publish.blockerDirty'))).toHaveCount(0);
  return draftRevision;
}

/** MAKER_EDIT: insert WAIT after SEND → EVENT_TRIGGER → SEND → WAIT → EXIT, then save */
async function makerEdit(evidence: RunEvidence) {
  const page = sessions.maker.page;
  const before = await journeyState('maker', evidence.run.journeyId);
  const insert = page
    .getByLabel(th('journeys:outline.insertAfter', { port: th('journeys:port.next') }))
    .first();
  await insert.selectOption('WAIT');
  await insert.locator('xpath=following-sibling::button[1]').click();
  const canvas = page.getByRole('group', { name: th('journeys:canvas.label') });
  await expect(canvas.getByRole('button', { name: th('journeys:node.WAIT') })).toBeVisible();
  const wait = page.getByLabel(th('journeys:field.waitSeconds'));
  await wait.fill('600');
  await wait.press('Enter');
  await saveDraft(page);

  const after = await journeyState('maker', evidence.run.journeyId);
  expect(after.head.currentDraftRevision).toBe(before.head.currentDraftRevision + 1);
  const { trigger, nodes, edges } = after.draft.document;
  const next = (nodeId: string) =>
    edges.find((edge) => edge.source.nodeId === nodeId)?.target.nodeId;
  const typeOf = (nodeId: string | undefined) => nodes.find((node) => node.nodeId === nodeId)?.type;
  const path = [trigger.type];
  for (let cursor = next(trigger.nodeId); cursor; cursor = next(cursor)) path.push(typeOf(cursor)!);
  expect(path).toEqual(['EVENT_TRIGGER', 'SEND', 'WAIT', 'EXIT']);
  await capture(
    evidence,
    'MAKER_EDIT',
    'maker',
    `Inserted WAIT 600 seconds, giving EVENT_TRIGGER → SEND → WAIT → EXIT, saved as revision ${after.head.currentDraftRevision}`,
  );
}

/** DIAGNOSTIC_RECOVERY: cut the edge from WAIT → validate shows a diagnostic pointing at a node → reconnect → validate is clean */
async function diagnosticRecovery(evidence: RunEvidence) {
  const page = sessions.maker.page;
  const port = page.getByLabel(
    th('journeys:outline.portTarget', {
      port: th('journeys:port.next'),
      node: th('journeys:node.WAIT'),
    }),
  );
  await port.selectOption('');
  await saveDraft(page);
  await page.getByRole('button', { name: th('journeys:editor.validate') }).click();
  const errors = page.getByRole('status').filter({ hasText: ERRORS_RE });
  await expect(errors).toBeVisible();
  const goTo = page.getByRole('button', { name: GO_TO_RE }).first();
  await expect(goTo).toBeVisible();
  const diagnosticText = (await errors.innerText()).trim();
  await capture(evidence, 'DIAGNOSTIC_RECOVERY', 'maker', '');
  await goTo.click();

  await page
    .getByLabel(
      th('journeys:outline.portTarget', {
        port: th('journeys:port.next'),
        node: th('journeys:node.WAIT'),
      }),
    )
    .selectOption({ label: th('journeys:node.EXIT') });
  await saveDraft(page);
  await page.getByRole('button', { name: th('journeys:editor.validate') }).click();
  await expect(
    page.getByRole('status').filter({ hasText: th('journeys:diagnostics.clean') }),
  ).toBeVisible();
  evidence.actual.set(
    'DIAGNOSTIC_RECOVERY',
    `Cut the next edge of WAIT, then validate: ${diagnosticText} with a go-to-node button; reconnected to EXIT and validate found no errors`,
  );
}

/** COMPILE + SIMULATE with the fixture the server pinned for the round */
async function compileAndSimulate(evidence: RunEvidence) {
  const page = sessions.maker.page;
  const compiled = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname.endsWith('/compile'),
  );
  await page.getByRole('button', { name: th('journeys:review.compile') }).click();
  const compileBody = (await (await compiled).json()) as {
    artifact: { compileDigest: string };
  };
  evidence.compileDigest = compileBody.artifact.compileDigest;
  await expect(
    page.getByText(
      th('journeys:review.compiled', { digest: evidence.compileDigest.slice(0, 12) }),
      {
        exact: false,
      },
    ),
  ).toBeVisible();
  await capture(
    evidence,
    'COMPILE',
    'maker',
    `Compiled the latest revision and got compile digest ${evidence.compileDigest.slice(0, 12)}`,
  );

  // there is no browser-built context field in UAT — use the server's fixture only
  await expect(page.getByLabel(th('journeys:review.contextLabel'))).toHaveCount(0);
  await expect(
    page.getByRole('definition').filter({ hasText: String(state.simulationFixture.fixtureId) }),
  ).toBeVisible();
  const simulated = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname.endsWith('/simulations'),
  );
  await page.getByRole('button', { name: th('journeys:review.simulate') }).click();
  const simulation = await simulated;
  expect(simulation.status()).toBe(200);
  expect(simulation.request().postDataJSON()).toMatchObject({ fixture: state.simulationFixture });
  const simulationBody = (await simulation.json()) as { profile: string };
  expect(simulationBody.profile).toBe('SIMULATION_ONLY');
  const result = page.locator('.j5-simulation');
  await expect(result).toContainText('SIMULATION_ONLY');
  await expect(result).toContainText(th('journeys:review.virtualAt'));
  await expect(result.locator('time').first()).toHaveAttribute(
    'datetime',
    String(state.simulationFixture.startAt),
  );
  await capture(
    evidence,
    'SIMULATE',
    'maker',
    'The simulation result is labelled SIMULATION_ONLY, uses the server fixture and shows virtual time, not a real send',
  );
}

async function submitReview(evidence: RunEvidence) {
  const page = sessions.maker.page;
  await page.getByRole('button', { name: th('journeys:review.submit') }).click();
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: th('journeys:review.state', { state: 'IN_REVIEW' }) }),
  ).toBeVisible();
  // the maker sees the reason another reviewer is required, and there is no decide button
  await expect(
    page.getByRole('note').filter({ hasText: th('journeys:review.blockedMaker') }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: th('journeys:review.decision.APPROVE'), exact: true }),
  ).toHaveCount(0);
  const journey = await journeyState('maker', evidence.run.journeyId);
  expect(journey.review).toMatchObject({
    state: 'IN_REVIEW',
    compileDigest: evidence.compileDigest,
  });
  evidence.reviewId = journey.review!.reviewId;
  await capture(
    evidence,
    'SUBMIT_REVIEW',
    'maker',
    'Submitted for review, status IN_REVIEW, and the maker has no decision button for their own work',
  );
}

/** the reviewer finds the candidate by themselves with the "awaiting review" filter and approves the exact candidate */
async function reviewerApprove(evidence: RunEvidence) {
  const page = await toList('reviewer');
  await page.getByRole('button', { name: th('journeys:list.filterPending') }).click();
  await expect(
    page.getByRole('button', { name: th('journeys:list.filterPending') }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.getByRole('heading', { level: 2, name: th('journeys:list.headingPending') }),
  ).toBeVisible();
  const pending = page.getByRole('table').filter({ hasText: evidence.compileDigest!.slice(0, 12) });
  await expect(pending).toBeVisible();
  await pending.getByRole('button', { name: JOURNEY_NAME }).click();
  await expect(page.getByRole('heading', { level: 1, name: JOURNEY_NAME })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('journey')).toBe(evidence.run.journeyId);
  // exact candidate: the same compile digest the maker submitted
  await expect(
    page.getByRole('definition').filter({ hasText: evidence.compileDigest!.slice(0, 12) }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: th('journeys:review.submit') })).toHaveCount(0);
  await page
    .getByRole('button', { name: th('journeys:review.decision.APPROVE'), exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Reason code').fill('LOOKS_GOOD');
  await dialog.getByLabel('Evidence reference').fill(`u1-gate-run-${evidence.run.sequence}`);
  await dialog.getByRole('button', { name: th('journeys:review.decision.APPROVE') }).click();
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: th('journeys:review.state', { state: 'APPROVED' }) }),
  ).toBeVisible();
  await capture(
    evidence,
    'REVIEW_APPROVE',
    'reviewer',
    `A reviewer on another account found the candidate through the pending filter, saw compile digest ${evidence.compileDigest!.slice(0, 12)} and approved it as APPROVED`,
  );
}

async function publishAndAudit(evidence: RunEvidence) {
  const page = await openRunJourney('maker');
  expect(new URL(page.url()).searchParams.get('journey')).toBe(evidence.run.journeyId);
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: th('journeys:review.state', { state: 'APPROVED' }) }),
  ).toBeVisible();
  await page.getByRole('button', { name: th('journeys:review.compile') }).click();
  await expect(page.getByText(`digest ${evidence.compileDigest!.slice(0, 12)}`)).toBeVisible();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  const confirm = page.getByRole('alertdialog', {
    name: new RegExp(escapeRegExp(th('journeys:publish.confirmTitle', { version: 1 }))),
  });
  await expect(confirm).toBeVisible();
  const published = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname.endsWith('/publish'),
  );
  await confirm.getByRole('button', { name: th('journeys:publish.confirmLabel') }).click();
  const receipt = (await (await published).json()) as {
    outcome: string;
    version: number;
    receiptId: string;
    runtimeHash: string;
  };
  // receipt confirmed by the server (authoritative) — Console shows the result only after it is known
  expect(receipt).toMatchObject({ outcome: 'PUBLISHED', version: 1 });
  expect(receipt.receiptId).toMatch(/^[0-9a-f-]{36}$/);
  await expect(page.getByText(th('journeys:publish.published', { version: 1 }))).toBeVisible();
  const journey = await journeyState('maker', evidence.run.journeyId);
  expect(journey.head.activeVersion).toBe(1);
  await capture(
    evidence,
    'PUBLISH',
    'maker',
    `Published version 1 with receipt ${receipt.receiptId.slice(0, 8)} and outcome ${receipt.outcome}`,
  );

  await page.getByRole('button', { name: th('journeys:audit.show') }).click();
  const timeline = page.getByRole('list', { name: th('journeys:audit.listLabel') });
  for (const action of ['JOURNEY_PUBLISHED', 'REVIEW_APPROVED', 'REVIEW_SUBMITTED']) {
    await expect(timeline).toContainText(action);
  }
  await timeline.scrollIntoViewIfNeeded();
  await capture(
    evidence,
    'AUDIT',
    'maker',
    'The history shows REVIEW_SUBMITTED, REVIEW_APPROVED and JOURNEY_PUBLISHED for the Journey of this run',
  );
}

/** record the result of every step through the UAT panel (by whoever did that step) and upload screenshots through the Console's evidence API */
async function recordRunEvidence(evidence: RunEvidence) {
  for (const step of state.stepCatalog) {
    const shot = evidence.shots.get(step.stepId);
    const actual = evidence.actual.get(step.stepId);
    expect(shot, `No screenshot for ${step.stepId}`).toBeTruthy();
    expect(actual, `No actual text for ${step.stepId}`).toBeTruthy();
    const page = sessions[shot!.persona].page;
    const panel = panelOf(page);
    const sequence = panel
      .getByRole('definition')
      .filter({ hasText: th('journeys:uat.sequenceValue', { sequence: evidence.run.sequence }) });
    // the other account's panel does not poll — after the maker changes the round the page must be reloaded like a real tester
    if (!(await sequence.isVisible())) await reloadSession(sessions[shot!.persona]);
    await expect(sequence).toBeVisible();
    await panel.getByLabel(th('journeys:uat.stepLabel')).selectOption(step.stepId);
    await panel.getByLabel(th('journeys:uat.outcome.PASS')).check();
    await panel.getByLabel(th('journeys:uat.actualLabel')).fill(actual!);
    await panel.getByRole('button', { name: th('journeys:uat.record'), exact: true }).click();
    await expect(
      panel
        .getByRole('status')
        .filter({ hasText: th('journeys:uat.recorded', { stepId: step.stepId }) }),
    ).toBeVisible();

    const upload = panel.getByRole('region', { name: th('journeys:uat.evidence.heading') });
    await upload.getByLabel(th('journeys:uat.evidence.stepLabel')).selectOption(step.stepId);
    await upload.getByLabel(th('journeys:uat.evidence.fileLabel')).setInputFiles({
      name: `${step.stepId}.png`,
      mimeType: 'image/png',
      buffer: shot!.buffer,
    });
    const uploaded = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === `/api/v1/uat-runs/${evidence.run.runId}/evidence`,
    );
    await upload.getByRole('button', { name: th('journeys:uat.evidence.upload') }).click();
    expect((await uploaded).status()).toBe(200);
    await expect(
      panel
        .getByRole('status')
        .filter({ hasText: th('journeys:uat.evidence.uploaded', { stepId: step.stepId }) }),
    ).toBeVisible();
  }
}

/** export the bundle through the Console button (fetch + Blob) then check the verdict/scan from the server */
async function exportBundle(evidence: RunEvidence): Promise<Bundle> {
  const page = sessions.maker.page;
  const region = panelOf(page).getByRole('region', { name: th('journeys:uat.evidence.heading') });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    region.getByRole('button', { name: th('journeys:uat.evidence.export') }).click(),
  ]);
  const bundle = JSON.parse(readFileSync((await download.path())!, 'utf8')) as Bundle;
  expect(bundle.schema).toBe('UatEvidenceBundleV1');
  expect(bundle.manifest).toMatchObject({
    runId: evidence.run.runId,
    sequence: evidence.run.sequence,
    buildSha: state.buildSha,
  });
  expect(bundle.scan.status).toBe('PASSED');
  expect(bundle.scan.findings).toEqual([]);
  expect(bundle.verdict).toBe('PASS');
  expect(new Set(bundle.screenshots.map((shot) => shot.stepId))).toEqual(
    new Set(state.stepCatalog.map((step) => step.stepId)),
  );
  for (const action of ['REVIEW_SUBMITTED', 'REVIEW_APPROVED', 'JOURNEY_PUBLISHED']) {
    expect(bundle.auditRefs.map((ref) => ref.action)).toContain(action);
  }
  const summary = region.getByRole('definition');
  await expect(
    summary.filter({ hasText: th('journeys:uat.evidence.verdictValue.PASS') }),
  ).toBeVisible();
  await expect(summary.filter({ hasText: bundle.digest.slice(0, 12) })).toBeVisible();
  evidence.bundle = bundle;
  return bundle;
}

/** walk the whole step catalog in the open round (used for both the first round and the rerun) */
async function walkRun(evidence: RunEvidence, previous?: { run: RunView; lifecycle: string }) {
  const page = sessions.maker.page;
  await expect(
    panelOf(page)
      .getByRole('definition')
      .filter({ hasText: /^ACTIVE$/ }),
  ).toBeVisible();
  await capture(
    evidence,
    'RUN_OPENED',
    'maker',
    previous
      ? `Run ${evidence.run.sequence} is ACTIVE; run ${previous.run.sequence} closed as ${previous.lifecycle} and its earlier evidence is still readable`
      : `Run ${evidence.run.sequence} is ACTIVE with run ID, build SHA and fixture digest from the server`,
  );
  await makerEdit(evidence);
  await diagnosticRecovery(evidence);
  await compileAndSimulate(evidence);
  await submitReview(evidence);
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test('U1-NEG-EGRESS runtime profile reports providerEgress BLOCKED and routes outside the allowlist are closed with ROUTE_NOT_AVAILABLE_IN_PROFILE', async () => {
  const before = await api(state, null, 'GET', 'runtime-profile');
  expect(before.status).toBe(200);
  expect(before.body).toMatchObject({
    profile: 'uat',
    providerEgress: 'BLOCKED',
    kafka: 'DISABLED',
    lineWebhook: 'DISABLED',
    journeyRuntime: 'NOT_DEPLOYED',
    unilateralPublish: 'NOT_EXPOSED',
  });
  // routes that lead out to a provider/runtime in another profile — must be closed before reaching the controller
  const probes: Array<['GET' | 'POST', string]> = [
    ['POST', 'events'],
    ['POST', 'contact-governance/decisions'],
    ['POST', 'recordings'],
    ['GET', 'queues'],
    ['GET', 'me/navigation'],
  ];
  for (const [method, path] of probes) {
    const blocked = await api(state, null, method, path, method === 'POST' ? { body: {} } : {});
    expect([blocked.status, blocked.body.code], `${method} /api/v1/${path}`).toEqual([
      404,
      'ROUTE_NOT_AVAILABLE_IN_PROFILE',
    ]);
  }
  // the LINE webhook ingress is not mounted in the UAT entry at all (it is outside /api, so call the API directly)
  const line = await fetch(`${state.apiUrl}/webhook/line`, { method: 'POST', body: '{}' });
  expect(line.status).toBe(404);
  const after = await api(state, null, 'GET', 'runtime-profile');
  expect(Number(after.body.blockedRequests)).toBeGreaterThanOrEqual(
    Number(before.body.blockedRequests) + probes.length,
  );
});

test('U1-MAKER round 1: maker login, start the round, edit the Journey, diagnostic recovery, compile/simulate and submit for review', async ({
  browser,
}) => {
  sessions.maker = await login(browser, state.accounts.maker);
  const run1 = await startRunFromConsole(1);
  await walkRun(run1);
});

test('U1-NEG-SELF-APPROVAL a maker holding journey.review cannot approve a candidate they submitted themselves', async () => {
  const run1 = runs[0]!;
  // UI: there is no decide button for the submitter
  await expect(
    sessions.maker.page.getByRole('button', {
      name: th('journeys:review.decision.APPROVE'),
      exact: true,
    }),
  ).toHaveCount(0);
  // real API: the maker has the journey.review grant but maker-checker must reject
  const decision = await api(
    state,
    sessions.maker,
    'POST',
    `journey-authoring/reviews/${run1.reviewId}/decisions`,
    {
      body: {
        expectedReviewState: 'IN_REVIEW',
        decision: 'APPROVE',
        reasonCode: 'SELF_APPROVAL_PROBE',
        evidenceRef: 'u1-gate-negative',
      },
    },
  );
  expect(decision.status, JSON.stringify(decision.body)).toBe(403);
  expect(decision.body.code).toBe('APPROVAL_SELF_FORBIDDEN');
  const journey = await journeyState('maker', run1.run.journeyId);
  expect(journey.review?.state).toBe('IN_REVIEW');
});

test('U1-NEG-CROSS-TENANT a token of another tenant cannot touch the run/Journey/review/evidence of tenant A', async ({
  browser,
}) => {
  const run1 = runs[0]!;
  sessions.foreign = await login(browser, state.accounts.foreign);
  const foreign = sessions.foreign;
  const reads: string[] = [
    `journey-authoring/journeys/${run1.run.journeyId}`,
    `journey-authoring/journeys/${run1.run.journeyId}/audit`,
    `uat-runs/${run1.run.runId}`,
    `uat-runs/${run1.run.runId}/evidence`,
    `uat-runs/${run1.run.runId}/bundle`,
  ];
  for (const path of reads) {
    const response = await api(state, foreign, 'GET', path);
    expect([403, 404], `GET ${path} → ${response.status}`).toContain(response.status);
  }
  const approve = await api(
    state,
    foreign,
    'POST',
    `journey-authoring/reviews/${run1.reviewId}/decisions`,
    {
      body: {
        expectedReviewState: 'IN_REVIEW',
        decision: 'APPROVE',
        reasonCode: 'CROSS_TENANT_PROBE',
        evidenceRef: 'u1-gate-negative',
      },
    },
  );
  expect([403, 404], JSON.stringify(approve.body)).toContain(approve.status);
  const step = await api(state, foreign, 'POST', `uat-runs/${run1.run.runId}/step-results`, {
    body: { stepId: 'RUN_OPENED', outcome: 'PASS', actual: 'cross-tenant probe' },
  });
  expect([403, 404]).toContain(step.status);
  // tenant B's current/pending does not see tenant A's
  expect((await api(state, foreign, 'GET', 'uat-runs/current')).status).toBe(404);
  const pending = await api(state, foreign, 'GET', 'journey-authoring/reviews');
  expect(pending.status).toBe(200);
  expect(JSON.stringify(pending.body)).not.toContain(run1.run.journeyId);
  const visible = await api(state, foreign, 'GET', 'journey-authoring/journeys');
  expect(JSON.stringify(visible.body)).not.toContain(run1.run.journeyId);

  // UI: tenant B's deep link to tenant A's Journey = not found, not data of another tenant
  const page = await openJourney('foreign', run1.run.journeyId, state.accounts.foreign.tenantSlug);
  await expect(page.getByText(th('journeys:error.JOURNEY_NOT_FOUND'))).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: JOURNEY_NAME })).toHaveCount(0);
  // tenant A's run is unchanged
  const after = await currentRun();
  expect(after.runId).toBe(run1.run.runId);
  expect(after.stepResults).toEqual([]);
});

test('U1-REVIEW a reviewer on a different account finds the candidate through the awaiting-review filter, checks the exact candidate and approves', async ({
  browser,
}) => {
  sessions.reviewer = await login(browser, state.accounts.reviewer);
  await reviewerApprove(runs[0]!);
  const journey = await journeyState('reviewer', runs[0]!.run.journeyId);
  expect(journey.review?.state).toBe('APPROVED');
});

test('U1-PUBLISH the maker can publish a version/receipt confirmed by the server and sees the audit', async () => {
  await publishAndAudit(runs[0]!);
});

test('U1-EVIDENCE round 1: record every step + screenshots through the evidence API and the bundle gets verdict PASS/scan PASSED', async () => {
  await recordRunEvidence(runs[0]!);
  const bundle = await exportBundle(runs[0]!);
  evidenceOut.bundles.push(bundle);
  persistEvidence();
});

test('U1-RERUN start a new round: round 2 ACTIVE, round 1 COMPLETED and the original evidence is unchanged', async () => {
  const run1 = runs[0]!;
  await startRunFromConsole(2);
  const closed = await api(state, sessions.reviewer, 'GET', `uat-runs/${run1.run.runId}`);
  expect(closed.status).toBe(200);
  const closedRun = closed.body as unknown as RunView;
  expect(closedRun.lifecycle).toBe('COMPLETED');
  expect(closedRun.stepResults).toHaveLength(state.stepCatalog.length);
  const evidence = await api(state, sessions.maker, 'GET', `uat-runs/${run1.run.runId}/evidence`);
  const items = (evidence.body as { items: Array<{ sha256: string }> }).items;
  expect(items.map((item) => item.sha256).sort()).toEqual(
    run1.bundle!.screenshots.map((shot) => shot.sha256).sort(),
  );
  // the earlier round's bundle can still be exported, the results/evidence are complete, only the lifecycle changes
  const again = await api(state, sessions.maker, 'GET', `uat-runs/${run1.run.runId}/bundle`);
  const bundle = again.body as unknown as Bundle;
  expect(bundle.manifest.lifecycle).toBe('COMPLETED');
  expect(bundle.stepResults).toEqual(run1.bundle!.stepResults);
  expect(bundle.screenshots).toEqual(run1.bundle!.screenshots);
  expect(bundle.verdict).toBe('PASS');
  // the earlier round's Journey audit can still be read
  const audit = await api(
    state,
    sessions.maker,
    'GET',
    `journey-authoring/journeys/${run1.run.journeyId}/audit`,
  );
  expect(audit.status).toBe(200);
});

test('U1-NEG-ABANDONED a candidate of an ABANDONED round cannot be submitted/published/edited further (UAT_RUN_CLOSED)', async () => {
  const run2 = runs[1]!;
  // the maker works in round 2 up to compile (candidate) and then starts a new round without publishing
  await makerEdit(run2);
  const page = sessions.maker.page;
  await page.getByRole('button', { name: th('journeys:review.compile') }).click();
  await expect(page.getByText(COMPILED_RE)).toBeVisible();
  const stale = await journeyState('maker', run2.run.journeyId);
  const compiled = await api(
    state,
    sessions.maker,
    'POST',
    `journey-authoring/journeys/${run2.run.journeyId}/compile`,
    {
      body: {
        draftRevision: stale.head.currentDraftRevision,
        draftDigest: stale.head.currentDraftDigest,
        expectedHeadVersion: stale.head.version,
      },
    },
  );
  expect(compiled.status).toBe(200);
  const artifact = compiled.body.artifact as {
    compileDigest: string;
    referenceDigest: string;
    capabilityDigest: string;
  };

  const run3 = await startRunFromConsole(3);
  const closed = await api(state, sessions.maker, 'GET', `uat-runs/${run2.run.runId}`);
  expect((closed.body as unknown as RunView).lifecycle).toBe('ABANDONED');
  expect(run3.run.journeyId).not.toBe(run2.run.journeyId);

  const frozen = { code: 'JOURNEY_LIFECYCLE_CONFLICT', safeParams: { reason: 'UAT_RUN_CLOSED' } };
  const candidate = {
    draftRevision: stale.head.currentDraftRevision,
    draftDigest: stale.head.currentDraftDigest,
    compileDigest: artifact.compileDigest,
    referenceDigest: artifact.referenceDigest,
    capabilityDigest: artifact.capabilityDigest,
    baseHeadVersion: stale.head.version,
    baseHeadDigest: null,
  };
  const submit = await api(
    state,
    sessions.maker,
    'POST',
    `journey-authoring/journeys/${run2.run.journeyId}/reviews`,
    { body: candidate },
  );
  expect([submit.status, submit.body]).toEqual([409, frozen]);
  const publish = await api(
    state,
    sessions.maker,
    'POST',
    `journey-authoring/journeys/${run2.run.journeyId}/publish`,
    {
      body: {
        reviewId: crypto.randomUUID(),
        ...candidate,
        expectedHeadVersion: stale.head.version,
      },
    },
  );
  expect([publish.status, publish.body]).toEqual([409, frozen]);
  const edit = await api(
    state,
    sessions.maker,
    'PUT',
    `journey-authoring/journeys/${run2.run.journeyId}/draft`,
    {
      body: {
        expectedHeadVersion: stale.head.version,
        expectedDraftRevision: stale.head.currentDraftRevision,
        expectedDraftDigest: stale.head.currentDraftDigest,
        document: stale.draft.document,
      },
    },
  );
  expect([edit.status, edit.body]).toEqual([409, frozen]);
  const late = await api(state, sessions.maker, 'POST', `uat-runs/${run2.run.runId}/step-results`, {
    body: { stepId: 'RUN_OPENED', outcome: 'PASS', actual: 'Recorded after the run closed' },
  });
  expect([late.status, late.body.code]).toEqual([409, 'UAT_RUN_CLOSED']);
  const head = await journeyState('maker', run2.run.journeyId);
  expect(head.review).toBeNull();
  expect(head.head.activeVersion).toBeNull();

  // UI: a Journey of a closed round cannot be submitted for review — the server rejects and Console states the reason
  const run2Page = await openJourney('maker', run2.run.journeyId);
  await expect(run2Page.getByRole('heading', { level: 1, name: JOURNEY_NAME })).toBeVisible();
  await run2Page.getByRole('button', { name: th('journeys:review.compile') }).click();
  await expect(run2Page.getByText(COMPILED_RE)).toBeVisible();
  await run2Page.getByRole('button', { name: th('journeys:review.submit') }).click();
  await expect(run2Page.getByText(th('journeys:error.JOURNEY_LIFECYCLE_CONFLICT'))).toBeVisible();
  expect((await journeyState('maker', run2.run.journeyId)).review).toBeNull();
});

test('U1-RERUN round 3: rerun every step after starting a new round, and the bundle gets verdict PASS', async () => {
  const run3 = runs[2]!;
  await openRunJourney('maker');
  expect(new URL(sessions.maker.page.url()).searchParams.get('journey')).toBe(run3.run.journeyId);
  await walkRun(run3, { run: runs[1]!.run, lifecycle: 'ABANDONED' });
  await reviewerApprove(run3);
  await publishAndAudit(run3);
  await recordRunEvidence(run3);
  const bundle = await exportBundle(run3);
  evidenceOut.bundles.push(bundle);
  persistEvidence();
  // the runs of every round are all still there (nothing was deleted): 3 → 2 → 1
  const history = await api(state, sessions.maker, 'GET', 'uat-runs?limit=10');
  const items = (history.body as { items: RunView[] }).items;
  expect(items.map((item) => [item.sequence, item.lifecycle])).toEqual([
    [3, 'ACTIVE'],
    [2, 'ABANDONED'],
    [1, 'COMPLETED'],
  ]);
});

test('U1-EVIDENCE the evidence of the rounds that passed both times is ready in the manifest and has no trace/HAR', async () => {
  expect(evidenceOut.bundles.map((bundle) => bundle.manifest.sequence)).toEqual([1, 3]);
  for (const bundle of evidenceOut.bundles) {
    expect(bundle.verdict).toBe('PASS');
    expect(bundle.scan.status).toBe('PASSED');
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toMatch(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./);
    expect(serialized).not.toMatch(/Bearer /i);
    for (const account of Object.values(state.accounts)) {
      expect(serialized).not.toContain(account.password);
      expect(serialized).not.toContain(account.username);
    }
  }
});

test.afterAll(async () => {
  for (const session of Object.values(sessions)) await session.context.close();
});
