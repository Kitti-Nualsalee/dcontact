import { PrismaClient } from '@d-contact/db';
import { CG4_ROLLOUT_STAGES, Cg4RolloutRepository, type Cg4RolloutStage } from './cg4-rollout.js';

/**
 * CG4.10 (#193): operator CLI ของ development rollout (ไม่มี provider traffic ในทุก stage)
 *
 *   pnpm cg4:rollout --tenant=<id> --status
 *   pnpm cg4:rollout --tenant=<id> --to=SHADOW_EVALUATION --scopes=<scopeKey,...> \
 *     --expected-version=<n> --operator=<ref> --evidence=<ref> --reason=<code>
 *   pnpm cg4:rollout --tenant=<id> --freeze|--unfreeze --expected-version=<n> ...
 */

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function required(name: string): string {
  const value = argument(name);
  if (!value) throw new TypeError(`ต้องระบุ --${name}=`);
  return value;
}

async function main(): Promise<void> {
  const database = new PrismaClient(
    process.env.APPLICATION_DATABASE_URL
      ? { datasources: { db: { url: process.env.APPLICATION_DATABASE_URL } } }
      : undefined,
  );
  try {
    const repository = new Cg4RolloutRepository(database);
    const tenantId = required('tenant');
    if (process.argv.includes('--status')) {
      console.log(JSON.stringify(await repository.current(tenantId), null, 2));
      return;
    }
    const base = {
      tenantId,
      expectedVersion: Number(required('expected-version')),
      actorRef: required('operator'),
      evidenceRef: required('evidence'),
      reasonCode: required('reason'),
    };
    if (process.argv.includes('--freeze') || process.argv.includes('--unfreeze')) {
      const result = await repository.setFrozen({
        ...base,
        frozen: process.argv.includes('--freeze'),
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const toStage = required('to') as Cg4RolloutStage;
    if (!CG4_ROLLOUT_STAGES.includes(toStage)) {
      throw new TypeError(`--to ต้องเป็น ${CG4_ROLLOUT_STAGES.join(' | ')}`);
    }
    const scopes = argument('scopes');
    const result = await repository.transition({
      ...base,
      toStage,
      ...(scopes ? { syntheticScopeKeys: scopes.split(',') } : {}),
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await database.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exitCode = 1;
});
