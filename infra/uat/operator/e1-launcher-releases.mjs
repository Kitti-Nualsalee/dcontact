import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const versionPattern = /^(\d+)\.\d+\.\d+$/;
const fileName = 'dphone-launcher.js';
const integrity = (content) => `sha384-${createHash('sha384').update(content).digest('base64')}`;

async function requireRegular(path, directory = false) {
  const status = await lstat(path);
  if (status.isSymbolicLink() || (directory ? !status.isDirectory() : !status.isFile()))
    throw new Error('LAUNCHER_SOURCE_INVALID');
}

export async function checkLauncherReleases(directory) {
  await requireRegular(directory, true);
  await requireRegular(join(directory, 'index.json'));
  const index = JSON.parse(await readFile(join(directory, 'index.json'), 'utf8'));
  if (!index.versions || !index.aliases || Object.keys(index.versions).length === 0)
    throw new Error('LAUNCHER_INDEX_INVALID');
  for (const [version, entry] of Object.entries(index.versions)) {
    if (!versionPattern.test(version)) throw new Error('LAUNCHER_VERSION_INVALID');
    await requireRegular(join(directory, version), true);
    const asset = join(directory, version, fileName);
    await requireRegular(asset);
    if (entry.integrity !== integrity(await readFile(asset)))
      throw new Error('LAUNCHER_INTEGRITY_MISMATCH');
  }
  for (const [alias, version] of Object.entries(index.aliases)) {
    const major = /^v(\d+)$/.exec(alias)?.[1];
    if (
      !major ||
      typeof version !== 'string' ||
      !index.versions[version] ||
      versionPattern.exec(version)?.[1] !== major
    )
      throw new Error('LAUNCHER_ALIAS_INVALID');
  }
  return index;
}

async function saveIndex(directory, index) {
  const temporary = join(directory, `.index-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(index, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
    await rename(temporary, join(directory, 'index.json'));
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

export async function importLauncherReleases(source, directory) {
  const packaged = await checkLauncherReleases(source);
  await mkdir(directory, { recursive: true, mode: 0o755 });
  await requireRegular(directory, true);
  let current;
  let exists = true;
  try {
    await lstat(join(directory, 'index.json'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    exists = false;
  }
  current = exists
    ? await checkLauncherReleases(directory)
    : { versions: {}, aliases: { ...packaged.aliases } };
  for (const [version, entry] of Object.entries(packaged.versions)) {
    if (current.versions[version] && current.versions[version].integrity !== entry.integrity)
      throw new Error('LAUNCHER_IMMUTABLE_CONFLICT');
    const versionDir = join(directory, version);
    await mkdir(versionDir, { recursive: true, mode: 0o755 });
    await requireRegular(versionDir, true);
    const asset = join(versionDir, fileName);
    const content = await readFile(join(source, version, fileName));
    try {
      await writeFile(asset, content, { flag: 'wx', mode: 0o444 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await requireRegular(asset);
      if (integrity(await readFile(asset)) !== entry.integrity)
        throw new Error('LAUNCHER_IMMUTABLE_CONFLICT');
    }
    current.versions[version] = entry;
  }
  await saveIndex(directory, current);
  await checkLauncherReleases(directory);
  return { status: 'IMPORTED', aliases: current.aliases };
}

export async function setLauncherAlias(directory, alias, version) {
  const index = await checkLauncherReleases(directory);
  if (
    alias !== 'v1' ||
    typeof version !== 'string' ||
    versionPattern.exec(version)?.[1] !== '1' ||
    !index.versions[version]
  )
    throw new Error('LAUNCHER_ALIAS_INVALID');
  const previous = index.aliases[alias] ?? null;
  index.aliases[alias] = version;
  await saveIndex(directory, index);
  return { status: 'ALIASED', alias, version, previous };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [command, alias, version] = process.argv.slice(2);
    const directory = process.env.DPHONE_LAUNCHER_RELEASES_DIR;
    if (!directory) throw new Error('LAUNCHER_DIRECTORY_REQUIRED');
    let result;
    if (command === 'import' && process.argv.length === 3) {
      const source = dirname(
        createRequire('/app/package.json').resolve('@d-contact/dphone-embed/package.json'),
      );
      result = await importLauncherReleases(join(source, 'releases'), directory);
    } else if (command === 'check' && process.argv.length === 3) {
      const index = await checkLauncherReleases(directory);
      result = { status: 'PASS', aliases: index.aliases };
    } else if (command === 'alias' && alias && version && process.argv.length === 5)
      result = await setLauncherAlias(directory, alias, version);
    else throw new Error('LAUNCHER_ARGUMENTS_INVALID');
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: 'FAIL', reason: error.message })}\n`);
    process.exitCode = 1;
  }
}
