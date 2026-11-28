import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { th } from '../e2e/catalog';
import { thRegExp, escapeRegExp } from '../e2e/locale-match';

/**
 * Sales-team Demo rehearsal for the Agent side on the stack that `scripts/sales-demo-stack.mjs` already brought up
 *
 * agent1000 logs in → picks Ready on the status picker page → SIPp calls queue 2000 → answer → search and link the customer imported from CSV →
 * edit the company → hang up → save disposition/note → open the result in the work history
 *
 * a rehearsal tool, not acceptance: audio is fake media, and the `dcontact_demo` DB has permissions seeded directly
 * `examples/sales-demo/customers.csv` must be imported in Console first (the first-row customer uses the number below)
 *
 * fails fast with the cause instead of waiting for a timeout: the DB has no customer to rehearse with, the search finds no customer,
 * the Workspace page reloaded / the dev server dropped mid-run (the stack was stopped or restarted during rehearsal)
 * or a previous run left a call in progress so Ready cannot be selected
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const shots = resolve(here, '../test-results-real/sales-demo');
const sippImage =
  'ctaloi/sipp@sha256:c459f2340443ddcc159227efc798217dbdaad0dbe88b76b78b1a876aa271986a';
const customerPhone = process.env.SALES_DEMO_CUSTOMER_PHONE ?? '+66895550110';
// the same database the stack uses (scripts/sales-demo-stack.mjs reads the same variable)
// SALES_DEMO_OUTCOME=followUp saves FOLLOW_UP_REQUIRED instead (the Journey trial, #1067)
const wrapupOutcome = process.env.SALES_DEMO_OUTCOME === 'followUp' ? 'followUp' : 'assisted';
const demoDatabase = process.env.SALES_DEMO_DATABASE ?? 'dcontact_demo';

function placeCall(): ChildProcess {
  return spawn(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      'd-contact-dev_default',
      '-v',
      `${resolve(repoRoot, 'scripts/fixtures/d1-real-call-uac.xml')}:/scenario.xml:ro`,
      sippImage,
      'freeswitch:5080',
      '-sf',
      '/scenario.xml',
      '-cid_str',
      `dcontact-sales-demo-${process.pid}-%u@%s`,
      '-m',
      '1',
      '-timeout',
      '150s',
      '-timeout_error',
      '-nostdin',
      '-trace_err',
    ],
    { cwd: repoRoot, stdio: 'ignore' },
  );
}

/** number of customer phone numbers used for rehearsal in tenant demo — pass the number as a psql variable, do not concatenate an SQL string */
function customerPhoneCount(): number {
  const result = spawnSync(
    'docker',
    [
      'compose',
      '-f',
      'infra/docker/docker-compose.dev.yml',
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'dcontact',
      '-d',
      demoDatabase,
      '-v',
      'ON_ERROR_STOP=1',
      '-v',
      `phone=${customerPhone}`,
      '-At',
      '-f',
      '-',
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      input: `SELECT count(*) FROM c360_contact_points p JOIN tenants t ON t.id = p.tenant_id
        WHERE t.slug = 'demo' AND p.kind = 'PHONE' AND p.retired_at IS NULL
          AND p.normalized_value = :'phone';`,
    },
  );
  if (result.status !== 0)
    throw new Error(
      `cannot read the ${demoDatabase} DB — bring up the stack with node scripts/sales-demo-stack.mjs first (${result.stderr.trim().split('\n')[0]})`,
    );
  return Number(result.stdout.trim());
}

