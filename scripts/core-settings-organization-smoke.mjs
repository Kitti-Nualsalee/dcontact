import http from 'node:http';
import https from 'node:https';
import { pathToFileURL } from 'node:url';
/** Authenticated route smoke อ่านอย่างเดียว; ไม่สร้าง command/config/identity และไม่รับรอง Voice/VM trial */
export async function runOrganizationSmoke({
  baseUrl,
  accessToken,
  expectedWrite = true,
  connectHost,
}) {
  const base = new URL(baseUrl);
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    !['https:', 'http:'].includes(base.protocol) ||
    (base.protocol === 'http:' && !['127.0.0.1', 'localhost'].includes(base.hostname))
  )
    throw Error('ต้องใช้ HTTPS หรือ isolated loopback');
  if (!accessToken) throw Error('ต้องมี access token ผ่าน environment');
  async function request(path, authenticated = true, method = 'GET') {
    try {
      return await new Promise((resolve, reject) => {
        const url = new URL(path, base),
          transport = url.protocol === 'https:' ? https : http;
        const req = transport.request(
          url,
          {
            hostname: connectHost ?? url.hostname,
            servername: url.hostname,
            method,
            headers: {
              host: url.host,
              ...(authenticated ? { authorization: `Bearer ${accessToken}` } : {}),
            },
          },
          (response) => {
            let text = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => {
              text += chunk;
              if (text.length > 1_000_000) req.destroy();
            });
            response.on('end', () => {
              let data = null;
              try {
                data = JSON.parse(text);
              } catch {}
              resolve({
                status: response.statusCode ?? 0,
                cache: response.headers['cache-control'] ?? null,
                data,
              });
            });
          },
        );
        req.setTimeout(10000, () => req.destroy());
        req.on('error', reject);
        req.end();
      });
    } catch {
      return { status: 0, data: null, cache: null };
    }
  }
  const checks = [];
  const check = (id, ok, status) =>
    checks.push({
      id,
      result: ok ? 'PASS' : 'FAIL',
      ...(status === undefined ? {} : { httpStatus: status }),
    });
  const runtime = await request('/api/v1/runtime-profile', false);
  check(
    'ORG-SM01-runtime',
    runtime.status === 200 &&
      runtime.data?.profile === 'uat-workspace' &&
      runtime.data?.providerEgress === 'BLOCKED' &&
      runtime.data?.kafka === 'DISABLED' &&
      runtime.data?.lineWebhook === 'DISABLED',
    runtime.status,
  );
  const caps = await request('/api/v1/tenant/core-settings/capabilities');
  check(
    'ORG-SM02-authority',
    caps.status === 200 &&
      caps.data?.organization?.read === true &&
      caps.data?.organization?.write === expectedWrite &&
      caps.cache === 'no-store',
    caps.status,
  );
  const org = await request('/api/v1/tenant/core-settings/organization'),
    value = org.data?.organization;
  check(
    'ORG-SM03-read',
    org.status === 200 &&
      org.cache === 'no-store' &&
      typeof value?.displayName === 'string' &&
      typeof value?.id === 'string' &&
      /^(0|[1-9][0-9]*)$/.test(value?.revision ?? '') &&
      (value.defaults === null ||
        ['PROVISIONING', 'CORE_ADMIN'].includes(value.defaults?.initializationSource)),
    org.status,
  );
  const locale = await request('/api/v1/tenant/locale-defaults');
  check(
    'ORG-SM04-locale-wire',
    locale.status === 200 &&
      locale.data?.locale === (value?.defaults?.locale ?? null) &&
      locale.data?.timeZone === (value?.defaults?.timeZone ?? null),
    locale.status,
  );
  const navigation = await request('/api/v1/me/navigation');
  const app = navigation.data?.apps?.find((a) => a.id === 'core-settings');
  const pages =
    navigation.data?.areas?.flatMap((a) =>
      a.sections.flatMap((s) =>
        s.items.filter((i) => i.appId === 'core-settings').flatMap((i) => i.pages ?? []),
      ),
    ) ?? [];
  check(
    'ORG-SM05-navigation',
    navigation.status === 200 &&
      app?.path === '/?view=core-settings&page=organization' &&
      pages.some((p) => p.id === 'organization'),
    navigation.status,
  );
  const denied = await request('/api/v1/tenant/core-settings/organization', false, 'PATCH');
  check('ORG-SM06-implemented-auth-route', denied.status === 401, denied.status);
  return {
    schemaVersion: 1,
    kind: 'CORE_ORGANIZATION_AUTHENTICATED_ROUTE_SMOKE',
    result: checks.every((c) => c.result === 'PASS') ? 'PASS' : 'FAIL',
    origin: base.origin,
    checks,
    voiceSmoke: 'NOT_RUN',
    vmTrial: 'NOT_PROVEN',
    recordedAt: new Date().toISOString(),
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await runOrganizationSmoke({
      baseUrl: process.env.CORE_SETTINGS_BASE_URL,
      accessToken: process.env.CORE_SETTINGS_ACCESS_TOKEN,
      expectedWrite: process.env.CORE_SETTINGS_EXPECT_WRITE !== 'false',
      connectHost: process.env.CORE_SETTINGS_CONNECT_HOST,
    });
    console.log(JSON.stringify(result));
    if (result.result !== 'PASS') process.exitCode = 1;
  } catch {
    console.error(
      'Core organization smoke ไม่พร้อม: ตรวจ URL/token/environment โดยไม่พิมพ์ secret',
    );
    process.exitCode = 1;
  }
}
