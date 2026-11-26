import { expect, test, type Page } from '@playwright/test';
import { th } from './catalog';
const workId = '11111111-1111-4111-8111-111111111111';
const contactId = '44444444-4444-4444-8444-444444444444';
const linked = () => ({
  interactionId: workId,
  state: 'LINKED',
  linkageRevision: '1',
  contact: { id: contactId, displayName: 'Work Test Customer', company: 'Test Company' },
  revisions: { profile: '0', tag: '0', lineage: '0' },
  canEdit: true,
  canLink: true,
  identity: 'ACTIVE',
});
async function fixture(
  page: Page,
  options: { unknown?: boolean; unlinked?: boolean; pending?: boolean } = {},
) {
  let view: Record<string, unknown> = options.unlinked
    ? { interactionId: workId, state: 'UNLINKED', linkageRevision: '0', canLink: true }
    : linked();
  let command: Record<string, unknown> | undefined;
  let mutations = 0;
  await page.route('**/api/v1/customer-360/work/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path.includes('22222222'))
      return route.fulfill({
        json: {
          interactionId: '22222222-2222-4222-8222-222222222222',
          state: 'UNLINKED',
          linkageRevision: '0',
          canLink: true,
        },
      });
    if (path.endsWith('/reauthenticate')) return route.fulfill({ json: { state: 'ACTIVE' } });
    if (path.includes('/candidates/search'))
      return route.fulfill({
        json: {
          items: [
            {
              candidateRef: 'opaque-reference',
              displayName: 'Customer From Search',
              company: 'Selected Company',
              matchingChannel: '•••11',
            },
          ],
          nextCursor: null,
          verified: false,
        },
      });
    if (path.includes('/commands/') && options.pending && method === 'GET')
      return route.fulfill({ json: { state: 'PENDING', commandId: command?.commandId } });
    if (path.includes('/commands/')) return route.fulfill({ json: { state: 'TERMINAL', command } });
    if (method === 'PATCH' || path.endsWith('/customer-link')) {
      mutations++;
      const body = route.request().postDataJSON();
      if (options.pending) {
        command = {
          commandId: body.commandId,
          outcome: 'REJECTED',
          code: 'COMMAND_NOT_APPLIED',
          committedRevisions: {},
        };
        return route.abort('failed');
      }
      view = path.endsWith('/customer-link')
        ? {
            ...linked(),
            contact: {
              id: contactId,
              displayName: 'Customer From Search',
              company: 'Selected Company',
            },
          }
        : {
            ...view,
            contact: { id: contactId, displayName: body.displayName, company: body.company },
            revisions: { profile: '1', tag: '0', lineage: '0' },
          };
      command = {
        commandId: body.commandId,
        outcome: 'APPLIED',
        code: null,
        committedRevisions: path.endsWith('/customer-link') ? { linkage: '1' } : { profile: '1' },
      };
      if (options.unknown) return route.abort('failed');
      return route.fulfill({ json: { state: 'TERMINAL', command } });
    }
    return route.fulfill({ json: view });
  });
  await page.goto('/?view=customer-trial');
  return {
    mutations: () => mutations,
    replaceLinkedContact: () => {
      view = {
        ...linked(),
        linkageRevision: '2',
        contact: {
          id: '55555555-5555-4555-8555-555555555555',
          displayName: 'New Customer',
          company: null,
        },
      };
    },
  };
}
async function privateDraft(page: Page, value: string) {
  expect(decodeURIComponent(page.url())).not.toContain(value);
  expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain(
    value,
  );
}
test('pick a candidate manually without auto-link even with a single result, and read back before success', async ({
  page,
}) => {
  const f = await fixture(page, { unlinked: true });
  await expect(page.getByText(th('workspace:customer.unlinked'))).toBeVisible();
  await page.getByLabel(th('workspace:customer.query')).fill('+6621234511');
  await page.getByRole('button', { name: th('workspace:customer.search') }).click();
  await expect(
    page.getByRole('status').filter({ hasText: th('workspace:customer.unverified') }),
  ).toBeVisible();
  expect(f.mutations()).toBe(0);
  await page.getByRole('button', { name: th('workspace:customer.select') }).click();
  await page.getByRole('button', { name: th('workspace:customer.confirm'), exact: true }).click();
  await expect(page.getByText(th('workspace:customer.saved'))).toBeVisible();
  expect(f.mutations()).toBe(1);
  await privateDraft(page, '+6621234511');
});
test('the draft lives in memory and pauses when the session is lost, recovering only the original work without creating Voice controls', async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole('button', { name: th('workspace:customer.edit') }).click();
  await page.getByLabel(th('workspace:customer.name')).fill('Private draft');
  await privateDraft(page, 'Private draft');
  await page.getByRole('button', { name: 'Pause fixture' }).click();
  await expect(page.getByLabel(th('workspace:customer.name'))).toHaveCount(0);
  await expect(page.getByText('Work Test Customer', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Resume fixture' }).click();
  await expect(page.getByLabel(th('workspace:customer.name'))).toHaveValue('Private draft');
  await page.getByRole('button', { name: 'Switch work fixture' }).click();
  await expect(page.getByLabel(th('workspace:customer.name'))).toHaveCount(0);
  await expect(page.getByText(th('workspace:customer.unlinked'))).toBeVisible();
});
test('response lost after save: use the same command to check the result, without creating a duplicate effect', async ({
  page,
}) => {
  const f = await fixture(page, { unknown: true });
  await page.getByRole('button', { name: th('workspace:customer.edit') }).click();
  await page.getByLabel(th('workspace:customer.name')).fill('Unknown draft');
  await page.getByRole('button', { name: th('workspace:customer.save') }).click();
  await expect(
    page.getByRole('button', { name: th('workspace:customer.checkCommand') }),
  ).toBeVisible();
  await privateDraft(page, 'Unknown draft');
  page.once('dialog', (dialog) => void dialog.accept());
  await page.reload();
  await page.getByRole('button', { name: th('workspace:customer.checkCommand') }).click();
  await expect(page.getByText(th('workspace:customer.saved'))).toBeVisible();
  expect(f.mutations()).toBe(1);
});
test('removing or changing the customer must confirm with a reason and the 768 screen does not overflow', async ({
  page,
}) => {
  await fixture(page);
  await page.setViewportSize({ width: 768, height: 900 });
  await page.getByRole('button', { name: th('workspace:customer.detach'), exact: true }).click();
  await expect(
    page.getByRole('button', { name: th('workspace:customer.confirm'), exact: true }),
  ).toBeDisabled();
  await page.getByLabel(th('workspace:customer.reason')).fill('Wrong item selected');
  await expect(
    page.getByRole('button', { name: th('workspace:customer.confirm'), exact: true }),
  ).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('admission stuck with no effect must reconcile PENDING to NOT_APPLIED before starting over', async ({
  page,
}) => {
  await fixture(page, { pending: true });
  await page.getByRole('button', { name: th('workspace:customer.edit') }).click();
  await page.getByLabel(th('workspace:customer.name')).fill('Unsaved draft');
  await page.getByRole('button', { name: th('workspace:customer.save') }).click();
  await page.getByRole('button', { name: th('workspace:customer.checkCommand') }).click();
  await expect(page.getByText(th('workspace:customer.notApplied'))).toBeVisible();
  await expect(page.getByLabel(th('workspace:customer.name'))).toHaveValue('Unsaved draft');
  await expect(page.getByRole('button', { name: th('workspace:customer.save') })).toBeEnabled();
});

test('the draft of the same customer does not move to a new one when the original work changes linkage during reauth', async ({
  page,
}) => {
  const f = await fixture(page);
  await page.getByRole('button', { name: th('workspace:customer.edit') }).click();
  await page.getByLabel(th('workspace:customer.name')).fill('Draft of the previous customer');
  await page.getByRole('button', { name: 'Pause fixture' }).click();
  await expect(page.getByLabel(th('workspace:customer.name'))).toHaveCount(0);
  f.replaceLinkedContact();
  await page.getByRole('button', { name: 'Resume fixture' }).click();
  await expect(page.getByText('New Customer', { exact: true })).toBeVisible();
  await expect(page.getByLabel(th('workspace:customer.name'))).toHaveCount(0);
  await page.getByRole('button', { name: th('workspace:customer.edit') }).click();
  await expect(page.getByLabel(th('workspace:customer.name'))).toHaveValue('New Customer');
  expect(f.mutations()).toBe(0);
});
