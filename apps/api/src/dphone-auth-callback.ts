/**
 * E1.13 (#487): the OIDC callback page of the embedded dphone (`/dphone/auth/callback`, E1.4 #460 item 2)
 *
 * the popup (opened from an iframe on the same dphone origin) returns here with `code`/`state` and this page:
 * - sends only `code`/`state`/`error` to `window.opener` with `targetOrigin` = its own origin, exactly
 *   (the opener must be on the same dphone origin — an outside host cannot receive this message)
 * - removes the query from the URL at once then closes itself — no token exchange happens here (the verifier is in the iframe's memory)
 * - strict CSP, `frame-ancestors 'none'`, `no-store`, `Referrer-Policy: no-referrer`
 */
import { randomBytes } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { Controller, Get, Res } from '@nestjs/common';
import { GatewayPublic } from './gateway-auth.js';

export const DPHONE_AUTH_CALLBACK_MESSAGE = 'dphone.auth.callback';

export function dphoneAuthCallbackHtml(nonce: string): string {
  // no values from the request are embedded in the HTML — the script reads from location itself and sends only known fields
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
    // the popup must be able to talk to the opener — do not set a COOP that severs the relationship
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
