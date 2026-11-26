#!/usr/bin/env bash
# #537 / ADR-030: first-time creation of the UAT roles/database on VM3 through local peer auth
# run with sudo on VM3; does not use the old system's password and shows no secrets on stdout/stderr
set -euo pipefail
mode="${1:---check}"
[[ "$mode" == --check || "$mode" == --apply ]] || { echo 'usage: sudo bash vm3-bootstrap-uat.sh [--check|--apply]' >&2; exit 64; }
[[ "$(id -u)" -eq 0 ]] || { echo 'must run with sudo on VM3' >&2; exit 1; }
ip -4 -o addr show | grep -Fq '192.168.102.113/' || { echo 'this machine does not have the expected VM3 IP' >&2; exit 1; }
[[ "${SUDO_USER:-}" == osdadmin ]] || { echo 'expected sudo to come from osdadmin' >&2; exit 1; }

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
        raise SystemExit('PostgreSQL check failed; no SQL or secret is shown')
    return result.stdout.strip()

def apply(sql, step):
    result = subprocess.run(
        ['runuser', '-u', 'postgres', '--', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-q', '-d', 'postgres'],
        input=sql, text=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
    )
    if result.returncode:
        raise SystemExit(f'{step} failed; the credential bundle is kept for checking/recovery')

version = query('show server_version_num;')
if not version.startswith('150'):
    raise SystemExit(f'expected the server to be PostgreSQL 15; found {version}')
existing_roles = query("select rolname from pg_roles where rolname in ('dcontact_uat_owner','dcontact_app','dcontact_platform','dcontact_provisioner','keycloak') order by 1;").splitlines()
existing_databases = query("select datname from pg_database where datname in ('dcontact_uat','keycloak_uat') order by 1;").splitlines()
print(f'PostgreSQL {version}; UAT roles that already exist: {len(existing_roles)}/5; UAT databases that already exist: {len(existing_databases)}/2')

if mode == '--check':
    if existing_roles or existing_databases or bundle.exists():
        raise SystemExit('found existing UAT resources; stopping to check by hand before bootstrap')
    print('CHECK passed: --apply will create separate UAT roles/databases and a credential bundle with mode 600')
    sys.exit(0)
if existing_roles or existing_databases or bundle.exists():
    raise SystemExit('found existing UAT resources; not creating over them or resetting passwords')

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

# the password is exactly 48 alphanumeric characters, so there is no character that changes the meaning of a SQL literal
apply(f"""
BEGIN;
SET LOCAL password_encryption = 'scram-sha-256';
CREATE ROLE dcontact_uat_owner LOGIN INHERIT BYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '{passwords['OWNER']}';
CREATE ROLE dcontact_app LOGIN INHERIT NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '{passwords['APP']}';
CREATE ROLE keycloak LOGIN INHERIT NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '{passwords['KEYCLOAK']}';
CREATE ROLE dcontact_platform NOLOGIN INHERIT NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE dcontact_provisioner NOLOGIN INHERIT NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
COMMIT;
""", 'create roles')
apply('CREATE DATABASE dcontact_uat OWNER dcontact_uat_owner;\n', 'create dcontact_uat')
apply('CREATE DATABASE keycloak_uat OWNER keycloak;\n', 'create keycloak_uat')
apply('REVOKE ALL ON DATABASE dcontact_uat FROM PUBLIC;\nREVOKE ALL ON DATABASE keycloak_uat FROM PUBLIC;\nGRANT CONNECT ON DATABASE dcontact_uat TO dcontact_app;\n', 'restrict database privileges')

if query("select count(*) from pg_roles where rolname in ('dcontact_platform','dcontact_provisioner') and rolcanlogin") != '0':
    raise SystemExit('the platform/provisioner roles are not NOLOGIN; stopping to check by hand')
if query("select rolcanlogin || ':' || rolinherit || ':' || rolsuper || ':' || rolbypassrls from pg_roles where rolname = 'dcontact_uat_owner'") != 'true:true:false:true':
    raise SystemExit('role dcontact_uat_owner must be LOGIN INHERIT BYPASSRLS NOSUPERUSER for migrate/backup')
if query("select rolcanlogin || ':' || rolinherit || ':' || rolsuper || ':' || rolbypassrls from pg_roles where rolname = 'dcontact_app'") != 'true:true:false:false':
    raise SystemExit('role dcontact_app must be LOGIN INHERIT NOBYPASSRLS for the API')
if query("select count(*) from pg_database where datname in ('dcontact_uat','keycloak_uat')") != '2':
    raise SystemExit('the UAT databases are incomplete; stopping to check by hand')
print('APPLY passed: created 5 roles / 2 databases; the owner uses BYPASSRLS for migrate/backup only and the API uses NOBYPASSRLS')
print(f'credential bundle: {bundle} (mode 600; forward to VM2 over SSH then delete from VM3)')
PY
