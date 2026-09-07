import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';

const repositoryRoot = resolve(process.cwd(), '../..');

function queryAsApplicationRole(sql: string): string {
  const compactSql = sql.replace(/\s+/g, ' ').trim();
  return execFileSync(
    'docker',
    [
      'compose',
      '-f',
      'infra/docker/docker-compose.dev.yml',
      'exec',
      '-T',
      'postgres',
      'sh',
      '-c',
      `PGPASSWORD=dcontact_app psql -h 127.0.0.1 -U dcontact_app -d dcontact -tAc ${JSON.stringify(compactSql)}`,
    ],
    { cwd: repositoryRoot, encoding: 'utf8' },
  ).trim();
}

function queryAsOwner(sql: string): string {
  return execFileSync(
    'docker',
    [
      'compose',
      '-f',
      'infra/docker/docker-compose.dev.yml',
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'dcontact',
      '-d',
      'dcontact',
      '-tAc',
      sql,
    ],
    { cwd: repositoryRoot, encoding: 'utf8' },
  ).trim();
}

test('dcontact_app RLS denies queue data without or with an incorrect tenant context', () => {
  assert.equal(queryAsApplicationRole('SELECT count(*) FROM queues;'), '0');
  assert.match(
    queryAsApplicationRole(
      "BEGIN; SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true); SELECT count(*) FROM queues; COMMIT;",
    ),
    /\n0\nCOMMIT$/,
  );
});

test('dcontact_app RLS permits the seeded demo tenant only after its context is set', () => {
  const result = queryAsApplicationRole(
    "BEGIN; SELECT set_config('app.tenant_id', (SELECT id::text FROM tenants WHERE slug = 'demo'), true); SELECT count(*) FROM queues; COMMIT;",
  );

  assert.match(result, /\n[1-9]\d*\nCOMMIT$/);
});

test('dcontact_app cannot read or mutate a second tenant queue', (t) => {
  const tenantId = randomUUID();
  const queueId = randomUUID();
  const suffix = tenantId.slice(0, 8);
  queryAsOwner(
    `INSERT INTO tenants (id, name, slug, sip_domain) VALUES ('${tenantId}', 'RLS test ${suffix}', 'rls-${suffix}', 'rls-${suffix}.test'); INSERT INTO queues (id, tenant_id, name, channels) VALUES ('${queueId}', '${tenantId}', 'RLS queue', ARRAY['VOICE']::"ChannelType"[]);`,
  );
  t.after(() =>
    queryAsOwner(
      `DELETE FROM queues WHERE tenant_id = '${tenantId}'; DELETE FROM tenants WHERE id = '${tenantId}';`,
    ),
  );
  const demoTenantId = queryAsOwner("SELECT id FROM tenants WHERE slug = 'demo';");

  const hiddenAndProtected = queryAsApplicationRole(
    `BEGIN; SELECT set_config('app.tenant_id', '${demoTenantId}', true); SELECT count(*) FROM queues WHERE id = '${queueId}'; UPDATE queues SET name = 'cross-tenant mutation' WHERE id = '${queueId}'; COMMIT;`,
  );
  const visibleToOwnerTenant = queryAsApplicationRole(
    `BEGIN; SELECT set_config('app.tenant_id', '${tenantId}', true); SELECT count(*) FROM queues WHERE id = '${queueId}'; COMMIT;`,
  );

  assert.match(hiddenAndProtected, /\n0\nUPDATE 0\nCOMMIT$/);
  assert.match(visibleToOwnerTenant, /\n1\nCOMMIT$/);
});

