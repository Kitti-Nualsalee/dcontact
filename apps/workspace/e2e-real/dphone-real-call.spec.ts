import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

/**
 * D1.16 (#455): acceptance ที่ห้าม waive ของ D1 (#428) บนสายจริงใน dev stack
 *
 * เอเจนต์ agent1000 login ผ่าน Keycloak (PKCE) → ตรวจอุปกรณ์เสียงด้วย fake media → SIP.js ลงทะเบียนกับ
 * FreeSWITCH → SIPp โทรเข้าคิว 2000 → Router เสนอสาย → รับสายใน dphone แล้ววัดทุกขั้นว่า
 * SIP session ID, WS connection ID, `performance.timeOrigin` และจำนวน navigation entry ไม่เปลี่ยน
 * และ channel ของสายใน FreeSWITCH ยังเป็นชุดเดิมที่ ACTIVE (สายไม่ถูกตัดหรือสร้างใหม่ฝั่ง media)
 *
 * รันผ่าน `pnpm d1:real-call` เท่านั้น — harness เตรียม stack ให้
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const compose = ['compose', '-f', 'infra/docker/docker-compose.dev.yml'];
const sippImage =
  'ctaloi/sipp@sha256:c459f2340443ddcc159227efc798217dbdaad0dbe88b76b78b1a876aa271986a';
const evidenceDir = resolve(here, '../test-results-real/evidence');

interface FsChannel {
  uuid: string;
  callstate: string;
  initial_dest?: string;
  dest?: string;
  presence_id?: string;
}

function fsChannels(): FsChannel[] {
  const result = spawnSync(
    'docker',
    [...compose, 'exec', '-T', 'freeswitch', 'fs_cli', '-x', 'show channels as json'],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`fs_cli ล้มเหลว: ${result.stderr}`);
  return (JSON.parse(result.stdout) as { rows?: FsChannel[] }).rows ?? [];
}

/** leg ขาเข้าจาก SIPp (ปลายทาง 2000) และ leg ที่ bridge ไปหาเอเจนต์ 1000 */
function callLegs() {
  const rows = fsChannels();
  const inbound = rows.find((row) => row.initial_dest === '2000');
  const agent = rows.find(
    (row) => row.uuid !== inbound?.uuid && /(^|\/)1000@/.test(`${row.presence_id ?? row.dest}`),
  );
  return {
    inbound: inbound ? `${inbound.uuid}:${inbound.callstate}` : undefined,
    agent: agent ? `${agent.uuid}:${agent.callstate}` : undefined,
  };
}

