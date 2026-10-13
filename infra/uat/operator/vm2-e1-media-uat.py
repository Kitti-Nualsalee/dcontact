import argparse
import fcntl
import ipaddress
import json
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import tempfile
from datetime import datetime, timezone
import xml.etree.ElementTree as xml


ROOT = Path('/opt/dcontact-uat')
STATE_DIR = Path('/var/lib/dcontact-uat-e1-media')
STATE_FILE = STATE_DIR / 'state.json'
OWNER = 'dcontact:e1-media:v1'
CLIENT = '192.168.0.0/16'
HOST = '192.168.102.112'
PORTS = '16384:16420'
FS = 'dcontact-uat-freeswitch-1'
NETWORK = 'dcontact-uat_internal'
FS_IMAGE = 'docker.io/safarov/freeswitch@sha256:b31c743f4c911a19687c61e3214968f2a24f93f9d3d667cc26284192e158ffc6'
CHAINS = {'nat': 'DCUAT_E1_RTP_DNAT', 'filter': 'DCUAT_E1_RTP_FWD'}


class MediaGuardError(Exception):
    pass


def command(arguments):
    result = subprocess.run(arguments, text=True, capture_output=True, check=False)
    if result.returncode:
        raise MediaGuardError('E1_MEDIA_COMMAND_FAILED')
    return result.stdout.strip()


def docker_value(expression, name):
    return json.loads(command(['docker', 'inspect', '--format', '{{json ' + expression + '}}', name]))


def require_return_route(routes, gateway):
    expected_gateway = int.from_bytes(ipaddress.IPv4Address(gateway).packed, 'little')
    for line in routes.splitlines()[1:]:
        fields = line.split()
        if len(fields) >= 8 and fields[1] == '00000000' and fields[7] == '00000000' and int(fields[2], 16) == expected_gateway and int(fields[3], 16) & 0x203 == 3:
            return
    raise MediaGuardError('E1_MEDIA_RETURN_ROUTE_REQUIRED')


def runtime():
    addresses = json.loads(command(['ip', '-j', '-4', 'addr', 'show']))
    if not any(address.get('local') == HOST for interface in addresses for address in interface.get('addr_info', [])):
        raise MediaGuardError('E1_MEDIA_VM2_REQUIRED')
    source_sha = json.loads((ROOT / 'deployments/current.json').read_text())['sourceSha']
    if not re.fullmatch('[0-9a-f]{40}', source_sha) or not (ROOT / 'e1-acceptance.enabled').is_file():
        raise MediaGuardError('E1_MEDIA_RELEASE_REQUIRED')
    profile = command(['docker', 'inspect', '--format', '{{range .Config.Env}}{{if eq . "DCONTACT_API_PROFILE=uat-e1"}}uat-e1{{end}}{{end}}', 'dcontact-uat-api-1'])
    if profile != 'uat-e1':
        raise MediaGuardError('E1_MEDIA_PROFILE_UAT_E1_REQUIRED')
    for service in ('api', 'e1-sandbox'):
        labels = docker_value('.Config.Labels', 'dcontact-uat-' + service + '-1')
        if labels.get('org.opencontainers.image.revision') != source_sha:
            raise MediaGuardError('E1_MEDIA_RUNTIME_SHA_MISMATCH')
    networks = docker_value('.NetworkSettings.Networks', FS)
    if set(networks) != {NETWORK} or command(['docker', 'network', 'inspect', '--format', '{{.Internal}}', NETWORK]) != 'true':
        raise MediaGuardError('E1_MEDIA_INTERNAL_NETWORK_REQUIRED')
    require_return_route(command(['docker', 'exec', FS, 'cat', '/proc/net/route']), networks[NETWORK]['Gateway'])
    if docker_value('.Config.Image', FS) != FS_IMAGE or docker_value('.State.Health.Status', FS) != 'healthy':
        raise MediaGuardError('E1_MEDIA_FREESWITCH_REQUIRED')
    mounts = docker_value('.Mounts', FS)
    release = ROOT / 'releases' / source_sha
    if not any(mount['Destination'] == '/e1-freeswitch' and mount['Source'] == str(release / 'e1-freeswitch') and not mount['RW'] for mount in mounts):
        raise MediaGuardError('E1_MEDIA_SOURCE_MOUNT_REQUIRED')
    network_id = command(['docker', 'network', 'inspect', '--format', '{{.Id}}', NETWORK])
    return {'sourceSha': source_sha, 'containerId': docker_value('.Id', FS), 'ip': networks[NETWORK]['IPAddress'], 'bridge': 'br-' + network_id[:12], 'bootId': Path('/proc/sys/kernel/random/boot_id').read_text().strip(), 'iptablesVersion': command(['iptables', '--version'])}


