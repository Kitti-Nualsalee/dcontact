import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { PrismaClient } from '@d-contact/db';
import { WebSocket } from 'ws';
import {
  configuredAgentSipCredentialService,
  FreeSwitchDirectoryController,
} from '../src/agent-sip-credentials.js';
import { WorkSessionLeases } from '../src/work-session.js';
import { FreeSwitchCommandAdapter } from '../../telephony/src/freeswitch-command-adapter.js';

const repositoryRoot = new URL('../../..', import.meta.url).pathname;
const owner = new PrismaClient();
const application = new PrismaClient({
  datasources: {
    db: {
      url:
        process.env.APPLICATION_DATABASE_URL ??
        'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public',
    },
  },
});
const tenantId = randomUUID();
const agentId = randomUUID();
const sipDomain = `${tenantId}.sip.test`;
const extension = '7199';
const registrations: Array<{ stop(): Promise<void> }> = [];
let serverStarted = false;

const credentials = configuredAgentSipCredentialService(application, {
  SIP_BROWSER_NODES_JSON: JSON.stringify([
    {
      telephonyNodeId: 'fs-local',
      wssUrl: 'ws://localhost:5066',
      directoryPassword: 'dcontact-xml-curl-dev-only',
    },
  ]),
});
const directory = new FreeSwitchDirectoryController(credentials);
const server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    const body = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
    void directory.directory(request, body, response).catch((error: unknown) => {
      const status =
        typeof error === 'object' && error && 'getStatus' in error
          ? Number((error as { getStatus(): number }).getStatus())
          : 500;
      response.writeHead(status, {
        'cache-control': 'no-store',
        ...(status === 401 ? { 'www-authenticate': 'Basic realm="dcontact-freeswitch"' } : {}),
      });
      response.end();
    });
  });
});
const commandAdapter = new FreeSwitchCommandAdapter(
  {
    command: async (command) => {
      fsCli(command.replace(/^api /, ''));
    },
  },
  sipDomain,
  'fs-local',
);
const pendingFlushes: Promise<void>[] = [];
const leases = new WorkSessionLeases(application, {
  sipRegistrations: {
    flush: (registration) => {
      pendingFlushes.push(
        commandAdapter.handle({
          type: 'sip.registration.flush',
          vendor: 'freeswitch',
          telephonyNodeId: registration.telephonyNodeId,
          extension: registration.extension,
          sipDomain: registration.sipDomain,
          workSessionLeaseId: registration.workSessionLeaseId,
        }),
      );
    },
  },
});

