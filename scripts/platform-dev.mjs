import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * `pnpm platform:dev` — เปิด Platform Console (A1.7 #412) บนเครื่อง dev ในคำสั่งเดียว
 *
 * ต้องมี infra ก่อน: `pnpm infra:up && pnpm infra:bootstrap`
 * 1. build dependency ของ Platform API/worker (workspace packages ใช้ `dist/`)
 * 2. ตั้งค่า Keycloak ของ platform (idempotent) เพื่อเอา subject ของ dev operator ใส่ allowlist
 * 3. publish bootstrap template และ plan สำหรับทดสอบ (`a1:dev-catalog`, idempotent) — ไม่มี plan ให้เลือก
 *    ฟอร์มสร้าง tenant จะไปต่อไม่ได้
 * 4. เปิด Platform API :3019, provisioning worker และ Console :5180 พร้อมกัน — ตัวใดหยุด ปิดทั้งหมด
 *
 * `pnpm platform:otp [auditor]` พิมพ์รหัส OTP ปัจจุบันของ dev user (secret อยู่ใน keycloak-platform-setup.mjs)
 *
 * ค่า env ทุกตัว override ได้จาก shell; ใช้กับ dev เท่านั้น — production ตั้งตาม
 * `docs/platform-provisioning-rollout.md`
 */

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

export const PLATFORM_DEV_DEFAULTS = Object.freeze({
  keycloakUrl: 'http://localhost:8081',
  realm: 'dcontact',
  platformDatabaseUrl:
    'postgresql://dcontact_platform:dcontact_platform@localhost:5433/dcontact?schema=public',
  provisionerDatabaseUrl:
    'postgresql://dcontact_provisioner:dcontact_provisioner@localhost:5433/dcontact?schema=public',
  provisionerSecret: 'dcontact-provisioner-dev-secret',
  sipBaseDomain: 'sip.localhost',
  mailpitUrl: 'http://localhost:8025',
  apiPort: '3019',
  consolePort: '5180',
});

/**
 * env ของแต่ละ process — ค่าใน `env` (shell) ชนะค่า default เสมอ
 * allowlist ต้องเป็น subject UUID ของ Keycloak (ไม่ใช่อีเมล) ไม่เช่นนั้น API start ไม่ขึ้น
 */
export function platformDevEnv({ operatorSubject, env = {} }) {
  const d = PLATFORM_DEV_DEFAULTS;
  const keycloakUrl = env.KEYCLOAK_URL ?? d.keycloakUrl;
  const realm = env.KEYCLOAK_REALM ?? d.realm;
  const issuer = env.PLATFORM_OIDC_ISSUER ?? `${keycloakUrl}/realms/${realm}`;
  const apiPort = env.PLATFORM_API_PORT ?? d.apiPort;
  const consolePort = d.consolePort;
  const shared = {
    PLATFORM_DATABASE_URL: env.PLATFORM_DATABASE_URL ?? d.platformDatabaseUrl,
    PLATFORM_SIP_BASE_DOMAIN: env.PLATFORM_SIP_BASE_DOMAIN ?? d.sipBaseDomain,
    PLATFORM_PROVISIONING_ENABLED: env.PLATFORM_PROVISIONING_ENABLED ?? 'true',
    PLATFORM_OPERATOR_ALLOWLIST: env.PLATFORM_OPERATOR_ALLOWLIST ?? operatorSubject,
  };
  return {
    api: {
      ...shared,
      PLATFORM_OIDC_ISSUER: issuer,
      PLATFORM_API_PORT: apiPort,
      PLATFORM_CONSOLE_ORIGIN: env.PLATFORM_CONSOLE_ORIGIN ?? `http://localhost:${consolePort}`,
    },
    worker: {
      ...shared,
      PROVISIONER_DATABASE_URL: env.PROVISIONER_DATABASE_URL ?? d.provisionerDatabaseUrl,
      KEYCLOAK_URL: keycloakUrl,
      KEYCLOAK_REALM: realm,
      KEYCLOAK_PROVISIONER_SECRET: env.KEYCLOAK_PROVISIONER_SECRET ?? d.provisionerSecret,
      MAILPIT_URL: env.MAILPIT_URL ?? d.mailpitUrl,
    },
    console: {
      VITE_KC_ISSUER: issuer,
      VITE_KC_CLIENT_ID: 'platform-console',
      VITE_PLATFORM_API_URL: env.VITE_PLATFORM_API_URL ?? `http://localhost:${apiPort}`,
    },
  };
}

/** คำสั่งของแต่ละ process — Console ต้องอยู่ port 5180 ตรงกับ redirect URI ของ Keycloak */
export function platformDevProcesses(envs) {
  return [
    {
      name: 'api',
      command: ['pnpm', '--filter', '@d-contact/platform-api', 'dev'],
      env: envs.api,
    },
    {
      name: 'worker',
      command: ['pnpm', '--filter', '@d-contact/platform-control', 'worker'],
      env: envs.worker,
    },
    {
      name: 'console',
      command: [
        'pnpm',
        '--filter',
        '@d-contact/platform-console',
        'exec',
        'vite',
        '--host',
        'localhost',
        '--port',
        PLATFORM_DEV_DEFAULTS.consolePort,
        '--strictPort',
      ],
      env: envs.console,
    },
  ];
}

function buildDependencies() {
  process.stdout.write('[platform:dev] build dependency ของ Platform API/worker…\n');
  const result = spawnSync(
    'pnpm',
    ['exec', 'turbo', 'run', 'build', '--filter=@d-contact/platform-api^...'],
    { cwd: repositoryRoot, stdio: 'inherit' },
  );
  if (result.status !== 0) throw new Error('build dependency ไม่ผ่าน');
}

function publishDevCatalog(env) {
  process.stdout.write('[platform:dev] publish plan/template สำหรับทดสอบ…\n');
  const result = spawnSync('pnpm', ['--filter', '@d-contact/platform-control', 'dev-catalog'], {
    cwd: repositoryRoot,
    env: { ...process.env, PLATFORM_DATABASE_URL: env.PLATFORM_DATABASE_URL },
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(
      'publish dev catalog ไม่ผ่าน — ตรวจว่ารัน `pnpm infra:bootstrap` (migrate) แล้ว',
    );
  }
}

async function operatorSubject() {
  const { setupKeycloakPlatform } = await import('./keycloak-platform-setup.mjs');
  let result;
  try {
    result = await setupKeycloakPlatform();
  } catch (error) {
    throw new Error(
      `ตั้งค่า Keycloak ไม่ได้ — รัน \`pnpm infra:up && pnpm infra:bootstrap\` ก่อน (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const operator = result.users.find(({ username }) => username.startsWith('platform-operator@'));
  if (!operator) throw new Error('ไม่พบ dev platform operator ใน Keycloak');
  return operator.id;
}

function prefixLines(stream, name, target) {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    const lines = (pending + chunk).split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) target.write(`[${name}] ${line}\n`);
  });
  stream.on('end', () => {
    if (pending) target.write(`[${name}] ${pending}\n`);
  });
}

/**
 * แต่ละ process อยู่ใน process group ของตัวเอง (`detached`) แล้วปิดทั้ง group — `pnpm` ไม่ส่ง signal
 * ต่อให้ลูก (tsx watch, node worker) จึงฆ่าแค่ pid ของ pnpm ไม่พอ
 */
function signalGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    // group ปิดไปแล้ว (ESRCH)
  }
}

function runAll(processes) {
  const children = processes.map(({ name, command: [bin, ...args], env }) => {
    const child = spawn(bin, args, {
      cwd: repositoryRoot,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    prefixLines(child.stdout, name, process.stdout);
    prefixLines(child.stderr, name, process.stderr);
    return { name, child };
  });

  let stopping = false;
  const stopAll = (exitCode) => {
    if (stopping) {
      // Ctrl+C ครั้งที่สอง = บังคับปิด
      for (const { child } of children) signalGroup(child, 'SIGKILL');
      return;
    }
    stopping = true;
    process.exitCode = exitCode;
    for (const { child } of children) signalGroup(child, 'SIGTERM');
    setTimeout(() => {
      for (const { child } of children) signalGroup(child, 'SIGKILL');
    }, 5000).unref();
  };
  // `exit` ไม่รอ pipe ที่หลานยังถืออยู่ ต่างจาก `close`
  for (const { name, child } of children) {
    child.once('exit', (code, signal) => {
      if (stopping) return;
      process.stderr.write(
        `[platform:dev] ${name} หยุด (${signal ?? `code ${code}`}) — ปิดทั้งหมด\n`,
      );
      stopAll(code || 1);
    });
  }
  process.on('SIGINT', () => stopAll(0));
  process.on('SIGTERM', () => stopAll(0));
}

async function main() {
  buildDependencies();
  const subject = await operatorSubject();
  const envs = platformDevEnv({ operatorSubject: subject, env: process.env });
  publishDevCatalog(envs.api);
  process.stdout.write(
    [
      '',
      `[platform:dev] Platform Console: http://localhost:${PLATFORM_DEV_DEFAULTS.consolePort}`,
      '[platform:dev] operator: platform-operator@platform.local / platform-operator-1234',
      '[platform:dev] auditor:  platform-auditor@platform.local / platform-auditor-1234',
      '[platform:dev] OTP:      pnpm platform:otp (หรือ pnpm platform:otp auditor)',
      `[platform:dev] อีเมลเชิญ first admin: ${envs.worker.MAILPIT_URL}`,
      '',
    ].join('\n'),
  );
  runAll(platformDevProcesses(envs));
}

async function printOtp(role) {
  const [{ PLATFORM_DEV_USERS }, { totp }] = await Promise.all([
    import('./keycloak-platform-setup.mjs'),
    import('./keycloak-platform-login.mjs'),
  ]);
  const user = PLATFORM_DEV_USERS.find((candidate) => candidate.role === `platform_${role}`);
  if (!user) throw new Error(`ไม่รู้จัก role "${role}" — ใช้ operator หรือ auditor`);
  const secondsLeft = 30 - (Math.floor(Date.now() / 1000) % 30);
  process.stdout.write(
    `${user.username}: ${totp(user.totpSecret)} (ใช้ได้อีก ${secondsLeft} วินาที)\n`,
  );
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  const [mode, role = 'operator'] = process.argv.slice(2);
  (mode === 'otp' ? printOtp(role) : main()).catch((error) => {
    process.stderr.write(
      `[platform:dev] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
