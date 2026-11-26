import { expect, test } from '@playwright/test';
import { th } from './support/catalog';

/**
 * D1.11 (#450): switching language must not reload — checked with the same page's `performance` and a marker in `window`
 * that disappears immediately if a new page is loaded (Phase Contract: no waiving)
 */
test.use({ locale: 'th-TH', timezoneId: 'America/New_York' });

test('switch TH → EN → TH immediately without reload, and the formatter follows the language', async ({
  page,
}) => {
  await page.goto('/?view=i18n');
  await expect(page.getByTestId('language-label')).toHaveText(th('common:language.label'));
  await expect(page.locator('html')).toHaveAttribute('lang', 'th');
  // no user/tenant → the system timezone, not the device time (the browser is set to New York)
  await expect(page.getByTestId('time-zone')).toHaveText('Asia/Bangkok');
  await expect(page.getByTestId('sample-date')).toHaveText('12 ก.ย. 2569 16:40'); // allow-thai: Thai Buddhist-era date formatting

  const before = await page.evaluate(() => {
    (window as unknown as { __d111Marker: string }).__d111Marker = 'same-document';
    return {
      timeOrigin: performance.timeOrigin,
      navigations: performance.getEntriesByType('navigation').length,
    };
  });
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));

  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.getByTestId('language-label')).toHaveText('Language');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByTestId('sample-date')).toHaveText('12 Sep 2026 16:40');
  await expect(page.getByRole('button', { name: 'English' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await page.getByRole('button', { name: th('common:language.th') }).click();
  await expect(page.getByTestId('language-label')).toHaveText(th('common:language.label'));

  const after = await page.evaluate(() => ({
    marker: (window as unknown as { __d111Marker?: string }).__d111Marker,
    timeOrigin: performance.timeOrigin,
    navigations: performance.getEntriesByType('navigation').length,
  }));
  expect(after).toEqual({ ...before, marker: 'same-document' });
  // both language bundles load at startup — switching language makes no new request at all
  expect(requests).toEqual([]);
});

test('browser language is the third step of the order — an English browser gets EN when there is no user/tenant value', async ({
  browser,
}) => {
  const context = await browser.newContext({ locale: 'en-US' });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:5174/?view=i18n');
  await expect(page.getByTestId('language-label')).toHaveText('Language');
  await context.close();
});