function placeCall(): { process: ChildProcess; output: () => string } {
  const child = spawn(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      'd-contact-dev_default',
      '-v',
      `${resolve(repoRoot, 'scripts/fixtures/d1-real-call-uac.xml')}:/scenario.xml:ro`,
      sippImage,
      'freeswitch:5060',
      '-sf',
      '/scenario.xml',
      '-cid_str',
      `dcontact-d1-16-${process.pid}-%u@%s`,
      '-m',
      '1',
      '-timeout',
      '150s',
      '-timeout_error',
      '-nostdin',
      '-trace_err',
    ],
    { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout?.on('data', (chunk) => (output += chunk.toString()));
  child.stderr?.on('data', (chunk) => (output += chunk.toString()));
  return { process: child, output: () => output };
}

const evidence = (page: Page) =>
  page.evaluate(() => ({
    sip: window.__dcontactDphone?.sipSessionId(),
    ws: window.__dcontactDphone?.wsConnectionId(),
    timeOrigin: performance.timeOrigin,
    navigations: performance
      .getEntriesByType('navigation')
      .map((entry) => (entry as PerformanceNavigationTiming).type),
  }));

async function login(page: Page) {
  await page.goto('/?tenant=demo');
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
  await page.waitForURL(/\/realms\/dcontact\//);
  // Keycloak Organizations ใช้ identity-first: กรอก username แล้วส่งก่อน จึงได้หน้ารหัสผ่าน
  await page.locator('#username').fill('agent1000@demo.local');
  if (!(await page.locator('#password').isVisible())) await page.locator('#kc-login').click();
  await page.locator('#password').fill('agent1234');
  await page.locator('#kc-login').click();
  await page.waitForURL((url) => url.origin === 'http://localhost:5173');
}

test('สายจริง: ย่อ/ขยาย 3 ขนาด แยกหน้าต่าง/ดึงกลับ และสลับภาษา — ไม่ reload ไม่ตัดสาย/WS', async ({
  page,
  context,
}) => {
  mkdirSync(evidenceDir, { recursive: true });
  const consoleLines: string[] = [];
  context.on('console', (message) =>
    consoleLines.push(`[${message.type()}] ${message.text()}`.slice(0, 2_000)),
  );
  // SIP ระหว่าง browser กับ FreeSWITCH (บรรทัดแรก + SDP ที่มีผลกับการต่อ media) สำหรับวินิจฉัยเมื่อ fail
  const sipLines: string[] = [];
  const sipSummary = (direction: string, payload: string | Buffer) => {
    const text = payload.toString();
    const lines = text.split('\r\n');
    const keep = lines.filter((line) =>
      /^(Reason:|m=|a=(fingerprint|setup|rtcp-mux|ice-|candidate|rtpmap|crypto|sendrecv|sendonly|recvonly|inactive)|c=)/.test(
        line,
      ),
    );
    sipLines.push(`${direction} ${lines[0]}${keep.length ? `\n  ${keep.join('\n  ')}` : ''}`);
  };
  page.on('websocket', (socket) => {
    if (!socket.url().includes(':5066')) return;
    socket.on('framesent', (frame) => sipSummary('>>', frame.payload));
    socket.on('framereceived', (frame) => sipSummary('<<', frame.payload));
  });
  const steps: Array<{ step: string; evidence: unknown; legs: unknown }> = [];

  await login(page);
  // locale ถูกเก็บใน Keycloak — รอบก่อนที่ล้มกลางทางอาจค้างเป็น English
  await page.getByRole('button', { name: 'ไทย' }).click();
  const dphone = page.getByRole('region', { name: 'dphone' });
  await expect(dphone).toBeVisible();
  await page.getByRole('button', { name: 'ตรวจอุปกรณ์เสียง' }).click();
  await expect(dphone.getByRole('status', { name: 'dphone' })).toHaveText('โทรศัพท์พร้อม');
  await page.getByRole('button', { name: 'เปิดรับสาย' }).click();
  await expect.poll(async () => (await evidence(page)).ws).toBeTruthy();

  const caller = placeCall();
  try {
    await expect(dphone.getByRole('status', { name: 'dphone' })).toHaveText('มีสายเรียกเข้า', {
      timeout: 60_000,
    });
    await dphone.getByRole('button', { name: 'รับสาย' }).click();
    await expect(dphone.getByRole('status', { name: 'dphone' })).toHaveText('กำลังสนทนา');
    await expect.poll(() => callLegs().agent, { timeout: 20_000 }).toMatch(/:ACTIVE$/);

    const before = await evidence(page);
    const legsBefore = callLegs();
    expect(before.sip).toMatch(/[0-9a-f-]{36}/);
    expect(before.ws).toBeTruthy();
    expect(before.navigations).toEqual(['navigate']);
    expect(legsBefore.inbound).toMatch(/:ACTIVE$/);

    const check = async (step: string) => {
      const now = await evidence(page);
      const legs = callLegs();
      steps.push({ step, evidence: now, legs });
      expect(now, step).toEqual(before);
      expect(legs, step).toEqual(legsBefore);
    };

    await page.screenshot({ path: resolve(evidenceDir, 'workspace-th-call-compact.png') });
    await dphone.getByRole('button', { name: 'ย่อเป็นแถบ' }).click();
    await expect(dphone.getByRole('button', { name: 'ปิดไมค์' })).toHaveCount(0);
    await dphone.screenshot({ path: resolve(evidenceDir, 'dphone-th-bar.png') });
    await check('ย่อเป็นแถบ');

    await dphone.getByRole('button', { name: 'ขยายพร้อมแป้นกด' }).click();
    await dphone.getByRole('button', { name: 'ส่ง DTMF 5' }).click();
    await dphone.screenshot({ path: resolve(evidenceDir, 'dphone-th-expanded.png') });
    await check('ขยายพร้อมแป้นกด + DTMF');

    await dphone.getByRole('button', { name: 'กะทัดรัด' }).click();
    await dphone.screenshot({ path: resolve(evidenceDir, 'dphone-th-compact.png') });
    await check('กะทัดรัด');

    await page.getByRole('button', { name: 'English' }).click();
    await expect(dphone.getByRole('status', { name: 'dphone' })).toHaveText('On a call');
    await page.screenshot({ path: resolve(evidenceDir, 'workspace-en-call-compact.png') });
    await check('สลับเป็น English');

    const [popup] = await Promise.all([
      context.waitForEvent('page'),
      dphone.getByRole('button', { name: 'Pop dphone out to a window' }).click(),
    ]);
    const remote = popup.getByRole('region', { name: 'dphone' });
    await expect(remote.getByRole('status', { name: 'dphone' })).toHaveText('On a call');
    await remote.getByRole('button', { name: 'Hold' }).click();
    await expect(remote.getByRole('status', { name: 'dphone' })).toHaveText('On hold');
    await remote.getByRole('button', { name: 'Resume' }).click();
    await expect(remote.getByRole('status', { name: 'dphone' })).toHaveText('On a call');
    await check('แยกหน้าต่าง + พัก/กลับเข้าสายจากหน้าต่างแยก');

    await page.getByRole('button', { name: 'ไทย' }).click();
    await expect(remote.getByRole('status', { name: 'dphone' })).toHaveText('กำลังสนทนา');
    await check('สลับกลับเป็นไทยขณะแยกหน้าต่าง');

    const closed = popup.waitForEvent('close');
    await page.getByRole('button', { name: 'กลับมาที่ Workspace' }).click();
    await closed;
    await expect(dphone.getByRole('button', { name: 'วางสาย' })).toBeVisible();
    await check('ดึง dphone กลับ');

    await dphone.getByRole('button', { name: 'วางสาย' }).click();
    const callerExit = await new Promise<number | null>((done) => {
      if (caller.process.exitCode !== null) done(caller.process.exitCode);
      else caller.process.once('exit', (code) => done(code));
    });
    expect(callerExit, caller.output()).toBe(0);
    expect(caller.output()).toMatch(/Successful call\s+\|\s+0\s+\|\s+1/);

    writeFileSync(
      resolve(evidenceDir, 'd1-real-call-evidence.json'),
      `${JSON.stringify(
        {
          type: 'd1.real-call-acceptance',
          status: 'PASS',
          tenantId: process.env.D1_REAL_CALL_TENANT_ID,
          telephonyNodeId: process.env.D1_REAL_CALL_NODE_ID,
          baseline: before,
          freeswitchLegs: legsBefore,
          steps,
          caller: 'SIPp received BYE after agent hangup (Successful call 1)',
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    if (caller.process.exitCode === null) caller.process.kill('SIGTERM');
    writeFileSync(resolve(evidenceDir, 'browser-console.log'), `${consoleLines.join('\n')}\n`);
    writeFileSync(resolve(evidenceDir, 'sipp-caller.log'), caller.output());
    writeFileSync(resolve(evidenceDir, 'browser-sip.log'), `${sipLines.join('\n')}\n`);
  }
});
