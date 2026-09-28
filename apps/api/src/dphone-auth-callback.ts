/**
 * E1.13 (#487): หน้า OIDC callback ของ dphone ที่ถูกฝัง (`/dphone/auth/callback`, E1.4 #460 ข้อ 2)
 *
 * popup (เปิดจาก iframe บน dphone origin เดียวกัน) กลับมาที่นี่พร้อม `code`/`state` แล้วหน้านี้:
 * - ส่งเฉพาะ `code`/`state`/`error` ไปที่ `window.opener` ด้วย `targetOrigin` = origin ของตัวเองแบบ exact
 *   (opener ต้องอยู่บน dphone origin เดียวกัน — host ภายนอกรับข้อความนี้ไม่ได้)
 * - ลบ query ออกจาก URL ทันทีแล้วปิดตัวเอง — ไม่มีการแลก token ที่นี่ (verifier อยู่ใน memory ของ iframe)
 * - CSP เข้มงวด, `frame-ancestors 'none'`, `no-store`, `Referrer-Policy: no-referrer`
 */
import { randomBytes } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { Controller, Get, Res } from '@nestjs/common';
import { GatewayPublic } from './gateway-auth.js';

export const DPHONE_AUTH_CALLBACK_MESSAGE = 'dphone.auth.callback';

export function dphoneAuthCallbackHtml(nonce: string): string {
  // ไม่ฝังค่าจาก request ลงใน HTML — script อ่านจาก location เองแล้วส่งเฉพาะ field ที่รู้จัก
  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<title>dphone</title>
<script nonce="${nonce}">
(function () {
  var params = new URLSearchParams(window.location.search);
  var message = {
    type: '${DPHONE_AUTH_CALLBACK_MESSAGE}',
    code: params.get('code'),
    state: params.get('state'),
    error: params.get('error')
  };
  window.history.replaceState(null, '', window.location.pathname);
  if (window.opener && window.opener !== window) {
    window.opener.postMessage(message, window.location.origin);
  }
  window.close();
})();
</script>
</head>
<body></body>
</html>
`;
}

export function dphoneAuthCallbackHeaders(nonce: string): Record<string, string> {
  return {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    // popup ต้องคุยกับ opener ได้ — ห้ามตั้ง COOP ที่ตัดความสัมพันธ์
    'cross-origin-opener-policy': 'unsafe-none',
  };
}

@Controller('dphone/auth/callback')
export class DphoneAuthCallbackController {
  @Get()
  @GatewayPublic()
  callback(@Res() response: ServerResponse) {
    const nonce = randomBytes(16).toString('base64');
    response.writeHead(200, dphoneAuthCallbackHeaders(nonce));
    response.end(dphoneAuthCallbackHtml(nonce));
  }
}
