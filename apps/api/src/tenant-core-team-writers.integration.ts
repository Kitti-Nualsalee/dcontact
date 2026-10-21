import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { teamWriterRace } from '@d-contact/db/testing/team-reference-races.js';
import { coreFixture } from './tenant-core-test-fixtures.js';
import { createCatalog, type VoiceActor } from './tenant-voice-catalog.js';
import { acceptPeopleCreate } from './tenant-people-operations.js';

for (const kind of ['queues', 'skills', 'people'] as const)
  for (const order of ['writer-first', 'deactivate-first'] as const)
    test(`Core Team fence: actual ${kind} ${order}`, async (t) => {
      const f = await coreFixture();
      t.after(() => f.close());
      const teamId = randomUUID();
      await f.owner.team.create({
        data: { id: teamId, tenantId: f.tenantId, name: 'Writer fixture' },
      });
      await f.owner
        .$executeRaw`INSERT INTO tenant_voice_provisioning_policies(tenant_id,revision,source_kind,accounts_limit,agents_limit,voice_queues_limit,skills_limit,approved_by_operator_subject,approved_at,approval_ref,reason,extension_pool) VALUES(${f.tenantId}::uuid,1,'UAT_EXPLICIT',50,20,10,10,'fixture-operator',now(),'isolated-writers','ทดสอบ transaction races','[]'::jsonb)`;
      const admin = f.actors.get('admin')!;
      const actor: VoiceActor = {
        tenantId: f.tenantId,
        userId: admin.id,
        roles: ['admin'],
        caller: {
          issuer: 'https://core-idp.test/realms/dcontact',
          subject: admin.id,
          clientId: 'dcontact-console',
          tenantSlug: `core-${f.tenantId}`,
        },
      };
      await teamWriterRace({
        owner: f.owner,
        tenantId: f.tenantId,
        teamId,
        table: kind === 'people' ? 'users' : kind,
        order,
        write: () =>
          kind === 'people'
            ? acceptPeopleCreate(f.db, actor, {
                commandId: randomUUID(),
                teamId,
                displayName: 'Writer fixture',
                email: `${randomUUID()}@test.invalid`,
                role: 'SUPERVISOR',
              })
            : createCatalog(f.db, actor, kind, {
                commandId: randomUUID(),
                teamId,
                name: 'Writer fixture',
                ...(kind === 'skills' ? { code: 'CORE_UAT' } : {}),
              }),
      });
    });
