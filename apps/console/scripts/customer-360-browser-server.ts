/**
 * Cus360 C2 (#792): browser sandbox แบบ loopback ที่ทิ้งได้
 * Chromium → Console (Vite, mode e2e) → proxy → Nest API จริง (gateway guard, c360 predicates, RLS ด้วย dcontact_app) → PostgreSQL
 *
 * ข้อจำกัดที่ต้องรู้: identity เป็น stub verifier (token = alias ของ actor) เหมือน integration tests ไม่ใช่ Keycloak จริง
 * จึงไม่นับเป็นหลักฐาน actual OIDC boundary; ใช้ข้อมูลสังเคราะห์ทั้งหมดและไม่เชื่อมต่อ UAT/VM
 */
import { createServer as createHttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { Customer360ReadController } from '../../api/src/customer-360-read-api.js';
import {
  contact,
  grant,
  head,
  interaction,
  point,
  tag,
} from '../../api/src/customer-360-read-test-fixtures.js';
import { deliverToIam, ownerCommit, setup } from '../../api/src/customer-360-test-fixtures.js';

const cleanups: (() => Promise<unknown>)[] = [];
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  for (const cleanup of cleanups.reverse()) await cleanup();
}

try {
  const f = await setup([Customer360ReadController]);
  cleanups.push(() => f.close());
  await f.owner.tenantUiFlag.create({
    data: {
      tenantId: f.tenantId,
      flagKey: 'ui.shell.v2',
      enabled: true,
      reason: 'isolated-c360-browser',
      updatedByActor: 'c360-isolated-operator',
    },
  });

  // ---- seed (สังเคราะห์ทั้งหมด) ----
  const ids: Record<string, string> = {};
  ids.somchai = await contact(f, {
    displayName: 'สมชาย ใจดี',
    company: 'บริษัท ตัวอย่าง จำกัด',
    vip: true,
  });
  await head(f, ids.somchai, 'ACTIVE');
  await grant(f, 'admin', ids.somchai, 'MANAGE');
  await point(f, ids.somchai, 'PHONE', '+6621234567', 'ACTIVE', '+66 2 123 4567');
  await point(f, ids.somchai, 'EMAIL', 'somchai@example.com');
  await point(
    f,
    ids.somchai,
    'EMAIL',
    'somchai.old@example.com',
    'REVIEW_REQUIRED',
    'Somchai.Old@Example.COM',
  );
  await tag(f, ids.somchai, 'ลูกค้าสำคัญ');
  await interaction(f, ids.somchai, 'admin');
  await interaction(f, ids.somchai, 'admin');
  await interaction(f, ids.somchai, 'agent');
  await interaction(f, ids.somchai, 'admin', 'WEBCHAT');
  ids.somsri = await contact(f, { displayName: 'Somsri Rakdee', company: 'Acme Co.' });
  await head(f, ids.somsri, 'ACTIVE');
  await grant(f, 'admin', ids.somsri, 'READ');
  await point(f, ids.somsri, 'PHONE', '+6621234567');
  ids.legacy = await contact(f, { displayName: 'ลูกค้าเดิม ก่อนมีสถานะ identity' });
  await grant(f, 'admin', ids.legacy, 'READ');
  ids.ambiguous = await contact(f, { displayName: 'Ambiguous Amy' });
  await head(f, ids.ambiguous, 'AMBIGUOUS');
  await grant(f, 'admin', ids.ambiguous, 'READ');
  ids.longName = await contact(f, {
    displayName:
      'นางสาวสมหญิง ผู้มีชื่อยาวมากเพื่อทดสอบการตัดบรรทัดและการแสดงผลบนจอแคบ Wolfeschlegelsteinhausenbergerdorff',
    company:
      'บริษัท ที่มีชื่อยาวมากเช่นกัน เพื่อทดสอบการ wrap ของข้อความในตารางและหัวโปรไฟล์ จำกัด (มหาชน)',
  });
  await grant(f, 'admin', ids.longName, 'READ');
  ids.canonical = await contact(f, { displayName: 'Canonical Carol' });
  ids.predecessor = await contact(f, { displayName: 'Predecessor Paul' });
  await grant(f, 'admin', ids.predecessor, 'READ');
  await grant(f, 'admin', ids.canonical, 'READ');
  await f.memberships.recordIdentityTransition({
    tenantId: f.tenantId,
    commandId: `identity:${randomUUID()}`,
    operation: 'MERGE',
    sourceContactId: ids.predecessor,
    targetContactId: ids.canonical,
    expectedSourceLineageRevision: 0,
    correlationId: 'c2-browser-merge',
  });
  ids.hidden = await contact(f, { displayName: 'ซ่อนจากทุกคน' });
  const revokable: Record<string, Awaited<ReturnType<typeof grant>>> = {};
  for (const [key, displayName] of [
    ['revokable', 'Revoke Rita'],
    ['revokableRetry', 'Revoke Retry Rex'],
    ['revokableGovernance', 'Revoke Gov Gus'],
    ['revokableMore', 'Revoke More Mia'],
  ] as const) {
    ids[key] = await contact(f, { displayName });
    revokable[key] = await grant(f, 'admin', ids[key], 'READ');
  }
  // Mia มีสายของผู้ใช้มากกว่าหนึ่งหน้า (limit 20) เพื่อทดสอบโหลดประวัติเพิ่ม
  for (let i = 0; i < 22; i += 1) await interaction(f, ids.revokableMore, 'admin');
  ids.empty = await contact(f, { displayName: 'ไม่มีประวัติ Empty' });
  await grant(f, 'admin', ids.empty, 'READ');
  for (let i = 1; i <= 24; i += 1) {
    const bulk = await contact(f, { displayName: `ลูกค้าจำนวนมาก ${String(i).padStart(2, '0')}` });
    await grant(f, 'admin', bulk, 'READ');
  }
  await contact(f, { displayName: 'Foreign Tenant', tenantId: f.otherTenantId });
  // Supervisor อ่านลูกค้า C1 ผ่าน IAM VIEW ของทีม (owner + IAM ตามทัน)
  ids.scoped = f.contactId;
  await f.scopes.grant({
    tenantId: f.tenantId,
    teamId: f.teamId,
    segmentId: f.segmentId,
    permission: 'VIEW',
    correlationId: 'c2-browser-scope',
  });
  await ownerCommit(f, 'GOLD');
  await deliverToIam(f);

  // ---- control ----
  let actor = 'admin';
  let sessionExpired = false;
  let delayMs = 0;
  let failNext: { fragment: string; status: number } | undefined;
  let scopeLagging = false;
  const proxy = createHttpServer(async (req, res) => {
    try {
      const url = req.url ?? '';
      if (url.startsWith('/__c360_test/')) {
        const [, , action, a, b] = url.split('?')[0]!.split('/');
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        if (action === 'config') {
          res.end(JSON.stringify({ tenant: `core-${f.tenantId}`, ids }));
          return;
        }
        if (action === 'reset') {
          actor = 'admin';
          sessionExpired = false;
          delayMs = 0;
          failNext = undefined;
          await f.owner.$executeRawUnsafe('GRANT SELECT ON interactions TO dcontact_app');
          await f.owner.$executeRawUnsafe('GRANT SELECT ON cg_preferences TO dcontact_app');
          if (scopeLagging) {
            await deliverToIam(f);
            await ownerCommit(f, 'GOLD');
            await deliverToIam(f);
            scopeLagging = false;
          }
        } else if (action === 'actor') actor = a ?? 'admin';
        else if (action === 'session') sessionExpired = a === 'expire';
        else if (action === 'delay') delayMs = Number(a ?? 0);
        else if (action === 'fail')
          // คงอยู่จนกว่าจะสั่ง fail/0/x เพราะ React StrictMode (dev) ยิง effect สองรอบ
          failNext = Number(a) > 0 ? { fragment: b ?? '', status: Number(a) } : undefined;
        else if (action === 'owner')
          await f.owner.$executeRawUnsafe(
            a === 'down'
              ? 'REVOKE SELECT ON interactions FROM dcontact_app'
              : 'GRANT SELECT ON interactions TO dcontact_app',
          );
        else if (action === 'cg')
          await f.owner.$executeRawUnsafe(
            a === 'down'
              ? 'REVOKE SELECT ON cg_preferences FROM dcontact_app'
              : 'GRANT SELECT ON cg_preferences TO dcontact_app',
          );
        else if (action === 'scope') {
          // lag: owner ออกจาก segment แต่ IAM ยังไม่ตามทัน → DEFER; fresh: IAM ตามทันและสมาชิกกลับมา
          if (a === 'lag') {
            await ownerCommit(f, 'SILVER');
            scopeLagging = true;
          } else {
            // IAM รับ revision ต่อเนื่อง: ส่ง SILVER ที่ค้างก่อน แล้วค่อย GOLD
            await deliverToIam(f);
            await ownerCommit(f, 'GOLD');
            await deliverToIam(f);
            scopeLagging = false;
          }
        } else if (action === 'revoke') {
          const target = revokable[a ?? 'revokable']!;
          await f.owner.c360ContactCustodianRevocation.create({
            data: {
              id: randomUUID(),
              tenantId: f.tenantId,
              grantId: target.id,
              actorIdentityKey: target.actorIdentityKey,
              commandId: target.commandId,
              reason: 'browser fixture revoke',
              evidenceRef: 'fixture-evidence',
            },
          });
        }
        res.end('{}');
        return;
      }
      if (!url.startsWith('/api/')) {
        res.statusCode = 404;
        res.end();
        return;
      }
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (sessionExpired) {
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json');
        res.end('{"error":{"code":"SESSION_REQUIRED","retryable":false}}');
        return;
      }
      if (failNext && url.includes(failNext.fragment)) {
        res.statusCode = failNext.status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: { code: 'REQUEST_FAILED', retryable: true } }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const name of ['content-type', 'x-request-id'])
        if (typeof req.headers[name] === 'string') headers.set(name, req.headers[name]);
      // token จำลองของ browser → actor ที่ sandbox เลือก (stub verifier รับ alias เป็น bearer)
      headers.set('authorization', `Bearer ${actor}`);
      const response = await fetch(`${f.base}${url}`, {
        method: req.method,
        headers,
        ...(['GET', 'HEAD'].includes(req.method ?? 'GET') ? {} : { body: Buffer.concat(chunks) }),
      });
      res.statusCode = response.status;
      for (const name of ['content-type', 'cache-control', 'retry-after', 'x-request-id']) {
        const value = response.headers.get(name);
        if (value) res.setHeader(name, value);
      }
      res.end(await response.text());
    } catch {
      res.statusCode = 500;
      res.end('{"error":{"code":"HARNESS_FAILED"}}');
    }
  });
  await new Promise<void>((resolve) => proxy.listen(5199, '127.0.0.1', resolve));
  cleanups.push(async () => {
    proxy.closeAllConnections();
    await new Promise<void>((resolve, reject) => proxy.close((e) => (e ? reject(e) : resolve())));
  });
  const vite = await createViteServer({
    root: fileURLToPath(new URL('../', import.meta.url)),
    configFile: false,
    mode: 'e2e',
    server: {
      host: '127.0.0.1',
      port: 5198,
      strictPort: true,
      proxy: { '/api': 'http://127.0.0.1:5199', '/__c360_test': 'http://127.0.0.1:5199' },
    },
  });
  await vite.listen();
  cleanups.push(() => vite.close());
  process.stdout.write(
    'Customer 360 browser sandbox พร้อม: UI → API/RLS/DB จริง (identity เป็น stub)\n',
  );
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      void close().finally(() => process.exit(0));
    });
} catch (error) {
  await close().catch(() => undefined);
  throw error;
}
