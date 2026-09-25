/**
 * D1.13 (#452): CLI ของ platform operator — `pnpm d1:shell-flag -- --tenant demo --on --reason "UAT" --actor ops@x --ack-voice-pilot`
 * ปิด: `--off` (ไม่ต้อง ack — เป็นทาง rollback) มีผลกับผู้ใช้ตอนโหลดหน้าครั้งถัดไป ไม่ต้อง deploy
 */
import { PrismaClient } from '@d-contact/db';
import { setTenantUiFlag, TenantUiFlagError } from './tenant-ui-flags.js';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const on = process.argv.includes('--on');
const off = process.argv.includes('--off');
const tenantSlug = option('tenant');
if (on === off || !tenantSlug) {
  process.stderr.write(
    'ใช้: --tenant <slug> (--on | --off) --reason "<เหตุผล>" --actor <operator> [--flag ui.shell.v2] [--ack-voice-pilot]\n',
  );
  process.exit(2);
}

const database = new PrismaClient({
  datasources: {
    db: {
      url:
        process.env.PLATFORM_DATABASE_URL ??
        'postgresql://dcontact_platform:dcontact_platform@localhost:5433/dcontact?schema=public',
    },
  },
});
try {
  const result = await setTenantUiFlag(database, {
    tenantSlug,
    flagKey: option('flag') ?? 'ui.shell.v2',
    enabled: on,
    reason: option('reason') ?? '',
    actor: option('actor') ?? process.env.PLATFORM_OPERATOR ?? '',
    voicePilotAcknowledged: process.argv.includes('--ack-voice-pilot'),
  });
  process.stdout.write(
    `${JSON.stringify({ type: 'd1.tenant-ui-flag', status: 'PASS', ...result })}\n`,
  );
} catch (error) {
  const code = error instanceof TenantUiFlagError ? error.code : String(error);
  process.stderr.write(`${JSON.stringify({ type: 'd1.tenant-ui-flag', status: 'FAIL', code })}\n`);
  process.exitCode = 1;
} finally {
  await database.$disconnect();
}
