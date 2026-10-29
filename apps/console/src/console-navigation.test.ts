import test from 'node:test';
import assert from 'node:assert/strict';
import { isConsoleNavigation } from './shell/console-navigation.js';

test('Console routing รับเฉพาะหน้า tenant เดิม ไม่รับ callback หรือปลายทางอื่น', () => {
  const current = new URL('http://127.0.0.1:5188/?tenant=acme&view=governance');
  for (const [href, expected] of [
    ['/?tenant=acme&view=home', true],
    ['/?tenant=acme&view=core-settings&page=organization', true],
    ['/?tenant=other&view=home', false],
    ['/?view=home', false],
    ['http://localhost:5173/?tenant=acme&view=home', false],
    ['/login?tenant=acme&view=home', false],
    ['/?tenant=acme&view=home&code=one-time-code&state=oidc-state', false],
    ['/?tenant=acme&view=account&token=email-action', false],
    ['/?tenant=acme&view=account&verify=email-verification-action', false],
    ['/?tenant=acme&view=unknown', false],
  ] as const)
    assert.equal(isConsoleNavigation(current, new URL(href, current)), expected, href);
});
