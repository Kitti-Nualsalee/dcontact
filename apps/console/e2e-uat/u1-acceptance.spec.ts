import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
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
 * U1.7 (#435): acceptance gate ของ UAT first slice บน backend จริง — ไม่มี `page.route` หรือ mock ใด ๆ
 *
 * Console (Vite, same-origin `/api/v1`) → API entry `uat-main` profile `uat` → Postgres (app role + RLS),
 * Keycloak จริง (password + TOTP + Organization) และ evidence store แบบ S3
 *
 * ชื่อ test ขึ้นต้นด้วย check ID ของ `scripts/u1-acceptance.mjs` — runner นับสถานะ check จากชื่อนี้
 * test ทั้งไฟล์เดินต่อกันเป็นเส้นเดียว (serial): รอบที่ 1 เดินครบ → เริ่มรอบใหม่ → รอบที่ 2 ถูก ABANDONED →
 * รอบที่ 3 rerun เดินครบอีกครั้ง
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

/** สิ่งที่แต่ละรอบสะสม: screenshot ต่อ step (อัปโหลดผ่าน evidence API ตอนท้ายรอบ) และ actual ที่เห็น */
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
  return page.getByRole('region', { name: 'รอบทดสอบ UAT' });
}

/** screenshot หลัง step — เก็บเป็นไฟล์ของ CI artifact และอัปโหลดผ่าน evidence API ของ run */
async function capture(evidence: RunEvidence, stepId: string, persona: Persona, actual: string) {
  const page = sessions[persona].page;
  // หลักฐานห้ามเห็น code/state ของ OIDC (#379)
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
 * session ของ Console อยู่ในหน่วยความจำ (reload = ต้องกดเข้าสู่ระบบใหม่) จึงเดินในแอปแทนการ `goto`
 * ใช้ปุ่มของ Console เมื่อมี; Journey ที่ไม่ใช่ของรอบปัจจุบันเปิดผ่าน history entry แบบเดียวกับ
 * Back/Forward ของ Console (`pushState` + `popstate`) — ไม่มี reload และไม่แตะ token
 */
async function toList(persona: Persona) {
  const page = sessions[persona].page;
  const back = page.getByRole('button', { name: '← รายการ Journey' });
  if (await back.isVisible()) await back.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Journey authoring' })).toBeVisible();
  return page;
}

async function openRunJourney(persona: Persona = 'maker') {
  const page = await toList(persona);
  await panelOf(page).getByRole('button', { name: 'เปิด Journey ของรอบนี้' }).first().click();
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

/** `เริ่มรอบใหม่` ผ่านแผง UAT ของ maker แล้วคืน run ที่ server ยืนยัน */
async function startRunFromConsole(expectedSequence: number): Promise<RunEvidence> {
  const page = sessions.maker.page;
  const panel = panelOf(page);
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'เริ่มรอบใหม่' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'ยืนยันเริ่มรอบใหม่' });
  await expect(confirm.getByLabel('Environment ของ fixture pack')).toHaveValue(
    state.fixture.fixturePack.environment,
  );
  await expect(confirm.getByLabel('Version ของ fixture pack')).toHaveValue(
    state.fixture.fixturePack.packVersion,
  );
  await confirm.getByRole('button', { name: 'เริ่มรอบใหม่' }).click();
  await expect(
    panel.getByRole('definition').filter({ hasText: `รอบที่ ${expectedSequence}` }),
  ).toBeVisible();
  // Console เปิด Journey ของรอบใหม่ให้เอง
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
  // build SHA และ fixture digest แสดงจาก server บนแผง (ผู้ทดสอบไม่ต้องพิมพ์เอง — #379)
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

/** บันทึกฉบับร่างแล้วรอจน Console แสดง revision ที่ server ตอบจริง (ไม่ใช่ข้อความของการบันทึกครั้งก่อน) */
async function saveDraft(page: Page): Promise<number> {
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' && new URL(response.url()).pathname.endsWith('/draft'),
  );
  await page.getByRole('button', { name: 'บันทึกฉบับร่าง' }).click();
  const response = await saved;
  expect(response.status()).toBe(200);
  const { draftRevision } = (await response.json()) as { draftRevision: number };
  await expect(
    page.getByRole('status').filter({ hasText: `บันทึกเป็น revision ${draftRevision} แล้ว` }),
  ).toBeVisible();
  await expect(page.getByText('มีการแก้ไขที่ยังไม่บันทึก')).toHaveCount(0);
  return draftRevision;
}