def require_canonical(current):
    release = ROOT / 'releases' / current['sourceSha']
    source = release / 'operator/vm2-e1-media-uat.py'
    if source.read_bytes() != Path(__file__).read_bytes():
        raise MediaGuardError('E1_MEDIA_CANONICAL_OPERATOR_REQUIRED')
    profile = xml.parse(release / 'e1-freeswitch/conf/sip_profiles/internal.xml')
    for name, expected in [('local-network-acl', 'none'), ('auth-calls', 'true'), ('apply-candidate-acl', 'dcontact_webrtc_candidates')]:
        values = [element.get('value') for element in profile.findall('.//param') if element.get('name') == name]
        if values != [expected]:
            raise MediaGuardError('E1_MEDIA_CANONICAL_PROFILE_REQUIRED')
    command(['docker', 'exec', FS, 'cmp', '/etc/freeswitch/sip_profiles/internal.xml', '/e1-freeswitch/conf/sip_profiles/internal.xml'])


def require_idle_off(current):
    runner = str(ROOT / 'releases' / current['sourceSha'] / 'bin/uat-deploy.sh')
    status = json.loads(command(['bash', runner, 'e1-voice-control', current['sourceSha'], 'status']))
    if status.get('runtimeEnabled') is not False or status.get('technicalSwitchOn') is not False:
        raise MediaGuardError('E1_MEDIA_DEFAULT_OFF_REQUIRED')
    command(['bash', runner, 'e1-voice-control', current['sourceSha'], 'idle'])
    count = command(['docker', 'exec', FS, 'sh', '-c', 'fs_cli -p "$E1_ESL_PASSWORD" -x "show calls count"'])
    if not re.search(r'^0 total\.$', count, re.MULTILINE):
        raise MediaGuardError('E1_MEDIA_CALLS_STILL_ACTIVE')


def ruleset(address):
    if ipaddress.IPv4Address(address) not in ipaddress.IPv4Network('172.16.0.0/12'):
        raise MediaGuardError('E1_MEDIA_DOCKER_IP_REQUIRED')
    marker = ('-m', 'comment', '--comment', OWNER)
    request_source = ('-p', 'udp', '-s', CLIENT)
    request_ports = ('-m', 'udp', '--sport', '1024:65535', '--dport', PORTS)
    inbound = request_source + ('-d', address + '/32') + request_ports
    reply = ('-p', 'udp', '-s', address + '/32', '-d', CLIENT, '-m', 'udp', '--sport', PORTS, '--dport', '1024:65535', '-m', 'conntrack', '--ctstate', 'ESTABLISHED')
    entrance = request_source + ('-d', HOST + '/32') + request_ports
    return {
        'nat': {'parent': 'PREROUTING', 'jump': entrance + marker + ('-j', CHAINS['nat']), 'rules': [entrance + marker + ('-j', 'DNAT', '--to-destination', address)]},
        'filter': {'parent': 'FORWARD', 'jump': ('-p', 'udp') + marker + ('-j', CHAINS['filter']), 'rules': [inbound + marker + ('-j', 'ACCEPT'), reply + marker + ('-j', 'ACCEPT')]},
    }


