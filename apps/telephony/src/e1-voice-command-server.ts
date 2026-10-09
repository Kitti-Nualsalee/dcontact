import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { VoiceOriginateCommandPublisher } from '@d-contact/delivery';
import type { FreeSwitchCommandAdapter } from './freeswitch-command-adapter.js';

export type E1VoiceCommandInput = Parameters<VoiceOriginateCommandPublisher['publish']>[0];

export interface E1VoiceCommandAuthority {
  claim(input: E1VoiceCommandInput): Promise<boolean>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const opaque = /^[A-Za-z0-9_-]{1,128}$/;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.test(value);
}

function parseInput(value: unknown, tenantId: string, nodeId: string): E1VoiceCommandInput | null {
  if (!record(value) || Object.keys(value).sort().join(',') !== 'command,tenantId') return null;
  if (value.tenantId !== tenantId || !record(value.command)) return null;
  const command = value.command;
  if (
    command.vendor !== 'freeswitch' ||
    command.telephonyNodeId !== nodeId ||
    !matches(command.deliveryId, opaque) ||
    !matches(command.providerRequestKey, opaque)
  )
    return null;
  const common = {
    vendor: 'freeswitch' as const,
    telephonyNodeId: nodeId,
    deliveryId: command.deliveryId,
    providerRequestKey: command.providerRequestKey,
  };
  if (command.type === 'call.originate') {
    if (
      Object.keys(command).sort().join(',') !==
        'agentExtension,deliveryId,originationUuid,providerRequestKey,targetIdentityId,telephonyNodeId,type,vendor' ||
      !matches(command.originationUuid, uuid) ||
      !matches(command.targetIdentityId, uuid) ||
      !matches(command.agentExtension, /^1[0-9]{3}$/)
    )
      return null;
    return {
      tenantId,
      command: {
        ...common,
        type: 'call.originate',
        originationUuid: command.originationUuid,
        targetIdentityId: command.targetIdentityId,
        agentExtension: command.agentExtension,
      },
    };
  }
  if (command.type === 'call.cancel') {
    if (
      Object.keys(command).sort().join(',') !==
        'callUuid,deliveryId,providerRequestKey,telephonyNodeId,type,vendor' ||
      !matches(command.callUuid, uuid)
    )
      return null;
    return { tenantId, command: { ...common, type: 'call.cancel', callUuid: command.callUuid } };
  }
  return null;
}

export function createE1VoiceCommandServer(options: {
  secret: string;
  tenantId: string;
  nodeId: string;
  authority: E1VoiceCommandAuthority;
  adapter: Pick<FreeSwitchCommandAdapter, 'handle'>;
}) {
  if (!/^[a-f0-9]{64}$/.test(options.secret)) throw new Error('E1_VOICE_COMMAND_SECRET_REQUIRED');
  if (!uuid.test(options.tenantId)) throw new Error('E1_VOICE_TENANT_REQUIRED');
  const expected = Buffer.from(`Bearer ${options.secret}`);
  const server = createServer(async (request, response) => {
    const supplied = Buffer.from(request.headers.authorization ?? '');
    response.setHeader('cache-control', 'no-store');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      response.writeHead(401, { connection: 'close' }).end();
      return;
    }
    if (request.method !== 'POST' || request.url !== '/commands') {
      response.writeHead(404, { connection: 'close' }).end();
      return;
    }
    if (request.headers['content-type'] !== 'application/json') {
      response.writeHead(415, { connection: 'close' }).end();
      return;
    }
    const chunks: Buffer[] = [];
    let length = 0;
    try {
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 4096) {
          response.writeHead(413, { connection: 'close' }).end();
          return;
        }
        chunks.push(chunk);
      }
      let value: unknown;
      try {
        value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        response.writeHead(400).end();
        return;
      }
      const input = parseInput(value, options.tenantId, options.nodeId);
      if (!input) {
        response.writeHead(400).end();
        return;
      }
      if (!(await options.authority.claim(input))) {
        response.writeHead(409).end();
        return;
      }
      await options.adapter.handle(input.command, input.tenantId);
      response.writeHead(202).end();
    } catch {
      if (!response.headersSent) response.writeHead(503).end();
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  return server;
}
