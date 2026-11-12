import importlib.util
import io
import json
from pathlib import Path
import unittest
import urllib.error

spec = importlib.util.spec_from_file_location('drain', Path(__file__).with_name('b868-people-drain-observe.py'))
drain = importlib.util.module_from_spec(spec)
spec.loader.exec_module(drain)


class Database:
    def __init__(self, tables=None, counts=None, scope=None):
        self.scope = {'database': 'dcontact_uat', 'principal': 'dcontact_uat_owner', 'readonly': 'on',
                      'bypassRls': True,
                      'tables': tables if tables is not None else [
                          {'table': 'tenant_people_disables', 'state': True, 'lease': True},
                          {'table': 'tenant_people_invitation_dispatches', 'state': False, 'lease': True},
                          {'table': 'tenant_people_operations', 'state': True, 'lease': True},
                          {'table': 'tenant_people_worker_bindings', 'state': False, 'lease': True}]}
        self.scope.update(scope or {})
        self.counts = counts if counts is not None else {
            'tenant_people_disables': ({'SUCCEEDED': 2}, 0),
            'tenant_people_invitation_dispatches': ({}, 0),
            'tenant_people_operations': ({'SUCCEEDED': 5, 'REJECTED': 1}, 0),
            'tenant_people_worker_bindings': ({}, 0)}
        self.invitations = {'readonly': 'on', 'intentsPendingDelivery': 0, 'resendsWithoutReceipt': 0,
                            'dispatchesWithoutReceipt': 0, 'ambiguitiesWithoutReceipt': 0}
        self.queries = []

    def __call__(self, sql):
        self.queries.append(sql)
        if sql == drain.TABLES_QUERY:
            return json.dumps(self.scope).encode()
        if sql == drain.INVITATION_QUERY:
            return json.dumps(self.invitations)
        return json.dumps({'readonly': 'on', 'tables': [
            {'table': name, 'states': states, 'liveLeases': leases}
            for name, (states, leases) in self.counts.items()]})


class DrainTests(unittest.TestCase):
    def test_drained_only_when_fence_armed_and_everything_terminal(self):
        database = Database()
        result = drain.observe_drain(database, True)
        self.assertEqual(result['status'], 'DRAINED')
        self.assertEqual(result['blocking'], [])
        self.assertFalse(result['rollbackCertified'])
        self.assertIn('FROM public.tenant_people_operations', database.queries[1])
        self.assertNotIn('FROM public.tenant_people_worker_bindings GROUP BY', database.queries[1])
        self.assertEqual(drain.observe_drain(Database(), False)['status'], 'FENCE_NOT_ARMED')

    def test_open_states_live_leases_and_unknown_states_block(self):
        for states, leases in [({'QUEUED': 1}, 0), ({'RUNNING': 1}, 0), ({'WAITING_EXTERNAL': 1}, 0),
                               ({'ACTION_REQUIRED': 1}, 0), ({'SOMETHING_NEW': 1}, 0), ({'SUCCEEDED': 3}, 1)]:
            with self.subTest(states=states, leases=leases):
                database = Database()
                database.counts['tenant_people_operations'] = (states, leases)
                result = drain.observe_drain(database, True)
                self.assertEqual(result['status'], 'NOT_DRAINED')
                self.assertEqual(result['blocking'][0]['table'], 'tenant_people_operations')

    def test_requires_reviewed_scope_and_rls_bypass(self):
        for key, value, code in [('principal', 'dcontact_app', 'LEDGER_SCOPE_REQUIRED'),
                                 ('readonly', 'off', 'LEDGER_SCOPE_REQUIRED'),
                                 ('database', 'other', 'LEDGER_SCOPE_REQUIRED'),
                                 ('bypassRls', False, 'RLS_BYPASS_REQUIRED')]:
            with self.subTest(key=key):
                with self.assertRaisesRegex(RuntimeError, code):
                    drain.observe_drain(Database(scope={key: value}), True)

    def test_rejects_unsafe_or_incomplete_table_lists(self):
        for tables in [[], [{'table': 'tenant_people_x; DROP TABLE y', 'state': True, 'lease': True}],
                       [{'table': 'tenant_people_disables', 'state': True, 'lease': True}],
                       [{'table': 'tenant_people_operations', 'state': 'yes', 'lease': True}]]:
            with self.subTest(tables=tables):
                with self.assertRaisesRegex(RuntimeError, 'PEOPLE_TABLES_INVALID'):
                    drain.observe_drain(Database(tables=tables), True)
        without_dispatches = [item for item in Database().scope['tables']
                              if item['table'] != 'tenant_people_invitation_dispatches']
        with self.assertRaisesRegex(RuntimeError, 'PEOPLE_TABLES_INVALID'):
            drain.observe_drain(Database(tables=without_dispatches), True)

    def test_invitations_without_receipt_block(self):
        for key in drain.INVITATION_KEYS:
            with self.subTest(key=key):
                database = Database()
                database.invitations[key] = 1
                result = drain.observe_drain(database, True)
                self.assertEqual(result['status'], 'NOT_DRAINED')
                self.assertEqual(result['blocking'], [{'invitations': {key: 1}}])
        self.assertIn("o.state='SUCCEEDED'", drain.INVITATION_QUERY)
        self.assertEqual(drain.INVITATION_QUERY.count('tenant_people_invitation_receipts'), 4)
        for broken in [{'readonly': 'off'}, {'resendsWithoutReceipt': -1}, {'extra': 0}]:
            with self.subTest(broken=broken):
                database = Database()
                database.invitations.update(broken)
                with self.assertRaisesRegex(RuntimeError, 'PEOPLE_COUNTS_INVALID'):
                    drain.observe_drain(database, True)

    def test_settled_requires_second_drained_observation(self):
        database, slept = Database(), []

        def sleep(seconds):
            slept.append(seconds)
            database.counts['tenant_people_operations'] = ({'QUEUED': 1}, 0)
        result = drain.observe_settled(database, lambda: True, 180, sleep)
        self.assertEqual(slept, [180])
        self.assertEqual(result['status'], 'NOT_DRAINED')
        self.assertEqual(result['settledSeconds'], 180)
        result = drain.observe_settled(Database(), lambda: True, 120, lambda _: None)
        self.assertEqual(result['status'], 'DRAINED')
        self.assertIn('firstObservedAt', result)
        slept.clear()
        result = drain.observe_settled(Database(), lambda: False, 180, sleep)
        self.assertEqual((result['status'], slept), ('FENCE_NOT_ARMED', []))
        for value in [0, 60, 119, 3601, '180']:
            with self.subTest(value=value), self.assertRaisesRegex(RuntimeError, 'SETTLE_SECONDS_INVALID'):
                drain.observe_settled(Database(), lambda: True, value, lambda _: None)

    def test_rejects_missing_or_malformed_counts(self):
        database = Database()
        del database.counts['tenant_people_disables']
        with self.assertRaisesRegex(RuntimeError, 'PEOPLE_COUNTS_INVALID'):
            drain.observe_drain(database, True)
        database = Database()
        database.counts['tenant_people_operations'] = ({'QUEUED': -1}, 0)
        with self.assertRaisesRegex(RuntimeError, 'PEOPLE_COUNTS_INVALID'):
            drain.observe_drain(database, True)

    def test_cli_rejects_non_numeric_settle_with_usage(self):
        self.assertEqual(drain.main(['drain', 'abc']), 64)
        self.assertEqual(drain.main(['drain', '1', '2']), 64)


