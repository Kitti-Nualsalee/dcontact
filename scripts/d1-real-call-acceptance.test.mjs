import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./d1-real-call-acceptance.mjs', import.meta.url), 'utf8');
const playwrightConfig = readFileSync(
  new URL('../apps/workspace/playwright.real-call.config.ts', import.meta.url),
  'utf8',
);

test('disables the LINE webhook with the full set of values when the API is started for the real-call acceptance', () => {
  assert.match(source, /LINE_WEBHOOK_SECRET_SOURCE: 'disabled'/);
  assert.match(source, /LINE_WEBHOOK_CHANNEL_ACCOUNT_ID: 'd1-16-disabled'/);
  assert.match(source, /LINE_WEBHOOK_DESTINATION: 'd1-16-disabled'/);
  assert.match(source, /LINE_WEBHOOK_PAYLOAD_KEY_REF: 'd1-16-disabled'/);
  assert.match(source, /environment\.LINE_WEBHOOK_TENANT_ID = claims\.tenantId/);
  assert.match(source, /SIP_BROWSER_FIXED_PASSWORD: 'D1-16-acceptance-only-password'/);
  assert.match(source, /const nodeId = 'fs-local'/);
});

test('separates the D1 real-call spec from the outbound harness', () => {
  assert.match(playwrightConfig, /testMatch: 'dphone-real-call\.spec\.ts'/);
});
