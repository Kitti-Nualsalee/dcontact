import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sha256 } from './cxa-c1-readiness.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * #559: the REG of J2/J3/J5 does not re-spawn the acceptance of earlier phases, but checks the marker in that phase's evidence manifest
 * on the same SHA - the manifest comes from an immutable CI artifact of any run on this SHA
 * (decision 1 of #559), which `acceptance-fetch-evidence.mjs` downloads together with provenance
 *
 * `dispatch` is the command that must be run first when a marker is missing
 */
export const ACCEPTANCE_PHASES = Object.freeze({
  c1: Object.freeze({
    marker: 'J1_ACCEPTED',
    directory: 'cxa-c1',
    artifact: 'cxa-c1-evidence',
    dispatch: 'gh workflow run CI --ref main -f acceptance=s1',
  }),
  s1: Object.freeze({
    marker: 'CONTACT_GOVERNANCE_CG3_ACCEPTED',
    directory: 's1',
    artifact: 's1-evidence',
    dispatch: 'gh workflow run CI --ref main -f acceptance=s1',
  }),
  j2: Object.freeze({
    marker: 'JOURNEY_J2_ACCEPTED',
    directory: 'cxa-j2',
    artifact: 'cxa-j2-evidence',
    dispatch: 'gh workflow run CI --ref main -f acceptance=j2',
  }),
  cg4: Object.freeze({
    marker: 'CONTACT_GOVERNANCE_CG4_ACCEPTED',
    directory: 'cxa-cg4',
    artifact: 'cxa-cg4-evidence',
    dispatch: 'gh workflow run CI --ref main -f acceptance=cg4',
  }),
  j3: Object.freeze({
    marker: 'JOURNEY_J3_ACCEPTED',
    directory: 'cxa-j3',
    artifact: 'cxa-j3-evidence',
    dispatch: 'gh workflow run cxa-j3-acceptance --ref main',
  }),
});

/** The phases whose marker each acceptance REG must see on the same SHA */
export const ACCEPTANCE_DEPENDENCIES = Object.freeze({
  J2: Object.freeze(['c1', 's1']),
  // #572: CG4-REG01 checks S1 via `cxa-cg4-dependency-readiness.mjs` (J2 is not a prerequisite of CG4)
  CG4: Object.freeze(['s1']),
  J3: Object.freeze(['s1', 'j2', 'cg4']),
  J5: Object.freeze(['c1', 'j2', 'j3', 's1']),
});

export const PROVENANCE_PATH = 'acceptance-dependencies/provenance.json';

export const fileDigest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function git(arguments_) {
  const result = spawnSync('git', arguments_, { cwd: repositoryRoot, encoding: 'utf8' });
  if (result.status !== 0 || result.error) return undefined;
  return String(result.stdout).trim();
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * A countable manifest must have provenance from downloading a CI artifact on the same SHA, and the file digest must match.
 * A file without provenance (e.g. a leftover from a local run) or edited after download does not count.
 */
export function loadVerifiedManifests(artifactsRoot, phase, commitSha) {
  const { directory } = ACCEPTANCE_PHASES[phase];
  const provenance = readJson(resolve(artifactsRoot, PROVENANCE_PATH));
  const entries = Array.isArray(provenance?.entries) ? provenance.entries : [];
  const folder = resolve(artifactsRoot, directory);
  if (!existsSync(folder)) return [];
  const files = new Set(readdirSync(folder));
  return entries
    .filter((entry) => entry?.phase === phase && entry.headSha === commitSha)
    .filter((entry) => typeof entry.file === 'string' && files.has(entry.file))
    .flatMap((entry) => {
      const bytes = readFileSync(resolve(folder, entry.file));
      if (fileDigest(bytes) !== entry.sha256) return [];
      try {
        return [{ manifest: JSON.parse(bytes.toString('utf8')), source: entry }];
      } catch {
        return [];
      }
    });
}

/** Count only manifests on the same commit that are not candidates and really carry the marker for that phase */
export function phaseMarkerStatus(records, commitSha, phase) {
  const { marker, dispatch } = ACCEPTANCE_PHASES[phase];
  const accepted = records.find(
    ({ manifest }) =>
      manifest?.commitSha === commitSha &&
      manifest?.candidate !== true &&
      (manifest.markers ?? []).includes(marker),
  );
  return accepted
    ? {
        status: 'ACCEPTED_SAME_SHA',
        marker,
        // the digest sits under the `sha256` key that the PII guard knows - a long hex may look like a phone number at the end of a string
        manifest: { sha256: sha256(accepted.manifest) },
        // run id is a number: the PII guard checks only strings, and a run id may happen to look like a phone number
        sourceRunId: accepted.source ? Number(accepted.source.runId) : null,
      }
    : { status: 'ABSENT', marker, manifest: null, remediation: dispatch };
}

/**
 * the `records` override is used in tests (treated as having passed provenance) - normally loaded from `artifacts/`
 */
export function acceptanceDependencySummary(acceptance, options = {}) {
  const phases = ACCEPTANCE_DEPENDENCIES[acceptance];
  if (!phases) throw new TypeError(`unknown acceptance ${acceptance}`);
  const commitSha = options.commitSha ?? git(['rev-parse', 'HEAD']);
  const artifactsRoot = options.artifactsRoot ?? resolve(repositoryRoot, 'artifacts');
  const records = options.records ?? {};
  const result = Object.fromEntries(
    phases.map((phase) => [
      phase,
      phaseMarkerStatus(
        records[phase] ?? loadVerifiedManifests(artifactsRoot, phase, commitSha),
        commitSha,
        phase,
      ),
    ]),
  );
  const allAcceptedSameSha = Object.values(result).every(
    ({ status }) => status === 'ACCEPTED_SAME_SHA',
  );
  return {
    type: 'dependency.readiness',
    workflow: `acceptance-dependency-${acceptance.toLowerCase()}`,
    status: allAcceptedSameSha ? 'PASS' : 'FAIL',
    commitSha,
    allAcceptedSameSha,
    phases: result,
  };
}

export function missingDependencyMessage(summary) {
  const missing = Object.entries(summary.phases).filter(
    ([, value]) => value.status !== 'ACCEPTED_SAME_SHA',
  );
  return [
    `dependency marker is incomplete on ${summary.commitSha}:`,
    ...missing.map(
      ([phase, value]) => `- ${phase} (${value.marker}): run \`${value.remediation}\``,
    ),
    'and wait for it to pass before running this acceptance again',
  ].join('\n');
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  try {
    const summary = acceptanceDependencySummary(process.argv[2]);
    process.stdout.write(`ACCEPTANCE_DEPENDENCY_EVIDENCE:${JSON.stringify(summary)}\n`);
    if (!summary.allAcceptedSameSha) {
      process.stderr.write(`${missingDependencyMessage(summary)}\n`);
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
