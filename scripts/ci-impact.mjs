import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const suites = ['managed', 'core', 'people', 'voice'];
const all = () => Object.fromEntries(suites.map((suite) => [suite, true]));

export function classifyPaths(paths) {
  const affected = Object.fromEntries(suites.map((suite) => [suite, false]));
  for (const path of paths) {
    // Documentation and isolated Customer 360 test tooling do not execute these four seams.
    if (
      /^docs\//.test(path) ||
      /\.md$/.test(path) ||
      /^packages\/(ui|ui-react|i18n)\//.test(path) ||
      /^apps\/api\/src\/customer-(360|overview|activity).*\.(test|integration)\.ts$/.test(path) ||
      /^apps\/api\/scripts\/cus360-[^/]+\.(mjs|mts)$/.test(path)
    )
      continue;

    let selected;
    if (/^apps\/(console|workspace|platform-console)\//.test(path)) {
      // The People boundary installs Chromium through the Console package's toolchain.
      selected = path === 'apps/console/package.json' ? ['people'] : [];
    } else if (/^apps\/(router|telephony)\//.test(path)) {
      selected = ['managed', 'voice'];
    } else if (/^apps\/(api|journey|dialer|customer-360)\//.test(path)) {
      selected = ['core', 'people', 'voice'];
    } else {
      // Shared packages (DB/RLS, IAM, contracts, Kafka), scripts, infra, workflow,
      // lockfiles, workspace/build configuration and unknown paths are conservative.
      selected = suites;
    }
    for (const suite of selected) affected[suite] = true;
  }
  return affected;
}

export function detectImpact({ env = process.env, cwd = process.cwd() } = {}) {
  if (env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
    const enabled = ['all', 'integration'].includes(env.ACCEPTANCE);
    return {
      affected: Object.fromEntries(suites.map((suite) => [suite, enabled])),
      reason: 'manual',
    };
  }
  try {
    const base = env.BASE_SHA;
    if (!/^[a-f0-9]{40}$/i.test(base ?? '') || /^0+$/.test(base)) throw new Error('invalid-base');
    const git = (args) => {
      const result = spawnSync('git', args, {
        cwd,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      });
      if (result.error || result.status !== 0) throw new Error('unavailable-diff');
      return result.stdout;
    };
    git(['cat-file', '-e', `${base}^{commit}`]);
    git(['merge-base', '--is-ancestor', base, 'HEAD']);
    // NUL separation and disabled rename detection cover both old and new paths.
    const paths = git(['diff', '--name-only', '-z', '--no-renames', base, 'HEAD', '--'])
      .split('\0')
      .filter(Boolean);
    return { affected: classifyPaths(paths), reason: 'diff', paths };
  } catch {
    return { affected: all(), reason: 'fallback-all' };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = detectImpact();
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      suites.map((suite) => `${suite}=${result.affected[suite]}\n`).join(''),
    );
  }
  process.stdout.write(`ผลตรวจ integration impact: ${JSON.stringify(result)}\n`);
}
