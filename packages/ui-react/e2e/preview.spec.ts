import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { th } from './catalog';
import { escapeRegExp, pen, pth } from './preview-catalog';

/**
 * D1.10 (#449) acceptance: axe 0 serious/critical in both languages, and every component is usable with the keyboard
 * with a focus ring per the token (`--dc-focus-ring` = outer ring in brand-700 #0f766e)
 */
const FOCUS_RING = 'rgb(15, 118, 110)';
/** inner ring (`--dc-focus-ring-inset`) — both layers must be inset: color at the edge, white inside */
const FOCUS_RING_INSET =
  /rgb\(15, 118, 110\) 0px 0px 0px 2px inset, rgb\(255, 255, 255\) 0px 0px 0px 4px inset/;

async function seriousViolations(page: Page) {
  const result = await new AxeBuilder({ page }).analyze();
  return result.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map(
      (violation) => `${violation.id}: ${violation.nodes.map((node) => node.target).join(', ')}`,
    );
}

async function focusRingOf(page: Page) {
  return page.evaluate(() => getComputedStyle(document.activeElement as Element).boxShadow);
}

for (const lang of ['th', 'en'] as const) {
  test(`axe: 0 serious/critical (${lang}) including when the dialog and select are open`, async ({
    page,
  }) => {
    await page.goto(`/?lang=${lang}`);
    await expect(page.locator('html')).toHaveAttribute('lang', lang);
    expect(await seriousViolations(page)).toEqual([]);

    await page
      .getByRole('button', { name: lang === 'th' ? pth('dialog.open') : pen('dialog.open') })
      .click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
    await page.keyboard.press('Escape');

    await page
      .getByRole('button', {
        name:
          lang === 'th'
            ? new RegExp(escapeRegExp(pth('select.label')))
            : new RegExp(escapeRegExp(pen('select.label'))),
      })
      .click();
    await expect(page.getByRole('listbox')).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
  });
}

test('switching the language in the preview changes both the page text and the component text (namespace ui)', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: th('shell.languageNames.th') }).focus();
  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.getByRole('heading', { name: 'Buttons' })).toBeVisible();
  // the clear button is hidden while the field is empty (not in the a11y tree) — type first, then check the name from namespace `ui`
  await page.getByRole('searchbox', { name: 'Search contacts' }).fill('Ann');
  await expect(page.getByRole('button', { name: 'Clear search' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});

test('keyboard: Tab reaches the button and shows the focus ring per the token', async ({
  page,
}) => {
  await page.goto('/');
  const save = page.getByRole('button', { name: pth('button.primary') });
  for (let i = 0; i < 10 && !(await save.evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press('Tab');
  }
  await expect(save).toBeFocused();
  expect(await focusRingOf(page)).toContain(FOCUS_RING);
  // a button that cannot be pressed is not in the Tab order
  await expect(page.getByRole('button', { name: pth('button.disabled') })).toBeDisabled();
});

test('keyboard: TextField/SearchField — typing, Esc clears the search, required shows an error', async ({
  page,
}) => {
  await page.goto('/');
  const search = page.getByRole('searchbox', { name: pth('field.search') });
  await search.focus();
  // the ring is on the field's frame (Group), not on the inner input
  expect(await search.evaluate((el) => getComputedStyle(el.parentElement!).boxShadow)).toContain(
    FOCUS_RING,
  );
  await expect(page.getByRole('button', { name: th('searchField.clear') })).toBeHidden();
  await page.keyboard.type('สมชาย'); // allow-thai: typing Thai text into the search field
  await expect(search).toHaveValue('สมชาย'); // allow-thai: typing Thai text into the search field
  // there is only our own clear button; the browser's × button (input type=search) must not show on top
  await expect(page.getByRole('button', { name: th('searchField.clear') })).toBeVisible();
  // getComputedStyle cannot read vendor pseudo-elements, so check that a display:none rule matches this input
  expect(
    await search.evaluate((el) =>
      Array.from(document.styleSheets).some((sheet) =>
        Array.from(sheet.cssRules).some((rule) => {
          if (!(rule instanceof CSSStyleRule) || rule.style.display !== 'none') return false;
          return rule.selectorText
            .split(',')
            .map((part) => part.trim())
            .some(
              (part) =>
                part.endsWith('::-webkit-search-cancel-button') &&
                el.matches(part.replace('::-webkit-search-cancel-button', '')),
            );
        }),
      ),
    ),
  ).toBe(true);
  await page.keyboard.press('Escape');
  await expect(search).toHaveValue('');

  const name = page.getByRole('textbox', { name: pth('field.name') });
  await name.focus();
  await page.keyboard.type('Welcome');
  await expect(name).toHaveValue('Welcome');
  await expect(name).toHaveAttribute('aria-describedby', /.+/);
});

test('keyboard: Select opens with Enter, moves with arrows, skips disabled options, and selects with Enter', async ({
  page,
}) => {
  await page.goto('/');
  const trigger = page.getByRole('button', { name: new RegExp(escapeRegExp(pth('select.label'))) });
  await trigger.focus();
  expect(await focusRingOf(page)).toContain(FOCUS_RING);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('listbox')).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('listbox')).toBeHidden();
  await expect(trigger).toContainText('LINE');
  await expect(trigger).toBeFocused();

  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('option', { name: pth('select.fax') })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await page.keyboard.press('Escape');
});

