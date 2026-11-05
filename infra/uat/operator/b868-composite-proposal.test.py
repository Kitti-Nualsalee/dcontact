import copy
from datetime import timedelta
import hashlib
import importlib.util
import json
import os
from pathlib import Path
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

    def test_proposal_does_not_authorize_record_or_rollback(self):
        ref = self.assemble()
        result = proposal.build(ref['path'], ref['sha256'], self.root, self.now)
        self.assertEqual(result['status'], 'NOT_AUTHORIZED_NOT_RECORDABLE')
        self.assertFalse(result['rollbackCertified'])
        self.assertIsNone(result['realmConfigDigest'])
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