async function login(page: Page) {
  await page.goto('/?tenant=demo');
  await page.getByRole('button', { name: th('dphone:embedAuth.signIn') }).click();
  await page.waitForURL(/\/realms\/dcontact\//);
  await page.locator('#username').fill('agent1000@demo.local');
  if (!(await page.locator('#password').isVisible())) await page.locator('#kc-login').click();
  await page.locator('#password').fill('agent1234');
  await page.locator('#kc-login').click();
  await page.waitForURL((url) => url.origin === 'http://localhost:5173');
  // the rehearsal reads the Thai catalog: switch back when the user's saved language (Keycloak `locale`) is English
  const thai = page.getByRole('button', { name: 'ไทย', exact: true }); // allow-thai: the button is named in its own language in both catalogs
  await thai.waitFor({ timeout: 30_000 });
  if ((await thai.getAttribute('aria-pressed')) !== 'true') await thai.click();
}

test('Demo rehearsal: answer, link the customer, edit data, save the outcome, and open the history', async ({
  page,
  context,
}) => {
  expect(
    customerPhoneCount(),
    `the ${demoDatabase} DB has no customer with number ${customerPhone} in tenant demo — ` +
      'import examples/sales-demo/customers.csv in Console before rehearsing (after --reset it must be imported again)',
  ).toBeGreaterThan(0);
  mkdirSync(shots, { recursive: true });
  const shot = (name: string) => page.screenshot({ path: resolve(shots, `${name}.png`) });

  // diagnose a failed rehearsal: the result of the customer-side work API (status/code only, no customer data)
  page.on('response', async (response) => {
    const url = response.url();
    if (!/customer-360\/work|workspace\/agent\/session/.test(url) || response.status() < 400)
      return;
    const body = await response.text().catch(() => '');
    console.log(`[work-api] ${response.status()} ${new URL(url).pathname} ${body.slice(0, 200)}`);
  });
  await login(page);
  // after login the Workspace page must not reload until the run ends; if it reloads the in-memory auth is lost and the page returns to the
  // sign-in button, and every following step waits until timeout — close the page so pending commands fail at once and report the cause
  let aborted: string | undefined;
  const abort = (reason: string) => {
    if (aborted) return;
    aborted = reason;
    void page.close();
  };
  // 'load' = a full document reload, not counting a URL change within the same page (history API)
  page.on('load', () =>
    abort(
      `the Workspace page reloaded mid-run (${page.url()}) — the stack may have been stopped or restarted during rehearsal`,
    ),
  );
  page.on('console', (message) => {
    if (message.text().includes('server connection lost'))
      abort(
        'the Workspace dev server dropped mid-run — the stack was stopped or restarted during rehearsal',
      );
  });
  try {
    await rehearse();
  } catch (error) {
    if (aborted) throw new Error(aborted, { cause: error });
    throw error;
  }

  async function rehearse() {
    // a previous rehearsal or another tab may still hold agent1000's work session (move here)
    // or the old session expired and nobody has taken work yet (start taking work here)
    const takeOver = page.getByRole('button', { name: th('workspace:lease.move') });
    const startHere = page.getByRole('button', { name: th('workspace:lease.start') });
    const dphone = page.getByRole('region', { name: 'dphone' });
    const status = dphone.getByRole('status', { name: 'dphone' });
    // the work session window can pop up at any time after the first snapshot — have Playwright press it every time it blocks a press
    // in some runs the window disappears by itself once no one holds the session, so a press that comes too late is not counted as a failure
    await page.addLocatorHandler(
      takeOver.or(startHere),
      async () => {
        if (await startHere.isVisible()) {
          await startHere.click({ timeout: 2_000 }).catch(() => undefined);
          return;
        }
        await takeOver.click({ timeout: 2_000 }).catch(() => undefined);
        await page
          .getByRole('button', { name: th('workspace:lease.confirm') })
          .click({ timeout: 5_000 })
          .catch(() => undefined);
      },
      { noWaitAfter: true },
    );
    await expect(dphone).toBeVisible({ timeout: 30_000 });
    // #938 status picker page after login — a leftover job from the previous run skips this page straight to Workspace
    const gate = page.getByRole('region', {
      name: new RegExp(`^${escapeRegExp(th('workspace:agentStatus.gate.title', { name: '' }))}`),
    });
    const workList = page.getByRole('region', { name: th('workspace:layout.work') });
    await expect(gate.or(workList).first()).toBeVisible({ timeout: 30_000 });
    if (await gate.isVisible()) {
      await gate.getByRole('radio', { name: /^Ready/ }).check();
      await gate.getByRole('button', { name: th('workspace:agentStatus.gate.enter') }).click();
      await expect(gate)
        .toHaveCount(0, { timeout: 30_000 })
        .catch(async () => {
          const failure = await gate
            .getByRole('alert')
            .innerText()
            .catch(() => '');
          throw new Error(
            `preparing to take calls from the status picker page failed: ${failure || 'no message shown'}`,
          );
        });
    } else {
      // a rehearsal that failed midway left a WRAPUP job — close it first, otherwise the Router sends no new call
      await page
        .getByRole('tab', { name: th('workspace:layout.inspector.tabs.wrapup'), exact: true })
        .click();
      const pending = page.getByRole('button', { name: th('workspace:wrapup.assisted') });
      if (await pending.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await pending.click();
        await page
          .getByRole('textbox', { name: th('workspace:wrapup.note') })
          .fill('Closing work left over from the previous rehearsal');
        await page.getByRole('button', { name: th('workspace:wrapup.submit') }).click();
        await expect(
          page.getByRole('heading', { name: th('workspace:wrapup.saved') }),
        ).toBeVisible();
      }
      // a run that failed mid-call left a call in progress, so the status selector does not appear until the call ends
      const selector = page.getByRole('button', {
        name: thRegExp('workspace:agentStatus.selectorLabel'),
      });
      await expect(selector)
        .toBeVisible({ timeout: 20_000 })
        .catch(async () => {
          const notice = (await page.getByRole('alert').allInnerTexts()).join(' / ');
          throw new Error(
            `cannot change to Ready (${notice || 'no message shown'}) — a previous run may have left a call in progress` +
              ' or another tab still holds the work session; wait for the call to end (about 2–3 minutes) then rehearse again',
          );
        });
      await selector.click();
      await page.getByRole('option', { name: 'Ready', exact: true }).click();
    }
    await expect(status).toHaveText(th('dphone:phase.READY'));
    await expect(
      page.getByRole('button', { name: thRegExp('workspace:agentStatus.selectorLabel') }),
    ).toContainText('Ready');
    await shot('01-ready');

    const caller = placeCall();
    try {
      await expect(status).toHaveText(th('dphone:phase.RINGING'), { timeout: 60_000 });
      await shot('02-ringing');
      await dphone.getByRole('button', { name: th('dphone:accept') }).click();
      await expect(status).toHaveText(th('dphone:phase.ACTIVE'));

      // Cus360 must confirm the work's session with the server before showing customer data (as in the #796 trial)
      const unlinked = page.getByText(th('workspace:customer.unlinked'));
      const confirmSession = page.getByRole('button', {
        name: th('workspace:customer.reauthenticate'),
      });
      await expect(unlinked.or(confirmSession).first()).toBeVisible();
      if (await confirmSession.isVisible()) await confirmSession.click();
      await expect(unlinked).toBeVisible();
      await page.getByLabel(th('workspace:customer.query')).fill(customerPhone);
      await page.getByRole('button', { name: th('workspace:customer.search') }).click();
      const select = page.getByRole('button', { name: th('workspace:customer.select') });
      const notFound = page.getByText(th('workspace:customer.empty'));
      await expect(select.or(notFound).first()).toBeVisible();
      if (await notFound.isVisible())
        throw new Error(
          `searched for number ${customerPhone} but found no selectable customer — check that the CSV was imported` +
            ' and that team Customer Care has WORK permission on "ลูกค้าทั้งหมด"', // allow-thai: seeded segment name
        );
      await select.click();
      await shot('03-customer-found');
      await page
        .getByRole('button', { name: th('workspace:customer.confirm'), exact: true })
        .click();
      await expect(page.getByText(th('workspace:customer.saved'))).toBeVisible();

      await page.getByRole('button', { name: th('workspace:customer.edit') }).click();
      // the value must differ from the previous run, otherwise the server answers that the data is unchanged
      const stamp = new Date().toLocaleTimeString('th-TH', { hour12: false });
      await page
        .getByLabel(th('workspace:customer.company'))
        .fill(`Siam Logistics Co., Ltd. (rehearsal ${stamp})`);
      await page.getByRole('button', { name: th('workspace:customer.save') }).click();
      await expect(page.getByText(th('workspace:customer.saved'))).toBeVisible();
      await shot('04-customer-linked');

      await dphone.getByRole('button', { name: th('dphone:hangup') }).click();
    } finally {
      caller.kill('SIGTERM');
    }

    await expect(page.getByRole('heading', { name: th('workspace:wrapup.title') })).toBeVisible();
    await page.getByRole('button', { name: th(`workspace:wrapup.${wrapupOutcome}`) }).click();
    await page
      .getByRole('textbox', { name: th('workspace:wrapup.note') })
      .fill('Customer asked about delivery status, delivery date given');
    await shot('05-wrapup');
    await page.getByRole('button', { name: th('workspace:wrapup.submit') }).click();
    await expect(page.getByRole('heading', { name: th('workspace:wrapup.saved') })).toBeVisible();
    await shot('06-saved');

    const [history] = await Promise.all([
      context.waitForEvent('page'),
      page.getByRole('link', { name: th('workspace:wrapup.history') }).click(),
    ]);
    await expect(
      history.getByText('Customer asked about delivery status, delivery date given'),
    ).toBeVisible();
    await history.screenshot({ path: resolve(shots, '07-history.png') });
  }
});
