import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * U1.9 (#506): renders the fixture pack of the UAT first slice from the committed template -> a `UatProvisionV1` input
 * that `uat-deploy.sh provision` / the `uat-provision` CLI (U1.8 #502) accepts - no dependency other than Node
 *
 * - the template (`infra/uat/fixtures/<name>.template.json`) is purely synthetic data; values bound to a deployment
 *   (tenant/team/maker/reviewer, environment, pack version, build SHA) are `__UAT_*__` placeholders
 * - the input is a copy of `infra/uat/uat-provision.example.json` that the operator filled in from the secret store:
 *   `fixturePack` is a stub `{ template, environment, packVersion }` - the ids of the tenant/team/accounts are taken from
 *   the same input (no need to fill them in twice) and `buildSha` comes from `--build-sha` = the SHA of the release being deployed
 * - a placeholder that is not filled in (anywhere in the input) = rejected, not rendered
 * - output = the original input with `fixturePack` replaced by the full manifest (stdout or `--output` with mode 600)
 * - status/error messages are a single JSON line on stderr: only codes and field names, never values from the input
 *   (the input has the real emails of the testers)
 *
 * Format checks/negative scan/full digest belong to the `uat-provision` CLI (`--check`) - not repeated here
 */

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LINE_TYPE = 'u1.uat.fixture-render';

/** Templates that can be rendered - name -> path from the repository root */
export const UAT_FIXTURE_TEMPLATES = Object.freeze({
  'uat-first-slice.v1': 'infra/uat/fixtures/uat-first-slice.v1.template.json',
});

/** placeholders of the template/example - this pattern must not remain in an input that will be provisioned */
export const UAT_PLACEHOLDER = /__UAT_[A-Z0-9_]+__/;
/** Full commit SHA (git SHA-1 or SHA-256) - a short form is not accepted because the pack digest is bound to this value */
const BUILD_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export class UatFixtureRenderError extends Error {
  constructor(code, safeParams = {}) {
    super(`uat fixture render: ${code}`);
    this.name = 'UatFixtureRenderError';
    this.code = code;
    /** field/template names only - never put a value from the input */
    this.safeParams = safeParams;
  }
}

/** path of the first string that is still a placeholder (e.g. `maker.email`), or null */
export function findUatPlaceholder(value, path = '') {
  if (typeof value === 'string') return UAT_PLACEHOLDER.test(value) ? path || '(root)' : null;
  if (!value || typeof value !== 'object') return null;
  for (const [key, entry] of Object.entries(value)) {
    const found = findUatPlaceholder(entry, path ? `${path}.${key}` : key);
    if (found) return found;
  }
  return null;
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringAt(input, path) {
  const value = path
    .split('.')
    .reduce((node, key) => (isObject(node) ? node[key] : undefined), input);
  if (typeof value !== 'string' || value.length === 0) {
    throw new UatFixtureRenderError('INPUT_INVALID', { field: path });
  }
  return value;
}

export function readUatFixtureTemplate(name, root = repositoryRoot) {
  if (!Object.hasOwn(UAT_FIXTURE_TEMPLATES, name)) {
    throw new UatFixtureRenderError('TEMPLATE_UNKNOWN', { field: 'fixturePack.template' });
  }
  try {
    return JSON.parse(readFileSync(resolve(root, UAT_FIXTURE_TEMPLATES[name]), 'utf8'));
  } catch {
    throw new UatFixtureRenderError('TEMPLATE_UNREADABLE', { template: name });
  }
}

/**
 * Replace the template placeholders one value at a time as a whole string (no concatenation) - a placeholder the template has but that is not in
 * `values`, or a value the template does not use = a bad template (fail closed)
 */
export function renderUatFixtureTemplate(template, values) {
  const used = new Set();
  const walk = (node) => {
    if (typeof node === 'string') {
      if (!UAT_PLACEHOLDER.test(node)) return node;
      if (!Object.hasOwn(values, node)) {
        throw new UatFixtureRenderError('TEMPLATE_PLACEHOLDER_UNKNOWN');
      }
      used.add(node);
      return values[node];
    }
    if (Array.isArray(node)) return node.map(walk);
    if (isObject(node))
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]));
    return node;
  };
  const rendered = walk(template);
  if (Object.keys(values).some((token) => !used.has(token))) {
    throw new UatFixtureRenderError('TEMPLATE_PLACEHOLDER_MISSING');
  }
  return rendered;
}

