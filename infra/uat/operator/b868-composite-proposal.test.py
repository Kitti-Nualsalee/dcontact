import copy
from datetime import timedelta
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest

HERE = Path(__file__).parent
def load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

proposal = load('proposal', 'b868-composite-proposal.py')
fixtures = load('candidate_tests', 'release-candidate-validate.test.py')


class ProposalTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        fixture = fixtures.CandidateTests()
        fixture.setUp()
        self.now = fixture.now
        self.obs = fixture.observation
        self.obs['runtime']['records']['current']['sourceSha'] = 'f' * 40
        self.obs['runtimeSha256'] = proposal.sha(proposal.CANDIDATE.canonical(self.obs['runtime']))
        self.package = 'SOURCE_SHA=' + 'c' * 40 + '\nAPI_IMAGE=example/image@sha256:' + 'e' * 64 + '\n'
        self.guard = {'type': 'u1.uat.readiness', 'mode': 'migration-guard', 'status': 'PASS',
                      'base': 'f' * 40, 'head': 'c' * 40, 'checks': [{'id': 'UAT-M01 check', 'status': 'PASS'}]}
        self.ci = {'schema': 'UatGithubEvidenceObservationV1', 'status': 'OBSERVED_NOT_CERTIFIED',
                   'sourceSha': 'c' * 40, 'ciConclusion': 'success', 'authorityConclusion': 'success',
                   'tenantBoundaryConclusion': 'success', 'packageConclusion': 'success'}
        self.proof = {'status': 'COPY_OWNER_ACL_STANDARD_MIGRATIONS_GENERATED_WRITER_PASS',
                      'scope': 'B714_VM2_APP_PERMISSION_COPY_ONLY', 'sourceSha': 'c' * 40,
                      'images': {'api': 'sha256:' + 'b' * 64},
                      'ledger': {'afterFinished': 154, 'rolledBackPreserved': 1,
                                 'historicalRowsByteValuesPreserved': True, 'secondDeploy': 'NOOP'},
                      'migrationManifest': {'migrations': copy.deepcopy(self.obs['ledger']['migrations'])},
                      'limitations': ['OLD_API_803_DATA_COMPATIBILITY_NOT_NEW_B2_AUTHORITY_OR_VM_ROLLBACK']}
        self.media = {'schema': 'UatMediaObservationV1', 'status': 'OBSERVED_NOT_CERTIFIED',
                      'rollbackCertified': False, 'observedAt': self.obs['observedAt'],
                      'currentRecordSha256': 'f' * 64, 'containerId': 'a' * 64,
                      'imageId': 'sha256:' + 'b' * 64, 'configSha256': 'd' * 64,
                      'sourceSha': 'e' * 40, 'sourceDigest': 'e' * 64}

    def write(self, name, value):
        path = self.root / name
        raw = value.encode() if isinstance(value, str) else json.dumps(value, sort_keys=True).encode()
        path.write_bytes(raw)
        path.chmod(0o600)
        return {'path': str(path), 'sha256': hashlib.sha256(raw).hexdigest()}

    def assemble(self):
        sources = {name: self.write(name + '.json', value) for name, value in {
            'observation': self.obs, 'package': self.package, 'migrationGuard': self.guard,
            'githubEvidence': self.ci, 'copyRehearsal': self.proof}.items()}
        base = self.write('base.json', {'schema': 'UatCompositeEvidenceManifestV1',
            'status': 'NOT_REVIEWED_NOT_RECORDABLE', 'rollbackCertified': False, 'references': sources})
        media = self.write('media.json', self.media)
        return self.write('manifest.json', {'schema': 'UatCompositeEvidenceManifestV2',
            'status': 'NOT_REVIEWED_NOT_RECORDABLE', 'rollbackCertified': False,
            'references': {'baseManifest': base, 'mediaObservation': media},
            'limitations': ['NO_REALM_RECEIPT', 'NO_VM_ROLLBACK_CERTIFICATION',
                            'PACKAGE_BINDING_API_ONLY', 'FRESH_REVALIDATION_REQUIRED']})

    def assemble_component_bound(self):
        self.assemble()
        top = json.loads((self.root / 'manifest.json').read_bytes())
        top['schema'] = 'UatCompositeEvidenceManifestV3'
        top['limitations'].remove('PACKAGE_BINDING_API_ONLY')
        top['limitations'].append('NO_BUILD_ATTESTATION')
        refs = {}
        for name, component in self.obs['runtime']['components'].items():
            raw = 'SOURCE_SHA=' + component['sourceSha'] + '\n'
            raw += ''.join(key + '=' + component['imageReference'] + '\n'
                           for key in ('API_IMAGE', 'OPS_IMAGE', 'CONSOLE_IMAGE', 'KEYCLOAK_IMAGE'))
            refs[name] = self.write(name + '-package.env', raw)
        top['references']['componentPackages'] = refs
        return self.write('component-manifest.json', top)

    def test_all_component_packages_bind_mixed_sources_without_certification(self):
        for name in ('e1-sandbox', 'proxy', 'keycloak'):
            component = self.obs['runtime']['components'][name]
            component.update(sourceSha='d' * 40, imageId='sha256:' + '1' * 64,
                             imageReference='example/legacy@sha256:' + 'd' * 64,
                             repositoryDigests=['example/legacy@sha256:' + 'd' * 64])
            self.obs['protectedRuntime']['/dcontact-uat-' + name + '-1']['image'] = component['imageId']
        self.obs['runtimeSha256'] = proposal.sha(proposal.CANDIDATE.canonical(self.obs['runtime']))
        self.obs['protectedRuntimeSha256'] = proposal.sha(proposal.CANDIDATE.canonical(self.obs['protectedRuntime']))
        ref = self.assemble_component_bound()
        result = proposal.build(ref['path'], ref['sha256'], self.root, self.now)
        self.assertEqual(result['schema'], 'UatCompositeReconciliationProposalV2')
        self.assertEqual(set(result['componentPackageBindings']), {'api', 'e1-sandbox', 'proxy', 'keycloak'})
        self.assertEqual(result['componentPackageBindings']['api']['sourceSha'], 'c' * 40)
        self.assertEqual(result['componentPackageBindings']['proxy']['sourceSha'], 'd' * 40)
        self.assertFalse(result['rollbackCertified'])
        self.assertEqual(result['status'], 'NOT_AUTHORIZED_NOT_RECORDABLE')
        self.assertIn('NO_BUILD_ATTESTATION', result['limitations'])
        self.assertNotIn('PACKAGE_BINDING_API_ONLY', result['limitations'])

    def test_wrong_component_source_or_missing_package_is_rejected(self):
        ref = self.assemble_component_bound()
        top = json.loads(Path(ref['path']).read_bytes())
        package = (self.root / 'proxy-package.env').read_text().replace('c' * 40, 'd' * 40)
        top['references']['componentPackages']['proxy'] = self.write('wrong-proxy.env', package)
        changed = self.write('wrong-source.json', top)
        with self.assertRaisesRegex(RuntimeError, 'COMPONENT_PACKAGE_MISMATCH'):
            proposal.build(changed['path'], changed['sha256'], self.root, self.now)
        del top['references']['componentPackages']['keycloak']
        changed = self.write('missing-component.json', top)
        with self.assertRaisesRegex(RuntimeError, 'COMPONENT_PACKAGES_REQUIRED'):
            proposal.build(changed['path'], changed['sha256'], self.root, self.now)

    def test_component_package_requires_all_pinned_image_entries(self):
        ref = self.assemble_component_bound()
        top = json.loads(Path(ref['path']).read_bytes())
        top['references']['componentPackages']['api'] = self.write('thin-package.env', self.package)
        changed = self.write('thin-component.json', top)
        with self.assertRaisesRegex(RuntimeError, 'COMPONENT_PACKAGE_INVALID'):
            proposal.build(changed['path'], changed['sha256'], self.root, self.now)

    def test_fifo_cannot_block_component_evidence_reader(self):
        path = self.root / 'package-fifo'
        os.mkfifo(path, 0o600)
        code = '''
import importlib.util,sys
from pathlib import Path
s=importlib.util.spec_from_file_location('proposal',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
try:
    m.read_private(Path(sys.argv[2]),Path(sys.argv[3]))
except RuntimeError:
    sys.exit(0)
sys.exit(1)
'''
        result = subprocess.run([sys.executable, '-B', '-c', code, str(HERE / 'b868-composite-proposal.py'),
                                 str(path), str(self.root)], capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)

    def observed_record_inputs(self):
        current = {'schema': 'UatDeploymentReconciliationV1', 'action': 'reconciliation',
            'sourceSha': 'f' * 40, 'rollbackEligible': False, 'recordedAt': 'historical',
            'observedAt': 'historical-observation', 'realmConfigDigest': None,
            'mediaSourceSha': self.media['sourceSha'], 'mediaSourceDigest': self.media['sourceDigest'],
            'realmConfigProvenance': {'kind': 'HISTORICAL_RENDERED_TEMPLATE_ONLY', 'realmReconciled': False},
            'images': {key: 'example/historical@sha256:' + 'f' * 64 for key in ('api', 'console', 'ops', 'keycloak')},
            'smoke': {'status': 'PASS'}, 'businessTrial': 'LIMITED_TRIAL_ONLY'}
        previous = {'schema': 'UatDeploymentRecordV1', 'sourceSha': 'a' * 40}
        current_raw, previous_raw = proposal.CANDIDATE.canonical(current), proposal.CANDIDATE.canonical(previous)
        self.obs['runtime']['records']['current']['sha256'] = proposal.sha(current_raw)
        self.media['currentRecordSha256'] = proposal.sha(current_raw)
        self.obs['runtime']['records']['previous']['sha256'] = proposal.sha(previous_raw)
        self.obs['runtimeSha256'] = proposal.sha(proposal.CANDIDATE.canonical(self.obs['runtime']))
        return current, current_raw, previous_raw

    def test_observation_record_preserves_legacy_layout_and_scopes_old_claims(self):
        current, raw, previous = self.observed_record_inputs()
        ref = self.assemble_component_bound()
        record = proposal.build_observed_record(ref['path'], ref['sha256'], raw, previous, self.root, self.now)
        for key, value in current.items():
            if key != 'recordedAt':
                self.assertEqual(record[key], value, key)
        self.assertEqual(record['components']['api']['sourceSha'], 'c' * 40)
        self.assertEqual(record['components']['api']['imageReference'], self.obs['runtime']['components']['api']['imageReference'])
        self.assertEqual(record['legacyAnchor']['sourceSha'], current['sourceSha'])
        self.assertIn('smoke', record['legacyAnchor']['fields'])
        self.assertTrue(record['observationProof']['previousPreserved'])
        self.assertEqual(record['observationProof']['previousRecordSha256'], proposal.sha(previous))
        self.assertFalse(record['observationProof']['rollbackCertified'])
        self.assertIsNone(record['realmConfigDigest'])
        self.assertEqual(record['realmConfigProvenance'], current['realmConfigProvenance'])

    def test_observation_record_rejects_pointer_drift_or_api_only_package_proof(self):
        _, raw, previous = self.observed_record_inputs()
        ref = self.assemble_component_bound()
        with self.assertRaisesRegex(RuntimeError, 'RECORD_CAS_MISMATCH'):
            proposal.build_observed_record(ref['path'], ref['sha256'], raw + b' ', previous, self.root, self.now)
        with self.assertRaisesRegex(RuntimeError, 'RECORD_CAS_MISMATCH'):
            proposal.build_observed_record(ref['path'], ref['sha256'], raw, previous + b' ', self.root, self.now)
        ref = self.assemble()
        with self.assertRaisesRegex(RuntimeError, 'ALL_COMPONENT_PACKAGES_REQUIRED'):
            proposal.build_observed_record(ref['path'], ref['sha256'], raw, previous, self.root, self.now)

    def test_proposal_does_not_authorize_record_or_rollback(self):
        ref = self.assemble()
        result = proposal.build(ref['path'], ref['sha256'], self.root, self.now)
        self.assertEqual(result['status'], 'NOT_AUTHORIZED_NOT_RECORDABLE')
        self.assertFalse(result['rollbackCertified'])
        self.assertIsNone(result['realmConfigDigest'])
        self.assertEqual(result['components']['api']['configuredImageDigest'], 'e' * 64)
        self.assertEqual(result['components']['api']['configuredReferenceSha256'], proposal.sha(('example/image@sha256:' + 'e' * 64).encode()))
        self.assertNotIn('imageReference', result['components']['api'])
        self.assertEqual(result['mediaObservation']['sourceSha'], 'e' * 40)
        self.assertEqual(result['mediaObservation']['verification'], 'UNVERIFIED_OUTSIDE_PROPOSAL')
        self.assertIn('MEDIA_SOURCE_REVALIDATION_REQUIRED', result['limitations'])

    def test_mutated_evidence_and_untrusted_manifest_hash_are_rejected(self):
        ref = self.assemble()
        with self.assertRaisesRegex(RuntimeError, 'MANIFEST_HASH_MISMATCH'):
            proposal.build(ref['path'], '0' * 64, self.root, self.now)
        (self.root / 'copyRehearsal.json').write_text('{}')
        with self.assertRaisesRegex(RuntimeError, 'EVIDENCE_HASH_MISMATCH'):
            proposal.build(ref['path'], ref['sha256'], self.root, self.now)

    def test_rejects_package_media_and_guard_mismatches(self):
        for field in ('package', 'media', 'guard'):
            with self.subTest(field=field):
                saved = copy.deepcopy(getattr(self, field))
                if field == 'package': self.package = self.package.replace('e' * 64, 'f' * 64)
                elif field == 'media': self.media['containerId'] = 'f' * 64
                else: self.guard['base'] = 'b' * 40
                ref = self.assemble()
                with self.assertRaisesRegex(RuntimeError, 'MISMATCH'):
                    proposal.build(ref['path'], ref['sha256'], self.root, self.now)
                setattr(self, field, saved)

    def test_stale_observation_and_public_evidence_are_rejected(self):
        ref = self.assemble()
        with self.assertRaisesRegex(RuntimeError, 'STALE'):
            proposal.build(ref['path'], ref['sha256'], self.root, self.now + timedelta(seconds=301))
        os.chmod(self.root / 'media.json', 0o644)
        with self.assertRaisesRegex(RuntimeError, 'PERMISSIONS'):
            proposal.build(ref['path'], ref['sha256'], self.root, self.now)

    def test_media_source_remains_unverified_even_when_structurally_valid(self):
        self.media['sourceSha'] = 'b' * 40
        self.media['sourceDigest'] = 'c' * 64
        ref = self.assemble()
        result = proposal.build(ref['path'], ref['sha256'], self.root, self.now)
        self.assertEqual(result['mediaObservation']['verification'], 'UNVERIFIED_OUTSIDE_PROPOSAL')
        self.assertNotIn('mediaSourceSha', result)
        self.assertIn('MEDIA_SOURCE_REVALIDATION_REQUIRED', result['limitations'])

    def test_proposal_drops_unreviewed_extra_component_fields(self):
        self.obs['runtime']['components']['api']['environment'] = 'PRIVATE_SECRET_SENTINEL'
        self.obs['runtimeSha256'] = proposal.sha(proposal.CANDIDATE.canonical(self.obs['runtime']))
        ref = self.assemble()
        result = proposal.build(ref['path'], ref['sha256'], self.root, self.now)
        self.assertNotIn('PRIVATE_SECRET_SENTINEL', json.dumps(result))
        self.assertNotIn('environment', result['components']['api'])


if __name__ == '__main__':
    unittest.main()
