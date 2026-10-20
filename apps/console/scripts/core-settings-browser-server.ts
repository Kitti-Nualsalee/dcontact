/** Disposable loopback browser harness: production Console/AuthRoot → real Keycloak → API/RLS */
import { createServer as createHttpServer } from 'node:http';
import { createServer as createViteServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { coreIdentitySandbox } from '../../api/src/tenant-core-identity-sandbox.js';
const cleanups: (() => Promise<unknown>)[] = [];
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  for (const cleanup of cleanups.reverse()) await cleanup();
}
try {
  const sandbox = await coreIdentitySandbox((cleanup) => cleanups.push(cleanup));
  const { f, issuer, password } = sandbox;
  await f.owner.tenantUiFlag.create({
    data: {
      tenantId: f.tenantId,
      flagKey: 'ui.shell.v2',
      enabled: true,
      reason: 'isolated-core726-browser',
      updatedByActor: 'core726-isolated-operator',
    },
  });
  let fault = '',
    readFailure = false;
  const proxy = createHttpServer(async (req, res) => {
    try {
      if (req.url === '/__core_test/config') {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(
          JSON.stringify({
            tenant: `core-${f.tenantId}`,
            otherTenant: `core-${f.otherTenantId}`,
            issuer,
            password,
            users: Object.fromEntries([...f.actors].map(([alias, actor]) => [alias, actor.id])),
          }),
        );
        return;
      }
      if (req.url?.startsWith('/__core_test/fault/')) {
        fault = req.url.split('/').at(-1) ?? '';
        res.end('{}');
        return;
      }
      if (req.url === '/__core_test/revoke') {
        const actor = f.actors.get('admin')!;
        await f.owner.user.update({ where: { id: actor.id }, data: { isActive: false } });
        res.end('{}');
        return;
      }
      if (req.url === '/__core_test/restore') {
        const actor = f.actors.get('admin')!;
        await f.owner.user.update({ where: { id: actor.id }, data: { isActive: true } });
        res.end('{}');
        return;
      }
      if (!req.url?.startsWith('/api/')) {
        res.statusCode = 404;
        res.end();
        return;
      }
      const patch =
        req.method === 'PATCH' && req.url === '/api/v1/tenant/core-settings/organization';
      if (
        (patch && fault === 'reauth') ||
        (readFailure &&
          req.method === 'GET' &&
          req.url === '/api/v1/tenant/core-settings/organization')
      ) {
        res.statusCode = patch ? 401 : 503;
        fault = '';
        readFailure = false;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({ error: { code: patch ? 'CORE_ACCESS_DENIED' : 'REQUEST_FAILED' } }),
        );
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const name of ['authorization', 'content-type', 'x-request-id'])
        if (typeof req.headers[name] === 'string') headers.set(name, req.headers[name]);
      const response = await fetch(`${f.base}${req.url}`, {
        method: req.method,
        headers,
        ...(['GET', 'HEAD'].includes(req.method ?? 'GET') ? {} : { body: Buffer.concat(chunks) }),
      });
      const body = await response.text();
      if (patch && fault === 'lost-response') {
        fault = '';
        res.destroy();
        return;
      }
      if (patch && fault === 'readback') {
        fault = '';
        readFailure = true;
      }
      res.statusCode = response.status;
      for (const name of ['content-type', 'cache-control', 'retry-after', 'x-request-id']) {
        const value = response.headers.get(name);
        if (value) res.setHeader(name, value);
      }
      res.end(body);
    } catch {
      res.statusCode = 500;
      res.end('{"error":{"code":"HARNESS_FAILED"}}');
    }
  });
  await new Promise<void>((resolve) => proxy.listen(5189, '127.0.0.1', resolve));
  cleanups.push(async () => {
    proxy.closeAllConnections();
    await new Promise<void>((resolve, reject) => proxy.close((e) => (e ? reject(e) : resolve())));
  });
  const vite = await createViteServer({
    root: fileURLToPath(new URL('../', import.meta.url)),
    configFile: false,
    mode: 'development',
    define: {
      'import.meta.env.VITE_KC_ISSUER': JSON.stringify(issuer),
      'import.meta.env.VITE_KC_CLIENT_ID': JSON.stringify('dcontact-console'),
      'import.meta.env.VITE_API_BASE_URL': JSON.stringify(''),
    },
    server: {
      host: '127.0.0.1',
      port: 5188,
      strictPort: true,
      // UAT ป้องกัน framing ทุกหน้า Console; session restore ต้องใช้ได้ภายใต้นโยบายนี้
      headers: { 'X-Frame-Options': 'DENY' },
      proxy: { '/api': 'http://127.0.0.1:5189', '/__core_test': 'http://127.0.0.1:5189' },
    },
  });
  await vite.listen();
  cleanups.push(() => vite.close());
  process.stdout.write(
    'Core Settings browser sandbox พร้อม: UI → OIDC/JWKS/proof → HTTP/DB จริง\n',
  );
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      void close().finally(() => process.exit(0));
    });
} catch (error) {
  await close();
  throw error;
}
