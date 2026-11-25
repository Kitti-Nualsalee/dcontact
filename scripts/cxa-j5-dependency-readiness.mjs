import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  loadVerifiedManifests,
  missingDependencyMessage,
  phaseMarkerStatus,
} from './acceptance-dependency-markers.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * J5-REG01 (#333): `JOURNEY_J5_ACCEPTED` needs the J1/J2/J3/CG3 markers on the same SHA
 * #559: the manifest comes from an immutable CI artifact of any run on this SHA (`acceptance-fetch-evidence.mjs J5`),
 * no longer from a `cxa:j3:acceptance` run nested inside J5 - an incomplete marker = the suite fails (fail-closed)
 * and the runner still blocks the J5 marker through `DEPENDENCY_MARKERS_NOT_SAME_SHA`
 *
 * the phase keys (j1/cg3) stay unchanged so J5 evidence can be compared with earlier manifests
 */
export const J5_DEPENDENCY_PHASES = Object.freeze([
  { phase: 'j1', marker: 'J1_ACCEPTED', source: 'c1' },
  { phase: 'j2', marker: 'JOURNEY_J2_ACCEPTED', source: 'j2' },
  { phase: 'j3', marker: 'JOURNEY_J3_ACCEPTED', source: 'j3' },
  { phase: 'cg3', marker: 'CONTACT_GOVERNANCE_CG3_ACCEPTED', source: 's1' },
]);

function git(arguments_) {
  const result = spawnSync('git', arguments_, { cwd: repositoryRoot, encoding: 'utf8' });
  if (result.status !== 0 || result.error) return undefined;
  return String(result.stdout).trim();
}

/** Count only manifests on the same commit that really carry the marker of that phase - a leftover file from another SHA does not count */
export function j5PhaseMarkerStatus(manifests, commitSha, marker) {
  const { source } = J5_DEPENDENCY_PHASES.find((item) => item.marker === marker);
  return phaseMarkerStatus(
    manifests.map((manifest) => ({ manifest })),
    commitSha,
    source,
  );
}

/** The `manifests` override is used in tests (treated as having passed provenance) - normally loaded from `artifacts/` */
export function cxaJ5DependencySummary(options = {}) {
  const commitSha = options.commitSha ?? git(['rev-parse', 'HEAD']);
  const artifactsRoot = options.artifactsRoot ?? resolve(repositoryRoot, 'artifacts');
  const manifests = options.manifests ?? {};
  const phases = Object.fromEntries(
    J5_DEPENDENCY_PHASES.map(({ phase, source }) => [
      phase,
      phaseMarkerStatus(
        manifests[phase]
          ? manifests[phase].map((manifest) => ({ manifest }))
          : loadVerifiedManifests(artifactsRoot, source, commitSha),
        commitSha,
        source,
      ),
    ]),
  );
  const allAcceptedSameSha = Object.values(phases).every(
    ({ status }) => status === 'ACCEPTED_SAME_SHA',
  );
  return {
    type: 'dependency.readiness',
    workflow: 'cxa-j5-dependency',
    status: allAcceptedSameSha ? 'PASS' : 'FAIL',
    commitSha,
    allAcceptedSameSha,
    phases,
  };
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  try {
    const summary = cxaJ5DependencySummary();
    process.stdout.write(`CXA_J5_DEPENDENCY_EVIDENCE:${JSON.stringify(summary)}\n`);
    if (!summary.allAcceptedSameSha) {
      process.stderr.write(`${missingDependencyMessage(summary)}\n`);
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
