#!/usr/bin/env bash
# #490: let the UAT-only owner dump FORCE RLS tables without adding privileges to the API
set -euo pipefail

mode="${1:---check}"
[[ "$mode" == --check || "$mode" == --apply ]] || { echo 'usage: sudo bash vm3-uat-backup-role.sh [--check|--apply]' >&2; exit 64; }
[[ "$(id -u)" -eq 0 ]] || { echo 'must run with sudo on VM3' >&2; exit 1; }
ip -4 -o addr show | grep -Fq '192.168.102.113/' || { echo 'this machine does not have the expected VM3 IP' >&2; exit 1; }
[[ "${SUDO_USER:-}" == osdadmin ]] || { echo 'expected sudo to come from osdadmin' >&2; exit 1; }

python3 - "$mode" <<'PY'
import subprocess, sys

mode = sys.argv[1]

def query(sql):
    result = subprocess.run(
        ['runuser', '-u', 'postgres', '--', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-d', 'postgres'],
        input=sql, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    if result.returncode:
        raise SystemExit('PostgreSQL check failed; no SQL or secret is shown')
    return result.stdout.strip()

def apply(sql):
    result = subprocess.run(
        ['runuser', '-u', 'postgres', '--', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-q', '-d', 'postgres'],
        input=sql, text=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
    )
    if result.returncode:
        raise SystemExit('configuring the role for backup failed; no SQL or secret is shown')

version = query('show server_version_num;')
if not version.startswith('150'):
    raise SystemExit(f'expected the server to be PostgreSQL 15; found {version}')

owner = query("select rolcanlogin || ':' || rolinherit || ':' || rolsuper || ':' || rolbypassrls from pg_roles where rolname = 'dcontact_uat_owner';")
app = query("select rolcanlogin || ':' || rolinherit || ':' || rolsuper || ':' || rolbypassrls from pg_roles where rolname = 'dcontact_app';")
database_owner = query("select pg_get_userbyid(datdba) from pg_database where datname = 'dcontact_uat';")

if owner not in ('true:true:false:false', 'true:true:false:true'):
    raise SystemExit('role dcontact_uat_owner does not match the expected UAT owner; stopping to check by hand')
if app != 'true:true:false:false':
    raise SystemExit('role dcontact_app must be LOGIN INHERIT NOBYPASSRLS; stopping to check by hand')
if database_owner != 'dcontact_uat_owner':
    raise SystemExit('the owner of database dcontact_uat is not dcontact_uat_owner; stopping to check by hand')

if mode == '--check':
    if owner == 'true:true:false:true':
        print('CHECK passed: dcontact_uat_owner is BYPASSRLS for migrate/backup; dcontact_app is still NOBYPASSRLS')
        sys.exit(0)
    raise SystemExit('dcontact_uat_owner is still NOBYPASSRLS, so pg_dump of FORCE RLS tables fails; run --apply to repair only this UAT role')

apply('ALTER ROLE dcontact_uat_owner BYPASSRLS;')
owner_after = query("select rolcanlogin || ':' || rolinherit || ':' || rolsuper || ':' || rolbypassrls from pg_roles where rolname = 'dcontact_uat_owner';")
app_after = query("select rolcanlogin || ':' || rolinherit || ':' || rolsuper || ':' || rolbypassrls from pg_roles where rolname = 'dcontact_app';")
if owner_after != 'true:true:false:true' or app_after != 'true:true:false:false':
    raise SystemExit('the post-repair role check failed; stopping to check by hand')
print('APPLY passed: dcontact_uat_owner is BYPASSRLS for migrate/backup only; dcontact_app is still NOBYPASSRLS')
PY