def rule_key(rule):
    options = {'-p', '-s', '-d', '-m', '--sport', '--dport', '--ctstate', '--comment', '-j', '--to-destination'}
    if len(rule) % 2 or any(option not in options for option in rule[::2]):
        raise MediaGuardError('E1_MEDIA_UNKNOWN_FIREWALL_OWNERSHIP')
    return tuple(sorted(zip(rule[::2], rule[1::2])))


def references_chain(row, chain):
    return any(option in ('-j', '-g') and target == chain for option, target in zip(row, row[1:]))


def chain_contents(rows, chain):
    declared = ('-N', chain) in rows
    leaves = [row[2:] for row in rows if row[:2] == ('-A', chain)]
    references = [row for row in rows if references_chain(row, chain)]
    return declared, leaves, references


class MediaFirewall:
    def __init__(self, execute=command):
        self.execute = execute

    def tables(self):
        return {table: [tuple(shlex.split(line)) for line in self.execute(['iptables', '-w', '5', '-t', table, '-S']).splitlines()] for table in CHAINS}

    def validate(self, plan, partial=False):
        tables = self.tables()
        for table, chain in CHAINS.items():
            declared, leaves, references = chain_contents(tables[table], chain)
            if plan is None:
                valid = not declared and not leaves and not references
            else:
                expected = plan[table]
                wanted = ('-A', expected['parent']) + expected['jump']
                leaf_keys = [rule_key(rule) for rule in leaves]
                expected_keys = [rule_key(rule) for rule in expected['rules']]
                reference_keys = [(row[:2], rule_key(row[2:])) for row in references]
                wanted_key = (wanted[:2], rule_key(wanted[2:]))
                if partial:
                    valid = all(key in expected_keys for key in leaf_keys) and len(leaf_keys) == len(set(leaf_keys)) and reference_keys in ([], [wanted_key]) and (declared or not leaves and not references)
                else:
                    valid = declared and leaf_keys == expected_keys and reference_keys == [wanted_key]
            if not valid:
                raise MediaGuardError('E1_MEDIA_UNKNOWN_FIREWALL_OWNERSHIP')
        return tables

    def check_first(self, plan):
        tables = self.validate(plan)
        for table, expected in plan.items():
            parent = [row for row in tables[table] if row[:2] == ('-A', expected['parent'])]
            if not parent or not references_chain(parent[0], CHAINS[table]):
                raise MediaGuardError('E1_MEDIA_RULE_ORDER_INVALID')

    def remove(self, plan, partial=False):
        tables = self.validate(plan, partial)
        if plan is None:
            return
        for table, expected in plan.items():
            chain = CHAINS[table]
            if ('-N', chain) not in tables[table]:
                continue
            wanted = ('-A', expected['parent']) + expected['jump']
            if any(row[:2] == wanted[:2] and references_chain(row, chain) for row in tables[table]):
                self.execute(['iptables', '-w', '5', '-t', table, '-D', expected['parent'], *expected['jump']])
            self.execute(['iptables', '-w', '5', '-t', table, '-F', chain])
            self.execute(['iptables', '-w', '5', '-t', table, '-X', chain])

    def install(self, plan):
        for table in ('filter', 'nat'):
            expected = plan[table]
            chain = CHAINS[table]
            self.execute(['iptables', '-w', '5', '-t', table, '-N', chain])
            for rule in expected['rules']:
                self.execute(['iptables', '-w', '5', '-t', table, '-A', chain, *rule])
            self.execute(['iptables', '-w', '5', '-t', table, '-I', expected['parent'], '1', *expected['jump']])

    def remove_known_partial(self, candidate, previous):
        tables = self.tables()
        mixed = {}
        for table, chain in CHAINS.items():
            _, leaves, _ = chain_contents(tables[table], chain)
            options = [candidate[table]] + ([previous[table]] if previous else [])
            expected = next((option for option in options if all(rule_key(rule) in [rule_key(wanted) for wanted in option['rules']] for rule in leaves)), None)
            if expected is None:
                raise MediaGuardError('E1_MEDIA_UNKNOWN_FIREWALL_OWNERSHIP')
            mixed[table] = expected
        self.remove(mixed, partial=True)


