import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('fp', Path(__file__).with_name('b868-protected-data-fingerprint.py'))
fp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fp)


def reader(tables, scope=None):
    queries = []

    def read(sql):
        queries.append(sql)
        if 'pg_tables' in sql:
            return json.dumps({'database': 'dcontact_uat', 'principal': 'dcontact_uat_owner', 'readonly': 'on',
                               'bypassRls': True, 'tables': sorted(tables), **(scope or {})})
        return json.dumps({'readonly': 'on', 'tables': [
            {'name': name, 'rows': rows, 'digest': digest} for name, (rows, digest) in sorted(tables.items())]})
    read.queries = queries
    return read


class FingerprintTests(unittest.TestCase):
    def setUp(self):
        self.tables = {'users': (15, 'a' * 32), 'voice_config_audit': (22, 'b' * 32),
                       'agent_work_session_leases': (143, 'c' * 32), 'dl_outbox_entries': (7, 'd' * 32)}

    def test_capture_reads_every_table_in_one_statement_without_values(self):
        read = reader(self.tables)
        result = fp.capture(read)
        self.assertEqual((result['tableCount'], result['rowCount']), (4, 187))
        self.assertEqual(len(read.queries), 2)
        self.assertEqual(read.queries[1].count('FROM public."'), 4)
        self.assertNotIn(';', read.queries[1][:-1])
        self.assertFalse(result['rollbackCertified'])

    def test_capture_rejects_wrong_scope_rls_or_table_names(self):
        for scope, error in (({'principal': 'dcontact_app'}, 'LEDGER_SCOPE_REQUIRED'),
                             ({'readonly': 'off'}, 'LEDGER_SCOPE_REQUIRED'),
                             ({'bypassRls': False}, 'RLS_BYPASS_REQUIRED'),
                             ({'tables': ['users"; DROP TABLE x; --']}, 'FINGERPRINT_TABLES_INVALID'),
                             ({'tables': []}, 'FINGERPRINT_TABLES_INVALID')):
            with self.subTest(scope=scope), self.assertRaisesRegex(RuntimeError, error):
                fp.capture(reader(self.tables, scope))

    def test_compare_separates_protected_groups_from_volatile_tables(self):
        before = fp.capture(reader(self.tables))
        self.assertEqual(fp.compare(before, before)['status'], 'PROTECTED_DATA_PRESERVED')
        volatile = dict(self.tables, agent_work_session_leases=(144, 'e' * 32))
        result = fp.compare(before, fp.capture(reader(volatile)))
        self.assertEqual(result['status'], 'PROTECTED_DATA_PRESERVED')
        self.assertEqual([item['table'] for item in result['otherChanged']], ['agent_work_session_leases'])
        for name in ('users', 'voice_config_audit', 'dl_outbox_entries'):
            with self.subTest(name):
                changed = dict(self.tables, **{name: (self.tables[name][0], 'f' * 32)})
                result = fp.compare(before, fp.capture(reader(changed)))
                self.assertEqual(result['status'], 'PROTECTED_DATA_CHANGED')
                self.assertEqual(result['protectedChanged'][0]['table'], name)
        removed = {k: v for k, v in self.tables.items() if k != 'users'}
        self.assertEqual(fp.compare(before, fp.capture(reader(removed)))['status'], 'PROTECTED_DATA_CHANGED')

    def test_compare_rejects_tampered_input(self):
        before = fp.capture(reader(self.tables))
        tampered = json.loads(json.dumps(before))
        tampered['tables']['users']['rows'] = 99
        with self.assertRaisesRegex(RuntimeError, 'FINGERPRINT_INPUT_INVALID'):
            fp.compare(before, tampered)

    def test_groups_cover_issue_categories(self):
        expected = {'users': 'user', 'tenant_people_operations': 'identity', 'pf_identity_reservations': 'identity',
                    'interaction_wrapup_results': 'result', 'pf_action_history': 'history', 'interactions': 'history',
                    'dl_outbox_entries': 'outbox', 'dl_voice_audit_events': 'audit', '_prisma_migrations': 'ledger',
                    'agent_work_session_leases': None}
        self.assertEqual({name: fp.group_of(name) for name in expected}, expected)


if __name__ == '__main__':
    unittest.main()