test('keyboard: Checkbox and Switch toggle with Space', async ({ page }) => {
  await page.goto('/');
  const checkbox = page.getByRole('checkbox', { name: pth('toggle.consent') });
  await checkbox.focus();
  await page.keyboard.press('Space');
  await expect(checkbox).toBeChecked();

  const toggle = page.getByRole('switch', { name: pth('toggle.autoAnswer') });
  await toggle.focus();
  await expect(toggle).toBeChecked();
  await page.keyboard.press('Space');
  await expect(toggle).not.toBeChecked();
});

test('keyboard: Table moves rows with arrows and selects with Space', async ({ page }) => {
  await page.goto('/');
  const table = page.getByRole('grid', { name: pth('table.label') });
  await table.focus();
  await page.keyboard.press('ArrowDown');
  const focusedRow = page.getByRole('row', {
    name: new RegExp(escapeRegExp(pth('table.support'))),
  });
  await expect(focusedRow).toBeFocused();
  expect(await focusRingOf(page)).toMatch(FOCUS_RING_INSET);
  await page.keyboard.press('Space');
  await expect(focusedRow).toHaveAttribute('aria-selected', 'true');
});

test('keyboard: Tabs move with arrows and show the matching panel', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('tab', { name: pth('tabs.overview') }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: pth('tabs.steps') })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('tabpanel')).toHaveText(pth('tabs.stepsBody'));
});

test('keyboard: Dialog opens with Enter, focus stays inside the dialog, Esc closes and focus returns to the opening button', async ({
  page,
}) => {
  await page.goto('/');
  const open = page.getByRole('button', { name: pth('dialog.open') });
  await open.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: pth('dialog.title') });
  await expect(dialog).toBeVisible();
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(open).toBeFocused();
});

test('keyboard: Toast shows in a named region and can be dismissed with the keyboard', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: pth('toast.show') }).focus();
  await page.keyboard.press('Enter');
  const region = page.getByRole('region', { name: th('toast.region') });
  await expect(region.getByText(pth('toast.title'))).toBeVisible();
  const dismiss = region.getByRole('button', { name: th('toast.dismiss') });
  await dismiss.focus();
  expect(await focusRingOf(page)).toContain(FOCUS_RING);
  await page.keyboard.press('Enter');
  await expect(region.getByText(pth('toast.title'))).toBeHidden();
});