test('dcontact_app isolates Contact Governance and Journey inbox rows between tenants', (t) => {
  const tenantId = randomUUID();
  const contactId = randomUUID();
  const restrictionId = randomUUID();
  const consentId = randomUUID();
  const decisionId = randomUUID();
  const reservationId = randomUUID();
  const inboxId = randomUUID();
  const suffix = tenantId.slice(0, 8);

  queryAsOwner(
    `BEGIN;
     INSERT INTO tenants (id, name, slug, sip_domain) VALUES ('${tenantId}', 'CXA RLS ${suffix}', 'cxa-rls-${suffix}', 'cxa-rls-${suffix}.test');
     INSERT INTO contacts (id, tenant_id, display_name) VALUES ('${contactId}', '${tenantId}', 'CXA RLS contact');
     INSERT INTO cg_restrictions (id, tenant_id, contact_id, type, scope, overridable, reason_code, source, starts_at, created_by) VALUES ('${restrictionId}', '${tenantId}', '${contactId}', 'DNC', 'CONTACT', false, 'DNC_GLOBAL', 'TEST', now(), 'integration-test');
     INSERT INTO cg_consents (id, tenant_id, contact_id, purpose, channel, status, lawful_basis, evidence, updated_at) VALUES ('${consentId}', '${tenantId}', '${contactId}', 'MARKETING', 'EMAIL', 'REVOKED', 'CONSENT', '{}', now());
     INSERT INTO cg_reservations (id, tenant_id, contact_id, channel, purpose, source, source_id, action_key, input_hash, state, expires_at, updated_at) VALUES ('${reservationId}', '${tenantId}', '${contactId}', 'EMAIL', 'MARKETING', 'JOURNEY', 'journey-001', 'enrollment-001:1:step-001', 'hash-001', 'RESERVED', now() + interval '15 minutes', now());
     INSERT INTO cg_decision_logs (id, tenant_id, contact_id, channel, purpose, source, source_id, action_key, decision, reason_code, policy_version, gate, trace, reservation_id) VALUES ('${decisionId}', '${tenantId}', '${contactId}', 'EMAIL', 'MARKETING', 'JOURNEY', 'journey-001', 'enrollment-001:1:step-001', 'ALLOW', 'POLICY_PASSED', 1, 'CONSENT', '[]', '${reservationId}');
     INSERT INTO jr_event_inbox (id, tenant_id, source, event_id, event_type, occurred_at, payload, payload_hash, state, updated_at) VALUES ('${inboxId}', '${tenantId}', 'billing', 'event-001', 'PAYMENT_DUE', now(), '{}', 'payload-hash-001', 'PENDING', now());
     COMMIT;`,
  );

  t.after(() =>
    queryAsOwner(
      `DELETE FROM jr_event_inbox WHERE tenant_id = '${tenantId}';
       DELETE FROM cg_decision_logs WHERE tenant_id = '${tenantId}';
       DELETE FROM cg_reservations WHERE tenant_id = '${tenantId}';
       DELETE FROM cg_consents WHERE tenant_id = '${tenantId}';
       DELETE FROM cg_restrictions WHERE tenant_id = '${tenantId}';
       DELETE FROM contacts WHERE tenant_id = '${tenantId}';
       DELETE FROM tenants WHERE id = '${tenantId}';`,
    ),
  );

  const demoTenantId = queryAsOwner("SELECT id FROM tenants WHERE slug = 'demo';");
  const hiddenAndProtected = queryAsApplicationRole(
    `BEGIN;
     SELECT set_config('app.tenant_id', '${demoTenantId}', true);
     SELECT (SELECT count(*) FROM cg_restrictions WHERE id = '${restrictionId}'),
            (SELECT count(*) FROM cg_consents WHERE id = '${consentId}'),
            (SELECT count(*) FROM cg_decision_logs WHERE id = '${decisionId}'),
            (SELECT count(*) FROM cg_reservations WHERE id = '${reservationId}'),
            (SELECT count(*) FROM jr_event_inbox WHERE id = '${inboxId}');
     UPDATE cg_restrictions SET reason_code = 'CROSS_TENANT' WHERE id = '${restrictionId}';
     UPDATE jr_event_inbox SET state = 'FAILED' WHERE id = '${inboxId}';
     COMMIT;`,
  );
  const visibleToOwnerTenant = queryAsApplicationRole(
    `BEGIN;
     SELECT set_config('app.tenant_id', '${tenantId}', true);
     SELECT (SELECT count(*) FROM cg_restrictions),
            (SELECT count(*) FROM cg_consents),
            (SELECT count(*) FROM cg_decision_logs),
            (SELECT count(*) FROM cg_reservations),
            (SELECT count(*) FROM jr_event_inbox);
     COMMIT;`,
  );

  assert.match(hiddenAndProtected, /\n0\|0\|0\|0\|0\nUPDATE 0\nUPDATE 0\nCOMMIT$/);
  assert.match(visibleToOwnerTenant, /\n1\|1\|1\|1\|1\nCOMMIT$/);
});
