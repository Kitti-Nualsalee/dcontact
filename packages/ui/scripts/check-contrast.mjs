#!/usr/bin/env node
/**
 * Checks the contrast of the color pairs that tokens declare, against WCAG 2.1 AA
 *
 * Why it exists: the previous mockup review found 55 of 559 elements on a single page
 * failing the criteria, mainly the light gray used for times and secondary text in 310 places
 * Without an automatic check these values would flow back in again unnoticed
 *
 *   node scripts/check-contrast.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '..', 'src', 'tokens.css'), 'utf8');

const tokens = new Map();
for (const [, name, value] of css.matchAll(/(--dc-[a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
  tokens.set(name, value);
}

const channel = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
function luminance(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3)
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  const [r, g, b] = [0, 2, 4].map((i) => channel(parseInt(h.slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** AA: normal text 4.5 · large text (>=18.66px bold or >=24px) 3.0 · non-text elements 3.0 */
const TEXT = 4.5;
const LARGE = 3;
const NON_TEXT = 3;

const pairs = [
  // main text on each surface level
  ['--dc-text-primary', '--dc-surface-raised', TEXT, 'main text on card'],
  ['--dc-text-primary', '--dc-surface-page', TEXT, 'main text on page background'],
  ['--dc-text-secondary', '--dc-surface-raised', TEXT, 'secondary text on card'],
  ['--dc-text-muted', '--dc-surface-raised', TEXT, 'faintest text that is still usable'],
  ['--dc-text-muted', '--dc-surface-page', TEXT, 'faint text on page background'],
  [
    '--dc-text-secondary',
    '--dc-surface-sunken',
    TEXT,
    'text on a sunken surface (muted must not be used here)',
  ],
  ['--dc-text-brand', '--dc-surface-raised', TEXT, 'links and brand-tone headings'],
  ['--dc-text-brand', '--dc-surface-selected', TEXT, 'text on the selected row'],
  ['--dc-text-brand-strong', '--dc-surface-raised', TEXT, 'brand name'],
  ['--dc-text-on-brand', '--dc-surface-brand', TEXT, 'text on the rail'],
  ['--dc-text-on-inverse', '--dc-surface-inverse', TEXT, 'text on the wallboard'],
  ['--dc-text-on-inverse-muted', '--dc-surface-inverse', TEXT, 'label on the wallboard'],

  // status badges — text on its own light background
  ['--dc-success-fg', '--dc-success-bg', TEXT, 'success badge'],
  ['--dc-attention-fg', '--dc-attention-bg', TEXT, 'warning badge'],
  ['--dc-attention-fg-strong', '--dc-attention-bg-subtle', TEXT, 'light warning strip'],
  ['--dc-critical-fg', '--dc-critical-bg', TEXT, 'critical badge'],
  ['--dc-critical-fg-strong', '--dc-critical-bg-subtle', TEXT, 'light critical strip'],
  ['--dc-info-fg', '--dc-info-bg', TEXT, 'info badge'],
  ['--dc-info-fg', '--dc-info-bg-subtle', TEXT, 'light info strip'],
  ['--dc-neutral-fg', '--dc-neutral-bg', TEXT, 'neutral badge'],
  ['--dc-accent-fg', '--dc-accent-bg', TEXT, 'category and AI badge'],

  // agent status — read all shift, must not be faint
  ['--dc-agent-available-fg', '--dc-agent-available-bg', TEXT, 'ready-to-take-calls status'],
  ['--dc-agent-busy-fg', '--dc-agent-busy-bg', TEXT, 'talking status'],
  ['--dc-agent-acw-fg', '--dc-agent-acw-bg', TEXT, 'wrap-up status'],
  ['--dc-agent-break-fg', '--dc-agent-break-bg', TEXT, 'break status'],
  ['--dc-agent-offline-fg', '--dc-agent-offline-bg', TEXT, 'offline status'],
  ['--dc-agent-cooldown-fg', '--dc-agent-cooldown-bg', TEXT, 'cooldown status'],

  // channel badges
  ['--dc-channel-voice-fg', '--dc-channel-voice-bg', TEXT, 'voice channel badge'],
  ['--dc-channel-webchat-fg', '--dc-channel-webchat-bg', TEXT, 'webchat channel badge'],
  ['--dc-channel-line-fg', '--dc-channel-line-bg', TEXT, 'LINE channel badge'],
  ['--dc-channel-facebook-fg', '--dc-channel-facebook-bg', TEXT, 'Facebook channel badge'],
  ['--dc-channel-whatsapp-fg', '--dc-channel-whatsapp-bg', TEXT, 'WhatsApp channel badge'],
  ['--dc-channel-email-fg', '--dc-channel-email-bg', TEXT, 'email channel badge'],

  // shifts and conversation parties
  ['--dc-shift-day-fg', '--dc-shift-day-bg', TEXT, 'morning shift'],
  ['--dc-shift-mid-fg', '--dc-shift-mid-bg', TEXT, 'midday shift'],
  ['--dc-shift-eve-fg', '--dc-shift-eve-bg', TEXT, 'evening shift'],
  ['--dc-shift-night-fg', '--dc-shift-night-bg', TEXT, 'night shift'],
  ['--dc-shift-off-fg', '--dc-shift-off-bg', TEXT, 'day off'],
  ['--dc-shift-leave-fg', '--dc-shift-leave-bg', TEXT, 'leave'],
  ['--dc-party-agent', '--dc-surface-raised', TEXT, 'agent-side speaker name'],
  ['--dc-party-contact', '--dc-surface-raised', TEXT, 'customer-side speaker name'],
  ['--dc-text-on-brand', '--dc-party-agent', TEXT, 'text in the agent bubble'],

  // non-text elements — 3:1 criterion
  ['--dc-success-solid', '--dc-surface-raised', NON_TEXT, 'bar and icon for success'],
  ['--dc-critical-solid', '--dc-surface-raised', NON_TEXT, 'bar and icon for critical'],
  ['--dc-activity-out-of-adherence', '--dc-surface-raised', NON_TEXT, 'out-of-adherence period'],

  // large numbers on the wallboard may use the large text criterion
  ['--dc-text-on-inverse', '--dc-surface-inverse', LARGE, 'numbers on the wallboard'],
];

