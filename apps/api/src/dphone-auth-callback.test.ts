import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DPHONE_AUTH_CALLBACK_MESSAGE,
  dphoneAuthCallbackHeaders,
  dphoneAuthCallbackHtml,
} from './dphone-auth-callback.js';

test('E1.13 callback: ส่งเฉพาะ code/state/error ไปที่ opener ด้วย targetOrigin ของตัวเอง แล้วลบ query และปิด', () => {
  const html = dphoneAuthCallbackHtml('n1');
  assert.match(html, /<script nonce="n1">/);
  assert.match(html, new RegExp(`type: '${DPHONE_AUTH_CALLBACK_MESSAGE}'`));
  assert.match(html, /postMessage\(message, window\.location\.origin\)/);
  assert.doesNotMatch(html, /postMessage\([^)]*'\*'/);
  assert.match(html, /history\.replaceState\(null, '', window\.location\.pathname\)/);
  assert.match(html, /window\.close\(\)/);
  assert.doesNotMatch(html, /access_token|refresh_token|fetch\(/);
});

test('E1.13 callback: CSP เข้มงวด, ห้ามถูกฝัง, ไม่ cache และไม่ส่ง referrer', () => {
  const headers = dphoneAuthCallbackHeaders('n2');
  assert.equal(
    headers['content-security-policy'],
    "default-src 'none'; script-src 'nonce-n2'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  assert.equal(headers['cache-control'], 'no-store');
  assert.equal(headers['referrer-policy'], 'no-referrer');
});
