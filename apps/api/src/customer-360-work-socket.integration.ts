import assert from 'node:assert/strict';
import test from 'node:test';
import { coreFixture } from './tenant-core-test-fixtures.js';
import { C360WorkAuthService } from './customer-360-work-auth.js';
import { WorkSessionLeases } from './work-session.js';
import {
  WorkspaceSessionGateway,
  WorkspaceSessionRegistry,
  WorkspaceSessionWebSocketAdapter,
} from '@d-contact/workspace-session';

test(
  'socket refresh ซ้อนใช้ durable epoch จาก PostgreSQL ก่อนส่ง session ล่าสุด',
  { timeout: 30_000 },
  async (t) => {
    const url = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid/none');
    assert.ok(url.pathname !== '/dcontact' && url.port !== '5433');
    const f = await coreFixture();
    t.after(() => f.close());
    const agent = f.actors.get('agent')!;
    const actor = { tenantId: f.tenantId, userId: agent.id };
    const leases = new WorkSessionLeases(f.db);
    const { leaseId } = await leases.acquire(
      actor,
      { surface: 'workspace', hostOrigin: null },
      'sequence-test',
    );
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const claims = (token: string) => ({
      iss: 'https://core-idp.test/realms/dcontact',
      sub: agent.id,
      azp: 'dcontact-console',
      tenant_id: f.tenantId,
      tenant_slug: `core-${f.tenantId}`,
      organization: { [`core-${f.tenantId}`]: { tenant_id: [f.tenantId] } },
      dc_user_id: agent.id,
      sid: `sid-${token}`,
      exp: expires,
      realm_access: { roles: ['agent'] },
    });
    let release!: () => void, reached!: () => void;
    const wait = new Promise<void>((r) => {
      release = r;
    });
    const started = new Promise<void>((r) => {
      reached = r;
    });
    const verifier = { verifyAccessToken: async (token: string) => claims(token) };
    const service = new C360WorkAuthService(f.db, verifier, {
      async introspect(token: string) {
        if (token === 'old') {
          reached();
          await wait;
        }
        const c = claims(token);
        return { active: true, iss: c.iss, sub: c.sub, sid: c.sid, exp: expires };
      },
    });
    const gateway = new WorkspaceSessionGateway(verifier, new WorkspaceSessionRegistry(), {
      isActive: async () => true,
    });
    const adapter = new WorkspaceSessionWebSocketAdapter(
      gateway,
      undefined,
      undefined,
      leases,
      service,
    );
    const messages: Record<string, unknown>[] = [];
    const socket = {
      send: (value: string) => messages.push(JSON.parse(value)),
      close: (code: number) => assert.fail(`unexpected close ${code}`),
    };
    await adapter.handle(socket, {
      type: 'auth:connect',
      accessToken: 'initial',
      tabId: 'a',
      leaseId,
    });
    const old = adapter.handle(socket, {
      type: 'auth:refresh',
      accessToken: 'old',
      tabId: 'a',
      leaseId,
    });
    await Promise.race([
      started,
      old.then(() => {
        throw new Error('refresh did not reach online check');
      }),
    ]);
    const latest = adapter.handle(socket, {
      type: 'auth:refresh',
      accessToken: 'new',
      tabId: 'a',
      leaseId,
    });
    release();
    await Promise.all([old, latest]);
    const row = await f.owner.c360WorkMutationAuth.findUniqueOrThrow({
      where: { tenantId_userId_leaseId: { ...actor, leaseId } },
    });
    assert.equal(row.authState, 'ACTIVE');
    assert.equal(row.authEpoch, 2n);
    assert.equal(row.sid, 'sid-new');
    await service.verifyOnline({ accessToken: 'new', leaseId });
    assert.equal(messages.filter((m) => m.type === 'workspace.session').length, 2);
    assert.ok(!JSON.stringify(messages).includes('tokenFingerprint'));
  },
);
