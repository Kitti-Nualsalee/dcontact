/**
 * #868: CLI หลักฐาน identity ของ People ก่อน/หลังสลับ API บน UAT — รันใน API container เดิม
 * (`docker exec <api> node dist/tenant-people-identity-evidence-main.js`) เพื่อให้ secret อยู่ใน container
 * ไม่ใช่ส่วนของ API server; exit 0 = CONSISTENT, 2 = INCONSISTENT, 1 = configuration/DB ใช้ไม่ได้
 */
import { PrismaClient } from '@d-contact/db';
import { peopleConfiguration } from './tenant-people-composition.js';
import { collectPeopleIdentityEvidence } from './tenant-people-identity-evidence.js';

export async function runPeopleIdentityEvidenceCli(
  environment: NodeJS.ProcessEnv,
  write: (line: string) => void,
  request: typeof fetch = fetch,
  database?: PrismaClient,
): Promise<number> {
  const failures = new Map<string, number>();
  let current = '';
  const counted: typeof fetch = async (input, init) => {
    try {
      const response = await request(input, init);
      if (!response.ok) failures.set(current, (failures.get(current) ?? 0) + 1);
      return response;
    } catch (error) {
      failures.set(current, (failures.get(current) ?? 0) + 1);
      throw error;
    }
  };
  const configuration = peopleConfiguration(environment, counted);
  if (!configuration) {
    write(JSON.stringify({ status: 'NOT_CONFIGURED' }));
    return 1;
  }
  const worker =
    database ?? new PrismaClient({ datasources: { db: { url: configuration.workerUrl } } });
  try {
    const sources = configuration.bindings.map((binding) => {
      const disable = binding.identity.disablePort();
      const invitations = binding.identity.invitationPort();
      const scoped =
        <T extends unknown[], R>(call: (...args: T) => Promise<R>) =>
        (...args: T) => {
          current = binding.tenantId;
          return call(...args);
        };
      return {
        tenantId: binding.tenantId,
        issuer: binding.client.issuer,
        clientId: binding.client.clientId,
        clientSecret: binding.client.clientSecret,
        readReadiness: scoped(() => binding.identity.readReadinessEvidence()),
        readStep: scoped((claim) => binding.identity.readOutcome(claim)),
        readInvitation: scoped((attempt) => invitations.readOutcome(attempt)),
        readPreparation: scoped((attempt) => invitations.readPreparation(attempt)),
        readDisable: scoped((attempt) => disable.readOutcome(attempt)),
        requestFailures: () => failures.get(binding.tenantId) ?? 0,
        requiredReadiness: [
          ...(configuration.invitationsEnabled ? (['invitationReady'] as const) : []),
          ...(configuration.disableEnabled ? (['disableReady'] as const) : []),
        ],
      } satisfies Parameters<typeof collectPeopleIdentityEvidence>[1][number];
    });
    const evidence = await collectPeopleIdentityEvidence(worker, sources);
    write(JSON.stringify(evidence));
    return evidence.status === 'CONSISTENT' ? 0 : 2;
  } finally {
    if (!database) await worker.$disconnect();
  }
}

if (process.argv[1]?.endsWith('tenant-people-identity-evidence-main.js')) {
  void runPeopleIdentityEvidenceCli(process.env, (line) => process.stdout.write(`${line}\n`))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `${JSON.stringify({ status: 'FAILED', error: error instanceof Error ? error.message : 'UNKNOWN' })}\n`,
      );
      process.exitCode = 1;
    });
}