/**
 * Known gaps not yet fixed — they do not turn the gate red, but must be printed every time
 * Both are values the user approved in the mockup; fixing them would change the visual weight
 * of every input and every status indicator meaning "nothing is happening", which is beyond the scope of the token extraction
 * The product owner must decide; it must not be decided silently during a refactor
 */
const knownGaps = [
  ['--dc-border-default', '--dc-surface-raised', NON_TEXT, 'input border at rest (WCAG 1.4.11)'],
  ['--dc-neutral-solid', '--dc-surface-raised', NON_TEXT, 'dots and bars for the empty status'],
];

let failed = 0;
const rows = [];
for (const [fg, bg, min, usage] of pairs) {
  const a = tokens.get(fg);
  const b = tokens.get(bg);
  if (!a || !b) {
    console.error(`token not found: ${!a ? fg : bg}`);
    failed += 1;
    continue;
  }
  const r = ratio(a, b);
  const ok = r >= min;
  if (!ok) failed += 1;
  rows.push({ ok, r, min, usage, fg, bg });
}

const width = Math.max(...rows.map((row) => row.usage.length));
for (const row of rows) {
  const mark = row.ok ? 'PASS' : 'FAIL';
  console.log(
    `${mark}  ${row.usage.padEnd(width)}  ${row.r.toFixed(2).padStart(5)}:1  (needs ${row.min})` +
      (row.ok ? '' : `  ← ${row.fg} on ${row.bg}`),
  );
}

console.log(`\n${rows.length - failed}/${rows.length} pairs meet WCAG AA`);

console.log('\nKnown gaps (not fixed, awaiting a decision):');
for (const [fg, bg, min, usage] of knownGaps) {
  const r = ratio(tokens.get(fg), tokens.get(bg));
  console.log(`      ${usage}  ${r.toFixed(2)}:1  (required ${min})  ${fg}`);
}

process.exit(failed === 0 ? 0 : 1);
