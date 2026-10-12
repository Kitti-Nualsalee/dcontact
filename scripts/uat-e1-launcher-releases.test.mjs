import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  checkLauncherReleases,
  importLauncherReleases,
  setLauncherAlias,
} from '../infra/uat/operator/e1-launcher-releases.mjs';

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), 'e1-launcher-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const directory = join(root, 'runtime');
  const index = { versions: {}, aliases: { v1: '1.0.1' } };
  for (const version of ['1.0.0', '1.0.1']) {
    const content = `export const version = '${version}';\n`;
    await mkdir(join(source, version), { recursive: true });
    await writeFile(join(source, version, 'dphone-launcher.js'), content);
    index.versions[version] = {
      integrity: `sha384-${createHash('sha384').update(content).digest('base64')}`,
    };
  }
  await writeFile(join(source, 'index.json'), JSON.stringify(index));
  return { root, source, directory };
}

test('runtime alias rollback ไม่แก้ pinned assets/SRI และ import ซ้ำไม่เลื่อน alias กลับเอง', async (context) => {
  const { source, directory } = await fixture(context);
  await importLauncherReleases(source, directory);
  const before = await checkLauncherReleases(directory);
  const pinned = await readFile(join(directory, '1.0.1/dphone-launcher.js'));
  assert.deepEqual(await setLauncherAlias(directory, 'v1', '1.0.0'), {
    status: 'ALIASED',
    alias: 'v1',
    version: '1.0.0',
    previous: '1.0.1',
  });
  await importLauncherReleases(source, directory);
  const after = await checkLauncherReleases(directory);
  assert.equal(after.aliases.v1, '1.0.0');
  assert.deepEqual(after.versions, before.versions);
  assert.deepEqual(await readFile(join(directory, '1.0.1/dphone-launcher.js')), pinned);
  await setLauncherAlias(directory, 'v1', '1.0.1');
  assert.equal((await checkLauncherReleases(directory)).aliases.v1, '1.0.1');
});

test('ไม่ชี้ alias ไป version ที่ไม่มี/ข้าม major/path และไม่เปลี่ยน index เมื่อปฏิเสธ', async (context) => {
  const { source, directory } = await fixture(context);
  await importLauncherReleases(source, directory);
  const before = await readFile(join(directory, 'index.json'));
  for (const [alias, version] of [
    ['v1', '1.9.9'],
    ['v1', '2.0.0'],
    ['v1', '../1.0.0'],
    ['v2', '1.0.0'],
    ['v1', ['1.0.0']],
  ])
    await assert.rejects(setLauncherAlias(directory, alias, version), /LAUNCHER_ALIAS_INVALID/);
  assert.deepEqual(await readFile(join(directory, 'index.json')), before);
});

test('index/asset ที่ถูกแก้หรือเป็น symlink ไม่ถูกใช้เพื่อเลื่อน alias', async (context) => {
  const { root, source, directory } = await fixture(context);
  await importLauncherReleases(source, directory);
  const asset = join(directory, '1.0.0/dphone-launcher.js');
  await rm(asset);
  const outside = join(root, 'outside.js');
  await writeFile(outside, 'outside');
  await symlink(outside, asset);
  await assert.rejects(setLauncherAlias(directory, 'v1', '1.0.0'), /LAUNCHER_SOURCE_INVALID/);
  await rm(asset);
  await writeFile(asset, 'changed');
  await assert.rejects(setLauncherAlias(directory, 'v1', '1.0.0'), /LAUNCHER_INTEGRITY_MISMATCH/);
});

test('source ที่ไม่มี asset ห้ามเขียน index ทับ runtime เดิม', async (context) => {
  const { source, directory } = await fixture(context);
  await importLauncherReleases(source, directory);
  const before = await readFile(join(directory, 'index.json'));
  await rm(join(source, '1.0.0/dphone-launcher.js'));
  await assert.rejects(importLauncherReleases(source, directory));
  assert.deepEqual(await readFile(join(directory, 'index.json')), before);
});

test('runtime ที่ asset หายต้อง fail closed ไม่ reset alias เป็น packaged default', async (context) => {
  const { source, directory } = await fixture(context);
  await importLauncherReleases(source, directory);
  await setLauncherAlias(directory, 'v1', '1.0.0');
  const before = await readFile(join(directory, 'index.json'));
  await rm(join(directory, '1.0.0/dphone-launcher.js'));
  await assert.rejects(importLauncherReleases(source, directory));
  assert.deepEqual(await readFile(join(directory, 'index.json')), before);
});

test('operator wiring: API mount เป็น read-only และ alias ไม่ restart API/FreeSWITCH', async () => {
  const overlay = await readFile(
    new URL('../infra/uat/docker-compose.uat.e1-launcher.yml', import.meta.url),
    'utf8',
  );
  const runner = await readFile(new URL('../infra/uat/bin/uat-deploy.sh', import.meta.url), 'utf8');
  assert.match(overlay, /DPHONE_LAUNCHER_RELEASES_DIR: \/launcher-releases/);
  assert.match(overlay, /e1-launcher-releases:\/launcher-releases:ro/);
  assert.match(overlay, /external: true\s+name: dcontact-uat_e1-launcher-releases/);
  assert.doesNotMatch(overlay, /ports:|privileged:|secrets:/);
  const commands = runner
    .split('  e1-launcher-enable|e1-launcher-status|e1-launcher-alias)')[1]
    .split('  line-status)')[0];
  assert.match(commands, /--network none --read-only --user 0:0 --cap-drop ALL/);
  assert.match(commands, /E1_LAUNCHER_REQUIRES_DEFAULT_OFF/);
  assert.match(commands, /e1-voice-control-main\.js idle/);
  assert.match(commands, /exec 8>"\$UAT_ROOT\/e1-launcher\.lock"/);
  assert.match(commands, /flock -n 8 \|\| fail 'E1_LAUNCHER_COMMAND_BUSY'/);
  assert.match(
    commands,
    /if \[\[ "\$cmd" == 'e1-launcher-enable' \]\]; then\s+: >"\$E1_LAUNCHER_FLAG"/,
  );
  assert.doesNotMatch(commands, /force-recreate.*freeswitch/);
  assert.ok(
    runner.indexOf('if is_e1_launcher "$dir"; then files+=') >
      runner.indexOf('if is_e1 "$dir"; then files+='),
  );
});
