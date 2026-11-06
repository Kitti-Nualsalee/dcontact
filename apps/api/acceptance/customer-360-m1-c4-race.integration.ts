import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Customer360OperatorController } from '../src/customer-360-operator-api.js';
import { Customer360TagCatalogController } from '../src/customer-360-tag-catalog-api.js';
import { setup } from '../src/customer-360-test-fixtures.js';

/** ต้องรันบน tree ที่รวม C4 #794 และ M1-A #819 แล้ว: ใช้ HTTP owner writers จริงทั้งสองฝั่ง */
for (const winner of ['retire', 'attach'] as const) {
  test(`actual M1 retire กับ C4 attach: ${winner} ถือ owner lock ก่อน`, async (t) => {
    const f = await setup([Customer360OperatorController, Customer360TagCatalogController]);
    t.after(() => f.close());
    const grant = await f.request('customer-360/operator/commands', 'operator', {
      commandId: randomUUID(),
      evidenceRef: 'ticket:TEST-RACE',
      reasonCode: 'APPROVED_CUSTODIAN',
      command: {
        action: 'CAPABILITY_GRANT',
        granteeUserId: f.actors.get('admin')!.id,
        capability: 'CONTACT_CREATE',
      },
    });
    assert.equal(grant.status, 201);
    const contactResult = await f.request('customer-360/contacts', 'admin', {
      commandId: randomUUID(),
      displayName: 'Race fixture',
    });
    assert.equal(contactResult.status, 201);
    const contactId = (
      contactResult.body as unknown as { command: { resourceRefs: { type: string; id: string }[] } }
    ).command.resourceRefs.find((ref) => ref.type === 'CONTACT')!.id;
    const tagResult = await f.request('customer-360/tags', 'admin', {
      commandId: randomUUID(),
      name: `Race ${winner}`,
    });
    assert.equal(tagResult.status, 201);
    const tagId = (
      tagResult.body as unknown as { command: { resourceRefs: { type: string; id: string }[] } }
    ).command.resourceRefs.find((ref) => ref.type === 'TAG')!.id;
    const retireId = randomUUID();
    const attachId = randomUUID();
    const retire = () =>
      f.request(`customer-360/tags/${tagId}/retire`, 'admin', {
        commandId: retireId,
        expectedRevision: '0',
      });
    const attach = () =>
      f.request(
        `customer-360/contacts/${contactId}/tags`,
        'admin',
        {
          commandId: attachId,
          expectedTagRevision: '0',
          expectedLineageRevision: '0',
          attachTagIds: [tagId],
          detachTagIds: [],
        },
        'PATCH',
      );
    const slot = winner === 'retire' ? 811 : 812;
    const table = winner === 'retire' ? 'c360_tags' : 'c360_contact_tags';
    const event = winner === 'retire' ? 'UPDATE' : 'INSERT';
    await f.owner.$executeRawUnsafe(
      `CREATE FUNCTION m1c4_race_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(819, ${slot}); RETURN NEW; END $$`,
    );
    await f.owner.$executeRawUnsafe(
      `CREATE TRIGGER m1c4_race_gate BEFORE ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION m1c4_race_gate()`,
    );
    let leader: ReturnType<typeof retire> | undefined;
    try {
      await f.owner.$transaction(
        async (blocker) => {
          await blocker.$executeRaw`SELECT pg_advisory_xact_lock(819, ${slot}::integer)`;
          leader = winner === 'retire' ? retire() : attach();
          let waiting = false;
          for (let i = 0; i < 100; i++) {
            const [row] = await f.owner.$queryRaw<
              { count: bigint }[]
            >`SELECT count(*)::bigint AS count FROM pg_locks WHERE locktype = 'advisory' AND classid = 819 AND objid = ${slot}::integer AND NOT granted`;
            if (row?.count) {
              waiting = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          assert.equal(waiting, true, 'owner writer ต้องถึง trigger หลังถือ lock จริง');
          assert.equal((await (winner === 'retire' ? attach() : retire())).status, 503);
        },
        { timeout: 10000 },
      );
      assert.equal((await leader!).status, 200);
      const retry = await (winner === 'retire' ? attach() : retire());
      assert.equal(retry.status, winner === 'retire' ? 409 : 200);
      if (winner === 'retire')
        assert.equal(
          (retry.body as unknown as { command: { code: string } }).command.code,
          'TAG_RETIRED',
        );
      const persisted = await f.owner.c360ContactTag.count({
        where: { tenantId: f.tenantId, contactId, tagId },
      });
      assert.equal(persisted, winner === 'attach' ? 1 : 0);
      const currentTag = await f.owner.c360Tag.findUniqueOrThrow({ where: { id: tagId } });
      assert.equal(currentTag.state, 'RETIRED');
      assert.equal(currentTag.revision, 1n);
      assert.equal(
        (await f.owner.contact.findUniqueOrThrow({ where: { id: contactId } })).tagRevision,
        winner === 'attach' ? 1n : 0n,
      );
      assert.equal(
        await f.owner.c360ProfileAudit.count({
          where: { tenantId: f.tenantId, commandId: retireId },
        }),
        1,
      );
      assert.equal(
        await f.owner.c360ProfileAudit.count({
          where: { tenantId: f.tenantId, commandId: attachId },
        }),
        winner === 'attach' ? 1 : 0,
      );
      assert.equal(
        await f.owner.c360ProfileCommandReceipt.count({
          where: { tenantId: f.tenantId, commandId: retireId, outcome: 'APPLIED' },
        }),
        1,
      );
      assert.equal(
        await f.owner.c360ProfileCommandReceipt.count({
          where: {
            tenantId: f.tenantId,
            commandId: attachId,
            outcome: winner === 'attach' ? 'APPLIED' : 'REJECTED',
          },
        }),
        1,
      );
      assert.equal((await retire()).status, 200);
      assert.equal((await attach()).status, winner === 'attach' ? 200 : 409);
      if (winner === 'attach') {
        const detached = await f.request(
          `customer-360/contacts/${contactId}/tags`,
          'admin',
          {
            commandId: randomUUID(),
            expectedTagRevision: '1',
            expectedLineageRevision: '0',
            attachTagIds: [],
            detachTagIds: [tagId],
          },
          'PATCH',
        );
        assert.equal(detached.status, 200);
        assert.equal(
          await f.owner.c360ContactTag.count({ where: { tenantId: f.tenantId, contactId, tagId } }),
          0,
        );
        assert.equal(
          (await f.owner.contact.findUniqueOrThrow({ where: { id: contactId } })).tagRevision,
          2n,
        );
      }
    } finally {
      await f.owner.$executeRawUnsafe(`DROP TRIGGER IF EXISTS m1c4_race_gate ON ${table}`);
      await f.owner.$executeRawUnsafe('DROP FUNCTION IF EXISTS m1c4_race_gate()');
    }
  });
}
