import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CG3_MARKER,
  LINE_MARKER,
  S1_FLAGS,
  S1_READINESS_CHECKS,
  assertValidS1Manifest,
  createS1Manifest,
  runS1Readiness,
  s1Summary,
} from './s1-readiness.mjs';

const context = {
  repository: 'Kitti-Nualsalee/dcontact',
  commitSha: 'a'.repeat(40),
  mainSha: 'a'.repeat(40),
  expectedCommitSha: 'a'.repeat(40),
  finalMain: true,
  runId: 'test',
  attempt: 1,
};
const passing = (check) => ({ checkId: check.id, status: 'PASS', durationMs: 1 });

test('the S1 registry has 20 checks covering every acceptance dimension', () => {
  assert.equal(S1_READINESS_CHECKS.length, 20);
  assert.deepEqual([...new Set(S1_READINESS_CHECKS.map((item) => item.id))].length, 20);
  assert.ok(S1_READINESS_CHECKS.some((item) => item.id === 'S1-PC-UX01'));
  assert.ok(S1_READINESS_CHECKS.some((item) => item.id === 'S1-LINE-SIM03'));
  assert.deepEqual(
    S1_READINESS_CHECKS.find((item) => item.id === 'S1-REG-01')?.commands.map((command) =>
      command.slice(1).join(' '),
    ),
    ['build', 'typecheck', 'lint', 'cxa:e0:acceptance', 'cxa:c1:acceptance', 'voice:acceptance'],
  );
});

test('the marker can be issued only when all 20 checks pass on a single final main SHA', () => {
  const result = runS1Readiness({
    context,
    executeCheck: passing,
    emit: () => undefined,
    writeManifest: false,
  });
  assert.equal(result.summary.status, 'PASS');
  assert.deepEqual(result.summary.markers.sort(), [CG3_MARKER, LINE_MARKER].sort());
  assert.deepEqual(result.manifest.flags, S1_FLAGS);
  assert.doesNotThrow(() => assertValidS1Manifest(result.manifest));
});

test('a PR SHA or a failed check must not issue the marker', () => {
  const diagnostics = S1_READINESS_CHECKS.map((item) => ({
    id: item.id,
    dimension: item.dimension,
    status: 'PASS',
    boundaries: [],
    durationMs: 1,
  }));
  assert.deepEqual(s1Summary({ ...context, finalMain: false }, diagnostics).markers, []);
  const failed = diagnostics.map((item) =>
    item.id === 'S1-CG3-F01' ? { ...item, status: 'FAIL' } : item,
  );
  assert.deepEqual(s1Summary(context, failed).markers, []);
});

test('a failed subcheck keeps a sanitized diagnostic in the manifest', () => {
  const result = runS1Readiness({
    context,
    executeCheck: (check) => {
      if (check.id === 'S1-REG-01' && check.command.at(-1) === 'lint') {
        return {
          checkId: check.id,
          status: 'FAIL',
          durationMs: 2,
          detail: 'Formatting check failed in a tracked source file.',
          remediation: 'Run pnpm lint and format the reported source file.',
        };
      }
      return passing(check);
    },
    emit: () => undefined,
    writeManifest: false,
  });
  const regression = result.manifest.checks.find((check) => check.id === 'S1-REG-01');
  const lint = regression.subchecks.find((check) => check.command.at(-1) === 'lint');
  assert.equal(lint.status, 'FAIL');
  assert.equal(lint.detail, 'Formatting check failed in a tracked source file.');
  assert.equal(lint.remediation, 'Run pnpm lint and format the reported source file.');
  assert.deepEqual(result.summary.markers, []);
  assert.doesNotThrow(() => assertValidS1Manifest(result.manifest));
});

test('the manifest rejects unsafe flags, SHA, artifacts or check count', () => {
  const diagnostics = S1_READINESS_CHECKS.map((item) => ({
    id: item.id,
    dimension: item.dimension,
    status: 'PASS',
    boundaries: [],
    durationMs: 1,
  }));
  const manifest = createS1Manifest(context, diagnostics, s1Summary(context, diagnostics));
  const unsafe = structuredClone(manifest);
  unsafe.flags.actualProviderTraffic = true;
  assert.throws(() => assertValidS1Manifest(unsafe), /flags/);
  const malformedSha = structuredClone(manifest);
  malformedSha.commitSha = 'not-a-sha';
  assert.throws(() => assertValidS1Manifest(malformedSha), /SHA/);
  const missing = structuredClone(manifest);
  missing.checks.pop();
  assert.throws(() => assertValidS1Manifest(missing), /20 checks/);
  const incompleteArtifacts = structuredClone(manifest);
  incompleteArtifacts.artifacts.pop();
  assert.throws(() => assertValidS1Manifest(incompleteArtifacts), /artifact/);
});
