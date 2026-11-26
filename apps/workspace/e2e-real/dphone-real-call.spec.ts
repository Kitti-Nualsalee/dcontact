import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { th } from '../e2e/catalog';

/**
 * D1.16 (#455): the non-waivable acceptance of D1 (#428) on a real call in the dev stack
 *
 * agent1000 logs in through Keycloak (PKCE) → check audio devices with fake media → SIP.js registers with
 * FreeSWITCH → SIPp calls queue 2000 → Router offers the call → answer in dphone, then measure at every step that the
 * SIP session ID, WS connection ID, `performance.timeOrigin` and the number of navigation entries do not change
 * and the call's channel in FreeSWITCH is still the same ACTIVE one (the call was not cut or recreated on the media side)
 *
 * run only through `pnpm d1:real-call` — the harness prepares the stack
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
  if (result.status !== 0) throw new Error(`fs_cli failed: ${result.stderr}`);
  return (JSON.parse(result.stdout) as { rows?: FsChannel[] }).rows ?? [];
}

/** inbound leg from SIPp (destination 2000) and the leg bridged to agent 1000 */
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
      // #562: the customer call arrives through the simulated trunk `pstn-sim`
      'freeswitch:5080',
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
  await page.getByRole('button', { name: th('dphone:embedAuth.signIn') }).click();
  await page.waitForURL(/\/realms\/dcontact\//);
  // Keycloak Organizations uses identity-first: enter the username and submit first, to get the password page
  await page.locator('#username').fill('agent1000@demo.local');
  if (!(await page.locator('#password').isVisible())) await page.locator('#kc-login').click();
  await page.locator('#password').fill('agent1234');
  await page.locator('#kc-login').click();
  await page.waitForURL((url) => url.origin === 'http://localhost:5173');
}

test('real call: collapse/expand 3 sizes, detach/pull back, and switch language — no reload, no cut call/WS', async ({
  page,
  context,
}) => {
  mkdirSync(evidenceDir, { recursive: true });
  const consoleLines: string[] = [];
  context.on('console', (message) =>
    consoleLines.push(`[${message.type()}] ${message.text()}`.slice(0, 2_000)),
  );
  // SIP between the browser and FreeSWITCH (first line + SDP that affects the media connection) for diagnosing a failure
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
  // the locale is stored in Keycloak — a previous run that failed midway may leave it as English
  await page.getByRole('button', { name: th('ui:shell.languageNames.th') }).click();
  const dphone = page.getByRole('region', { name: 'dphone' });
  await expect(dphone).toBeVisible();
  await page.getByRole('button', { name: th('workspace:media.check') }).click();
  await expect(dphone.getByRole('status', { name: 'dphone' })).toHaveText(th('dphone:phase.READY'));
  await page.getByRole('button', { name: th('workspace:availability.open') }).click();
  await expect.poll(async () => (await evidence(page)).ws).toBeTruthy();

  const caller = placeCall();
  try {
    await expect(dphone.getByRole('status', { name: 'dphone' })).toHaveText(
      th('dphone:phase.RINGING'),
      {
        timeout: 60_000,
      },
    );
    await dphone.getByRole('button', { name: th('dphone:accept') }).click();
    await expect(dphone.getByRole('status', { name: 'dphone' })).toHaveText(
      th('dphone:phase.ACTIVE'),
    );
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
    await dphone.getByRole('button', { name: th('dphone:size.bar') }).click();
    await expect(dphone.getByRole('button', { name: th('dphone:mute') })).toHaveCount(0);
    await dphone.screenshot({ path: resolve(evidenceDir, 'dphone-th-bar.png') });
    await check('collapse to bar');

    await dphone.getByRole('button', { name: th('dphone:size.expanded') }).click();
    await dphone.getByRole('button', { name: th('dphone:dtmf', { value: '5' }) }).click();
    await dphone.screenshot({ path: resolve(evidenceDir, 'dphone-th-expanded.png') });
    await check('expand with keypad + DTMF');

    await dphone.getByRole('button', { name: th('dphone:size.compact') }).click();
    await dphone.screenshot({ path: resolve(evidenceDir, 'dphone-th-compact.png') });
    await check('compact');

    await page.getByRole('button', { name: 'English' }).click();
    await expect(dphone.getByRole('status', { name: 'dphone' })).toHaveText('On a call');
    await page.screenshot({ path: resolve(evidenceDir, 'workspace-en-call-compact.png') });
    await check('switch to English');

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
    await check('detach window + hold/resume the call from the detached window');

    await page.getByRole('button', { name: th('ui:shell.languageNames.th') }).click();
    await expect(remote.getByRole('status', { name: 'dphone' })).toHaveText(
      th('dphone:phase.ACTIVE'),
    );
    await check('switch back to Thai while detached');

    const closed = popup.waitForEvent('close');
    await page.getByRole('button', { name: th('dphone:attach') }).click();
    await closed;
    await expect(dphone.getByRole('button', { name: th('dphone:hangup') })).toBeVisible();
    await check('pull dphone back');

    await dphone.getByRole('button', { name: th('dphone:hangup') }).click();
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
