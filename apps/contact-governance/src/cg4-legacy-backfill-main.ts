/**
 * CG4.10 (#193): operator command to backfill CG3 -> CG4 per tenant
 *
 *   pnpm --filter @d-contact/contact-governance cg4:backfill --tenant=<uuid> --operator=<opaque-ref>
 *
 * Prints the report as JSON containing only opaque ids, versions, scope keys and reason codes: no PII
 * Re-runnable: a source that was already backfilled is counted in `alreadyRecorded` and is not touched again
 */
import { PrismaClient } from '@d-contact/db';
import { Cg4LegacyBackfill } from './cg4-legacy-backfill.js';

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

const tenantId = argument('tenant');
const operatorRef = argument('operator');
if (!tenantId || !operatorRef) {
  process.stderr.write('usage: cg4:backfill --tenant=<uuid> --operator=<opaque-ref>\n');
  process.exit(2);
}

// uses the application role (RLS) like the other owner services, not the owner connection
const url = process.env.APPLICATION_DATABASE_URL ?? process.env.DATABASE_URL;
const database = new PrismaClient(url ? { datasources: { db: { url } } } : undefined);
try {
  const report = await new Cg4LegacyBackfill(database).run({ tenantId, operatorRef });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await database.$disconnect();
}
