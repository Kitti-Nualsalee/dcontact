import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  clientDrift,
  envLine,
  mergeEnvFile,
  mergeExtensionPool,
  profileChanges,
  scramVerifier,
  withPeopleProfile,
  workerDatabaseUrl,
  extensionPool,
  parseArguments,
  parseExtensions,
  peopleBinding,
  policyDiffers,
} from './tenant-voice-onboarding.mjs';

const digest = (char) => char.repeat(64);
const node = {
  telephonyNodeId: 'fs-local',
  releaseDigest: digest('a'),
  dialplanDigest: digest('b'),
};
const baseArguments = [
  '--tenant',
  'onboard977',
  '--approval-ref',
  'issue-977',
  '--operator-subject',
  'operator-1',
  '--reason',
  'prepare a new tenant',
  '--accounts',
  '20',
  '--agents',
  '10',
  '--voice-queues',
  '5',
  '--skills',
  '10',
  '--node',
  'fs-local',
  '--release-digest',
  digest('a'),
  '--dialplan-digest',
  digest('b'),
  '--extensions',
  '1100-1102',
  '--destination',
  '2000',
  '--worker-principal',
  'dcontact_people_dev',
];

test('parseExtensions accepts ranges and lists, keeps the original digit count, and rejects duplicates or malformed input', () => {
  assert.deepEqual(parseExtensions('1100-1102'), ['1100', '1101', '1102']);
  assert.deepEqual(parseExtensions('0100-0101,2000'), ['0100', '0101', '2000']);
  assert.throws(() => parseExtensions('1100-1100,1100'), /duplicates/);
  assert.throws(() => parseExtensions('110'), /4-6 digit/);
  assert.throws(() => parseExtensions('1102-1100'), /range/);
  assert.throws(() => parseExtensions('1000-10000'), /range/);
});

test('parseArguments is dry-run by default and requires all 4 caps', () => {
  const plan = parseArguments(baseArguments);
  assert.equal(plan.apply, false);
  assert.deepEqual(plan.caps, { accounts: 20, agents: 10, voiceQueues: 5, skills: 10 });
  assert.deepEqual(plan.extensions, ['1100', '1101', '1102']);
  assert.equal(parseArguments([...baseArguments, '--apply', '--env-out', '/tmp/e']).apply, true);
  const withoutSkills = baseArguments.filter(
    (_, index, all) => all[index] !== '--skills' && all[index - 1] !== '--skills',
  );
  assert.throws(() => parseArguments(withoutSkills), /--skills/);
  assert.throws(() => parseArguments([...baseArguments, '--agents', '1000001']), /0–1,000,000/);
  assert.throws(
    () => parseArguments([...baseArguments, '--release-digest', 'A'.repeat(64)]),
    /sha256/,
  );
  assert.throws(() => parseArguments([...baseArguments, '--tenant', 'Bad_Slug']), /slug/);
  assert.throws(() => parseArguments([...baseArguments, '--worker-principal', 'x";drop']), /role/);
});

test('the extension pool has all 4 keys that the API extensionPermit accepts', () => {
  const [entry] = extensionPool(['1100'], node);
  assert.deepEqual(Object.keys(entry).sort(), [
    'dialplanDigest',
    'ref',
    'releaseDigest',
    'telephonyNodeId',
  ]);
});

test('the people binding has the shape of TENANT_PEOPLE_BINDINGS_JSON and a secret env name the API accepts', () => {
  const tenantId = '3c71f624-a141-4060-a025-da026101efbf';
  const binding = peopleBinding({
    tenantId,
    issuer: 'http://127.0.0.1:8081/realms/dcontact',
    node,
    extensions: ['1100'],
  });
  assert.deepEqual(Object.keys(binding).sort(), ['clientSecretEnv', 'issuer', 'nodes', 'tenantId']);
  assert.match(binding.clientSecretEnv, /^TENANT_PEOPLE_SECRET_[A-Z0-9_]+$/);
  assert.deepEqual(Object.keys(binding.nodes[0]).sort(), [
    'dialplanDigest',
    'extensions',
    'releaseDigest',
    'telephonyNodeId',
  ]);
});

