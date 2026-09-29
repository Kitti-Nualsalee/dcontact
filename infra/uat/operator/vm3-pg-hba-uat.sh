#!/usr/bin/env bash
# #537 / ADR-030: แทรกกฎเฉพาะ UAT ก่อน broad md5 rule โดยไม่เปลี่ยนกฎเดิม
# รันบน VM3 ด้วย sudo: --check ก่อน, --apply เมื่อพร้อม
set -euo pipefail

mode="${1:---check}"
[[ "$mode" == --check || "$mode" == --apply ]] || { echo 'usage: sudo bash vm3-pg-hba-uat.sh [--check|--apply]' >&2; exit 64; }
[[ "$(id -u)" -eq 0 ]] || { echo 'ต้องรันด้วย sudo บน VM3' >&2; exit 1; }
ip -4 -o addr show | grep -Fq '192.168.102.113/' || { echo 'เครื่องนี้ไม่มี IP VM3 ที่คาดไว้' >&2; exit 1; }

psql_pg() { runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -d postgres "$@"; }
hba="$(psql_pg -Atqc 'show hba_file')"
[[ -f "$hba" ]] || { echo 'ไม่พบ pg_hba.conf' >&2; exit 1; }
[[ "$(psql_pg -Atqc 'show server_version_num')" == 150* ]] || { echo 'คาดว่า server เป็น PostgreSQL 15' >&2; exit 1; }
existing_errors="$(psql_pg -Atqc 'select count(*) from pg_hba_file_rules where error is not null')"
[[ "$existing_errors" == 0 ]] || { echo 'pg_hba.conf เดิมมี error; หยุดก่อนแก้' >&2; exit 1; }

change_result="$(python3 - "$mode" "$hba" <<'PY'
import os, re, shutil, stat, sys, tempfile
from datetime import datetime, timezone
from pathlib import Path

mode, path_arg = sys.argv[1:]
path = Path(path_arg)
raw = path.read_bytes()
text = raw.decode('utf-8')
if '\r\n' in text:
    raise SystemExit('pg_hba.conf ใช้ CRLF; หยุดเพื่อตรวจด้วยมือ')
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
    raise SystemExit(f'คาดว่า broad md5 rule ต้องมี 1 บรรทัด; พบ {len(indexes)}')
index = indexes[0]
if marker_begin in text or marker_end in text:
    if text.count(block) != 1 or not (text.index(block) < sum(map(len, lines[:index]))):
        raise SystemExit('พบ block UAT ที่ต่างจาก expected หรืออยู่หลังกฎ md5; หยุดเพื่อตรวจด้วยมือ')
    print(f'กฎ UAT อยู่ก่อน broad md5 rule แล้ว: {path}:{index + 1}')
    sys.exit(0)
print(f'จะแทรกกฎ UAT 4 บรรทัดก่อน {path}:{index + 1}; กฎเดิมคงครบ')
if mode == '--check':
    sys.exit(0)

before = path.stat()
backup = path.with_name(path.name + '.dcontact-uat.' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '.bak')
if backup.exists():
    raise SystemExit(f'ชื่อ backup ซ้ำ: {backup}')
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
  echo 'CHECK ผ่าน; --apply จะตรวจ pg_hba_file_rules แล้ว reload config โดยไม่ restart PostgreSQL'
  exit 0
fi

backup="$(printf '%s\n' "$change_result" | sed -n 's/^BACKUP=//p')"
if [[ -n "$backup" && ! -f "$backup" ]]; then echo 'ไม่พบ backup หลัง apply' >&2; exit 1; fi
rollback() {
  if [[ -n "$backup" ]]; then
    cp -p "$backup" "$hba"
    psql_pg -Atqc 'select pg_reload_conf()' >/dev/null || true
    echo "ย้อน pg_hba.conf กลับจาก $backup" >&2
  fi
}
errors="$(psql_pg -Atqc 'select count(*) from pg_hba_file_rules where error is not null')" || { rollback; exit 1; }
if [[ "$errors" != 0 ]]; then rollback; echo "pg_hba_file_rules พบ error $errors" >&2; exit 1; fi
# ต้องเห็น 4 กฎของ UAT ในไฟล์จริงก่อน reload
count="$(psql_pg -Atqc "select count(*) from pg_hba_file_rules where line_number < (select min(line_number) from pg_hba_file_rules where type='host' and database='{all}' and user_name='{all}' and address='0.0.0.0' and auth_method='md5') and (database::text like '%dcontact_uat%' or user_name::text like '%dcontact_app%')")"
if [[ "$count" -lt 3 ]]; then rollback; echo 'กฎ UAT ไม่อยู่ก่อน broad md5 rule' >&2; exit 1; fi
reloaded="$(psql_pg -Atqc 'select pg_reload_conf()')" || { rollback; exit 1; }
if [[ "$reloaded" != t ]]; then rollback; echo 'pg_reload_conf() ล้ม' >&2; exit 1; fi
printf 'APPLY ผ่าน: %s; UAT rules อยู่ก่อน broad md5; reload แล้ว\n' "$hba"
