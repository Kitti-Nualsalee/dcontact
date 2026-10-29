import importlib.util
import fcntl
import json
from pathlib import Path
import shlex
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import call, patch


spec = importlib.util.spec_from_file_location('e1_media', Path(__file__).with_name('vm2-e1-media-uat.py'))
media = importlib.util.module_from_spec(spec)
spec.loader.exec_module(media)
CURRENT = {'sourceSha': 'a' * 40, 'containerId': 'b' * 64, 'ip': '172.21.0.7', 'bridge': 'br-123456789abc', 'bootId': '11111111-1111-4111-8111-111111111111', 'iptablesVersion': 'iptables v1.8.4 (nf_tables)'}
ACTOR = 'operator:patiphan-phakam'


def snapshot(current=CURRENT, enabled=True):
    return {**current, 'owner': media.OWNER, 'client': media.CLIENT, 'host': media.HOST, 'ports': media.PORTS, 'enabled': enabled}


class FakeIptables:
    def __init__(self):
        self.tables = {'nat': [('-N', 'UNRELATED'), ('-A', 'PREROUTING', '-j', 'UNRELATED')], 'filter': [('-P', 'FORWARD', 'DROP')]}
        self.mutations = []
        self.fail = None

    def execute(self, arguments):
        self.assert_prefix(arguments)
        table = arguments[4]
        operation = arguments[5]
        if operation == '-S':
            return '\n'.join(shlex.join(self.kernel_order(row)) for row in self.tables[table])
        if self.fail and self.fail(table, operation, arguments[6]):
            self.fail = None
            raise media.MediaGuardError('E1_MEDIA_COMMAND_FAILED')
        self.mutations.append(arguments)
        target = arguments[6]
        rows = self.tables[table]
        if operation == '-N':
            rows.append(('-N', target))
        elif operation == '-A':
            rows.append(('-A', target, *arguments[7:]))
        elif operation == '-I':
            self.assert_first(arguments[7])
            position = next((index for index, row in enumerate(rows) if row[:2] == ('-A', target)), len(rows))
            rows.insert(position, ('-A', target, *arguments[8:]))
        elif operation == '-D':
            rows.remove(('-A', target, *arguments[7:]))
        elif operation == '-F':
            if target not in media.CHAINS.values():
                raise AssertionError('ห้าม flush unrelated/built-in chain')
            rows[:] = [row for row in rows if row[:2] != ('-A', target)]
        elif operation == '-X':
            rows.remove(('-N', target))
        else:
            raise AssertionError(operation)
        return ''

    def assert_prefix(self, arguments):
        if arguments[:4] != ['iptables', '-w', '5', '-t']:
            raise AssertionError(arguments)

    def assert_first(self, position):
        if position != '1':
            raise AssertionError(position)

    def kernel_order(self, row):
        if row[0] != '-A':
            return row
        pairs = list(zip(row[2::2], row[3::2]))
        base = [pair for option in ('-s', '-d', '-p') for pair in pairs if pair[0] == option]
        extensions = [pair for pair in pairs if pair[0] not in ('-s', '-d', '-p')]
        return (*row[:2], *(value for pair in base + extensions for value in pair))


