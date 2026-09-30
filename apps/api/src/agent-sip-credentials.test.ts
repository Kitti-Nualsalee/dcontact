import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test from 'node:test';
import {
  FreeSwitchDirectoryController,
  type AgentSipCredentialService,
} from './agent-sip-credentials.js';

test('FreeSWITCH directory คืน XML เฉพาะ credential ที่ service ยืนยันและ escape ข้อมูลคน', async () => {
  let authorization: string | undefined;
  const service: AgentSipCredentialService = {
    issue: async () => {
      throw new Error('not used');
    },
    authenticateDirectoryRequest: (value) => {
      authorization = value;
      return 'fs-local';
    },
    directory: async (input) => ({
      ...input,
      a1Hash: '0123456789abcdef0123456789abcdef',
      displayName: 'Agent <One>',
      workSessionLeaseId: 'ca6103cd-23d1-4efb-9df9-7e9d984e6eb4',
    }),
  };
  const controller = new FreeSwitchDirectoryController(service);
  let status = 0;
  let body = '';
  const response = {
    writeHead: (nextStatus: number) => {
      status = nextStatus;
      return response;
    },
    end: (value: string) => {
      body = value;
      return response;
    },
  } as unknown as ServerResponse;

  await controller.directory(
    { headers: { authorization: 'Basic credential' } } as IncomingMessage,
    { section: 'directory', user: '1000', domain: 'tenant.voice.test' },
    response,
  );

  assert.equal(authorization, 'Basic credential');
  assert.equal(status, 200);
  assert.match(body, /<domain name="tenant\.voice\.test">/);
  assert.match(body, /<param name="a1-hash" value="0123456789abcdef0123456789abcdef"\/>/);
  assert.match(body, /Agent &lt;One&gt;/);
  assert.doesNotMatch(body, /Agent <One>/);
});

test('FreeSWITCH directory คืน not found document เมื่อ lookup ไม่ใช่ directory', async () => {
  const service: AgentSipCredentialService = {
    issue: async () => {
      throw new Error('not used');
    },
    authenticateDirectoryRequest: () => 'fs-local',
    directory: async () => {
      throw new Error('must not query');
    },
  };
  const controller = new FreeSwitchDirectoryController(service);
  let body = '';
  const response = {
    writeHead: () => response,
    end: (value: string) => {
      body = value;
      return response;
    },
  } as unknown as ServerResponse;

  await controller.directory(
    { headers: { authorization: 'Basic credential' } } as IncomingMessage,
    { section: 'dialplan', user: '1000', domain: 'tenant.voice.test' },
    response,
  );

  assert.match(body, /<result status="not found"\/>/);
});