/** MAKER_EDIT: แทรก WAIT หลัง SEND → EVENT_TRIGGER → SEND → WAIT → EXIT แล้วบันทึก */
async function makerEdit(evidence: RunEvidence) {
  const page = sessions.maker.page;
  const before = await journeyState('maker', evidence.run.journeyId);
  const insert = page.getByLabel('แทรกขั้นตอนหลัง ถัดไป').first();
  await insert.selectOption('WAIT');
  await insert.locator('xpath=following-sibling::button[1]').click();
  const canvas = page.getByRole('group', { name: 'ผังขั้นตอนของ Journey' });
  await expect(canvas.getByRole('button', { name: 'รอ' })).toBeVisible();
  const wait = page.getByLabel('ระยะเวลารอ (วินาที)');
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
    `แทรก WAIT 600 วินาที ได้ EVENT_TRIGGER → SEND → WAIT → EXIT บันทึกเป็น revision ${after.head.currentDraftRevision}`,
  );
}

/** DIAGNOSTIC_RECOVERY: ตัดเส้นจาก WAIT → validate เห็น diagnostic ชี้ node → ต่อกลับ → validate สะอาด */
async function diagnosticRecovery(evidence: RunEvidence) {
  const page = sessions.maker.page;
  const port = page.getByLabel('ถัดไป ของ รอ ไปที่');
  await port.selectOption('');
  await saveDraft(page);
  await page.getByRole('button', { name: 'ตรวจฉบับร่างที่บันทึกแล้ว' }).click();
  const errors = page.getByRole('status').filter({ hasText: /server พบข้อผิดพลาด \d+ รายการ/ });
  await expect(errors).toBeVisible();
  const goTo = page.getByRole('button', { name: /^ไปที่ / }).first();
  await expect(goTo).toBeVisible();
  const diagnosticText = (await errors.innerText()).trim();
  await capture(evidence, 'DIAGNOSTIC_RECOVERY', 'maker', '');
  await goTo.click();

  await page.getByLabel('ถัดไป ของ รอ ไปที่').selectOption({ label: 'จบ Journey' });
  await saveDraft(page);
  await page.getByRole('button', { name: 'ตรวจฉบับร่างที่บันทึกแล้ว' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'server ตรวจแล้วไม่พบข้อผิดพลาด' }),
  ).toBeVisible();
  evidence.actual.set(
    'DIAGNOSTIC_RECOVERY',
    `ตัดเส้นถัดไปของ WAIT แล้ว validate: ${diagnosticText} พร้อมปุ่มไปที่ node; ต่อกลับไป EXIT แล้ว validate ไม่พบข้อผิดพลาด`,
  );
}

/** COMPILE + SIMULATE ด้วย fixture ที่ server ตรึงของรอบ */
async function compileAndSimulate(evidence: RunEvidence) {
  const page = sessions.maker.page;
  const compiled = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname.endsWith('/compile'),
  );
  await page.getByRole('button', { name: 'Compile ฉบับร่าง' }).click();
  const compileBody = (await (await compiled).json()) as {
    artifact: { compileDigest: string };
  };
  evidence.compileDigest = compileBody.artifact.compileDigest;
  await expect(
    page.getByText(`compile แล้ว · digest ${evidence.compileDigest.slice(0, 12)}`, {
      exact: false,
    }),
  ).toBeVisible();
  await capture(
    evidence,
    'COMPILE',
    'maker',
    `compile revision ล่าสุดได้ compile digest ${evidence.compileDigest.slice(0, 12)}`,
  );

  // ไม่มีช่อง context ที่ browser สร้างเองใน UAT — ใช้ fixture ของ server เท่านั้น
  await expect(page.getByLabel('Context สังเคราะห์สำหรับ simulation (JSON)')).toHaveCount(0);
  await expect(
    page.getByRole('definition').filter({ hasText: String(state.simulationFixture.fixtureId) }),
  ).toBeVisible();
  const simulated = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname.endsWith('/simulations'),
  );
  await page.getByRole('button', { name: 'จำลองการทำงาน' }).click();
  const simulation = await simulated;
  expect(simulation.status()).toBe(200);
  expect(simulation.request().postDataJSON()).toMatchObject({ fixture: state.simulationFixture });
  const simulationBody = (await simulation.json()) as { profile: string };
  expect(simulationBody.profile).toBe('SIMULATION_ONLY');
  const result = page.locator('.j5-simulation');
  await expect(result).toContainText('SIMULATION_ONLY');
  await expect(result).toContainText('เวลาเสมือน');
  await expect(result.locator('time').first()).toHaveAttribute(
    'datetime',
    String(state.simulationFixture.startAt),
  );
  await capture(
    evidence,
    'SIMULATE',
    'maker',
    'ผลจำลองติดป้าย SIMULATION_ONLY ใช้ fixture ของ server และแสดงเวลาเสมือน ไม่ใช่การส่งจริง',
  );
}