test('policyDiffers does not treat the key order that jsonb reorders as a change', () => {
  const desired = {
    sourceKind: 'PLAN_SNAPSHOT',
    sourcePlanDigest: digest('c'),
    caps: { accounts: 20, agents: 10, voiceQueues: 5, skills: 10 },
    extensionPool: extensionPool(['1100'], node),
    destinationPool: [{ destinationId: 'd1', telephonyNodeId: 'fs-local' }],
  };
  const stored = {
    sourceKind: 'PLAN_SNAPSHOT',
    sourcePlanDigest: digest('c'),
    accountsLimit: 20,
    agentsLimit: 10,
    voiceQueuesLimit: 5,
    skillsLimit: 10,
    // jsonb orders keys by length first
    extensionPool: [
      {
        ref: '1100',
        releaseDigest: digest('a'),
        dialplanDigest: digest('b'),
        telephonyNodeId: 'fs-local',
      },
    ],
    destinationPool: [{ destinationId: 'd1', telephonyNodeId: 'fs-local' }],
  };
  assert.equal(policyDiffers(stored, desired), false);
  assert.equal(policyDiffers({ ...stored, agentsLimit: 11 }, desired), true);
  assert.equal(policyDiffers({ ...stored, extensionPool: [] }, desired), true);
});

test('envLine can be read back by the shell even when the value has & and a single quote', () => {
  const value = "postgresql://u:p'w@h/db?schema=public&options=-c+role%3Dx";
  const output = execFileSync('bash', ['-c', `${envLine('X', value)}; printf %s "$X"`], {
    encoding: 'utf8',
  });
  assert.equal(output, value);
});

test('--apply requires --env-out and allows choosing only one of create/rotate', () => {
  assert.throws(() => parseArguments([...baseArguments, '--apply']), /--env-out/);
  assert.equal(parseArguments([...baseArguments, '--apply', '--env-out', '/tmp/x']).apply, true);
  assert.throws(
    () =>
      parseArguments([...baseArguments, '--create-worker-principal', '--rotate-worker-password']),
    /choose either/,
  );
});

test('mergeEnvFile keeps existing values not set this round (e.g. the worker password) and forces mode 600', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'tvo-')), 'people.env');
  writeFileSync(
    path,
    "# old\nTENANT_PEOPLE_WORKER_DATABASE_URL='postgresql://w:p@h/db'\nOTHER='1'\n",
    { mode: 0o644 },
  );
  mergeEnvFile(
    path,
    [
      ['OTHER', '2'],
      ['NEW_KEY', 'v&w'],
    ],
    '# header',
  );
  const text = readFileSync(path, 'utf8');
  assert.match(text, /TENANT_PEOPLE_WORKER_DATABASE_URL='postgresql:\/\/w:p@h\/db'/);
  assert.match(text, /^OTHER='2'$/m);
  assert.match(text, /^NEW_KEY='v&w'$/m);
  assert.equal(text.match(/OTHER=/g).length, 1);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('mergeExtensionPool does not remove existing extensions when run with a new range', () => {
  const current = extensionPool(['1100', '1101'], node);
  const merged = mergeExtensionPool(current, extensionPool(['1101', '1110'], node));
  assert.deepEqual(
    merged.map((entry) => entry.ref),
    ['1100', '1101', '1110'],
  );
});

test('withPeopleProfile keeps the existing displayName/validators and changes only the permissions', () => {
  const profile = {
    attributes: [
      {
        name: 'tenant_id',
        displayName: 'Tenant',
        validations: { length: { max: 36 } },
        permissions: { view: ['admin', 'user'], edit: ['admin'] },
      },
    ],
  };
  const names = profileChanges(profile);
  assert.ok(names.includes('tenant_id') && names.includes('dc_identity_class'));
  const next = withPeopleProfile(profile, names);
  const tenant = next.attributes.find((attribute) => attribute.name === 'tenant_id');
  assert.equal(tenant.displayName, 'Tenant');
  assert.deepEqual(tenant.validations, { length: { max: 36 } });
  assert.deepEqual(tenant.permissions, { view: ['admin'], edit: ['admin'] });
  assert.deepEqual(profileChanges(next), []);
});