class Response:
    def __init__(self, status, headers, body):
        self.status, self.headers, self.body = status, headers, body

    def read(self, _limit):
        return self.body


class ProbeTests(unittest.TestCase):
    def opener(self, status, headers, body):
        def open_(request, timeout):
            self.request = request
            if status >= 400:
                raise urllib.error.HTTPError(request.full_url, status, 'x', headers, io.BytesIO(body))
            return Response(status, headers, body)
        return open_

    def test_active_only_with_marker_and_exact_body(self):
        body = b'{"code":"CAPABILITY_NOT_READY","reason":"ADMISSION_FENCED"}'
        result = drain.probe('https://uat.example', self.opener(503, {'X-DContact-Admission-Fence': 'people'}, body))
        self.assertEqual(result['status'], 'FENCE_ACTIVE')
        self.assertEqual(self.request.get_method(), 'POST')
        self.assertIsNone(self.request.get_header('Authorization'))
        self.assertEqual(self.request.full_url, 'https://uat.example/api/v1/tenant-voice/people/users')
        for status, headers, payload in [(401, {}, b'{"code":"UNAUTHORIZED"}'),
                                         (503, {}, b'{"code":"CAPABILITY_NOT_READY"}'),
                                         (503, {'X-DContact-Admission-Fence': 'people'}, b'oops'),
                                         (403, {}, b'')]:
            with self.subTest(status=status):
                result = drain.probe('https://uat.example', self.opener(status, headers, payload))
                self.assertEqual(result['status'], 'FENCE_INACTIVE')

    def test_transport_error_is_inactive_not_raised(self):
        def broken(request, timeout):
            raise urllib.error.URLError('connection reset')
        result = drain.probe('https://uat.example', broken)
        self.assertEqual((result['status'], result['httpStatus']), ('FENCE_INACTIVE', None))

    def test_rejects_non_https_or_path_urls(self):
        for url in ['http://uat.example', 'https://uat.example/api', 'https://uat.example?x=1']:
            with self.subTest(url=url), self.assertRaisesRegex(RuntimeError, 'PROBE_URL_INVALID'):
                drain.probe(url, self.opener(503, {}, b''))


if __name__ == '__main__':
    unittest.main()
