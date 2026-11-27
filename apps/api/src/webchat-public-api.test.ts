import assert from 'node:assert/strict';
import test from 'node:test';
import { webchatFrameCsp } from './webchat-public-api.js';
import { normalizeWebchatOrigin } from './webchat-widget.js';
import { WebchatError } from './webchat-errors.js';

test('the chat frame may be embedded only by the allowed origins, the preview page by this origin, and otherwise by nobody', () => {
  const ancestors = (csp: string) => /frame-ancestors ([^;]+)/.exec(csp)?.[1];
  assert.equal(
    ancestors(webchatFrameCsp(['https://shop.example.co.th', 'https://www.example.co.th'])),
    'https://shop.example.co.th https://www.example.co.th',
  );
  assert.equal(ancestors(webchatFrameCsp('self')), "'self'");
  assert.equal(ancestors(webchatFrameCsp([])), "'none'");
  assert.match(webchatFrameCsp([]), /script-src 'self'/);
  assert.doesNotMatch(webchatFrameCsp([]), /unsafe/);
});

test('an allowed origin is one exact https host, so it can never widen or break the CSP', () => {
  assert.equal(normalizeWebchatOrigin('https://Shop.Example.co.th/'), 'https://shop.example.co.th');
  assert.equal(
    normalizeWebchatOrigin('https://shop.example.co.th:8443'),
    'https://shop.example.co.th:8443',
  );
  assert.equal(normalizeWebchatOrigin('http://localhost:8080'), 'http://localhost:8080');
  for (const origin of [
    'https://*.example.com',
    'https://a.com;sandbox',
    'https://a.com,b',
    'https://com',
    'http://shop.example.co.th',
    'https://shop.example.co.th/path',
    'https://user@shop.example.co.th',
    "https://shop.example.co.th'",
  ])
    assert.throws(() => normalizeWebchatOrigin(origin), WebchatError, origin);
});