async function submitReview(evidence: RunEvidence) {
  const page = sessions.maker.page;
  await page.getByRole('button', { name: 'ส่งตรวจ' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'สถานะการตรวจ: IN_REVIEW' }),
  ).toBeVisible();
  // maker เห็นเหตุผลว่าต้องใช้ reviewer คนอื่น และไม่มีปุ่มตัดสิน
  await expect(page.getByRole('note').filter({ hasText: 'ต้องให้ reviewer คนอื่น' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'อนุมัติ', exact: true })).toHaveCount(0);
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
    'ส่งตรวจแล้ว สถานะ IN_REVIEW และ maker ไม่มีปุ่มตัดสินงานของตัวเอง',
  );
}

/** reviewer หา candidate เองจากตัวกรอง "รอตรวจ" แล้วอนุมัติ exact candidate */
async function reviewerApprove(evidence: RunEvidence) {
  const page = await toList('reviewer');
  await page.getByRole('button', { name: 'รอตรวจ' }).click();
  await expect(page.getByRole('button', { name: 'รอตรวจ' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('heading', { level: 2, name: 'งานที่รอให้คุณตรวจ' })).toBeVisible();
  const pending = page.getByRole('table').filter({ hasText: evidence.compileDigest!.slice(0, 12) });
  await expect(pending).toBeVisible();
  await pending.getByRole('button', { name: JOURNEY_NAME }).click();
  await expect(page.getByRole('heading', { level: 1, name: JOURNEY_NAME })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('journey')).toBe(evidence.run.journeyId);
  // exact candidate: compile digest เดียวกับที่ maker ส่ง
  await expect(
    page.getByRole('definition').filter({ hasText: evidence.compileDigest!.slice(0, 12) }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'ส่งตรวจ' })).toHaveCount(0);
  await page.getByRole('button', { name: 'อนุมัติ', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Reason code').fill('LOOKS_GOOD');
  await dialog.getByLabel('Evidence reference').fill(`u1-gate-run-${evidence.run.sequence}`);
  await dialog.getByRole('button', { name: 'อนุมัติ' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'สถานะการตรวจ: APPROVED' }),
  ).toBeVisible();
  await capture(
    evidence,
    'REVIEW_APPROVE',
    'reviewer',
    `reviewer คนละบัญชีหา candidate จากตัวกรองรอตรวจ เห็น compile digest ${evidence.compileDigest!.slice(0, 12)} แล้วอนุมัติได้ APPROVED`,
  );
}

async function publishAndAudit(evidence: RunEvidence) {
  const page = await openRunJourney('maker');
  expect(new URL(page.url()).searchParams.get('journey')).toBe(evidence.run.journeyId);
  await expect(
    page.getByRole('status').filter({ hasText: 'สถานะการตรวจ: APPROVED' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Compile ฉบับร่าง' }).click();
  await expect(page.getByText(`digest ${evidence.compileDigest!.slice(0, 12)}`)).toBeVisible();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  const confirm = page.getByRole('alertdialog', { name: /ยืนยัน publish version 1/ });
  await expect(confirm).toBeVisible();
  const published = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname.endsWith('/publish'),
  );
  await confirm.getByRole('button', { name: 'ยืนยัน Publish' }).click();
  const receipt = (await (await published).json()) as {
    outcome: string;
    version: number;
    receiptId: string;
    runtimeHash: string;
  };
  // receipt ที่ server ยืนยัน (authoritative) — Console แสดงผลหลังรู้ผลเท่านั้น
  expect(receipt).toMatchObject({ outcome: 'PUBLISHED', version: 1 });
  expect(receipt.receiptId).toMatch(/^[0-9a-f-]{36}$/);
  await expect(page.getByText('Publish version 1 สำเร็จ')).toBeVisible();
  const journey = await journeyState('maker', evidence.run.journeyId);
  expect(journey.head.activeVersion).toBe(1);
  await capture(
    evidence,
    'PUBLISH',
    'maker',
    `publish ได้ version 1 receipt ${receipt.receiptId.slice(0, 8)} outcome ${receipt.outcome}`,
  );

  await page.getByRole('button', { name: 'แสดงประวัติ' }).click();
  const timeline = page.getByRole('list', { name: 'ประวัติการเปลี่ยนแปลง ใหม่สุดก่อน' });
  for (const action of ['JOURNEY_PUBLISHED', 'REVIEW_APPROVED', 'REVIEW_SUBMITTED']) {
    await expect(timeline).toContainText(action);
  }
  await timeline.scrollIntoViewIfNeeded();
  await capture(
    evidence,
    'AUDIT',
    'maker',
    'ประวัติแสดง REVIEW_SUBMITTED, REVIEW_APPROVED และ JOURNEY_PUBLISHED ของ Journey รอบนี้',
  );
}

/** บันทึกผลทุก step ผ่านแผง UAT (ผู้ที่ทำ step นั้น) และอัปโหลด screenshot ผ่าน evidence API ของ Console */
async function recordRunEvidence(evidence: RunEvidence) {
  for (const step of state.stepCatalog) {
    const shot = evidence.shots.get(step.stepId);
    const actual = evidence.actual.get(step.stepId);
    expect(shot, `ไม่มี screenshot ของ ${step.stepId}`).toBeTruthy();
    expect(actual, `ไม่มี actual ของ ${step.stepId}`).toBeTruthy();
    const page = sessions[shot!.persona].page;
    const panel = panelOf(page);
    const sequence = panel
      .getByRole('definition')
      .filter({ hasText: `รอบที่ ${evidence.run.sequence}` });
    // แผงของอีกบัญชีไม่ poll — รอบเปลี่ยนโดย maker แล้วต้อง reload หน้าเหมือนผู้ทดสอบจริง
    if (!(await sequence.isVisible())) await reloadSession(sessions[shot!.persona]);
    await expect(sequence).toBeVisible();
    await panel.getByLabel('ขั้นตอนที่ทดสอบ').selectOption(step.stepId);
    await panel.getByLabel('ผ่าน (PASS)').check();
    await panel.getByLabel('สิ่งที่เกิดขึ้นจริง').fill(actual!);
    await panel.getByRole('button', { name: 'บันทึกผล', exact: true }).click();
    await expect(
      panel.getByRole('status').filter({ hasText: `บันทึกผลของ ${step.stepId} แล้ว` }),
    ).toBeVisible();

    const upload = panel.getByRole('region', { name: 'ภาพหน้าจอหลักฐาน' });
    await upload.getByLabel('ขั้นตอนของภาพหน้าจอ').selectOption(step.stepId);
    await upload.getByLabel('ไฟล์ภาพหน้าจอ').setInputFiles({
      name: `${step.stepId}.png`,
      mimeType: 'image/png',
      buffer: shot!.buffer,
    });
    const uploaded = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === `/api/v1/uat-runs/${evidence.run.runId}/evidence`,
    );
    await upload.getByRole('button', { name: 'อัปโหลดภาพหน้าจอ' }).click();
    expect((await uploaded).status()).toBe(200);
    await expect(
      panel.getByRole('status').filter({ hasText: `แนบภาพหน้าจอของ ${step.stepId} แล้ว` }),
    ).toBeVisible();
  }
}

/** ส่งออก bundle ผ่านปุ่มของ Console (fetch + Blob) แล้วตรวจ verdict/scan จาก server */
async function exportBundle(evidence: RunEvidence): Promise<Bundle> {
  const page = sessions.maker.page;
  const region = panelOf(page).getByRole('region', { name: 'ภาพหน้าจอหลักฐาน' });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    region.getByRole('button', { name: 'ส่งออก evidence bundle' }).click(),
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
  await expect(summary.filter({ hasText: 'ผ่าน (PASS)' })).toBeVisible();
  await expect(summary.filter({ hasText: bundle.digest.slice(0, 12) })).toBeVisible();
  evidence.bundle = bundle;
  return bundle;
}

/** เดินครบทั้ง step catalog ในรอบที่เปิดอยู่ (ใช้ทั้งรอบแรกและ rerun) */
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
      ? `รอบที่ ${evidence.run.sequence} ACTIVE; รอบที่ ${previous.run.sequence} ปิดเป็น ${previous.lifecycle} และหลักฐานเดิมยังอ่านได้`
      : `รอบที่ ${evidence.run.sequence} ACTIVE พร้อม run ID, build SHA และ fixture digest จาก server`,
  );
  await makerEdit(evidence);
  await diagnosticRecovery(evidence);
  await compileAndSimulate(evidence);
  await submitReview(evidence);
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test('U1-NEG-EGRESS runtime profile รายงาน providerEgress BLOCKED และ route นอก allowlist ถูกปิดด้วย ROUTE_NOT_AVAILABLE_IN_PROFILE', async () => {
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
  // route ที่พาออกไปหา provider/runtime ใน profile อื่น — ต้องถูกปิดก่อนถึง controller
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
  // LINE webhook ingress ไม่ถูก mount ใน entry ของ UAT เลย (อยู่นอก /api จึงเรียก API ตรง)
  const line = await fetch(`${state.apiUrl}/webhook/line`, { method: 'POST', body: '{}' });
  expect(line.status).toBe(404);
  const after = await api(state, null, 'GET', 'runtime-profile');
  expect(Number(after.body.blockedRequests)).toBeGreaterThanOrEqual(
    Number(before.body.blockedRequests) + probes.length,
  );
});

test('U1-MAKER รอบที่ 1: maker login, เริ่มรอบ, แก้ Journey, diagnostic recovery, compile/simulate และส่งตรวจ', async ({
  browser,
}) => {
  sessions.maker = await login(browser, state.accounts.maker);
  const run1 = await startRunFromConsole(1);
  await walkRun(run1);
});

test('U1-NEG-SELF-APPROVAL maker ที่ถือ journey.review อนุมัติ candidate ที่ตัวเองส่งไม่ได้', async () => {
  const run1 = runs[0]!;
  // UI: ไม่มีปุ่มตัดสินสำหรับผู้ส่งตรวจ
  await expect(
    sessions.maker.page.getByRole('button', { name: 'อนุมัติ', exact: true }),
  ).toHaveCount(0);
  // API จริง: maker มี grant journey.review แต่ maker-checker ต้องปฏิเสธ
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

test('U1-NEG-CROSS-TENANT token ของ tenant อื่นแตะ run/Journey/review/หลักฐานของ tenant A ไม่ได้', async ({
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
  // current/pending ของ tenant B ไม่เห็นของ tenant A
  expect((await api(state, foreign, 'GET', 'uat-runs/current')).status).toBe(404);
  const pending = await api(state, foreign, 'GET', 'journey-authoring/reviews');
  expect(pending.status).toBe(200);
  expect(JSON.stringify(pending.body)).not.toContain(run1.run.journeyId);
  const visible = await api(state, foreign, 'GET', 'journey-authoring/journeys');
  expect(JSON.stringify(visible.body)).not.toContain(run1.run.journeyId);

  // UI: deep link ของ tenant B ไป Journey ของ tenant A = ไม่พบ ไม่ใช่ข้อมูลของ tenant อื่น
  const page = await openJourney('foreign', run1.run.journeyId, state.accounts.foreign.tenantSlug);
  await expect(page.getByText('ไม่พบ Journey นี้ หรือคุณไม่มีสิทธิ์เห็น')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: JOURNEY_NAME })).toHaveCount(0);
  // run ของ tenant A ยังเหมือนเดิม
  const after = await currentRun();
  expect(after.runId).toBe(run1.run.runId);
  expect(after.stepResults).toEqual([]);
});

test('U1-REVIEW reviewer คนละบัญชีหา candidate เองจากตัวกรองรอตรวจ ตรวจ exact candidate แล้วอนุมัติ', async ({
  browser,
}) => {
  sessions.reviewer = await login(browser, state.accounts.reviewer);
  await reviewerApprove(runs[0]!);
  const journey = await journeyState('reviewer', runs[0]!.run.journeyId);
  expect(journey.review?.state).toBe('APPROVED');
});

test('U1-PUBLISH maker publish ได้ version/receipt ที่ server ยืนยัน และเห็น audit', async () => {
  await publishAndAudit(runs[0]!);
});

test('U1-EVIDENCE รอบที่ 1: บันทึกผลทุก step + screenshot ผ่าน evidence API และ bundle ได้ verdict PASS/scan PASSED', async () => {
  await recordRunEvidence(runs[0]!);
  const bundle = await exportBundle(runs[0]!);
  evidenceOut.bundles.push(bundle);
  persistEvidence();
});

test('U1-RERUN เริ่มรอบใหม่: รอบที่ 2 ACTIVE, รอบที่ 1 COMPLETED และหลักฐานเดิมไม่เปลี่ยน', async () => {
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
  // bundle ของรอบเดิมยังส่งออกได้ ผลบันทึก/หลักฐานเดิมครบ เปลี่ยนแค่ lifecycle
  const again = await api(state, sessions.maker, 'GET', `uat-runs/${run1.run.runId}/bundle`);
  const bundle = again.body as unknown as Bundle;
  expect(bundle.manifest.lifecycle).toBe('COMPLETED');
  expect(bundle.stepResults).toEqual(run1.bundle!.stepResults);
  expect(bundle.screenshots).toEqual(run1.bundle!.screenshots);
  expect(bundle.verdict).toBe('PASS');
  // audit ของ Journey รอบเดิมยังอ่านได้
  const audit = await api(
    state,
    sessions.maker,
    'GET',
    `journey-authoring/journeys/${run1.run.journeyId}/audit`,
  );
  expect(audit.status).toBe(200);
});

test('U1-NEG-ABANDONED candidate ของรอบที่ถูก ABANDONED ส่งตรวจ/publish/แก้ต่อไม่ได้ (UAT_RUN_CLOSED)', async () => {
  const run2 = runs[1]!;
  // maker ทำงานในรอบที่ 2 ถึงขั้น compile (candidate) แล้วเริ่มรอบใหม่โดยไม่ publish
  await makerEdit(run2);
  const page = sessions.maker.page;
  await page.getByRole('button', { name: 'Compile ฉบับร่าง' }).click();
  await expect(page.getByText(/compile แล้ว · digest/)).toBeVisible();
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
    body: { stepId: 'RUN_OPENED', outcome: 'PASS', actual: 'บันทึกหลังรอบปิด' },
  });
  expect([late.status, late.body.code]).toEqual([409, 'UAT_RUN_CLOSED']);
  const head = await journeyState('maker', run2.run.journeyId);
  expect(head.review).toBeNull();
  expect(head.head.activeVersion).toBeNull();

  // UI: Journey ของรอบที่ปิดแล้วส่งตรวจไม่ได้ — server ปฏิเสธและ Console บอกเหตุ
  const run2Page = await openJourney('maker', run2.run.journeyId);
  await expect(run2Page.getByRole('heading', { level: 1, name: JOURNEY_NAME })).toBeVisible();
  await run2Page.getByRole('button', { name: 'Compile ฉบับร่าง' }).click();
  await expect(run2Page.getByText(/compile แล้ว · digest/)).toBeVisible();
  await run2Page.getByRole('button', { name: 'ส่งตรวจ' }).click();
  await expect(run2Page.getByText('สถานะของ Journey ไม่อนุญาตคำสั่งนี้')).toBeVisible();
  expect((await journeyState('maker', run2.run.journeyId)).review).toBeNull();
});

test('U1-RERUN รอบที่ 3: rerun ครบทุก step หลังเริ่มรอบใหม่ และ bundle ได้ verdict PASS', async () => {
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
  // run ของทุกรอบยังอยู่ครบ (ไม่มีอะไรถูกลบ): 3 → 2 → 1
  const history = await api(state, sessions.maker, 'GET', 'uat-runs?limit=10');
  const items = (history.body as { items: RunView[] }).items;
  expect(items.map((item) => [item.sequence, item.lifecycle])).toEqual([
    [3, 'ACTIVE'],
    [2, 'ABANDONED'],
    [1, 'COMPLETED'],
  ]);
});

test('U1-EVIDENCE หลักฐานของรอบที่ผ่านทั้งสองรอบพร้อมใน manifest และไม่มี trace/HAR', async () => {
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
