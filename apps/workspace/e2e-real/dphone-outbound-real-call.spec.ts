import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Frame, type Page } from '@playwright/test';

const here = resolve(fileURLToPath(new URL('.', import.meta.url)));
const repoRoot = resolve(here, '../../..');
const compose = ['compose', '-f', 'infra/docker/docker-compose.dev.yml'];
const database = process.env.E1_18_DATABASE ?? 'dcontact_e1_18';
const evidenceDir = resolve(here, '../test-results-outbound-real/evidence');
const sippImage =
  'ctaloi/sipp@sha256:c459f2340443ddcc159227efc798217dbdaad0dbe88b76b78b1a876aa271986a';

function psql(sql: string): string {
  const result = spawnSync(
    'docker',
    [...compose, 'exec', '-T', 'postgres', 'psql', '-U', 'dcontact', '-d', database, '-Atc', sql],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`psql ล้มเหลว: ${result.stdout}${result.stderr}`);
  return result.stdout.trim();
}

async function embeddedFrame(page: Page): Promise<Frame> {
  await expect
    .poll(() => page.frames().some((frame) => frame.url().includes('/dphone/embed')))
    .toBe(true);
  return page.frames().find((frame) => frame.url().includes('/dphone/embed'))!;
}

async function login(page: Page, frame: Frame) {
  const popupPromise = page.context().waitForEvent('page');
  await frame.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
  const popup = await popupPromise;
  await popup.waitForURL(/\/realms\/dcontact\//);
  await popup.locator('#username').fill('agent1000@demo.local');
  if (!(await popup.locator('#password').isVisible())) await popup.locator('#kc-login').click();
  await popup.locator('#password').fill('agent1234');
  await popup.locator('#kc-login').click();
  await expect(
    frame.getByRole('region', { name: 'การเข้าสู่ระบบของ dphone' }).getByRole('status'),
  ).toHaveText('เข้าสู่ระบบแล้ว');
  if (!popup.isClosed()) await popup.close();
}

async function requestCall(page: Page, frame: Frame, number: string, expected: RegExp) {
  await page.getByLabel('เบอร์โทร').fill(number);
  await page.getByRole('button', { name: 'ส่งเบอร์ให้ dphone' }).click();
  const prompt = frame.getByRole('region', { name: 'โทรออกจากระบบที่ฝัง' });
  await prompt.getByRole('button', { name: 'โทร', exact: true }).click();
  await expect(page.locator('#call-result')).toHaveText(expected);
  return prompt;
}

test('E1.18 real stack: ALLOW โทรจริง; BLOCK/DEFER/REVIEW ไม่แตะ provider', async ({ page }) => {
  mkdirSync(evidenceDir, { recursive: true });
  await page.goto('/');
  await expect(page.locator('body')).toHaveAttribute('data-dphone-ready', 'true');
  const frame = await embeddedFrame(page);
  await login(page, frame);

  await frame.getByRole('button', { name: 'ตรวจอุปกรณ์เสียง' }).click();
  const dphone = frame.getByRole('region', { name: 'dphone' });
  await expect(dphone.getByRole('status', { name: 'dphone' })).toHaveText('โทรศัพท์พร้อม');
  await frame.getByRole('button', { name: 'เปิดรับสาย' }).click();

  const allowPrompt = await requestCall(page, frame, '1001', /^ผล: dialing \(QUEUED\)$/);
  await expect(dphone.getByRole('status', { name: 'dphone' })).toHaveText('มีสายเรียกเข้า');
  await dphone.getByRole('button', { name: 'รับสาย' }).click();
  await expect(dphone.getByRole('status', { name: 'dphone' })).toHaveText('กำลังสนทนา');
  await expect
    .poll(
      () =>
        psql(
          "SELECT count(*) FROM dl_outbox_entries WHERE adapter='FREESWITCH_ORIGINATE' AND state='SETTLED' AND outcome='DELIVERED'",
        ),
      { timeout: 30_000 },
    )
    .toBe('1');
  await dphone.getByRole('button', { name: 'วางสาย' }).click();
  await allowPrompt.getByRole('button', { name: 'ปิด' }).click();

  await requestCall(page, frame, '1002', /^ผล: blocked \(CONSENT_REVOKED\)$/);

  await requestCall(page, frame, '1003', /^ผล: blocked \(IDENTITY_NOT_FOUND\)$/);

  psql(`INSERT INTO cg_policies
    (id, tenant_id, policy_id, version, purpose, channel, timezone_fallback, quiet_hours,
     callback_mode, overridable_rules, status, content_digest, maker_actor_ref, checker_actor_ref,
     approval_ref, effective_from, published_at, created_at)
    VALUES (gen_random_uuid(), '${process.env.E1_18_TENANT_ID}', gen_random_uuid(), 1,
      'SERVICE', 'VOICE', 'Asia/Bangkok',
      '[{"daysOfWeek":[1,2,3,4,5,6,7],"startLocal":"00:00","endLocal":"23:59"}]'::jsonb,
      'NO_OVERRIDE', '[]'::jsonb, 'PUBLISHED', repeat('a',64), 'e1-18-maker',
      'e1-18-checker', 'e1-18-acceptance', NOW() - interval '1 day', NOW() - interval '1 day', NOW())`);
  await requestCall(page, frame, '1001', /^ผล: blocked \(QUIET_HOURS\)$/);

  await expect
    .poll(() => psql("SELECT count(*) FROM dl_outbox_entries WHERE adapter='FREESWITCH_ORIGINATE'"))
    .toBe('1');
  const decisions = psql(
    "SELECT string_agg(decision, ',' ORDER BY occurred_at) FROM dphone_click_to_call_audit_events",
  );
  expect(decisions.split(',')).toEqual(['ALLOW', 'BLOCK', 'REVIEW', 'DEFER']);
  const durable = psql(`SELECT concat_ws('|', o.state, o.outcome, r.state, r.settlement_status,
      i.direction, i.state, count(c.delivery_id))
    FROM dl_outbox_entries o
    JOIN cg_reservations r ON r.tenant_id=o.tenant_id AND r.id=o.reservation_id
    JOIN dl_voice_originates v ON v.tenant_id=o.tenant_id AND v.delivery_id=o.delivery_id
    JOIN interactions i ON i.tenant_id=o.tenant_id AND i.id=v.interaction_id
    LEFT JOIN dl_voice_cap_ledger c ON c.tenant_id=o.tenant_id AND c.delivery_id=o.delivery_id
    WHERE o.adapter='FREESWITCH_ORIGINATE'
    GROUP BY o.state,o.outcome,r.state,r.settlement_status,i.direction,i.state`);
  expect(durable).toMatch(/^SETTLED\|DELIVERED\|CONFIRMED\|SETTLED\|OUTBOUND\|(ACTIVE|WRAPUP)\|1$/);
  const direct = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      'd-contact-dev_default',
      '-v',
      `${resolve(repoRoot, 'scripts/fixtures/e1-18-direct-outbound-denied.xml')}:/scenario.xml:ro`,
      sippImage,
      'freeswitch:5060',
      '-sf',
      '/scenario.xml',
      '-m',
      '1',
      '-timeout',
      '15s',
      '-timeout_error',
      '-nostdin',
      '-trace_err',
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  expect(`${direct.stdout}${direct.stderr}`, 'agent direct outbound ต้องถูกปฏิเสธด้วย 603').toMatch(
    /Successful call\s+\|\s+0\s+\|\s+1/,
  );
  expect(direct.status).toBe(0);
  writeFileSync(
    resolve(evidenceDir, 'e1-18-real-call-evidence.json'),
    `${JSON.stringify(
      {
        type: 'e1.18.voice-delivery-acceptance',
        status: 'PASS',
        marker: 'OUTBOUND_DELIVERY_VOICE_SANDBOX_READY',
        tenantId: process.env.E1_18_TENANT_ID,
        telephonyNodeId: process.env.E1_18_NODE_ID,
        decisions,
        durable,
        providerSubmissions: 1,
      },
      null,
      2,
    )}\n`,
  );
});
