import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dialerRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testFiles = readdirSync(resolve(dialerRoot, 'src'))
  .filter((file) => file.endsWith('.integration.ts'))
  .sort();
const tsxCli = resolve(dialerRoot, 'node_modules/tsx/dist/cli.mjs');
let completed = 0;

for (const testFile of testFiles) {
  process.stdout.write(`\n# Dialer integration file: ${testFile}\n`);
  const result = spawnSync(
    process.execPath,
    [tsxCli, '--test', '--test-concurrency=1', `src/${testFile}`],
    { cwd: dialerRoot, stdio: 'inherit', env: process.env },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(`\n# Dialer integration failure: ${testFile}\n`);
    process.exitCode = result.status ?? 1;
    break;
  }
  completed += 1;
}

if (process.exitCode === undefined) {
  process.stdout.write(
    `\n# Dialer integration summary: pass ${completed}/${testFiles.length} files\n`,
  );
}
