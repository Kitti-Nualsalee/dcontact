/** Test-only fault injection บน PostgreSQL จริง; production entry point ไม่ export โมดูลนี้ */
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import type { PrismaClient, Prisma } from '@prisma/client';
import { withTenantDatabaseTransaction } from '../tenant-context';

export interface TeamWriterRace {
  owner: PrismaClient;
  tenantId: string;
  teamId: string;
  table: string;
  order: 'writer-first' | 'deactivate-first';
  existingReferences?: boolean;
  write: () => Promise<unknown>;
  blockedResult?: (result: unknown) => boolean | Promise<boolean>;
}
function latch() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
function busy(error: unknown) {
  if (/TEAM_REFERENCE_BUSY|55P03|could not obtain lock|CONFIG_BUSY/.test(String(error)))
    return true;
  if (
    error &&
    typeof error === 'object' &&
    'getResponse' in error &&
    typeof error.getResponse === 'function'
  ) {
    const response: unknown = error.getResponse();
    return (
      !!response &&
      typeof response === 'object' &&
      'code' in response &&
      response.code === 'CONFIG_BUSY'
    );
  }
  return false;
}
export async function teamWriterRace(input: TeamWriterRace): Promise<void> {
  const { owner, tenantId, teamId } = input;
  assert.match(tenantId, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  assert.match(input.table, /^[a-z][a-z0-9_]*$/);
  const ready = latch(),
    release = latch();
  const deactivate = async (tx: Prisma.TransactionClient) => {
    await tx.$executeRawUnsafe(
      'SELECT public.dc_team_reference_lock($1::uuid,ARRAY[$2::uuid],true)',
      tenantId,
      teamId,
    );
    return tx.team.update({ where: { id: teamId }, data: { isActive: false } });
  };
  if (input.order === 'deactivate-first') {
    const first = withTenantDatabaseTransaction(
      owner,
      tenantId,
      async (tx) => {
        if (input.existingReferences)
          await tx.$executeRawUnsafe(
            'SELECT public.dc_team_reference_lock($1::uuid,ARRAY[$2::uuid],true)',
            tenantId,
            teamId,
          );
        else await deactivate(tx);
        ready.open();
        await release.promise;
      },
      { timeout: 10000 },
    );
    const observed = first.catch((error) => {
      ready.open();
      throw error;
    });
    try {
      await ready.promise;
      const start = performance.now();
      let rejected = false;
      try {
        const result = await input.write();
        rejected = (await input.blockedResult?.(result)) === true;
      } catch (error) {
        assert.ok(busy(error), 'writer ต้อง rollback ด้วย busy outcome');
        rejected = true;
      }
      assert.ok(rejected, 'writer ต้อง fail-closed เมื่อ deactivate ถือ fence');
      assert.ok(
        performance.now() - start < 2000,
        'writer ต้อง fail-fast เมื่อ deactivate ถือ fence',
      );
    } finally {
      release.open();
      await observed;
    }
    assert.equal(
      (await owner.team.findUniqueOrThrow({ where: { id: teamId } })).isActive,
      !!input.existingReferences,
    );
    if (input.existingReferences)
      await assert.rejects(
        withTenantDatabaseTransaction(owner, tenantId, deactivate),
        /TEAM_REFERENCED|TEAM_REFERENCE_UNRESOLVED/,
      );
    return;
  }
  const suffix = randomUUID().replaceAll('-', '');
  const trigger = `zz_team_test_pause_${suffix}`,
    fn = `dc_team_test_pause_${suffix}`;
  const barrier = randomInt(1_000_000, 1_000_000_000);
  // ทุก literal ด้านล่างเป็น UUID/identifier ที่ตรวจแล้ว และ integer ที่สุ่มใน test; ไม่มี request SQL
  await owner.$executeRawUnsafe(
    `CREATE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE previous_timeout text; BEGIN IF NEW.tenant_id='${tenantId}'::uuid THEN previous_timeout:=current_setting('lock_timeout'); PERFORM set_config('lock_timeout','5s',true); PERFORM pg_advisory_xact_lock(${barrier}::bigint); PERFORM set_config('lock_timeout',previous_timeout,true); END IF; RETURN NEW; END $$`,
  );
  await owner.$executeRawUnsafe(
    `CREATE TRIGGER ${trigger} AFTER INSERT OR UPDATE ON public.${input.table} FOR EACH ROW EXECUTE FUNCTION public.${fn}()`,
  );
  let writer: Promise<void> | undefined;
  let settled = false;
  let failure: unknown;
  let assertionFailure: unknown;
  const first = owner.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock($1::bigint)', barrier);
      ready.open();
      await release.promise;
    },
    { timeout: 10000 },
  );
  const observed = first.catch((error) => {
    ready.open();
    throw error;
  });
  try {
    await ready.promise;
    writer = input.write().then(
      () => {
        settled = true;
      },
      (error) => {
        settled = true;
        failure = error;
      },
    );
    const deadline = performance.now() + 2500;
    let waiting = false;
    while (performance.now() < deadline && !settled) {
      const rows = await owner.$queryRawUnsafe<{ waiting: boolean }[]>(
        "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=0 AND objid=$1::oid AND NOT granted) AS waiting",
        barrier,
      );
      if (rows[0]?.waiting) {
        waiting = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (failure) throw failure;
    assert.ok(waiting, 'actual repository ต้องถึง material writer และถือ Team fence ก่อน barrier');
    const start = performance.now();
    await assert.rejects(withTenantDatabaseTransaction(owner, tenantId, deactivate), busy);
    assert.ok(
      performance.now() - start < 2000,
      'deactivate ต้อง fail-fast เมื่อ actual writer ถือ fence',
    );
  } catch (error) {
    assertionFailure = error;
  } finally {
    release.open();
    await observed;
    await writer;
    await owner.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${trigger} ON public.${input.table}`);
    await owner.$executeRawUnsafe(`DROP FUNCTION IF EXISTS public.${fn}()`);
  }
  if (failure) throw failure;
  if (assertionFailure) throw assertionFailure;
  assert.equal((await owner.team.findUniqueOrThrow({ where: { id: teamId } })).isActive, true);
}