def root_owned(path, private=False):
    metadata = path.lstat()
    mode = stat.S_IMODE(metadata.st_mode)
    if path.is_symlink() or metadata.st_uid != 0 or mode & (0o077 if private else 0o022):
        raise MediaGuardError('E1_MEDIA_ROOT_OWNERSHIP_REQUIRED')


def read_state():
    if STATE_DIR.is_symlink() or STATE_FILE.is_symlink():
        raise MediaGuardError('E1_MEDIA_ROOT_OWNERSHIP_REQUIRED')
    if not STATE_DIR.exists():
        return None
    root_owned(STATE_DIR)
    if not STATE_FILE.exists():
        return None
    root_owned(STATE_FILE)
    state = json.loads(STATE_FILE.read_text())
    if state.get('owner') != OWNER or state.get('client') != CLIENT or state.get('host') != HOST or state.get('ports') != PORTS or type(state.get('enabled')) is not bool:
        raise MediaGuardError('E1_MEDIA_STATE_INVALID')
    if not re.fullmatch('[0-9a-f]{40}', state.get('sourceSha', '')) or not re.fullmatch('[0-9a-f]{64}', state.get('containerId', '')):
        raise MediaGuardError('E1_MEDIA_STATE_INVALID')
    ruleset(state['ip'])
    return state


def matches_current(state, current):
    return bool(state and state['enabled'] and all(state.get(key) == current[key] for key in ('sourceSha', 'containerId', 'ip', 'bootId', 'iptablesVersion')))


def write_state(current, actor, enabled):
    record = {**current, 'owner': OWNER, 'client': CLIENT, 'host': HOST, 'ports': PORTS, 'enabled': enabled, 'actorRef': actor, 'at': datetime.now(timezone.utc).isoformat()}
    descriptor = os.open(STATE_DIR / 'audit.jsonl', os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'a') as audit:
        audit.write(json.dumps({**record, 'event': 'snapshot.publish.intent'}) + '\n')
        audit.flush()
        os.fsync(audit.fileno())
    with tempfile.NamedTemporaryFile(mode='w', dir=STATE_DIR, delete=False) as handle:
        temporary = Path(handle.name)
        try:
            json.dump(record, handle)
            handle.flush()
            os.fsync(handle.fileno())
            os.fchmod(handle.fileno(), 0o644)
            os.replace(temporary, STATE_FILE)
        finally:
            if temporary.exists():
                temporary.unlink()


def reconcile(firewall, previous, current, actor, restore=False):
    previous_plan = ruleset(previous['ip']) if previous and previous['enabled'] else None
    try:
        firewall.validate(previous_plan)
    except MediaGuardError:
        if previous_plan is None:
            raise
        firewall.validate(None)
        previous_plan = None
    if not restore and previous_plan is not None and matches_current(previous, current):
        try:
            firewall.check_first(previous_plan)
            return 'UNCHANGED'
        except MediaGuardError as error:
            if str(error) != 'E1_MEDIA_RULE_ORDER_INVALID':
                raise
    candidate = ruleset(current['ip'])
    write_state(current, actor, False)
    try:
        firewall.remove(previous_plan)
        if not restore:
            firewall.install(candidate)
            firewall.check_first(candidate)
        else:
            firewall.validate(None)
        write_state(current, actor, not restore)
    except Exception:
        try:
            firewall.remove_known_partial(candidate, previous_plan)
            if previous_plan is not None and matches_current(previous, current):
                firewall.install(previous_plan)
                firewall.check_first(previous_plan)
                write_state(current, actor, True)
                restored = True
            else:
                write_state(current, actor, False)
                restored = False
        except Exception:
            raise MediaGuardError('E1_MEDIA_ROLLBACK_FAILED') from None
        raise MediaGuardError('E1_MEDIA_APPLY_FAILED_ROLLED_BACK' if restored else 'E1_MEDIA_APPLY_FAILED_CLOSED') from None
    return 'RESTORED' if restore else 'APPLIED'


