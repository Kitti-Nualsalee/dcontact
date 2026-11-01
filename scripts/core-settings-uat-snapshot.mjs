import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// ส่งเฉพาะ source ของ collector ไปอ่านบน VM2; credential อยู่ใน operator process เท่านั้น
const SCRIPT = readFileSync(new URL('./core-settings-uat-runtime.py', import.meta.url), 'utf8');

export function collectRuntimeSnapshot() {
  try {
    const value = execFileSync(
      'ssh',
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', 'osdadmin@192.168.102.112', 'python3 -'],
      { input: SCRIPT, encoding: 'utf8', timeout: 40_000, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    return { ...JSON.parse(value), observedAt: new Date().toISOString() };
  } catch {
    throw Error('RUNTIME_SNAPSHOT_UNAVAILABLE');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(`${JSON.stringify(collectRuntimeSnapshot(), null, 2)}\n`);
  } catch {
    process.stderr.write('RUNTIME_SNAPSHOT_UNAVAILABLE\n');
    process.exitCode = 1;
  }
}