/** input (a filled-in copy of the example) + build SHA -> a `UatProvisionV1` input that has the full manifest */
export function renderUatProvisionInput(input, { buildSha, root = repositoryRoot } = {}) {
  if (!isObject(input) || input.schema !== 'UatProvisionV1') {
    throw new UatFixtureRenderError('INPUT_INVALID', { field: 'schema' });
  }
  const placeholder = findUatPlaceholder(input);
  if (placeholder) throw new UatFixtureRenderError('PLACEHOLDER_UNFILLED', { field: placeholder });
  if (typeof buildSha !== 'string' || !BUILD_SHA.test(buildSha)) {
    throw new UatFixtureRenderError('BUILD_SHA_INVALID', { field: '--build-sha' });
  }
  const stub = input.fixturePack;
  if (
    !isObject(stub) ||
    Object.keys(stub).sort().join(',') !== 'environment,packVersion,template'
  ) {
    throw new UatFixtureRenderError('INPUT_INVALID', { field: 'fixturePack' });
  }
  const template = readUatFixtureTemplate(stringAt(input, 'fixturePack.template'), root);
  const fixturePack = renderUatFixtureTemplate(template, {
    __UAT_ENVIRONMENT__: stringAt(input, 'fixturePack.environment'),
    __UAT_FIXTURE_PACK_VERSION__: stringAt(input, 'fixturePack.packVersion'),
    __UAT_BUILD_SHA__: buildSha,
    __UAT_TENANT_ID__: stringAt(input, 'tenant.id'),
    __UAT_OWNER_TEAM_ID__: stringAt(input, 'ownerTeam.id'),
    __UAT_MAKER_SUBJECT_ID__: stringAt(input, 'maker.dcUserId'),
    __UAT_REVIEWER_SUBJECT_ID__: stringAt(input, 'reviewer.dcUserId'),
  });
  return { ...input, fixturePack };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const name = { '--input': 'input', '--build-sha': 'buildSha', '--output': 'output' }[flag];
    const value = argv[index + 1];
    if (!name || options[name] !== undefined || value === undefined) {
      throw new UatFixtureRenderError('USAGE');
    }
    options[name] = value;
    index += 1;
  }
  if (!options.input || !options.buildSha) throw new UatFixtureRenderError('USAGE');
  return options;
}

/**
 * `node scripts/u1-uat-fixture-render.mjs --input <file|-> --build-sha <sha> [--output <file>]`
 * returns an exit code; stdout = the JSON of the rendered input (if there is no `--output`), stderr = a single status line
 */
export function runUatFixtureRenderCli(argv, io = {}) {
  const readInput = io.readInput ?? ((path) => readFileSync(path === '-' ? 0 : path, 'utf8'));
  const write = io.write ?? ((text) => process.stdout.write(text));
  const status = io.status ?? ((line) => process.stderr.write(`${line}\n`));
  try {
    const options = parseArguments(argv);
    let input;
    try {
      input = JSON.parse(readInput(options.input));
    } catch {
      throw new UatFixtureRenderError('INPUT_UNREADABLE', { field: '--input' });
    }
    const rendered = renderUatProvisionInput(input, { buildSha: options.buildSha, root: io.root });
    const text = `${JSON.stringify(rendered, null, 2)}\n`;
    if (options.output) {
      try {
        // contains real emails: create new only (never overwrite) and readable only by the owner
        writeFileSync(options.output, text, { mode: 0o600, flag: 'wx' });
      } catch {
        throw new UatFixtureRenderError('OUTPUT_NOT_WRITTEN', { field: '--output' });
      }
    } else {
      write(text);
    }
    status(
      JSON.stringify({
        type: LINE_TYPE,
        status: 'PASS',
        template: input.fixturePack.template,
        steps: String(rendered.fixturePack.steps.length),
      }),
    );
    return 0;
  } catch (error) {
    const known = error instanceof UatFixtureRenderError;
    status(
      JSON.stringify({
        type: LINE_TYPE,
        status: 'FAIL',
        code: known ? error.code : 'UNEXPECTED',
        ...(known ? error.safeParams : {}),
      }),
    );
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = runUatFixtureRenderCli(process.argv.slice(2));
}