async function main(): Promise<void> {
  try {
    await owner.tenant.create({
      data: { id: tenantId, name: `E1.10 ${tenantId}`, slug: `e1-10-${tenantId}`, sipDomain },
    });
    await owner.user.create({
      data: {
        id: agentId,
        tenantId,
        email: `e1-10-${agentId}@test.local`,
        passwordHash: 'test',
        displayName: 'E1.10 Agent',
        role: 'AGENT',
        extension,
      },
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(3000, '0.0.0.0', () => {
        serverStarted = true;
        resolve();
      });
    });

    assert(fsCli('module_exists mod_xml_curl').trim() === 'true', 'mod_xml_curl is not loaded');
    assert(registrationCount() === 0, 'expected no registration before test');
    const actor = { tenantId, userId: agentId };
    const firstLease = await leases.acquire(
      actor,
      { surface: 'workspace', hostOrigin: null },
      'e1-10-real-first',
    );
    const firstCredential = await credentials.issue({
      ...actor,
      workSessionLeaseId: firstLease.leaseId,
    });
    const firstRegistration = await register(
      firstCredential.authorizationPassword,
      firstLease.leaseId,
    );
    registrations.push(firstRegistration);
    await eventually(() => registrationCount() === 1, 'first registration did not appear');

    const renewedCredential = await credentials.issue({
      ...actor,
      workSessionLeaseId: firstLease.leaseId,
    });
    assert(
      renewedCredential.authorizationPassword !== firstCredential.authorizationPassword,
      'credential renewal reused a password',
    );
    assert(registrationCount() === 1, 'credential renewal dropped the current registration');

    const secondLease = await leases.takeover(
      actor,
      { surface: 'dphone', hostOrigin: null, expectedLeaseId: firstLease.leaseId },
      'e1-10-real-takeover',
    );
    await Promise.all(pendingFlushes);
    await eventually(() => registrationCount() === 0, 'takeover did not flush registration');
    assert(
      !(await canRegister(renewedCredential.authorizationPassword, firstLease.leaseId)),
      'stale credential registered after takeover',
    );

    const currentCredential = await credentials.issue({
      ...actor,
      workSessionLeaseId: secondLease.leaseId,
    });
    const currentRegistration = await register(
      currentCredential.authorizationPassword,
      secondLease.leaseId,
    );
    registrations.push(currentRegistration);
    await eventually(() => registrationCount() === 1, 'new lease registration did not appear');

    console.log(
      JSON.stringify({
        ok: true,
        checks: {
          modXmlCurlLoaded: true,
          oneRegistrationBeforeTakeover: true,
          renewalPreservedRegistration: true,
          takeoverFlushedRegistration: true,
          staleCredentialRejected: true,
          oneRegistrationAfterTakeover: true,
        },
      }),
    );
  } finally {
    await Promise.all(registrations.map((registration) => registration.stop()));
    try {
      fsCli(`sofia profile internal flush_inbound_reg ${extension}@${sipDomain}`);
    } catch {
      // cleanup best effort
    }
    if (serverStarted) await new Promise<void>((resolve) => server.close(() => resolve()));
    await owner.agentSipCredential.deleteMany({ where: { tenantId } });
    await owner.agentWorkSessionEvent.deleteMany({ where: { tenantId } });
    await owner.agentWorkSessionLease.deleteMany({ where: { tenantId } });
    await owner.agentStateLog.deleteMany({ where: { tenantId } });
    await owner.user.deleteMany({ where: { tenantId } });
    await owner.tenant.deleteMany({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

async function register(password: string, instanceId: string): Promise<{ stop(): Promise<void> }> {
  Object.assign(globalThis, { WebSocket });
  const { Registerer, UserAgent } = await import('sip.js');
  const uri = UserAgent.makeURI(`sip:${extension}@${sipDomain}`);
  if (!uri) throw new Error('SIP URI is invalid');
  const userAgent = new UserAgent({
    uri,
    authorizationUsername: extension,
    authorizationPassword: password,
    transportOptions: { server: 'ws://127.0.0.1:5066' },
    instanceId,
    instanceIdAlwaysAdded: true,
    logBuiltinEnabled: false,
    reconnectionAttempts: 0,
  });
  const registerer = new Registerer(userAgent, {
    expires: 60,
    refreshFrequency: 80,
    instanceId,
    regId: 1,
  });
  try {
    await userAgent.start();
    await new Promise<void>((resolve, reject) => {
      void registerer
        .register({
          requestDelegate: {
            onAccept: () => resolve(),
            onReject: (response) =>
              reject(new Error(`SIP REGISTER failed with ${response.message.statusCode}`)),
          },
        })
        .catch(reject);
    });
    return {
      stop: async () => {
        await registerer.unregister().catch(() => undefined);
        await userAgent.stop();
      },
    };
  } catch (error) {
    await userAgent.stop().catch(() => undefined);
    throw error;
  }
}

async function canRegister(password: string, instanceId: string): Promise<boolean> {
  try {
    const registration = await register(password, instanceId);
    await registration.stop();
    return true;
  } catch {
    return false;
  }
}

function registrationCount(): number {
  const value = fsCli(`sofia_count_reg internal/${extension}@${sipDomain}`).trim();
  return Number(value);
}

function fsCli(command: string): string {
  return execFileSync(
    'docker',
    [
      'compose',
      '-f',
      'infra/docker/docker-compose.dev.yml',
      'exec',
      '-T',
      'freeswitch',
      'fs_cli',
      '-x',
      command,
    ],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );
}

async function eventually(check: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
