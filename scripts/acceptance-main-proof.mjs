import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * ADR-032: an acceptance marker can be issued when the tested commit **is already on main** (an ancestor of
 * origin/main or the same commit); it need not be main HEAD at run time - the S1 -> J2/CG4 -> J3 -> J5 chain takes
 * several hours while main keeps receiving new commits, and the old HEAD rule made it impossible to issue a marker
 *
 * A commit that is not merged (PR/branch) fails because it is not an ancestor of origin/main
 */
export function commitOnMain(commitSha, run = spawnSync) {
  if (!/^[0-9a-f]{40}$/i.test(commitSha ?? '')) return false;
  const result = run('git', ['merge-base', '--is-ancestor', commitSha, 'origin/main'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  return result.status === 0 && !result.error;
}

/** A context with no check result (e.g. an old fixture) follows the original rule: the commit must be main HEAD */
export function contextOnMain(context) {
  return typeof context.commitOnMain === 'boolean'
    ? context.commitOnMain
    : context.commitSha === context.finalMainSha;
}