def run(mode, actor, source_sha):
    if mode != 'verify' and os.geteuid() != 0:
        raise MediaGuardError('E1_MEDIA_SUDO_ON_VM2_REQUIRED')
    if mode in ('apply', 'restore') and not re.fullmatch('operator:[A-Za-z0-9_-]{1,64}', actor or ''):
        raise MediaGuardError('E1_MEDIA_ACTOR_REQUIRED')
    current = runtime()
    if source_sha and source_sha != current['sourceSha']:
        raise MediaGuardError('E1_MEDIA_SOURCE_SHA_MISMATCH')
    if mode == 'inspect':
        tables = MediaFirewall().tables()
        return {'status': 'INSPECTED', **current, 'publishedPorts': docker_value('.NetworkSettings.Ports', FS), 'uatBridgeRules': [list(row) for rows in tables.values() for row in rows if current['bridge'] in row]}
    if mode != 'restore':
        require_canonical(current)
    if mode in ('check', 'verify'):
        if not STATE_DIR.exists() or not (STATE_DIR / 'lock').exists():
            raise MediaGuardError('E1_MEDIA_SNAPSHOT_MISSING_OR_STALE')
        root_owned(STATE_DIR)
        root_owned(STATE_DIR / 'lock')
        descriptor = os.open(STATE_DIR / 'lock', os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(descriptor, 'r') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
            except BlockingIOError:
                raise MediaGuardError('E1_MEDIA_OPERATOR_BUSY') from None
            if not matches_current(read_state(), current):
                raise MediaGuardError('E1_MEDIA_SNAPSHOT_MISSING_OR_STALE')
            if mode == 'check':
                MediaFirewall().check_first(ruleset(current['ip']))
        return {'status': 'PASS', **current, 'liveFirewallChecked': mode == 'check'}
    require_idle_off(current)
    try:
        STATE_DIR.mkdir(mode=0o755)
        os.chmod(STATE_DIR, 0o755)
    except FileExistsError:
        pass
    root_owned(STATE_DIR)
    if stat.S_IMODE(STATE_DIR.lstat().st_mode) != 0o755:
        raise MediaGuardError('E1_MEDIA_STATE_DIRECTORY_MODE_INVALID')
    for filename in ('lock', 'audit.jsonl'):
        path = STATE_DIR / filename
        if path.exists() or path.is_symlink():
            root_owned(path, private=filename == 'audit.jsonl')
            if filename == 'lock' and path.lstat().st_size:
                raise MediaGuardError('E1_MEDIA_UNKNOWN_LOCK_CONTENT')
    descriptor = os.open(STATE_DIR / 'lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o644)
    os.fchmod(descriptor, 0o644)
    with os.fdopen(descriptor, 'w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise MediaGuardError('E1_MEDIA_OPERATOR_BUSY') from None
        current = runtime()
        if mode != 'restore':
            require_canonical(current)
        require_idle_off(current)
        result = reconcile(MediaFirewall(), read_state(), current, actor, restore=mode == 'restore')
    return {'status': result, **current}


def main():
    os.environ['PATH'] = '/usr/sbin:/usr/bin:/sbin:/bin'
    parser = argparse.ArgumentParser()
    modes = parser.add_mutually_exclusive_group(required=True)
    for flag in ('inspect', 'check', 'apply', 'restore'):
        modes.add_argument('--' + flag, dest='mode', action='store_const', const=flag)
    modes.add_argument('--verify-snapshot', dest='mode', action='store_const', const='verify')
    parser.add_argument('--actor')
    parser.add_argument('--source-sha')
    arguments = parser.parse_args()
    try:
        result = run(arguments.mode, arguments.actor, arguments.source_sha)
        print(json.dumps({'type': 'e1.uat.media', 'client': CLIENT, 'ports': PORTS, **result}))
    except Exception as error:
        reason = str(error) if isinstance(error, MediaGuardError) else 'E1_MEDIA_STATE_OR_COMMAND_INVALID'
        print(json.dumps({'type': 'e1.uat.media', 'status': 'FAIL', 'reason': reason}))
        raise SystemExit(1)


if __name__ == '__main__':
    main()
