import assert from 'node:assert/strict';
import test from 'node:test';
import { coreC4IdentitySandbox } from './tenant-core-identity-sandbox.js';

test('C4 identity trial ปฏิเสธฐานร่วม remote และ owner role ก่อนสร้าง fixture', async () => {
  const names = [
    'DATABASE_URL',
    'APPLICATION_DATABASE_URL',
    'CXA_ACCEPTANCE_DATABASE_NAME',
  ] as const;
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const run = () => coreC4IdentitySandbox(() => undefined);
  try {
    delete process.env.DATABASE_URL;
    delete process.env.APPLICATION_DATABASE_URL;
    delete process.env.CXA_ACCEPTANCE_DATABASE_NAME;
    await assert.rejects(run(), /sandbox/);
    process.env.DATABASE_URL = 'postgresql://owner:pass@127.0.0.1:5432/dcontact';
    process.env.APPLICATION_DATABASE_URL = 'postgresql://app:pass@127.0.0.1:5432/dcontact';
    process.env.CXA_ACCEPTANCE_DATABASE_NAME = 'dcontact';
    await assert.rejects(run(), /sandbox/);
    process.env.DATABASE_URL = 'postgresql://owner:pass@remote.example:5432/dcontact_c4_test';
    process.env.APPLICATION_DATABASE_URL = 'postgresql://app:pass@127.0.0.1:5432/dcontact_c4_test';
    process.env.CXA_ACCEPTANCE_DATABASE_NAME = 'dcontact_c4_test';
    await assert.rejects(run(), /loopback/);
    process.env.DATABASE_URL = 'postgresql://app:pass@127.0.0.1:5432/dcontact_c4_test';
    await assert.rejects(run(), /role/);
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});
