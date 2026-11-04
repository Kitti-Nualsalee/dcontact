"""ข้อมูลจำลองทดสอบ collector เท่านั้น ไม่ใช่หลักฐาน UAT."""
import copy
import importlib.util
import io
import json
import pathlib
import sys
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location('core_runtime', pathlib.Path(__file__).with_name('core-settings-uat-runtime.py'))
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)
BASE = '/admin/realms/dcontact'


class IdentityFixture:
    def __init__(self):
        self.rows = {
            BASE: {'realm': 'dcontact', 'browserFlow': 'uat browser password otp', 'otpPolicyDigits': 6},
            BASE + '/authentication/flows': [{'id': 'flow', 'alias': 'uat browser password otp'}],
            BASE + '/authentication/flows/uat%20browser%20password%20otp/executions': [
                {'id': 'otp', 'providerId': 'auth-otp-form', 'requirement': 'REQUIRED', 'authenticationConfig': 'otp-config'}],
            BASE + '/authentication/config/otp-config': {'id': 'otp-config', 'config': {'default.reference.value': 'otp'}},
            BASE + '/clients': [{'id': 'console'}],
            BASE + '/clients/console': {'id': 'console', 'clientId': 'dcontact-uat-console', 'authenticationFlowBindingOverrides': {}},
            BASE + '/clients/console/roles': [],
            BASE + '/clients/console/scope-mappings': {'realmMappings': [{'id': 'agent-role', 'name': 'agent'}]},
            BASE + '/client-scopes/scope/scope-mappings': {'clientMappings': {'target': {'mappings': [{'id': 'read-role', 'name': 'read'}]}}},
            BASE + '/clients/console/protocol-mappers/models': [{'id': 'mapper', 'config': {'claim.name': 'dc_user_id'}}],
            BASE + '/roles': [{'id': 'admin-role', 'name': 'admin', 'composite': True}],
            BASE + '/roles-by-id/admin-role/composites': [{'id': 'agent-role', 'name': 'agent'}],
            BASE + '/client-scopes': [{'id': 'scope', 'name': 'roles'}],
            BASE + '/client-scopes/scope': {'id': 'scope', 'name': 'roles', 'attributes': {}},
            BASE + '/components': [],
            BASE + '/client-scopes/scope/protocol-mappers/models': [{'id': 'scope-mapper', 'config': {'claim.name': 'roles'}}],
            BASE + '/organizations': [{'id': 'org', 'alias': 'dcontact-uat', 'enabled': True, 'attributes': {'dc_mfa_required': ['true']}}],
            BASE + '/authentication/required-actions': [{'alias': 'CONFIGURE_TOTP', 'enabled': True, 'defaultAction': True}],
            BASE + '/identity-provider/instances': [],
            BASE + '/users/profile': {'attributes': [{'name': 'tenant_id', 'permissions': {'edit': ['admin']}}]},
            BASE + '/keys': {'active': {'RS256': 'key-1'}, 'keys': [{'kid': 'key-1'}]},
        }
        self.requests = []

    def get(self, path):
        self.requests.append(path)
        clean = path.split('?')[0]
        if clean.startswith(BASE + '/organizations/') and clean.endswith('/identity-providers'):
            return []
        if clean.startswith(BASE + '/organizations/') and clean not in self.rows:
            key = clean.rsplit('/', 1)[1]
            return copy.deepcopy(next(row for row in self.rows[BASE + '/organizations'] if row['id'] == key))
        value = copy.deepcopy(self.rows[clean])
        if '?' in path:
            query = runtime.urllib.parse.parse_qs(path.split('?')[1])
            first, maximum = int(query['first'][0]), int(query['max'][0])
            value = value[first:first + maximum]
        return value

    def hash(self):
        return runtime.digest(runtime.identity_configuration(self.get))


