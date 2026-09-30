import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient } from '@d-contact/db';
import { configuredAgentSipCredentialService } from './agent-sip-credentials.js';

test('dev FreeSWITCH directory credential authenticates the configured telephony node', () => {
  const service = configuredAgentSipCredentialService({} as PrismaClient, {
    SIP_BROWSER_NODES_JSON: JSON.stringify([
      { telephonyNodeId: 'fs-local', wssUrl: 'ws://localhost:5066' },
    ]),
  });

  assert.equal(
    service.authenticateDirectoryRequest(
      `Basic ${Buffer.from('fs-local:dcontact-xml-curl-dev-only').toString('base64')}`,
    ),
    'fs-local',
  );
});
