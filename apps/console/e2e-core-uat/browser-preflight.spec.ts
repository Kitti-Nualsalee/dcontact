import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';

test('Core VM: ตรวจ branded browser และ runtime จริงก่อนทีมทดสอบ', async ({
  page,
  browser,
  request,
}, info) => {
  const startedAt = new Date().toISOString();
  const response = await request.get('/api/v1/runtime-profile');
  expect(response.status()).toBe(200);
  const profile = await response.json();
  expect(profile.profile).toBe('uat-workspace');
  expect(profile.providerEgress).toBe('BLOCKED');
  expect(profile.kafka).toBe('DISABLED');
  expect(profile.lineWebhook).toBe('DISABLED');
  await page.goto('/');
  const userAgent = await page.evaluate(() => navigator.userAgent);
  expect(userAgent).not.toMatch(/HeadlessChrome|Chromium/);
  if (info.project.name === 'msedge') expect(userAgent).toMatch(/Edg\/[\d.]+/);
  else {
    expect(userAgent).toMatch(/Chrome\/[\d.]+/);
    expect(userAgent).not.toMatch(/Edg\//);
  }
  writeFileSync(
    info.outputPath('browser-preflight.json'),
    JSON.stringify(
      {
        kind: 'CORE_SETTINGS_BROWSER_PREFLIGHT',
        channel: info.project.name,
        version: browser.version(),
        userAgent,
        startedAt,
        endedAt: new Date().toISOString(),
        runtimeProfile: profile.profile,
        businessCases: 'NOT_RUN',
        vmUat: 'NOT_PROVEN',
      },
      null,
      2,
    ),
  );
});
