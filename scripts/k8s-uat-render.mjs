#!/usr/bin/env node
/**
 * Render K8s UAT manifests locally. This script never contacts a cluster or applies resources.
 * Release files contain image references only; credentials stay in Kubernetes Secrets.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = join(root, 'infra/k8s/uat');
const jobs = new Set([
  'migrate',
  'object-storage-init',
  'tenant-keycloak-config',
  'platform-keycloak-config',
  'platform-catalog-seed',
  'tenant-keycloak-users',
  'tenant-provision',
  'platform-operator',
]);

function fail(message) {
  process.stderr.write(`k8s-uat-render: ${message}\n`);
  process.exitCode = 1;
}

function argumentsOf(argv) {
  const options = { template: false, check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--template' || flag === '--check') {
      options[flag.slice(2)] = true;
    } else if (
      ['--phase', '--tenant-release', '--platform-release', '--storage-class'].includes(flag) &&
      argv[index + 1]
    ) {
      options[flag.slice(2)] = argv[++index];
    } else {
      throw new Error(`invalid argument: ${flag}`);
    }
  }
  if (
    !['foundation', 'applications', 'exposure'].includes(options.phase) &&
    !(options.phase?.startsWith('job:') && jobs.has(options.phase.slice(4)))
  ) {
    throw new Error('--phase must be foundation, applications, exposure or job:<a supported name>');
  }
  if (options.template && options.check)
    throw new Error('--template and --check cannot be used together');
  return options;
}

function releaseFile(path) {
  const values = new Map();
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(\S+)$/.exec(line);
    if (!match || values.has(match[1]))
      throw new Error(`the release file is malformed or has a duplicate key: ${path}`);
    values.set(match[1], match[2]);
  }
  return values;
}

function required(map, key) {
  const value = map.get(key);
  if (!value) throw new Error(`the release file has no ${key}`);
  return value;
}

function image(map, key) {
  const value = required(map, key);
  if (!/^ghcr\.io\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${key} must be a pinned GHCR image digest`);
  }
  return value;
}

function template(phase) {
  if (phase.startsWith('job:')) {
    return readFileSync(join(base, 'jobs', `${phase.slice(4)}.yaml`), 'utf8');
  }
  // `kubectl kustomize` works only with local files; it does not read kubeconfig or the API server
  return execFileSync('kubectl', ['kustomize', join(base, phase)], { encoding: 'utf8' });
}

try {
  const options = argumentsOf(process.argv.slice(2));
  let manifest = template(options.phase);
  if (!options.template) {
    if (!options['tenant-release'] || !options['platform-release']) {
      throw new Error('--tenant-release and --platform-release must be specified');
    }
    const tenant = releaseFile(options['tenant-release']);
    const platform = releaseFile(options['platform-release']);
    const sourceSha = required(tenant, 'SOURCE_SHA');
    if (!/^[a-f0-9]{40}$/.test(sourceSha) || required(platform, 'SOURCE_SHA') !== sourceSha) {
      throw new Error('SOURCE_SHA of both releases must be the same full SHA');
    }
    const storageClass = options['storage-class'];
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(storageClass ?? '')) {
      throw new Error('--storage-class must be specified as a real StorageClass name');
    }
    const replacements = new Map([
      ['__API_IMAGE__', image(tenant, 'API_IMAGE')],
      ['__OPS_IMAGE__', image(tenant, 'OPS_IMAGE')],
      ['__CONSOLE_IMAGE__', image(tenant, 'CONSOLE_IMAGE')],
      ['__PLATFORM_API_IMAGE__', image(platform, 'PLATFORM_API_IMAGE')],
      ['__PLATFORM_CONSOLE_IMAGE__', image(platform, 'PLATFORM_CONSOLE_IMAGE')],
      ['__PLATFORM_KEYCLOAK_IMAGE__', image(platform, 'PLATFORM_KEYCLOAK_IMAGE')],
      ['REPLACE_WITH_STORAGE_CLASS', storageClass],
    ]);
    for (const [placeholder, value] of replacements) {
      manifest = manifest.replaceAll(placeholder, value);
    }
    if (/__[A-Z_]+__|REPLACE_WITH_[A-Z_]+/.test(manifest)) {
      throw new Error('there is still a placeholder in the manifest');
    }
  }
  if (options.check) {
    process.stdout.write(
      `PASS ${options.phase}: offline render, release SHA and placeholder checks passed\n`,
    );
  } else {
    process.stdout.write(manifest);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : 'unknown error');
}
