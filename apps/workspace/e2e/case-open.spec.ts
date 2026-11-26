import { expect, test } from './fixtures';
import { th } from './catalog';
import { thRegExp } from './locale-match';

// #956 happy path of opening a case from the work being talked about; route mocks only, not evidence of the real API
const workId = '7a33ac96-d87d-4ca4-ab75-f27e40e943be';
const caseId = '9b0c6a1e-2f3d-4c5b-8a7e-1d2c3b4a5f6e';

test('open a case from work already linked to a customer: the first unknown result resends the same commandId, then gets a link to Console', async ({
  page,
}) => {
  let state = 'ASSIGNED';
  const attempts: Record<string, unknown>[] = [];
  await page.route('**/api/v1/customer-360/work/*/customer', (route) =>
    route.fulfill({
      json: {
        interactionId: workId,
        state: 'LINKED',
        linkageRevision: '1',
        contact: {
          id: '44444444-4444-4444-8444-444444444444',
          displayName: 'Pa Chanpen',
          company: 'Siam Retail',
        },
        revisions: { profile: '0', tag: '0', lineage: '0' },
        canEdit: true,
        canLink: true,
        identity: 'ACTIVE',
      },
    }),
  );
  await page.route('**/api/v1/me/navigation', (route) =>
    route.fulfill({
      json: {
        groups: [{ id: 'live', labelKey: 'navigation.groups.live' }],
        apps: [
          {
            id: 'agent-workspace',
            groupId: 'live',
            labelKey: 'navigation.apps.agentWorkspace',
            hostApp: 'workspace',
            path: '/',
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
        ],
        pins: { appIds: ['agent-workspace'], source: 'TENANT', revision: 0 },
        limits: { maxPins: 15 },
        features: { shellV2: true },
      },
    }),
  );
  await page.route('**/api/v1/workspace/agent/snapshot', (route) =>
    route.fulfill({
      json: {
        capabilities: { voiceWrapupV1: 1, workCustomerV1: 1 },
        agent: { id: 'agent-one', displayName: 'Somying Jaidee', extension: '1000', state: 'BUSY' },
        interaction: {
          id: workId,
          state,
          direction: 'INBOUND',
          voiceWrapupPolicy: 'VOICE_NOTE_V1',
          version: '1',
          caller: null,
          queue: null,
          offerExpiresAt: null,
          answeredAt: null,
          endedAt: null,
        },
      },
    }),
  );
  await page.route('**/sip-credentials', (route) =>
    route.fulfill({
      json: {
        leaseId: route.request().headers()['x-work-session-lease-id'],
        extension: '1000',
        authorizationUsername: '1000',
        authorizationPassword: 'synthetic-only',
        sipDomain: 'e2e.invalid',
        wssUrl: 'wss://e2e.invalid',
        telephonyNodeId: 'synthetic',
        iceServers: [],
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      },
    }),
  );
  await page.route('**/api/v1/workspace/agent/cases/team-agents', (route) =>
    route.fulfill({
      json: {
        items: [
          { userId: 'agent-one', displayName: 'Somying Jaidee' },
          { userId: 'agent-two', displayName: 'Pakorn Srisuk' },
        ],
      },
    }),
  );
  await page.route('**/api/v1/workspace/agent/cases', async (route) => {
    attempts.push(route.request().postDataJSON() as Record<string, unknown>);
    if (attempts.length === 1) return route.abort('connectionreset');
    return route.fulfill({ status: 201, json: { caseId, version: 1 } });
  });

  await page.goto('/?authHarness=1&tenant=demo');
  await page.getByRole('button', { name: 'Sign in fixture', exact: true }).click();
  await page.getByRole('button', { name: th('workspace:media.check'), exact: true }).click();
  await page.getByRole('button', { name: th('dphone:accept'), exact: true }).click();
  state = 'ACTIVE';
  await expect(page.getByText('Pa Chanpen').first()).toBeVisible();

  await page
    .getByRole('button', { name: th('workspace:case.open'), exact: true })
    .first()
    .click();
  const subject = page.getByRole('textbox', { name: th('workspace:case.subject') });
  await expect(subject).toBeFocused();
  await subject.fill('X200 unit defective, replacement requested');
  await page
    .getByRole('textbox', { name: th('workspace:case.note') })
    .fill('Waiting for warehouse to confirm stock');
  const panel = page.getByRole('tabpanel', { name: th('workspace:layout.inspector.tabs.case') });
  await panel.getByRole('button', { name: thRegExp('workspace:case.assignee') }).click();
  await page.getByRole('option', { name: 'Pakorn Srisuk' }).click();
  await panel.getByRole('button', { name: th('workspace:case.submit'), exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText(th('workspace:case.unknown'));
  await expect(page.getByRole('textbox', { name: th('workspace:case.subject') })).toHaveAttribute(
    'readonly',
    '',
  );

  await panel.getByRole('button', { name: th('workspace:case.retrySame') }).click();
  await expect(panel.getByRole('heading', { name: th('workspace:case.created') })).toBeVisible();
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  expect(attempts[0]).toMatchObject({
    interactionId: workId,
    subject: 'X200 unit defective, replacement requested',
    note: 'Waiting for warehouse to confirm stock',
    assigneeUserId: 'agent-two',
  });
  const link = panel.getByRole('link', { name: th('workspace:case.openInConsole') });
  await expect(link).toHaveAttribute('href', new RegExp(`view=team-cases&case=${caseId}`));
  expect(decodeURIComponent(page.url())).not.toContain('X200');
});