test('clientDrift catches an over-enabled flow and a missing audience mapper', () => {
  const attributes = { dc_service_purpose: 'TENANT_PEOPLE_V1' };
  const narrow = {
    enabled: true,
    publicClient: false,
    serviceAccountsEnabled: true,
    standardFlowEnabled: false,
    directAccessGrantsEnabled: false,
    implicitFlowEnabled: false,
    fullScopeAllowed: false,
    attributes,
    protocolMappers: [
      {
        protocolMapper: 'oidc-audience-mapper',
        config: { 'included.custom.audience': 'dc-tenant-people', 'access.token.claim': 'true' },
      },
    ],
  };
  assert.deepEqual(clientDrift(narrow, attributes), []);
  assert.deepEqual(
    clientDrift({ ...narrow, directAccessGrantsEnabled: true, protocolMappers: [] }, attributes),
    ['directAccessGrantsEnabled', 'people-audience'],
  );
});

test('workerDatabaseUrl keeps the sslmode and existing parameters of the operator URL', () => {
  const url = new URL(
    workerDatabaseUrl(
      'postgresql://op:secret@db:5432/app?sslmode=require&schema=public',
      'worker_x',
      'pw',
    ),
  );
  assert.equal(url.username, 'worker_x');
  assert.equal(url.password, 'pw');
  assert.equal(url.searchParams.get('sslmode'), 'require');
  assert.equal(url.searchParams.get('options'), '-c role=dcontact_tenant_people_worker');
});

test('scramVerifier produces the SCRAM-SHA-256 form PostgreSQL accepts and matches the RFC 7677 test vector', () => {
  assert.match(
    scramVerifier('pw'),
    /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/,
  );
  // RFC 7677: password "pencil", salt W22ZaJ0SNY7soEsUEjb6gQ==, i=4096
  const verifier = scramVerifier('pencil', Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64'));
  assert.equal(
    verifier.split('$')[2].split(':')[1],
    'wfPLwcE6nTWhTAmQ7tl2KeoiWGPlZqQxSrmfPwDl2dU=',
  );
});

test('peopleBinding adds backchannelUrl only when specified (the shape tenant-people-composition accepts)', () => {
  const tenantId = '3c71f624-a141-4060-a025-da026101efbf';
  const binding = peopleBinding({
    tenantId,
    issuer: 'https://uat.example.test/auth/realms/dcontact',
    node,
    extensions: ['1100'],
    backchannelUrl: 'http://keycloak:8080/auth/realms/dcontact',
  });
  assert.deepEqual(Object.keys(binding).sort(), [
    'backchannelUrl',
    'clientSecretEnv',
    'issuer',
    'nodes',
    'tenantId',
  ]);
  const issuer = ['--issuer', 'https://uat.example.test/auth/realms/dcontact'];
  assert.equal(
    parseArguments([
      ...baseArguments,
      ...issuer,
      '--backchannel-url',
      'http://keycloak:8080/auth/realms/dcontact',
    ]).backchannelUrl,
    'http://keycloak:8080/auth/realms/dcontact',
  );
  assert.throws(
    () =>
      parseArguments([
        ...baseArguments,
        '--backchannel-url',
        'http://keycloak:8080/auth/realms/dcontact',
      ]),
    /--issuer/,
  );
  assert.throws(
    () =>
      parseArguments([
        ...baseArguments,
        ...issuer,
        '--backchannel-url',
        'http://keycloak:8080/realms/dcontact',
      ]),
    /backchannel/,
  );
  assert.throws(
    () =>
      parseArguments([
        ...baseArguments,
        '--issuer',
        'http://x.test/auth/realms/dcontact',
        '--backchannel-url',
        'http://keycloak:8080/auth/realms/dcontact',
      ]),
    /https/,
  );
  assert.throws(() => parseArguments([...baseArguments, '--backchannel-url']), /must have a value/);
});
