import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const container = process.env.VOICE_SKILL_TEST_CONTAINER;
const databaseUser = process.env.VOICE_SKILL_TEST_USER ?? 'postgres';
if (!container) throw new Error('ต้องระบุ VOICE_SKILL_TEST_CONTAINER ของ PostgreSQL sandbox');
const migration = readFileSync(
  resolve(__dirname, '../prisma/migrations/20261022130000_tenant_voice_skill_scope/migration.sql'),
  'utf8',
);
const finalGuards = readFileSync(
  resolve(
    __dirname,
    '../prisma/migrations/20261022150000_tenant_voice_config_commit_guards/migration.sql',
  ),
  'utf8',
);
const tenantA = '00000000-0000-4000-8000-000000000001';
const tenantB = '00000000-0000-4000-8000-000000000002';
const userA = '00000000-0000-4000-8000-000000000011';
const userB = '00000000-0000-4000-8000-000000000012';
const skillA = '00000000-0000-4000-8000-000000000021';
const skillB = '00000000-0000-4000-8000-000000000022';
const queueA = '00000000-0000-4000-8000-000000000031';
const queueB = '00000000-0000-4000-8000-000000000032';

function sql(database: string, input: string) {
  return execFileSync(
    'docker',
    [
      'exec',
      '-i',
      container!,
      'psql',
      '-X',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      databaseUser,
      '-d',
      database,
      '-At',
    ],
    {
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
}

const baseline = `
CREATE TABLE users(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,team_id uuid,config_revision integer DEFAULT 1,role text DEFAULT 'AGENT',is_active boolean DEFAULT true,UNIQUE(tenant_id,id));
CREATE TABLE queues(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,team_id uuid,config_revision integer DEFAULT 1,voice_config_version integer,is_active boolean DEFAULT false,channels text[] DEFAULT '{VOICE}',UNIQUE(tenant_id,id));
CREATE TABLE skills(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,team_id uuid,voice_config_version integer,UNIQUE(tenant_id,id));
CREATE TABLE teams(id uuid PRIMARY KEY,tenant_id uuid,is_active boolean DEFAULT true);
CREATE TABLE agent_skills(user_id uuid NOT NULL REFERENCES users(id),skill_id uuid NOT NULL REFERENCES skills(id),level integer NOT NULL DEFAULT 1,PRIMARY KEY(user_id,skill_id));
CREATE TABLE queue_skills(queue_id uuid NOT NULL REFERENCES queues(id),skill_id uuid NOT NULL REFERENCES skills(id),min_level integer NOT NULL DEFAULT 1,PRIMARY KEY(queue_id,skill_id));
CREATE TABLE voice_destinations(id uuid PRIMARY KEY,tenant_id uuid,queue_id uuid,entry_mode text DEFAULT 'DIRECT_QUEUE',is_active boolean DEFAULT false);
CREATE TABLE tenant_voice_provisioning_policies(tenant_id uuid PRIMARY KEY,destination_pool jsonb DEFAULT '[]');
CREATE TABLE voice_config_commands(tenant_id uuid,command_id uuid,actor_user_id uuid,resource_id uuid,action text,command_kind text,expected_revision integer);
CREATE TABLE voice_config_command_receipts(tenant_id uuid,command_id uuid);
CREATE TABLE voice_config_audit(tenant_id uuid,command_id uuid,actor_user_id uuid,resource_id uuid,action text,outcome text,before_revision integer,after_revision integer);
CREATE TABLE interactions(tenant_id uuid,queue_id uuid,agent_id uuid,channel text,state text,metadata jsonb DEFAULT '{}');
CREATE FUNCTION dc_voice_catalog_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE TRIGGER voice_queue_config_guard BEFORE INSERT OR UPDATE OR DELETE ON queues FOR EACH ROW EXECUTE FUNCTION dc_voice_catalog_guard();
CREATE FUNCTION dc_team_reference_lock(uuid,uuid[],boolean) RETURNS void LANGUAGE sql AS $$ SELECT $$;
INSERT INTO users(id,tenant_id) VALUES('${userA}','${tenantA}'),('${userB}','${tenantB}');
INSERT INTO skills(id,tenant_id) VALUES('${skillA}','${tenantA}'),('${skillB}','${tenantB}');
INSERT INTO queues(id,tenant_id) VALUES('${queueA}','${tenantA}'),('${queueB}','${tenantB}');
INSERT INTO agent_skills(user_id,skill_id,level) VALUES('${userA}','${skillA}',5),('${userB}','${skillB}',1);
INSERT INTO queue_skills(queue_id,skill_id,min_level) VALUES('${queueA}','${skillA}',1),('${queueB}','${skillB}',5);
`;

test('Voice skill migration: contamination ต้อง rollback ทั้ง agent และ queue', async (context) => {
  for (const table of ['agent_skills', 'queue_skills']) {
    await context.test(table, () => {
      const database = `voice_skill_${randomUUID().replaceAll('-', '')}`;
      sql('postgres', `CREATE DATABASE ${database}`);
      try {
        sql(database, baseline);
        sql(database, `UPDATE ${table} SET skill_id='${skillB}' WHERE skill_id='${skillA}'`);
        assert.throws(() => sql(database, migration), /SKILL_ASSIGNMENT_TENANT_CONTAMINATION/);
        assert.equal(
          sql(
            database,
            "SELECT count(*) FROM information_schema.columns WHERE table_name IN ('agent_skills','queue_skills') AND column_name='tenant_id'",
          ).trim(),
          '0',
        );
      } finally {
        sql('postgres', `DROP DATABASE ${database} WITH (FORCE)`);
      }
    });
  }
});

test('Voice config commit: descriptor/receipt ไม่แทน revision/audit และ metadata targets ต้อง busy', () => {
  const database = `voice_skill_${randomUUID().replaceAll('-', '')}`;
  sql('postgres', `CREATE DATABASE ${database}`);
  try {
    sql(database, baseline);
    sql(database, migration);
    sql(database, finalGuards);
    const adminId = randomUUID();
    const teamId = randomUUID();
    const destinationId = randomUUID();
    sql(
      database,
      `DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='dcontact_app') THEN CREATE ROLE dcontact_app NOBYPASSRLS; END IF; END $$;
      GRANT USAGE ON SCHEMA public TO dcontact_app;
      GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO dcontact_app;
      INSERT INTO teams(id,tenant_id) VALUES('${teamId}','${tenantA}');
      INSERT INTO users(id,tenant_id,role) VALUES('${adminId}','${tenantA}','ADMIN');
      UPDATE users SET team_id='${teamId}' WHERE id='${userA}';
      UPDATE queues SET team_id='${teamId}',voice_config_version=1 WHERE id='${queueA}';
      UPDATE skills SET team_id='${teamId}',voice_config_version=1 WHERE id='${skillA}';
      INSERT INTO tenant_voice_provisioning_policies(tenant_id,destination_pool) VALUES('${tenantA}','[{"destinationId":"${destinationId}"}]');
      INSERT INTO voice_destinations(id,tenant_id,queue_id,voice_config_version) VALUES('${destinationId}','${tenantA}','${queueA}',1);`,
    );
    const context = `BEGIN; SET LOCAL ROLE dcontact_app; SET LOCAL app.tenant_id='${tenantA}';`;
    assert.throws(
      () =>
        sql(database, `${context} UPDATE users SET config_revision=2 WHERE id='${userA}'; COMMIT;`),
      /VOICE_CONFIG_V1_REQUIRED/,
    );
    sql(database, `${context} UPDATE users SET is_active=false WHERE id='${userA}'; COMMIT;`);
    for (const action of [
      'AGENT_SKILLS_REPLACE',
      'QUEUE_REQUIRED_SKILLS_REPLACE',
      'QUEUE_UPDATE',
      'DESTINATION_BINDING_UPDATE',
    ]) {
      const resource =
        action === 'AGENT_SKILLS_REPLACE'
          ? userA
          : action === 'DESTINATION_BINDING_UPDATE'
            ? destinationId
            : queueA;
      const table =
        action === 'AGENT_SKILLS_REPLACE'
          ? 'users'
          : action === 'DESTINATION_BINDING_UPDATE'
            ? 'voice_destinations'
            : 'queues';
      const assignment =
        action === 'AGENT_SKILLS_REPLACE'
          ? `UPDATE agent_skills SET level=2 WHERE user_id='${userA}';`
          : action === 'QUEUE_REQUIRED_SKILLS_REPLACE'
            ? `UPDATE queue_skills SET min_level=2 WHERE queue_id='${queueA}';`
            : '';
      const revision = `UPDATE ${table} SET config_revision=config_revision+1 WHERE id='${resource}';`;
      function transaction(options: { bump?: boolean; audit?: boolean; badActor?: boolean } = {}) {
        const commandId = randomUUID();
        return `${context} SET LOCAL app.voice_config_command='${commandId}';
          INSERT INTO voice_config_commands VALUES('${tenantA}','${commandId}','${adminId}','${resource}','${action}','CONFIG_UPDATE',1);
          ${assignment} ${options.bump ? revision : ''}
          ${options.audit ? `INSERT INTO voice_config_audit VALUES('${tenantA}','${commandId}','${options.badActor ? userA : adminId}','${resource}','${action}','SUCCEEDED',1,2);` : ''}
          INSERT INTO voice_config_command_receipts VALUES('${tenantA}','${commandId}'); COMMIT;`;
      }
      assert.throws(
        () => sql(database, transaction({ audit: true })),
        /VOICE_CONFIG_FINAL_REVISION_REQUIRED/,
      );
      assert.throws(
        () => sql(database, transaction({ bump: true })),
        /VOICE_CONFIG_FINAL_EVIDENCE_REQUIRED/,
      );
      assert.throws(
        () => sql(database, transaction({ bump: true, audit: true, badActor: true })),
        /VOICE_CONFIG_FINAL_EVIDENCE_REQUIRED/,
      );
      assert.equal(
        sql(database, `SELECT config_revision FROM ${table} WHERE id='${resource}'`).trim(),
        '1',
      );
      for (const metadataKey of ['targetAgentId', 'target_agent_id']) {
        sql(
          database,
          `INSERT INTO interactions(tenant_id,channel,state,metadata) VALUES('${tenantA}','VOICE','QUEUED','{"${metadataKey}":"${userA}"}')`,
        );
        assert.throws(() => sql(database, transaction({ bump: true, audit: true })), /CONFIG_BUSY/);
        sql(database, 'DELETE FROM interactions');
      }
      sql(database, transaction({ bump: true, audit: true }));
      assert.equal(
        sql(database, `SELECT config_revision FROM ${table} WHERE id='${resource}'`).trim(),
        '2',
      );
      sql(database, `UPDATE ${table} SET config_revision=1 WHERE id='${resource}'`);
    }
    sql(
      database,
      `${context} INSERT INTO voice_config_commands VALUES('${tenantA}','${randomUUID()}','${adminId}','${queueA}','QUEUE_CREATE','CATALOG_CREATE',NULL); COMMIT;`,
    );
  } finally {
    sql('postgres', `DROP DATABASE ${database} WITH (FORCE)`);
  }
});

test('Voice skill migration: backfill, composite FK, checks และ FORCE RLS', () => {
  const database = `voice_skill_${randomUUID().replaceAll('-', '')}`;
  sql('postgres', `CREATE DATABASE ${database}`);
  try {
    sql(database, baseline);
    sql(database, migration);
    sql(
      database,
      `DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='dcontact_app') THEN CREATE ROLE dcontact_app NOBYPASSRLS; END IF; END $$;
      GRANT USAGE ON SCHEMA public TO dcontact_app;
      GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO dcontact_app;
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO dcontact_app;`,
    );
    assert.equal(
      sql(
        database,
        `SELECT count(*) FROM agent_skills WHERE tenant_id='${tenantA}' AND level=5`,
      ).trim(),
      '1',
    );
    assert.equal(
      sql(
        database,
        `SELECT count(*) FROM queue_skills WHERE tenant_id='${tenantB}' AND min_level=5`,
      ).trim(),
      '1',
    );
    for (const table of ['agent_skills', 'queue_skills']) {
      const parentColumn = table === 'agent_skills' ? 'user_id' : 'queue_id';
      const parentId = table === 'agent_skills' ? userA : queueA;
      const levelColumn = table === 'agent_skills' ? 'level' : 'min_level';
      for (const level of [0, 6]) {
        assert.throws(
          () => sql(database, `UPDATE ${table} SET ${levelColumn}=${level}`),
          /check constraint/,
        );
      }
      for (const level of [1, 2, 3, 4, 5])
        sql(database, `UPDATE ${table} SET ${levelColumn}=${level}`);
      assert.throws(
        () =>
          sql(
            database,
            `INSERT INTO ${table}(tenant_id,${parentColumn},skill_id) VALUES('${tenantA}','${parentId}','${skillB}')`,
          ),
        /foreign key constraint/,
      );
      assert.throws(
        () =>
          sql(
            database,
            `INSERT INTO ${table}(${parentColumn},skill_id) VALUES('${parentId}','${skillB}')`,
          ),
        /not-null constraint/,
      );
      assert.equal(
        sql(database, `SET ROLE dcontact_app; SELECT count(*) FROM ${table}`)
          .trim()
          .split('\n')
          .at(-1),
        '0',
      );
      assert.equal(
        sql(
          database,
          `SET ROLE dcontact_app; SET app.tenant_id='${tenantA}'; SELECT count(*) FROM ${table}`,
        )
          .trim()
          .split('\n')
          .at(-1),
        '1',
      );
      assert.equal(
        sql(
          database,
          `SET ROLE dcontact_app; SET app.tenant_id='${tenantA}'; DELETE FROM ${table} WHERE tenant_id='${tenantB}'; SELECT count(*) FROM ${table}`,
        )
          .trim()
          .split('\n')
          .at(-1),
        '1',
      );
      assert.throws(
        () =>
          sql(
            database,
            `SET ROLE dcontact_app; SET app.tenant_id='${tenantB}'; INSERT INTO ${table}(tenant_id,${parentColumn},skill_id) VALUES('${tenantA}','${parentId}','${skillA}')`,
          ),
        /row-level security policy/,
      );
    }
    assert.equal(
      sql(
        database,
        "SELECT count(*) FROM pg_class WHERE relname IN ('agent_skills','queue_skills') AND relrowsecurity AND relforcerowsecurity",
      ).trim(),
      '2',
    );
    sql(database, `INSERT INTO tenant_voice_provisioning_policies(tenant_id) VALUES('${tenantA}')`);
    assert.throws(
      () =>
        sql(
          database,
          `SET ROLE dcontact_app; SET app.tenant_id='${tenantA}'; DELETE FROM agent_skills WHERE user_id='${userA}'`,
        ),
      /VOICE_CONFIG_V1_REQUIRED/,
    );
    assert.throws(
      () =>
        sql(
          database,
          `SET ROLE dcontact_app; SET app.tenant_id='${tenantA}'; DELETE FROM queue_skills WHERE queue_id='${queueA}'`,
        ),
      /VOICE_CONFIG_V1_REQUIRED/,
    );
    sql(database, `UPDATE agent_skills SET level=4 WHERE user_id='${userA}'`);
    const adminId = randomUUID();
    const teamId = randomUUID();
    const commandId = randomUUID();
    const destinationId = randomUUID();
    sql(
      database,
      `INSERT INTO teams(id,tenant_id) VALUES('${teamId}','${tenantA}');
      INSERT INTO users(id,tenant_id,role) VALUES('${adminId}','${tenantA}','ADMIN');
      UPDATE users SET team_id='${teamId}' WHERE id='${userA}';
      UPDATE queues SET team_id='${teamId}',voice_config_version=1 WHERE id='${queueA}';
      UPDATE skills SET team_id='${teamId}',voice_config_version=1 WHERE id='${skillA}';
      INSERT INTO voice_config_commands VALUES('${tenantA}','${commandId}','${adminId}','${userA}','AGENT_SKILLS_REPLACE','CONFIG_UPDATE',1);`,
    );
    const assignmentContext = `BEGIN; SET LOCAL ROLE dcontact_app; SET LOCAL app.tenant_id='${tenantA}'; SET LOCAL app.voice_config_command='${commandId}';`;
    sql(
      database,
      `${assignmentContext} DELETE FROM agent_skills WHERE user_id='${userA}';
      INSERT INTO agent_skills(tenant_id,user_id,skill_id,level) VALUES('${tenantA}','${userA}','${skillA}',3); COMMIT;`,
    );
    sql(
      database,
      `UPDATE voice_config_commands SET expected_revision=2 WHERE command_id='${commandId}'`,
    );
    assert.throws(
      () =>
        sql(
          database,
          `${assignmentContext} UPDATE agent_skills SET level=2 WHERE user_id='${userA}'; COMMIT;`,
        ),
      /REVISION_CONFLICT/,
    );
    sql(
      database,
      `UPDATE voice_config_commands SET expected_revision=1 WHERE command_id='${commandId}';
      INSERT INTO interactions(tenant_id,agent_id,channel,state) VALUES('${tenantA}','${userA}','VOICE','WRAPUP')`,
    );
    assert.throws(
      () =>
        sql(
          database,
          `${assignmentContext} DELETE FROM agent_skills WHERE user_id='${userA}'; COMMIT;`,
        ),
      /CONFIG_BUSY/,
    );
    assert.equal(
      sql(database, `SELECT level FROM agent_skills WHERE user_id='${userA}'`).trim(),
      '3',
    );
    sql(
      database,
      `DELETE FROM interactions;
      INSERT INTO voice_destinations(id,tenant_id,queue_id,voice_config_version) VALUES('${destinationId}','${tenantA}','${queueB}',1);
      UPDATE tenant_voice_provisioning_policies SET destination_pool='[{"destinationId":"${destinationId}"}]' WHERE tenant_id='${tenantA}';
      UPDATE voice_config_commands SET resource_id='${destinationId}',action='DESTINATION_BINDING_UPDATE' WHERE command_id='${commandId}';`,
    );
    sql(
      database,
      `${assignmentContext} UPDATE voice_destinations SET queue_id='${queueA}',config_revision=2 WHERE id='${destinationId}'; COMMIT;`,
    );
    assert.equal(
      sql(
        database,
        `SELECT queue_id::text||':'||is_active::text FROM voice_destinations WHERE id='${destinationId}'`,
      ).trim(),
      `${queueA}:false`,
    );
    const ownerRole = `voice_owner_${randomUUID().replaceAll('-', '')}`;
    sql(
      database,
      `CREATE ROLE ${ownerRole} NOBYPASSRLS; GRANT USAGE ON SCHEMA public TO ${ownerRole};
      ALTER TABLE agent_skills OWNER TO ${ownerRole}; ALTER TABLE queue_skills OWNER TO ${ownerRole};`,
    );
    try {
      for (const table of ['agent_skills', 'queue_skills']) {
        assert.equal(
          sql(database, `SET ROLE ${ownerRole}; SELECT count(*) FROM ${table}`)
            .trim()
            .split('\n')
            .at(-1),
          '0',
        );
      }
    } finally {
      sql(
        database,
        `ALTER TABLE agent_skills OWNER TO ${databaseUser}; ALTER TABLE queue_skills OWNER TO ${databaseUser};
        DROP OWNED BY ${ownerRole}; DROP ROLE ${ownerRole};`,
      );
    }
  } finally {
    sql('postgres', `DROP DATABASE ${database} WITH (FORCE)`);
  }
});