class IdentityDigestTests(unittest.TestCase):
    def test_live_identity_changes_invalidate_digest(self):
        changes = [
            (BASE, lambda d: d.update(browserFlow='other-flow')),
            (BASE, lambda d: d.update(otpPolicyDigits=8)),
            (BASE + '/authentication/flows/uat%20browser%20password%20otp/executions', lambda d: d[0].update(requirement='DISABLED')),
            (BASE + '/authentication/config/otp-config', lambda d: d['config'].update({'default.reference.value': 'pwd'})),
            (BASE + '/clients/console', lambda d: d['authenticationFlowBindingOverrides'].update(browser='other-flow-id')),
            (BASE + '/clients/console/protocol-mappers/models', lambda d: d[0]['config'].update({'claim.name': 'other-user-id'})),
            (BASE + '/roles-by-id/admin-role/composites', lambda d: d.clear()),
            (BASE + '/clients/console/scope-mappings', lambda d: d['realmMappings'][0].update(name='admin', id='admin-role')),
            (BASE + '/client-scopes/scope/scope-mappings', lambda d: d['clientMappings']['target']['mappings'].clear()),
            (BASE + '/client-scopes/scope/protocol-mappers/models', lambda d: d[0]['config'].update({'claim.name': 'other-roles'})),
            (BASE + '/organizations', lambda d: d[0]['attributes'].update(dc_mfa_required=['false'])),
            (BASE + '/authentication/required-actions', lambda d: d[0].update(enabled=False)),
            (BASE + '/users/profile', lambda d: d['attributes'][0]['permissions'].update(edit=['user'])),
            (BASE + '/keys', lambda d: d['active'].update(RS256='key-2')),
            (BASE + '/components', lambda d: d.append({'id':'condition-component','config':{'enabled':['false']}})),
            (BASE + '/client-scopes/scope', lambda d: d['attributes'].update({'include.in.token.scope':'false'})),
            (BASE + '/identity-provider/instances', lambda d: d.append({'alias': 'new-broker', 'enabled': True})),
        ]
        for path, change in changes:
            with self.subTest(path=path):
                fixture = IdentityFixture()
                before = fixture.hash()
                change(fixture.rows[path])
                self.assertNotEqual(before, fixture.hash())

    def test_organization_detail_is_checked_even_when_list_is_brief(self):
        fixture = IdentityFixture()
        fixture.rows[BASE + '/organizations/org'] = fixture.rows[BASE + '/organizations'][0]
        fixture.rows[BASE + '/organizations'] = [{'id': 'org'}]
        before = fixture.hash()
        fixture.rows[BASE + '/organizations/org']['attributes']['dc_mfa_required'] = ['false']
        self.assertNotEqual(before, fixture.hash())

    def test_pagination_covers_organization_beyond_first_page(self):
        fixture = IdentityFixture()
        fixture.rows[BASE + '/organizations'] = [{'id': str(i), 'enabled': True} for i in range(101)]
        before = fixture.hash()
        fixture.rows[BASE + '/organizations'][100]['enabled'] = False
        self.assertNotEqual(before, fixture.hash())
        self.assertIn(BASE + '/organizations?first=100&max=100', fixture.requests)

    def test_collection_order_and_dictionary_order_do_not_change_digest(self):
        fixture = IdentityFixture()
        fixture.rows[BASE + '/organizations'].append({'id': 'second', 'enabled': True})
        before = fixture.hash()
        fixture.rows[BASE + '/organizations'].reverse()
        fixture.rows[BASE] = dict(reversed(list(fixture.rows[BASE].items())))
        self.assertEqual(before, fixture.hash())

    def test_role_scope_mapping_order_does_not_change_digest(self):
        fixture = IdentityFixture()
        client = fixture.rows[BASE + '/clients/console/scope-mappings']['realmMappings']
        scope = fixture.rows[BASE + '/client-scopes/scope/scope-mappings']['clientMappings']['target']['mappings']
        client.append({'id': 'other-role', 'name': 'other'})
        scope.append({'id': 'write-role', 'name': 'write'})
        before = fixture.hash()
        client.reverse()
        scope.reverse()
        self.assertEqual(before, fixture.hash())

    def test_unavailable_live_config_is_not_an_empty_valid_fingerprint(self):
        fixture = IdentityFixture()
        del fixture.rows[BASE + '/authentication/required-actions']
        with self.assertRaises(KeyError):
            fixture.hash()

    def test_reader_only_posts_token_and_gets_config_without_printing_secrets(self):
        requests = []
        def response(request, **kwargs):
            requests.append(request)
            payload = {'access_token': 'unit-test-token'} if request.get_method() == 'POST' else {'realm': 'dcontact'}
            return io.BytesIO(json.dumps(payload).encode())
        container = {'Config': {'Env': ['KC_BOOTSTRAP_ADMIN_USERNAME=test-admin', 'KC_BOOTSTRAP_ADMIN_PASSWORD=unit-test-password', 'KC_HTTP_RELATIVE_PATH=/auth']},
                     'NetworkSettings': {'Networks': {'internal': {'IPAddress': '172.18.0.2'}}}}
        output = io.StringIO()
        with patch.object(runtime.urllib.request, 'build_opener') as build, patch('sys.stdout', output):
            build.return_value.open.side_effect = response
            self.assertEqual(runtime.keycloak_reader(container)(BASE)['realm'], 'dcontact')
        self.assertEqual([r.get_method() for r in requests], ['POST', 'GET'])
        self.assertEqual(requests[0].full_url, 'http://172.18.0.2:8080/auth/realms/master/protocol/openid-connect/token')
        self.assertEqual(output.getvalue(), '')

    def test_identity_redirect_cannot_forward_admin_credential(self):
        handler = runtime.RejectIdentityRedirect()
        self.assertIsNone(handler.redirect_request(None, None, 302, 'moved', {}, 'https://outside.invalid'))

    def test_authentication_failure_propagates_instead_of_record_fallback(self):
        container = {'Config': {'Env': ['KC_BOOTSTRAP_ADMIN_USERNAME=test-admin', 'KC_BOOTSTRAP_ADMIN_PASSWORD=unit-test-password']},
                     'NetworkSettings': {'Networks': {'internal': {'IPAddress': '172.18.0.2'}}}}
        with patch.object(runtime.urllib.request, 'build_opener') as build:
            build.return_value.open.side_effect = OSError('unit-test-only')
            with self.assertRaises(OSError):
                runtime.keycloak_reader(container)

    def test_runtime_digest_uses_live_state_even_when_record_does_not_change(self):
        fixture = IdentityFixture()
        record = {'sourceSha': 'a' * 40, 'images': {k: 'repo@sha256:' + 'b' * 64 for k in ['api', 'console', 'keycloak', 'ops']}, 'realmConfigDigest': 'record-stale'}
        container = {'State': {'Running': True}, 'Config': {'Image': 'repo@sha256:' + 'b' * 64, 'Env': [], 'Labels': {'org.opencontainers.image.revision': 'a' * 40}},
                     'HostConfig': {}, 'Mounts': []}
        with patch.object(runtime.pathlib.Path, 'read_bytes', return_value=json.dumps(record).encode()), \
             patch.object(runtime.subprocess, 'check_output', return_value=json.dumps([container]).encode()), \
             patch.object(runtime, 'keycloak_reader', return_value=fixture.get):
            before = runtime.collect()
            fixture.rows[BASE]['browserFlow'] = 'new-live-flow'
            after = runtime.collect()
        self.assertEqual(before['sourceSha'], after['sourceSha'])
        self.assertEqual(before['images'], after['images'])
        self.assertEqual(before['configDigestVersion'], 2)
        self.assertNotEqual(before['identityConfigDigest'], after['identityConfigDigest'])
        self.assertNotEqual(before['configDigest'], after['configDigest'])

    def test_identity_change_during_snapshot_fails_closed(self):
        record = {'sourceSha': 'a' * 40, 'images': {k: 'repo@sha256:' + 'b' * 64 for k in ['api', 'console', 'keycloak', 'ops']}}
        container = {'State': {'Running': True}, 'Config': {'Image': 'repo@sha256:' + 'b' * 64, 'Env': [], 'Labels': {'org.opencontainers.image.revision': 'a' * 40}}, 'HostConfig': {}, 'Mounts': []}
        with patch.object(runtime.pathlib.Path, 'read_bytes', return_value=json.dumps(record).encode()), \
             patch.object(runtime.subprocess, 'check_output', return_value=json.dumps([container]).encode()), \
             patch.object(runtime, 'keycloak_reader'), \
             patch.object(runtime, 'identity_configuration', side_effect=[{'browserFlow': 'before'}, {'browserFlow': 'after'}]):
            with self.assertRaisesRegex(ValueError, 'IDENTITY_CONFIG_CHANGED_DURING_SNAPSHOT'):
                runtime.collect()


if __name__ == '__main__':
    unittest.main()
