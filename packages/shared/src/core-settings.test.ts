import test from 'node:test';
import assert from 'node:assert/strict';
import { coreOrganizationNameError, coreTimeZoneValid } from './core-settings.js';
import { coreNameFixtures, coreTimeZoneFixtures } from './core-settings-fixtures.js';
test('Core: validation fixtures ยึด UTF-16/control characters และ IANA/UTC', () => {
  for (const { value, valid } of coreNameFixtures)
    assert.equal(!coreOrganizationNameError(value.trim()), valid);
  for (const { value, valid } of coreTimeZoneFixtures)
    assert.equal(coreTimeZoneValid(value), valid);
});
