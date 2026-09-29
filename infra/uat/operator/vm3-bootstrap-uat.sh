#!/usr/bin/env bash
# #537 / ADR-030: สร้าง role/database ของ UAT ครั้งแรกบน VM3 ผ่าน local peer auth
# รันด้วย sudo บน VM3; ไม่ใช้ password ของระบบเดิม ไม่แสดง secret ใน stdout/stderr
set -euo pipefail
mode="${1:---check}"
[[ "$mode" == --check || "$mode" == --apply ]] || { echo 'usage: sudo bash vm3-bootstrap-uat.sh [--check|--apply]' >&2; exit 64; }
[[ "$(id -u)" -eq 0 ]] || { echo 'ต้องรันด้วย sudo บน VM3' >&2; exit 1; }
ip -4 -o addr show | grep -Fq '192.168.102.113/' || { echo 'เครื่องนี้ไม่มี IP VM3 ที่คาดไว้' >&2; exit 1; }
[[ "${SUDO_USER:-}" == osdadmin ]] || { echo 'คาดว่า sudo มาจาก osdadmin' >&2; exit 1; }

python3 - "$mode" <<'PY'
import os, secrets, string, subprocess, sys
from pathlib import Path

mode = sys.argv[1]
bundle = Path('/home/osdadmin/dcontact-uat-db-credentials.env')
roles = ('dcontact_uat_owner', 'dcontact_app', 'dcontact_platform', 'dcontact_provisioner', 'keycloak')
databases = ('dcontact_uat', 'keycloak_uat')

def query(sql):
    result = subprocess.run(
        ['runuser', '-u', 'postgres', '--', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-d', 'postgres'],
        input=sql, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    if result.returncode:
        raise SystemExit('ตรวจ PostgreSQL ไม่ผ่าน; ไม่มีการแสดง SQL หรือ secret')
    return result.stdout.strip()

def apply(sql, step):
    result = subprocess.run(
        ['runuser', '-u', 'postgres', '--', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-q', '-d', 'postgres'],
        input=sql, text=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
    )
    if result.returncode:
        raise SystemExit(f'{step} ล้ม; credential bundle คงอยู่สำหรับการตรวจ/กู้คืน')

version = query('show server_version_num;')
if not version.startswith('150'):
    raise SystemExit(f'คาดว่า server เป็น PostgreSQL 15; พบ {version}')
existing_roles = query("select rolname from pg_roles where rolname in ('dcontact_uat_owner','dcontact_app','dcontact_platform','dcontact_provisioner','keycloak') order by 1;").splitlines()
existing_databases = query("select datname from pg_database where datname in ('dcontact_uat','keycloak_uat') order by 1;").splitlines()
print(f'PostgreSQL {version}; role UAT ที่มีแล้ว: {len(existing_roles)}/5; database UAT ที่มีแล้ว: {len(existing_databases)}/2')

if mode == '--check':
    if existing_roles or existing_databases or bundle.exists():
        raise SystemExit('พบทรัพยากร UAT เดิม; หยุดและตรวจด้วยมือก่อน bootstrap')
    print('CHECK ผ่าน: --apply จะสร้าง role/database แยกของ UAT และ credential bundle mode 600')
    sys.exit(0)
if existing_roles or existing_databases or bundle.exists():
    raise SystemExit('พบทรัพยากร UAT เดิม; ไม่สร้างทับหรือตั้งรหัสผ่านใหม่')

alphabet = string.ascii_letters + string.digits
passwords = {name: ''.join(secrets.choice(alphabet) for _ in range(48)) for name in ('OWNER', 'APP', 'KEYCLOAK')}
fd = os.open(bundle, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
try:
    with os.fdopen(fd, 'w') as file:
        file.write('UAT_POSTGRES_USER=dcontact_uat_owner\n')
        file.write(f'UAT_POSTGRES_PASSWORD={passwords["OWNER"]}\n')
        file.write(f'UAT_APP_DB_PASSWORD={passwords["APP"]}\n')
        file.write(f'UAT_KEYCLOAK_DB_PASSWORD={passwords["KEYCLOAK"]}\n')
        file.flush()
        os.fsync(file.fileno())
    os.chown(bundle, int(os.environ['SUDO_UID']), int(os.environ['SUDO_GID']))
except BaseException:
    bundle.unlink(missing_ok=True)
    raise

# password เป็น alphanumeric 48 ตัวเท่านั้น จึงไม่มีอักขระที่เปลี่ยนความหมายของ SQL literal
apply(f"""
BEGIN;
SET LOCAL password_encryption = 'scram-sha-256';
CREATE ROLE dcontact_uat_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '{passwords['OWNER']}';
CREATE ROLE dcontact_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '{passwords['APP']}';
CREATE ROLE keycloak LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '{passwords['KEYCLOAK']}';
CREATE ROLE dcontact_platform NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE dcontact_provisioner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
COMMIT;
""", 'สร้าง role')
apply('CREATE DATABASE dcontact_uat OWNER dcontact_uat_owner;\n', 'สร้าง dcontact_uat')
apply('CREATE DATABASE keycloak_uat OWNER keycloak;\n', 'สร้าง keycloak_uat')
apply('REVOKE ALL ON DATABASE dcontact_uat FROM PUBLIC;\nREVOKE ALL ON DATABASE keycloak_uat FROM PUBLIC;\nGRANT CONNECT ON DATABASE dcontact_uat TO dcontact_app;\n', 'จำกัดสิทธิ์ database')

if query("select count(*) from pg_roles where rolname in ('dcontact_platform','dcontact_provisioner') and rolcanlogin") != '0':
    raise SystemExit('role platform/provisioner ไม่ใช่ NOLOGIN; หยุดเพื่อตรวจด้วยมือ')
if query("select count(*) from pg_database where datname in ('dcontact_uat','keycloak_uat')") != '2':
    raise SystemExit('database UAT ไม่ครบ; หยุดเพื่อตรวจด้วยมือ')
print('APPLY ผ่าน: สร้าง 5 roles / 2 databases; platform/provisioner เป็น NOLOGIN')
print(f'credential bundle: {bundle} (mode 600; ส่งต่อ VM2 ทาง SSH แล้วลบจาก VM3)')
PY
