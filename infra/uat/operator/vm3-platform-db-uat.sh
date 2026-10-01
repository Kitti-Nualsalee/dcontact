#!/usr/bin/env bash
# A1.9 (#574): เพิ่ม login member ของ role A1 บน VM3 โดยคง parent NOLOGIN ของ ADR-030
# รันบน VM3: sudo bash vm3-platform-db-uat.sh --check แล้ว --apply
set -euo pipefail
mode="${1:---check}"
[[ "$mode" == --check || "$mode" == --apply ]] || { echo 'usage: sudo bash vm3-platform-db-uat.sh [--check|--apply]' >&2; exit 64; }
[[ "$(id -u)" == 0 && "${SUDO_USER:-}" == osdadmin ]] || { echo 'ต้องรันด้วย sudo จาก osdadmin บน VM3' >&2; exit 1; }
ip -4 -o addr show | grep -Fq '192.168.102.113/' || { echo 'เครื่องนี้ไม่ใช่ VM3 ที่คาดไว้' >&2; exit 1; }

python3 - "$mode" <<'PY'
import os, secrets, shutil, stat, string, subprocess, sys, tempfile
from datetime import datetime, timezone
from pathlib import Path

mode = sys.argv[1]
bundle = Path('/home/osdadmin/dcontact-platform-uat-db-credentials.env')

def sql(query, database='postgres'):
    result = subprocess.run(
        ['runuser', '-u', 'postgres', '--', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-d', database],
        input=query, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    if result.returncode:
        raise SystemExit('PostgreSQL operation ล้ม; ไม่แสดง SQL หรือ secret')
    return result.stdout.strip()

if not sql('show server_version_num;').startswith('150'):
    raise SystemExit('ต้องเป็น PostgreSQL 15')
if sql("select count(*) from pg_roles where rolname in ('dcontact_platform','dcontact_provisioner') and not rolcanlogin and not rolbypassrls;") != '2':
    raise SystemExit('parent role ของ A1 ไม่ตรง ADR-030')
if sql("select count(*) from pg_database where datname='dcontact_uat';") != '1':
    raise SystemExit('ไม่พบ dcontact_uat')
if sql('select count(*) from pg_hba_file_rules where error is not null;') != '0':
    raise SystemExit('pg_hba.conf เดิมมี error')

roles = ('dcontact_platform_login', 'dcontact_provisioner_login')
existing = sql("select rolname from pg_roles where rolname in ('dcontact_platform_login','dcontact_provisioner_login') order by 1;").splitlines()
if existing and existing != sorted(roles):
    raise SystemExit('พบ login role เพียงบางส่วน; หยุดให้ตรวจด้วยมือ')

hba_path = Path(sql('show hba_file;'))
text = hba_path.read_text()
start = '# BEGIN DCONTACT UAT 3VM (ADR-030)'
marker = '# BEGIN DCONTACT PLATFORM UAT (A1.9)'
end = '# END DCONTACT PLATFORM UAT (A1.9)'
block = '\n'.join((
    marker,
    'host  dcontact_uat  dcontact_platform_login,dcontact_provisioner_login  192.168.102.112/32  scram-sha-256',
    'host  all  dcontact_platform_login,dcontact_provisioner_login  0.0.0.0/0  reject',
    end,
)) + '\n'
if text.count(start) != 1:
    raise SystemExit('ไม่พบ UAT pg_hba block ที่คาดไว้')
if marker in text and (text.count(block) != 1 or text.index(block) > text.index(start)):
    raise SystemExit('พบ platform pg_hba block ที่ต่างจาก expected')

print(f'CHECK: login roles {len(existing)}/2; HBA {"present" if marker in text else "missing"}; credential bundle {"present" if bundle.exists() else "absent"}')
if mode == '--check':
    print('CHECK ผ่าน; --apply จะสร้าง login member และ HBA เฉพาะ VM2 โดยไม่เปลี่ยน parent role')
    sys.exit(0)

if not existing:
    if bundle.exists():
        raise SystemExit('พบ credential bundle เดิมแต่ไม่มี role; หยุดเพื่อตรวจ')
    alphabet = string.ascii_letters + string.digits
    passwords = [''.join(secrets.choice(alphabet) for _ in range(48)) for _ in roles]
    fd = os.open(bundle, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as out:
        out.write(f'PLATFORM_DB_PASSWORD={passwords[0]}\nPROVISIONER_DB_PASSWORD={passwords[1]}\n')
        out.flush()
        os.fsync(out.fileno())
    os.chown(bundle, int(os.environ['SUDO_UID']), int(os.environ['SUDO_GID']))
    sql(f"""
BEGIN;
SET LOCAL password_encryption = 'scram-sha-256';
CREATE ROLE dcontact_platform_login LOGIN INHERIT NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '{passwords[0]}';
CREATE ROLE dcontact_provisioner_login LOGIN INHERIT NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '{passwords[1]}';
GRANT dcontact_platform TO dcontact_platform_login;
GRANT dcontact_provisioner TO dcontact_provisioner_login;
GRANT CONNECT ON DATABASE dcontact_uat TO dcontact_platform_login,dcontact_provisioner_login;
COMMIT;
""")

if marker not in text:
    before = hba_path.stat()
    backup = hba_path.with_name(hba_path.name + '.dcontact-platform-uat.' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '.bak')
    if backup.exists():
        raise SystemExit('ชื่อ backup pg_hba ซ้ำ')
    shutil.copy2(hba_path, backup)
    updated = text.replace(start, block + start, 1)
    fd, temporary = tempfile.mkstemp(prefix='.pg_hba.platform-uat.', dir=hba_path.parent)
    try:
        with os.fdopen(fd, 'w') as out:
            out.write(updated)
            out.flush()
            os.fsync(out.fileno())
        os.chown(temporary, before.st_uid, before.st_gid)
        os.chmod(temporary, stat.S_IMODE(before.st_mode))
        os.replace(temporary, hba_path)
        if sql('select count(*) from pg_hba_file_rules where error is not null;') != '0':
            raise RuntimeError('pg_hba_file_rules พบ error')
        if sql('select pg_reload_conf();') != 't':
            raise RuntimeError('pg_reload_conf ล้ม')
    except BaseException:
        shutil.copy2(backup, hba_path)
        sql('select pg_reload_conf();')
        raise
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print(f'BACKUP={backup}')

if sql("select count(*) from pg_roles where rolname in ('dcontact_platform_login','dcontact_provisioner_login') and rolcanlogin and not rolbypassrls;") != '2':
    raise SystemExit('login role invariant ล้ม')
if sql("select count(*) from pg_roles where rolname in ('dcontact_platform','dcontact_provisioner') and not rolcanlogin;") != '2':
    raise SystemExit('parent NOLOGIN invariant ล้ม')
print('APPLY ผ่าน: login member 2 roles; parent NOLOGIN คงเดิม; pg_hba reload แล้ว')
if bundle.exists():
    print(f'credential bundle: {bundle} (mode 600; ส่งไป VM2 ทาง SSH แล้วลบจาก VM3)')
PY
