import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

export const SPEC_PATH = 'apps/api/openapi/contact-governance-external-read.v1.json';

function operations(pathItem = {}) {
  return Object.entries(pathItem).filter(
    ([method, value]) =>
      ['get', 'post', 'put', 'patch', 'delete'].includes(method) &&
      value &&
      typeof value === 'object',
  );
}

function resolveParameter(spec, parameter) {
  if (!parameter?.$ref) return parameter;
  const match = /^#\/components\/parameters\/([^/]+)$/.exec(parameter.$ref);
  return match ? spec.components?.parameters?.[match[1]] : parameter;
}

function parameterKey(parameter) {
  return `${parameter.in}:${parameter.name}`;
}

function assertOperationCompatible(path, method, before, after, beforeSpec, afterSpec) {
  const beforeParameters = (before.parameters ?? []).map((parameter) =>
    resolveParameter(beforeSpec, parameter),
  );
  const afterParameters = (after.parameters ?? []).map((parameter) =>
    resolveParameter(afterSpec, parameter),
  );
  const currentParameters = new Map(
    afterParameters.map((parameter) => [parameterKey(parameter), parameter]),
  );
  for (const parameter of beforeParameters) {
    const current = currentParameters.get(parameterKey(parameter));
    if (!current)
      throw new TypeError(
        `${method.toUpperCase()} ${path} removed parameter ${parameterKey(parameter)}`,
      );
    if (parameter.required && !current.required) {
      throw new TypeError(`${method.toUpperCase()} ${path} made a required parameter optional`);
    }
  }
  for (const parameter of afterParameters) {
    const previous = beforeParameters.find(
      (candidate) => parameterKey(candidate) === parameterKey(parameter),
    );
    if (parameter.required && !previous) {
      throw new TypeError(
        `${method.toUpperCase()} ${path} added required parameter ${parameterKey(parameter)}`,
      );
    }
  }
  for (const status of Object.keys(before.responses ?? {})) {
    if (!(status in (after.responses ?? {}))) {
      throw new TypeError(`${method.toUpperCase()} ${path} removed response ${status}`);
    }
  }
  if (before['x-dcontact-external'] && !after['x-dcontact-external']) {
    throw new TypeError(
      `${method.toUpperCase()} ${path} withdrew external status without a major version`,
    );
  }
}

export function assertNoBreakingChanges(before, after) {
  for (const [path, beforePath] of Object.entries(before.paths ?? {})) {
    const afterPath = after.paths?.[path];
    if (!afterPath) throw new TypeError(`removed external path ${path}`);
    for (const [method, beforeOperation] of operations(beforePath)) {
      const afterOperation = afterPath[method];
      if (!afterOperation) throw new TypeError(`removed operation ${method.toUpperCase()} ${path}`);
      assertOperationCompatible(path, method, beforeOperation, afterOperation, before, after);
    }
  }
}

export async function readCurrentSpec() {
  return JSON.parse(await readFile(SPEC_PATH, 'utf8'));
}

function readBaseSpec(ref) {
  try {
    execFileSync('git', ['cat-file', '-e', `${ref}^{commit}`], { stdio: 'ignore' });
  } catch {
    throw new TypeError(`cannot read the OpenAPI base commit: ${ref}`);
  }
  try {
    return JSON.parse(execFileSync('git', ['show', `${ref}:${SPEC_PATH}`], { encoding: 'utf8' }));
  } catch {
    // the first PR that adds this API has no spec in base, so there is no compatibility surface to compare against
    return undefined;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const current = await readCurrentSpec();
  const base = process.env.CG5_EXTERNAL_OPENAPI_BASE_REF
    ? readBaseSpec(process.env.CG5_EXTERNAL_OPENAPI_BASE_REF)
    : undefined;
  if (base) assertNoBreakingChanges(base, current);
  console.log(
    `CG5 external OpenAPI contract passed${base ? ' (compared with base)' : ' (no base spec yet)'}`,
  );
}
