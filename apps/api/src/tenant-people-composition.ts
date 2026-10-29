import { PrismaClient } from '@d-contact/db';
import { TenantPeopleKeycloak } from './tenant-people-keycloak.js';
import { TenantPeopleRuntime } from './tenant-people-runtime.js';
import type { PeopleTelephonyNode } from './tenant-people-infrastructure.js';
import type { TenantPeopleReadiness } from './tenant-people-readiness.js';
import type { PeopleDisableFlushPort } from './tenant-people-disable.js';

function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('INVALID_PEOPLE_CONFIGURATION');
  return Object.fromEntries(Object.entries(raw));
}

export function peopleConfiguration(environment: NodeJS.ProcessEnv) {
  try {
    return parsePeopleConfiguration(environment);
  } catch {
    throw new Error('INVALID_PEOPLE_CONFIGURATION');
  }
}

function parsePeopleConfiguration(environment: NodeJS.ProcessEnv) {
  const raw = environment.TENANT_PEOPLE_BINDINGS_JSON;
  const workerUrl = environment.TENANT_PEOPLE_WORKER_DATABASE_URL;
  const invitationFlag = environment.TENANT_PEOPLE_INVITATIONS_ENABLED;
  const disableFlag = environment.TENANT_PEOPLE_DISABLE_ENABLED;
  if (disableFlag !== undefined && !['true', 'false'].includes(disableFlag))
    throw new Error('INVALID_PEOPLE_CONFIGURATION');
  const disableEnabled = disableFlag === 'true';
  if (disableEnabled && (!raw || !workerUrl)) throw new Error('INVALID_PEOPLE_CONFIGURATION');
  if (invitationFlag !== undefined && !['true', 'false'].includes(invitationFlag))
    throw new Error('INVALID_PEOPLE_CONFIGURATION');
  const invitationsEnabled = invitationFlag === 'true';
  if (invitationsEnabled && (!raw || !workerUrl)) throw new Error('INVALID_PEOPLE_CONFIGURATION');
  if (!raw && !workerUrl) return null;
  if (!raw || !workerUrl) throw new Error('INVALID_PEOPLE_CONFIGURATION');
  const database = new URL(workerUrl);
  if (
    !['postgres:', 'postgresql:'].includes(database.protocol) ||
    !database.username ||
    !database.password ||
    database.searchParams.get('options') !== '-c role=dcontact_tenant_people_worker'
  )
    throw new Error('INVALID_PEOPLE_WORKER_DATABASE_CONFIGURATION');
  const bindings: unknown = JSON.parse(raw);
  const sipNodes: unknown = JSON.parse(environment.SIP_BROWSER_NODES_JSON ?? '[]');
  if (
    !Array.isArray(bindings) ||
    !bindings.length ||
    bindings.length > 100 ||
    !Array.isArray(sipNodes)
  )
    throw new Error('INVALID_PEOPLE_CONFIGURATION');
  const seen = new Set<string>();
  return {
    workerUrl,
    invitationsEnabled,
    disableEnabled,
    bindings: bindings.map((value) => {
      const entry = object(value);
      if (
        Object.keys(entry).sort().join(',') !== 'clientSecretEnv,issuer,nodes,tenantId' ||
        typeof entry.tenantId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(entry.tenantId) ||
        seen.has(entry.tenantId) ||
        typeof entry.issuer !== 'string' ||
        typeof entry.clientSecretEnv !== 'string' ||
        !/^TENANT_PEOPLE_SECRET_[A-Z0-9_]+$/.test(entry.clientSecretEnv) ||
        !environment[entry.clientSecretEnv] ||
        !Array.isArray(entry.nodes)
      )
        throw new Error('INVALID_PEOPLE_CONFIGURATION');
      seen.add(entry.tenantId);
      const nodeIds = new Set<string>();
      const nodes: PeopleTelephonyNode[] = entry.nodes.map((value) => {
        const node = object(value);
        if (
          Object.keys(node).sort().join(',') !==
            'dialplanDigest,extensions,releaseDigest,telephonyNodeId' ||
          typeof node.telephonyNodeId !== 'string' ||
          !/^[A-Za-z0-9_.-]{1,128}$/.test(node.telephonyNodeId) ||
          nodeIds.has(node.telephonyNodeId) ||
          typeof node.releaseDigest !== 'string' ||
          !/^[a-f0-9]{64}$/.test(node.releaseDigest) ||
          typeof node.dialplanDigest !== 'string' ||
          !/^[a-f0-9]{64}$/.test(node.dialplanDigest) ||
          !Array.isArray(node.extensions) ||
          !node.extensions.every((ref) => typeof ref === 'string' && /^[0-9]{4,6}$/.test(ref)) ||
          new Set(node.extensions).size !== node.extensions.length ||
          sipNodes.filter((candidate) => object(candidate).telephonyNodeId === node.telephonyNodeId)
            .length !== 1
        )
          throw new Error('INVALID_PEOPLE_NODE_CONFIGURATION');
        nodeIds.add(node.telephonyNodeId);
        return {
          telephonyNodeId: node.telephonyNodeId,
          releaseDigest: node.releaseDigest,
          dialplanDigest: node.dialplanDigest,
          extensions: node.extensions,
        };
      });
      const identity = new TenantPeopleKeycloak({
        tenantId: entry.tenantId,
        issuer: entry.issuer,
        clientId: `dcontact-tenant-people-${entry.tenantId}`,
        clientSecret: environment[entry.clientSecretEnv]!,
      });
      return { tenantId: entry.tenantId, identity, nodes };
    }),
  };
}

class OwnedPeopleRuntime extends TenantPeopleRuntime {
  constructor(
    private readonly workerDatabase: PrismaClient,
    bindings: NonNullable<ReturnType<typeof peopleConfiguration>>['bindings'],
    invitationsEnabled: boolean,
    disableEnabled: boolean,
    disableFlush?: PeopleDisableFlushPort,
  ) {
    super(
      workerDatabase,
      new Map(bindings.map((binding) => [binding.tenantId, binding.identity])),
      {
        nodes: new Map(bindings.map((binding) => [binding.tenantId, binding.nodes])),
        ...(disableEnabled
          ? {
              disables: new Map(
                bindings.map((binding) => [binding.tenantId, binding.identity.disablePort()]),
              ),
              disableFlush,
            }
          : {}),
        ...(invitationsEnabled
          ? {
              invitations: new Map(
                bindings.map((binding) => [binding.tenantId, binding.identity.invitationPort()]),
              ),
              resends: new Map(
                bindings.map((binding) => [binding.tenantId, binding.identity.invitationPort()]),
              ),
              activations: new Map(bindings.map((binding) => [binding.tenantId, binding.identity])),
            }
          : {}),
      },
    );
  }
  override async onModuleDestroy() {
    await super.onModuleDestroy();
    await this.workerDatabase.$disconnect();
  }
}

export function configuredPeopleRuntime(
  environment: NodeJS.ProcessEnv = process.env,
  disableFlush?: PeopleDisableFlushPort,
): TenantPeopleReadiness {
  const configuration = peopleConfiguration(environment);
  if (!configuration) return { isReady: async () => false, nodesForTenant: () => [] };
  if (configuration.disableEnabled && !disableFlush)
    throw new Error('PEOPLE_DISABLE_FLUSH_REQUIRED');
  const worker = new PrismaClient({ datasources: { db: { url: configuration.workerUrl } } });
  return new OwnedPeopleRuntime(
    worker,
    configuration.bindings,
    configuration.invitationsEnabled,
    configuration.disableEnabled,
    disableFlush,
  );
}