test('forced-colors: Switch still shows the track/thumb and tells on/off apart (background colors are forced to Canvas)', async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await page.goto('/');
  const toggle = page.getByRole('switch', { name: pth('toggle.autoAnswer') });
  const label = page.locator('label').filter({ has: toggle });
  // the track is a span hidden from the a11y tree (Toggle.tsx) and the thumb is its child
  const parts = () =>
    label
      .locator('span[aria-hidden="true"]')
      .first()
      .evaluate((track) => {
        const thumb = track.firstElementChild as Element;
        return {
          trackOutline: getComputedStyle(track).outlineStyle,
          trackBackground: getComputedStyle(track).backgroundColor,
          thumbBackground: getComputedStyle(thumb).backgroundColor,
        };
      });
  await expect(toggle).toBeChecked();
  const on = await parts();
  await toggle.focus();
  await page.keyboard.press('Space');
  await expect(toggle).not.toBeChecked();
  const off = await parts();
  expect(on.trackOutline).toBe('solid');
  expect(off.trackOutline).toBe('solid');
  expect(on.thumbBackground).not.toBe(on.trackBackground);
  expect(off.thumbBackground).not.toBe(off.trackBackground);
  expect(on.trackBackground).not.toBe(off.trackBackground);
});

test('forced-colors: a selected Table row has a Highlight bar at the row start (the row background is forced to Canvas)', async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await page.goto('/');
  const table = page.getByRole('grid', { name: pth('table.label') });
  await table.focus();
  await page.keyboard.press('ArrowDown');
  const row = page.getByRole('row', { name: new RegExp(escapeRegExp(pth('table.support'))) });
  await expect(row).toBeFocused();
  await page.keyboard.press('Space');
  await expect(row).toHaveAttribute('aria-selected', 'true');
  const marker = (target: typeof row) =>
    target
      .locator(':scope > *')
      .first()
      .evaluate((cell) => getComputedStyle(cell).getPropertyValue('border-inline-start-width'));
  expect(await marker(row)).toBe('4px');
  expect(
    await marker(page.getByRole('row', { name: new RegExp(escapeRegExp(pth('table.billing'))) })),
  ).toBe('0px');
});

test('forced-colors: Tabs still show the selected tab underline (inset box-shadow is removed in this mode)', async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await page.goto('/');
  const underline = (name: string) =>
    page.getByRole('tab', { name }).evaluate((tab) => {
      const bar = getComputedStyle(tab, '::after');
      return { content: bar.content, height: bar.height };
    });
  await expect(page.getByRole('tab', { name: pth('tabs.overview') })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect(await underline(pth('tabs.overview'))).toEqual({ content: '""', height: '4px' });
  expect((await underline(pth('tabs.steps'))).content).toBe('none');
});

test('forced-colors: a pressed Button (aria-pressed) uses a Highlight background to stand apart from other buttons', async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await page.goto('/');
  const group = page.getByRole('group', { name: pth('language') });
  const thai = group.getByRole('button', { name: th('shell.languageNames.th') });
  const english = group.getByRole('button', { name: 'English' });
  await expect(thai).toHaveAttribute('aria-pressed', 'true');
  await expect(english).toHaveAttribute('aria-pressed', 'false');
  // other buttons may have a transparent background on Canvas, so compare against the system's real Highlight value
  const highlight = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.backgroundColor = 'Highlight';
    document.body.append(probe);
    const value = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return value;
  });
  const background = (target: typeof thai) =>
    target.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(await background(thai)).toBe(highlight);
  expect(await background(english)).not.toBe(highlight);

  // focus on a pressed button still shows the outer outline (tokens.css) and no brand-colored ring remains because adjust is turned off
  await english.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(thai).toBeFocused();
  const focused = await thai.evaluate((element) => {
    const style = getComputedStyle(element);
    return { outline: style.outlineStyle, offset: style.outlineOffset, shadow: style.boxShadow };
  });
  expect(focused).toEqual({ outline: 'solid', offset: '2px', shadow: 'none' });
});
