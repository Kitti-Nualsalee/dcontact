#!/usr/bin/env bash
# #537 / ADR-030: insert the UAT-only rules before the broad md5 rule without changing the existing rules
# run on VM3 with sudo: --check first, --apply when ready
set -euo pipefail

mode="${1:---check}"
[[ "$mode" == --check || "$mode" == --apply ]] || { echo 'usage: sudo bash vm3-pg-hba-uat.sh [--check|--apply]' >&2; exit 64; }
[[ "$(id -u)" -eq 0 ]] || { echo 'must run with sudo on VM3' >&2; exit 1; }
ip -4 -o addr show | grep -Fq '192.168.102.113/' || { echo 'this machine does not have the expected VM3 IP' >&2; exit 1; }

psql_pg() { runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -d postgres "$@"; }
hba="$(psql_pg -Atqc 'show hba_file')"
[[ -f "$hba" ]] || { echo 'pg_hba.conf not found' >&2; exit 1; }
[[ "$(psql_pg -Atqc 'show server_version_num')" == 150* ]] || { echo 'expected the server to be PostgreSQL 15' >&2; exit 1; }
existing_errors="$(psql_pg -Atqc 'select count(*) from pg_hba_file_rules where error is not null')"
[[ "$existing_errors" == 0 ]] || { echo 'the existing pg_hba.conf has errors; stopping before editing' >&2; exit 1; }

change_result="$(python3 - "$mode" "$hba" <<'PY'
import os, re, shutil, stat, sys, tempfile
from datetime import datetime, timezone
from pathlib import Path

mode, path_arg = sys.argv[1:]
path = Path(path_arg)
raw = path.read_bytes()
text = raw.decode('utf-8')
if '\r\n' in text:
    raise SystemExit('pg_hba.conf uses CRLF; stopping to check by hand')
marker_begin = '# BEGIN DCONTACT UAT 3VM (ADR-030)'
marker_end = '# END DCONTACT UAT 3VM'
block = '\n'.join([
    marker_begin,
    'host  dcontact_uat  dcontact_app,dcontact_uat_owner  192.168.102.112/32  scram-sha-256',
    'host  keycloak_uat  keycloak  192.168.102.112/32  scram-sha-256',
    'host  all  dcontact_app,dcontact_platform,dcontact_provisioner,dcontact_uat_owner,keycloak  0.0.0.0/0  reject',
    'host  dcontact_uat,keycloak_uat  all  0.0.0.0/0  reject',
    marker_end,
]) + '\n'
lines = text.splitlines(keepends=True)
broad = re.compile(r'^\s*host\s+all\s+all\s+0\.0\.0\.0/0\s+md5(?:\s|$)')
indexes = [i for i, line in enumerate(lines) if broad.match(line)]
if len(indexes) != 1:
    raise SystemExit(f'expected exactly 1 broad md5 rule line; found {len(indexes)}')
index = indexes[0]
if marker_begin in text or marker_end in text:
    if text.count(block) != 1 or not (text.index(block) < sum(map(len, lines[:index]))):
        raise SystemExit('found a UAT block that differs from expected or sits after the md5 rule; stopping to check by hand')
    print(f'the UAT rules are already before the broad md5 rule: {path}:{index + 1}')
    sys.exit(0)
print(f'will insert 4 UAT rule lines before {path}:{index + 1}; the existing rules are kept in full')
if mode == '--check':
    sys.exit(0)

before = path.stat()
backup = path.with_name(path.name + '.dcontact-uat.' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '.bak')
if backup.exists():
    raise SystemExit(f'duplicate backup name: {backup}')
shutil.copy2(path, backup)
os.chown(backup, before.st_uid, before.st_gid)
new_text = ''.join(lines[:index]) + block + ''.join(lines[index:])
fd, temporary = tempfile.mkstemp(prefix='.pg_hba.dcontact-uat.', dir=path.parent)
try:
    with os.fdopen(fd, 'wb') as f:
        f.write(new_text.encode('utf-8'))
        f.flush()
        os.fsync(f.fileno())
    os.chown(temporary, before.st_uid, before.st_gid)
    os.chmod(temporary, stat.S_IMODE(before.st_mode))
    os.replace(temporary, path)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
print(f'BACKUP={backup}')
PY
)"
printf '%s\n' "$change_result"

if [[ "$mode" == --check ]]; then
  echo 'CHECK passed; --apply will check pg_hba_file_rules then reload the config without restarting PostgreSQL'
  exit 0
fi

backup="$(printf '%s\n' "$change_result" | sed -n 's/^BACKUP=//p')"
if [[ -n "$backup" && ! -f "$backup" ]]; then echo 'backup not found after apply' >&2; exit 1; fi
rollback() {
  if [[ -n "$backup" ]]; then
    cp -p "$backup" "$hba"
    psql_pg -Atqc 'select pg_reload_conf()' >/dev/null || true
    echo "restoring pg_hba.conf from $backup" >&2
  fi
}
errors="$(psql_pg -Atqc 'select count(*) from pg_hba_file_rules where error is not null')" || { rollback; exit 1; }
if [[ "$errors" != 0 ]]; then rollback; echo "pg_hba_file_rules found $errors errors" >&2; exit 1; fi
# the 4 UAT rules must be visible in the real file before the reload
count="$(psql_pg -Atqc "select count(*) from pg_hba_file_rules where line_number < (select min(line_number) from pg_hba_file_rules where type='host' and database='{all}' and user_name='{all}' and address='0.0.0.0' and auth_method='md5') and (database::text like '%dcontact_uat%' or user_name::text like '%dcontact_app%')")"
if [[ "$count" -lt 3 ]]; then rollback; echo 'the UAT rules are not before the broad md5 rule' >&2; exit 1; fi
reloaded="$(psql_pg -Atqc 'select pg_reload_conf()')" || { rollback; exit 1; }
if [[ "$reloaded" != t ]]; then rollback; echo 'pg_reload_conf() failed' >&2; exit 1; fi
printf 'APPLY passed: %s; UAT rules are before the broad md5; reloaded\n' "$hba"