class MediaTests(unittest.TestCase):
    def setUp(self):
        self.fake = FakeIptables()
        self.firewall = media.MediaFirewall(self.fake.execute)
        self.written = []
        self.writer = patch.object(media, 'write_state', side_effect=lambda current, actor, enabled: self.written.append(snapshot(current, enabled)))
        self.writer.start()
        self.addCleanup(self.writer.stop)
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.state_dir = Path(self.directory.name)
        (self.state_dir / 'lock').touch()
        self.state_path = patch.object(media, 'STATE_DIR', self.state_dir)
        self.state_path.start()
        self.addCleanup(self.state_path.stop)

    def test_rules_are_only_approved_udp_tuple_and_established_reply(self):
        plan = media.ruleset(CURRENT['ip'])
        self.assertEqual(len(plan['nat']['rules']), 1)
        self.assertEqual(len(plan['filter']['rules']), 2)
        inbound, reply = plan['filter']['rules']
        self.assertIn(media.CLIENT, inbound)
        self.assertIn(CURRENT['ip'] + '/32', inbound)
        self.assertEqual(inbound[inbound.index('--dport') + 1], media.PORTS)
        self.assertEqual(reply[reply.index('--sport') + 1], media.PORTS)
        self.assertEqual(reply[reply.index('--ctstate') + 1], 'ESTABLISHED')
        for expected in plan.values():
            for rule in [expected['jump'], *expected['rules']]:
                self.assertIn(media.OWNER, rule)
                self.assertNotIn('tcp', rule)
                self.assertNotIn('0.0.0.0/0', rule)
                self.assertNotIn('NEW', reply)

    def test_planner_rejects_host_public_and_malformed_targets(self):
        for address in ('192.168.102.112', '8.8.8.8', '127.0.0.1', '172.21.0.7; echo bad'):
            with self.subTest(address=address), self.assertRaises((media.MediaGuardError, ValueError)):
                media.ruleset(address)

    def test_goto_reference_blocks_restore_before_any_mutation(self):
        self.firewall.install(media.ruleset(CURRENT['ip']))
        self.fake.tables['nat'].append(('-A', 'UNRELATED', '-g', media.CHAINS['nat']))
        before = len(self.fake.mutations)
        with self.assertRaisesRegex(media.MediaGuardError, 'UNKNOWN_FIREWALL_OWNERSHIP'):
            media.reconcile(self.firewall, snapshot(), CURRENT, ACTOR, restore=True)
        self.assertEqual(len(self.fake.mutations), before)
        self.assertEqual(self.written, [])

    def test_comment_cannot_hide_jump_or_goto_reference(self):
        for option in ('-j', '-g'):
            with self.subTest(option=option):
                fake = FakeIptables()
                firewall = media.MediaFirewall(fake.execute)
                firewall.install(media.ruleset(CURRENT['ip']))
                fake.tables['nat'].append(('-A', 'UNRELATED', '-m', 'comment', '--comment', option, option, media.CHAINS['nat']))
                before = len(fake.mutations)
                with self.assertRaisesRegex(media.MediaGuardError, 'UNKNOWN_FIREWALL_OWNERSHIP'):
                    media.reconcile(firewall, snapshot(), CURRENT, ACTOR, restore=True)
                self.assertEqual(len(fake.mutations), before)
                self.assertEqual(self.written, [])

    def test_observed_vm2_default_route_is_to_internal_gateway(self):
        routes = 'Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT\neth0 00000000 010015AC 0003 0 0 0 00000000 0 0 0\neth0 000015AC 00000000 0001 0 0 0 0000FFFF 0 0 0\n'
        media.require_return_route(routes, '172.21.0.1')
        with self.assertRaisesRegex(media.MediaGuardError, 'RETURN_ROUTE_REQUIRED'):
            media.require_return_route(routes, '172.22.0.1')

    def test_missing_or_down_default_route_is_not_assumed_from_internal_network(self):
        for routes in ('Iface Destination Gateway Flags RefCnt Use Metric Mask\neth0 000015AC 00000000 0001 0 0 0 0000FFFF\n', 'Iface Destination Gateway Flags RefCnt Use Metric Mask\neth0 00000000 010015AC 0002 0 0 0 00000000\n'):
            with self.assertRaisesRegex(media.MediaGuardError, 'RETURN_ROUTE_REQUIRED'):
                media.require_return_route(routes, '172.21.0.1')

    def test_half_internet_route_is_not_a_default_route_covering_client(self):
        routes = 'Iface Destination Gateway Flags RefCnt Use Metric Mask\neth0 00000000 010015AC 0003 0 0 0 00000080\n'
        with self.assertRaisesRegex(media.MediaGuardError, 'RETURN_ROUTE_REQUIRED'):
            media.require_return_route(routes, '172.21.0.1')

    def test_reject_route_is_not_an_active_default_route(self):
        routes = 'Iface Destination Gateway Flags RefCnt Use Metric Mask\neth0 00000000 010015AC 0203 0 0 0 00000000\n'
        with self.assertRaisesRegex(media.MediaGuardError, 'RETURN_ROUTE_REQUIRED'):
            media.require_return_route(routes, '172.21.0.1')

    def test_apply_recovers_fully_missing_owned_rules_after_reboot(self):
        previous = snapshot({**CURRENT, 'bootId': 'previous-boot'})
        self.assertEqual(media.reconcile(self.firewall, previous, CURRENT, ACTOR), 'APPLIED')
        self.firewall.check_first(media.ruleset(CURRENT['ip']))
        self.assertTrue(self.written[-1]['enabled'])

    def test_restore_accepts_fully_missing_owned_rules_after_reboot(self):
        previous = snapshot({**CURRENT, 'bootId': 'previous-boot'})
        unrelated = list(self.fake.tables['nat'])
        self.assertEqual(media.reconcile(self.firewall, previous, CURRENT, ACTOR, restore=True), 'RESTORED')
        self.assertEqual(self.fake.mutations, [])
        self.assertEqual(self.fake.tables['nat'], unrelated)
        self.assertFalse(self.written[-1]['enabled'])

    def test_profile_guard_accepts_only_e1_sandbox_profiles(self):
        for profile in ('uat-e1', 'uat-workspace'):
            with self.subTest(profile=profile):
                media.require_media_profile(['UNRELATED=value', 'DCONTACT_API_PROFILE=' + profile])

    def test_profile_guard_rejects_missing_unknown_and_ambiguous_profiles(self):
        environments = [[], *[['DCONTACT_API_PROFILE=' + profile] for profile in ('', 'default', 'uat', 'uat-line', 'unknown')], ['DCONTACT_API_PROFILE=uat-e1', 'DCONTACT_API_PROFILE=uat-workspace'], ['DCONTACT_API_PROFILE=uat-e1', 'DCONTACT_API_PROFILE=uat-e1']]
        for environment in environments:
            with self.subTest(environment=environment), self.assertRaisesRegex(media.MediaGuardError, 'PROFILE_UAT_E1_REQUIRED'):
                media.require_media_profile(environment)

    def test_profile_guard_rejects_sha_matching_api_without_uat_e1(self):
        root = self.state_dir / 'root'
        (root / 'deployments').mkdir(parents=True)
        (root / 'deployments/current.json').write_text(json.dumps({'sourceSha': CURRENT['sourceSha']}))
        (root / 'e1-acceptance.enabled').touch()
        def inspect(arguments):
            if arguments[0] == 'ip':
                return json.dumps([{'addr_info': [{'local': media.HOST}]}])
            return ''
        with patch.object(media, 'ROOT', root), patch.object(media, 'command', side_effect=inspect), patch.object(media, 'docker_value', return_value={'org.opencontainers.image.revision': CURRENT['sourceSha']}), self.assertRaisesRegex(media.MediaGuardError, 'PROFILE_UAT_E1_REQUIRED'):
            media.runtime()

    def test_voice_on_outer_shared_lock_blocks_restore_after_verify_returns(self):
        self.state_dir.chmod(0o755)
        with (self.state_dir / 'lock').open('r') as lock:
            fcntl.flock(lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
            with patch.object(media.os, 'geteuid', return_value=0), patch.object(media, 'runtime', return_value=CURRENT), patch.object(media, 'require_canonical'), patch.object(media, 'require_idle_off'), patch.object(media, 'root_owned'), patch.object(media, 'read_state', return_value=snapshot()), patch.object(media, 'MediaFirewall', return_value=self.firewall):
                self.assertEqual(media.run('verify', None, None)['status'], 'PASS')
                with self.assertRaisesRegex(media.MediaGuardError, 'OPERATOR_BUSY'):
                    media.run('restore', ACTOR, None)
        self.assertEqual(self.fake.mutations, [])

    def test_realistic_iptables_print_order_is_semantically_matched(self):
        plan = media.ruleset(CURRENT['ip'])
        self.firewall.install(plan)
        printed = next(row for row in self.firewall.tables()['nat'] if row[:2] == ('-A', 'PREROUTING') and media.CHAINS['nat'] in row)
        self.assertNotEqual(printed[2:], plan['nat']['jump'])
        self.firewall.check_first(plan)
        self.firewall.remove(plan)
        self.firewall.validate(None)

    def test_apply_repairs_order_only_for_owned_jump(self):
        plan = media.ruleset(CURRENT['ip'])
        self.firewall.install(plan)
        rows = self.fake.tables['nat']
        jump = ('-A', 'PREROUTING', *plan['nat']['jump'])
        rows.remove(jump)
        rows.append(jump)
        with self.assertRaisesRegex(media.MediaGuardError, 'RULE_ORDER_INVALID'):
            self.firewall.check_first(plan)
        self.assertEqual(media.reconcile(self.firewall, snapshot(), CURRENT, ACTOR), 'APPLIED')
        self.firewall.check_first(plan)

    def test_apply_idempotency_and_restore_preserve_unrelated(self):
        unrelated = list(self.fake.tables['nat'])
        self.assertEqual(media.reconcile(self.firewall, None, CURRENT, ACTOR), 'APPLIED')
        self.firewall.check_first(media.ruleset(CURRENT['ip']))
        mutations = len(self.fake.mutations)
        self.assertEqual(media.reconcile(self.firewall, snapshot(), CURRENT, ACTOR), 'UNCHANGED')
        self.assertEqual(len(self.fake.mutations), mutations)
        self.assertEqual(media.reconcile(self.firewall, snapshot(), CURRENT, ACTOR, restore=True), 'RESTORED')
        self.assertEqual(self.fake.tables['nat'], unrelated)
        self.assertEqual(self.fake.tables['filter'], [('-P', 'FORWARD', 'DROP')])
        self.assertFalse(self.written[-1]['enabled'])

    def test_unknown_ownership_is_rejected_before_mutation(self):
        self.fake.tables['nat'].append(('-N', media.CHAINS['nat']))
        with self.assertRaisesRegex(media.MediaGuardError, 'UNKNOWN_FIREWALL_OWNERSHIP'):
            media.reconcile(self.firewall, None, CURRENT, ACTOR)
        self.assertEqual(self.fake.mutations, [])
        self.assertEqual(self.written, [])

    def test_extra_rule_or_reference_is_not_deleted(self):
        self.firewall.install(media.ruleset(CURRENT['ip']))
        self.fake.tables['filter'].append(('-A', media.CHAINS['filter'], '-j', 'ACCEPT'))
        before = len(self.fake.mutations)
        with self.assertRaisesRegex(media.MediaGuardError, 'UNKNOWN_FIREWALL_OWNERSHIP'):
            media.reconcile(self.firewall, snapshot(), CURRENT, ACTOR, restore=True)
        self.assertEqual(len(self.fake.mutations), before)

    def test_stale_container_invalidates_snapshot_and_reconciles_ip(self):
        previous = snapshot({**CURRENT, 'containerId': 'c' * 64, 'ip': '172.21.0.6'})
        self.firewall.install(media.ruleset(previous['ip']))
        self.assertFalse(media.matches_current(previous, CURRENT))
        media.reconcile(self.firewall, previous, CURRENT, ACTOR)
        self.firewall.check_first(media.ruleset(CURRENT['ip']))
        self.assertFalse(any('172.21.0.6' in str(row) for rows in self.fake.tables.values() for row in rows))
        self.assertTrue(self.written[-1]['enabled'])

    def test_failure_during_install_removes_partial_owned_rules(self):
        self.fake.fail = lambda table, operation, target: table == 'nat' and operation == '-A'
        with self.assertRaisesRegex(media.MediaGuardError, 'APPLY_FAILED_CLOSED'):
            media.reconcile(self.firewall, None, CURRENT, ACTOR)
        self.firewall.validate(None)
        self.assertFalse(self.written[0]['enabled'])
        self.assertFalse(self.written[-1]['enabled'])

    def test_failure_removing_stale_rules_cleans_known_partial_state(self):
        previous = snapshot({**CURRENT, 'ip': '172.21.0.6', 'containerId': 'c' * 64})
        self.firewall.install(media.ruleset(previous['ip']))
        self.fake.fail = lambda table, operation, target: table == 'filter' and operation == '-F'
        with self.assertRaisesRegex(media.MediaGuardError, 'APPLY_FAILED_CLOSED'):
            media.reconcile(self.firewall, previous, CURRENT, ACTOR)
        self.firewall.validate(None)
        self.assertFalse(self.written[-1]['enabled'])

    def test_restore_failure_rolls_back_only_safe_current_scope(self):
        self.firewall.install(media.ruleset(CURRENT['ip']))
        self.fake.fail = lambda table, operation, target: table == 'filter' and operation == '-F'
        with self.assertRaisesRegex(media.MediaGuardError, 'APPLY_FAILED_ROLLED_BACK'):
            media.reconcile(self.firewall, snapshot(), CURRENT, ACTOR, restore=True)
        self.firewall.check_first(media.ruleset(CURRENT['ip']))
        self.assertTrue(self.written[-1]['enabled'])

    def test_check_and_verify_do_not_mutate(self):
        with patch.object(media.os, 'geteuid', return_value=0), patch.object(media, 'runtime', return_value=CURRENT), patch.object(media, 'require_canonical'), patch.object(media, 'root_owned'), patch.object(media, 'read_state', return_value=snapshot()), patch.object(media, 'MediaFirewall', return_value=self.firewall):
            self.firewall.install(media.ruleset(CURRENT['ip']))
            before = len(self.fake.mutations)
            self.assertEqual(media.run('check', None, CURRENT['sourceSha'])['status'], 'PASS')
            self.assertEqual(media.run('verify', None, CURRENT['sourceSha'])['liveFirewallChecked'], False)
            self.assertEqual(len(self.fake.mutations), before)
            self.assertEqual(self.written, [])

    def test_nonroot_snapshot_verifier_rejects_operator_lock(self):
        with (self.state_dir / 'lock').open('r') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with patch.object(media, 'runtime', return_value=CURRENT), patch.object(media, 'require_canonical'), patch.object(media, 'root_owned'), self.assertRaisesRegex(media.MediaGuardError, 'OPERATOR_BUSY'):
                media.run('verify', None, None)

    def test_private_umask_does_not_make_public_snapshot_lock_unreadable(self):
        directory = self.state_dir / 'fresh-state'
        previous_umask = media.os.umask(0o077)
        try:
            with patch.object(media.os, 'geteuid', return_value=0), patch.object(media, 'STATE_DIR', directory), patch.object(media, 'runtime', return_value=CURRENT), patch.object(media, 'require_canonical'), patch.object(media, 'require_idle_off'), patch.object(media, 'root_owned'), patch.object(media, 'read_state', return_value=None), patch.object(media, 'MediaFirewall', return_value=self.firewall):
                self.assertEqual(media.run('apply', ACTOR, None)['status'], 'APPLIED')
            self.assertEqual(directory.stat().st_mode & 0o777, 0o755)
            self.assertEqual((directory / 'lock').stat().st_mode & 0o777, 0o644)
        finally:
            media.os.umask(previous_umask)

    def test_wrong_user_actor_or_release_does_not_reach_mutation(self):
        with patch.object(media.os, 'geteuid', return_value=1000), self.assertRaisesRegex(media.MediaGuardError, 'SUDO_ON_VM2_REQUIRED'):
            media.run('apply', ACTOR, None)
        with patch.object(media.os, 'geteuid', return_value=0), self.assertRaisesRegex(media.MediaGuardError, 'ACTOR_REQUIRED'):
            media.run('apply', 'spoof\noperator:other', None)
        with patch.object(media.os, 'geteuid', return_value=0), patch.object(media, 'runtime', return_value=CURRENT), self.assertRaisesRegex(media.MediaGuardError, 'SOURCE_SHA_MISMATCH'):
            media.run('apply', ACTOR, 'c' * 40)
        self.assertEqual(self.fake.mutations, [])

    def test_wrong_host_is_rejected_before_docker_or_firewall(self):
        with patch.object(media, 'command', return_value=json.dumps([{'addr_info': [{'local': '192.168.102.113'}]}])) as execute, self.assertRaisesRegex(media.MediaGuardError, 'VM2_REQUIRED'):
            media.runtime()
        self.assertEqual(execute.call_count, 1)

    def test_busy_or_runtime_enabled_blocks_operator(self):
        for state in ({'runtimeEnabled': True, 'technicalSwitchOn': False}, {'runtimeEnabled': False, 'technicalSwitchOn': True}):
            with patch.object(media, 'command', return_value=json.dumps(state)), self.assertRaisesRegex(media.MediaGuardError, 'DEFAULT_OFF_REQUIRED'):
                media.require_idle_off(CURRENT)
        def busy(arguments):
            if arguments[-1] == 'status':
                return json.dumps({'runtimeEnabled': False, 'technicalSwitchOn': False})
            raise media.MediaGuardError('E1_MEDIA_COMMAND_FAILED')
        with patch.object(media, 'command', side_effect=busy), self.assertRaises(media.MediaGuardError):
            media.require_idle_off(CURRENT)

    def test_root_snapshot_rejects_other_owner_writable_or_symlink(self):
        for uid, mode, linked in ((1000, 0o644, False), (0, 0o666, False), (0, 0o644, True)):
            path = SimpleNamespace(lstat=lambda: SimpleNamespace(st_uid=uid, st_mode=mode), is_symlink=lambda: linked)
            with self.assertRaisesRegex(media.MediaGuardError, 'ROOT_OWNERSHIP_REQUIRED'):
                media.root_owned(path)

    def test_nonroot_verify_rejects_disabled_or_stale_snapshot(self):
        for state in (None, snapshot(enabled=False), snapshot({**CURRENT, 'containerId': 'c' * 64}), snapshot({**CURRENT, 'bootId': 'changed'}), snapshot({**CURRENT, 'iptablesVersion': 'changed'})):
            with patch.object(media, 'runtime', return_value=CURRENT), patch.object(media, 'require_canonical'), patch.object(media, 'root_owned'), patch.object(media, 'read_state', return_value=state), self.assertRaisesRegex(media.MediaGuardError, 'SNAPSHOT_MISSING_OR_STALE'):
                media.run('verify', None, None)

    def test_candidate_selectors_are_explicit_paired_and_canonical(self):
        operator_sha = 'd' * 40
        for candidate, operator in ((CURRENT['sourceSha'], None), (None, operator_sha), ('../release', operator_sha), (CURRENT['sourceSha'], 'd' * 39), ('', operator_sha)):
            with self.subTest(candidate=candidate, operator=operator), patch.object(media, 'runtime') as runtime, self.assertRaisesRegex(media.MediaGuardError, 'CANDIDATE_OPERATOR_SHA_REQUIRED'):
                media.run('verify', None, None, candidate, operator)
            runtime.assert_not_called()
        current = {**CURRENT, 'recordedSourceSha': 'e' * 40}
        with patch.object(media, 'runtime', return_value=current) as runtime, patch.object(media, 'require_canonical') as canonical, patch.object(media, 'root_owned'), patch.object(media, 'read_state', return_value=snapshot()):
            result = media.run('verify', None, CURRENT['sourceSha'], CURRENT['sourceSha'], operator_sha)
        runtime.assert_called_once_with(CURRENT['sourceSha'])
        canonical.assert_called_once_with({**current, 'operatorSourceSha': operator_sha}, operator_sha)
        self.assertEqual(result['recordedSourceSha'], 'e' * 40)
        self.assertEqual(result['operatorSourceSha'], operator_sha)
        self.assertEqual(self.fake.mutations, [])

    def test_candidate_restore_and_inspect_require_operator_lineage(self):
        for mode in ('restore', 'inspect'):
            with self.subTest(mode=mode), patch.object(media.os, 'geteuid', return_value=0), patch.object(media, 'runtime', return_value=CURRENT), patch.object(media, 'require_operator', side_effect=media.MediaGuardError('E1_MEDIA_CANONICAL_OPERATOR_REQUIRED')), self.assertRaisesRegex(media.MediaGuardError, 'CANONICAL_OPERATOR_REQUIRED'):
                media.run(mode, ACTOR, CURRENT['sourceSha'], CURRENT['sourceSha'], 'd' * 40)
        self.assertEqual(self.fake.mutations, [])

    def test_apply_and_restore_keep_candidate_lineage_after_exclusive_lock(self):
        operator = 'd' * 40
        current = {**CURRENT, 'recordedSourceSha': 'e' * 40}
        selected = {**current, 'operatorSourceSha': operator}
        self.state_dir.chmod(0o755)
        for mode in ('apply', 'restore'):
            with self.subTest(mode=mode):
                fake = FakeIptables()
                firewall = media.MediaFirewall(fake.execute)
                if mode == 'restore':
                    firewall.install(media.ruleset(CURRENT['ip']))
                def runtime(candidate=None):
                    if candidate != CURRENT['sourceSha']:
                        raise media.MediaGuardError('E1_MEDIA_RUNTIME_SHA_MISMATCH')
                    return current
                with patch.object(media.os, 'geteuid', return_value=0), patch.object(media, 'runtime', side_effect=runtime) as read_runtime, patch.object(media, 'require_canonical') as canonical, patch.object(media, 'require_operator') as lineage, patch.object(media, 'require_idle_off') as idle, patch.object(media, 'root_owned'), patch.object(media, 'read_state', return_value=snapshot(current) if mode == 'restore' else None), patch.object(media, 'MediaFirewall', return_value=firewall):
                    result = media.run(mode, ACTOR, CURRENT['sourceSha'], CURRENT['sourceSha'], operator)
                self.assertEqual(read_runtime.call_args_list, [call(CURRENT['sourceSha'])] * 2)
                self.assertEqual(idle.call_args_list, [call(selected)] * 2)
                guard = canonical if mode == 'apply' else lineage
                self.assertEqual(guard.call_args_list, [call(selected, operator)] * 2)
                self.assertEqual(result['status'], 'APPLIED' if mode == 'apply' else 'RESTORED')
                self.assertEqual(result['recordedSourceSha'], current['recordedSourceSha'])
                self.assertEqual(result['operatorSourceSha'], operator)
                self.assertEqual(self.written[-1]['sourceSha'], CURRENT['sourceSha'])

    def test_candidate_rechecks_guards_inside_lock_before_firewall_mutation(self):
        self.state_dir.chmod(0o755)
        for mode, guard_name in (('apply', 'runtime'), ('apply', 'require_canonical'), ('apply', 'require_idle_off'), ('restore', 'require_operator'), ('restore', 'require_idle_off')):
            with self.subTest(mode=mode, guard=guard_name):
                self.written.clear()
                guards = {name: patch.object(media, name, return_value=CURRENT if name == 'runtime' else None) for name in ('runtime', 'require_canonical', 'require_operator', 'require_idle_off')}
                with patch.object(media.os, 'geteuid', return_value=0), guards['runtime'] as runtime, guards['require_canonical'] as canonical, guards['require_operator'] as lineage, guards['require_idle_off'] as idle, patch.object(media, 'root_owned'), patch.object(media, 'MediaFirewall', return_value=self.firewall):
                    guard = {'runtime': runtime, 'require_canonical': canonical, 'require_operator': lineage, 'require_idle_off': idle}[guard_name]
                    guard.side_effect = [CURRENT if guard_name == 'runtime' else None, media.MediaGuardError('E1_MEDIA_RECHECK_REJECTED')]
                    with self.assertRaisesRegex(media.MediaGuardError, 'RECHECK_REJECTED'):
                        media.run(mode, ACTOR, CURRENT['sourceSha'], CURRENT['sourceSha'], 'd' * 40)
                self.assertEqual(self.fake.mutations, [])
                self.assertEqual(self.written, [])

    def test_recorded_apply_keeps_default_guards_after_lock(self):
        self.state_dir.chmod(0o755)
        with patch.object(media.os, 'geteuid', return_value=0), patch.object(media, 'runtime', return_value=CURRENT) as runtime, patch.object(media, 'require_canonical') as canonical, patch.object(media, 'require_idle_off') as idle, patch.object(media, 'root_owned'), patch.object(media, 'read_state', return_value=None), patch.object(media, 'MediaFirewall', return_value=self.firewall):
            self.assertEqual(media.run('apply', ACTOR, CURRENT['sourceSha'])['status'], 'APPLIED')
        self.assertEqual(runtime.call_args_list, [call(), call()])
        self.assertEqual(canonical.call_args_list, [call(CURRENT), call(CURRENT)])
        self.assertEqual(idle.call_args_list, [call(CURRENT), call(CURRENT)])


class CandidateRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / 'deployments').mkdir()
        self.recorded = 'a' * 40
        self.candidate = 'b' * 40
        self.operator = 'c' * 40
        self.record = self.root / 'deployments/current.json'
        self.record.write_text(json.dumps({'sourceSha': self.recorded, 'acceptance': 'OLD_RELEASE'}))
        (self.root / 'e1-acceptance.enabled').touch()
        self.boot = self.root / 'boot-id'
        self.boot.write_text(CURRENT['bootId'])
        self.labels = {name: self.candidate for name in ('api', 'e1-sandbox')}
        self.mount_sha = self.candidate
        self.commands = []
        self.root_patch = patch.object(media, 'ROOT', self.root)
        self.root_patch.start()
        self.addCleanup(self.root_patch.stop)

    def execute(self, arguments):
        self.commands.append(arguments)
        if arguments[0] == 'ip':
            return json.dumps([{'addr_info': [{'local': media.HOST}]}])
        if arguments[:3] == ['docker', 'network', 'inspect']:
            return 'true' if '{{.Internal}}' in arguments else '1' * 64
        if arguments[:3] == ['docker', 'exec', media.FS]:
            return 'Iface Destination Gateway Flags RefCnt Use Metric Mask\neth0 00000000 010015AC 0003 0 0 0 00000000'
        if arguments == ['iptables', '--version']:
            return CURRENT['iptablesVersion']
        raise AssertionError(arguments)

    def inspect(self, expression, name):
        if name == 'dcontact-uat-api-1' and expression == '.Config.Env':
            return ['DCONTACT_API_PROFILE=uat-workspace']
        if expression == '.Config.Labels':
            return {'org.opencontainers.image.revision': self.labels[name.removeprefix('dcontact-uat-').removesuffix('-1')]}
        values = {
            '.NetworkSettings.Networks': {media.NETWORK: {'IPAddress': CURRENT['ip'], 'Gateway': '172.21.0.1'}},
            '.Config.Image': media.FS_IMAGE,
            '.State.Health.Status': 'healthy',
            '.Mounts': [{'Destination': '/e1-freeswitch', 'Source': str(self.root / 'releases' / self.mount_sha / 'e1-freeswitch'), 'RW': False}],
            '.Id': CURRENT['containerId'],
        }
        return values[expression]

    def read_runtime(self, candidate=None):
        with patch.object(media, 'command', side_effect=self.execute), patch.object(media, 'docker_value', side_effect=self.inspect), patch.object(media, 'Path', side_effect=lambda value: self.boot if value == '/proc/sys/kernel/random/boot_id' else Path(value)):
            return media.runtime(candidate)

    def test_candidate_matches_actual_runtime_without_rewriting_record(self):
        before = self.record.read_bytes()
        result = self.read_runtime(self.candidate)
        self.assertEqual(result['sourceSha'], self.candidate)
        self.assertEqual(result['recordedSourceSha'], self.recorded)
        self.assertEqual(before, self.record.read_bytes())
        self.assertFalse(any(command[0] == 'iptables' and command != ['iptables', '--version'] for command in self.commands))

    def test_default_still_requires_recorded_runtime(self):
        with self.assertRaisesRegex(media.MediaGuardError, 'RUNTIME_SHA_MISMATCH'):
            self.read_runtime()
        self.labels = {name: self.recorded for name in self.labels}
        self.mount_sha = self.recorded
        result = self.read_runtime()
        self.assertEqual(result['sourceSha'], self.recorded)
        self.assertNotIn('recordedSourceSha', result)

    def test_candidate_rejects_either_service_from_another_release(self):
        for name in self.labels:
            with self.subTest(service=name):
                self.labels[name] = self.recorded
                with self.assertRaisesRegex(media.MediaGuardError, 'RUNTIME_SHA_MISMATCH'):
                    self.read_runtime(self.candidate)
                self.labels[name] = self.candidate

    def test_candidate_rejects_recorded_mount_even_when_images_match(self):
        self.mount_sha = self.recorded
        with self.assertRaisesRegex(media.MediaGuardError, 'SOURCE_MOUNT_REQUIRED'):
            self.read_runtime(self.candidate)

    def test_candidate_does_not_accept_invalid_recorded_identity(self):
        self.record.write_text(json.dumps({'sourceSha': '../untrusted'}))
        with self.assertRaisesRegex(media.MediaGuardError, 'RELEASE_REQUIRED'):
            self.read_runtime(self.candidate)

    def stage_operator(self):
        path = self.root / 'releases' / self.operator / 'operator/vm2-e1-media-uat.py'
        path.parent.mkdir(parents=True)
        path.write_bytes(Path(media.__file__).read_bytes())
        profile = self.root / 'releases' / self.candidate / 'e1-freeswitch/conf/sip_profiles/internal.xml'
        profile.parent.mkdir(parents=True)
        profile.write_text('<profile><param name="local-network-acl" value="none"/><param name="auth-calls" value="true"/><param name="apply-candidate-acl" value="dcontact_webrtc_candidates"/></profile>')
        return path, profile

    def test_operator_lineage_is_separate_but_runtime_profile_stays_pinned(self):
        self.stage_operator()
        with patch.object(media, 'command') as command:
            media.require_canonical({'sourceSha': self.candidate}, self.operator)
        self.assertEqual(command.call_args.args[0][-2:], ['/etc/freeswitch/sip_profiles/internal.xml', '/e1-freeswitch/conf/sip_profiles/internal.xml'])

    def test_tampered_operator_fails_before_container_profile_check(self):
        path, _ = self.stage_operator()
        path.write_text('# unreviewed replacement')
        with patch.object(media, 'command') as command, self.assertRaisesRegex(media.MediaGuardError, 'CANONICAL_OPERATOR_REQUIRED'):
            media.require_canonical({'sourceSha': self.candidate}, self.operator)
        command.assert_not_called()

    def test_candidate_profile_still_rejects_relaxed_acl(self):
        _, profile = self.stage_operator()
        profile.write_text(profile.read_text().replace('value="none"', 'value="lan"'))
        with patch.object(media, 'command') as command, self.assertRaisesRegex(media.MediaGuardError, 'CANONICAL_PROFILE_REQUIRED'):
            media.require_canonical({'sourceSha': self.candidate}, self.operator)
        command.assert_not_called()


class SnapshotPublishTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.state_dir = Path(self.directory.name)
        self.state_file = self.state_dir / 'state.json'
        self.state_file.write_text(json.dumps(snapshot(enabled=False)))
        self.state_path = patch.object(media, 'STATE_DIR', self.state_dir)
        self.state_path.start()
        self.addCleanup(self.state_path.stop)
        self.snapshot_path = patch.object(media, 'STATE_FILE', self.state_file)
        self.snapshot_path.start()
        self.addCleanup(self.snapshot_path.stop)

    def test_audit_failure_cannot_publish_enabled_snapshot(self):
        original_open = media.os.open
        def fail_audit(path, flags, mode=0o777):
            if Path(path) == self.state_dir / 'audit.jsonl':
                raise OSError('audit unavailable')
            return original_open(path, flags, mode)
        with patch.object(media.os, 'open', side_effect=fail_audit), self.assertRaises(OSError):
            media.write_state(CURRENT, ACTOR, True)
        self.assertFalse(json.loads(self.state_file.read_text())['enabled'])

    def test_failed_snapshot_publish_keeps_disabled_state_and_intent_audit(self):
        with patch.object(media.os, 'replace', side_effect=OSError('publish unavailable')), self.assertRaises(OSError):
            media.write_state(CURRENT, ACTOR, True)
        self.assertFalse(json.loads(self.state_file.read_text())['enabled'])
        audit = json.loads((self.state_dir / 'audit.jsonl').read_text())
        self.assertEqual(audit['event'], 'snapshot.publish.intent')
        self.assertEqual({path.name for path in self.state_dir.iterdir()}, {'state.json', 'audit.jsonl'})


if __name__ == '__main__':
    unittest.main()
