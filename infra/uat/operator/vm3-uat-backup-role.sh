#!/usr/bin/env bash
# #490: ทำให้ owner เฉพาะ UAT dump ตาราง FORCE RLS ได้ โดยไม่เพิ่มสิทธิ์ให้ API
set -euo pipefail

mode="${1:---check}"
[[ "$mode" == --check || "$mode" == --apply ]] || { echo 'usage: sudo bash vm3-uat-backup-role.sh [--check|--apply]' >&2; exit 64; }
[[ "$(id -u)" -eq 0 ]] || { echo 'ต้องรันด้วย sudo บน VM3' >&2; exit 1; }
ip -4 -o addr show | grep -Fq '192.168.102.113/' || { echo 'เครื่องนี้ไม่มี IP VM3 ที่คาดไว้' >&2; exit 1; }
[[ "${SUDO_USER:-}" == osdadmin ]] || { echo 'คาดว่า sudo มาจาก osdadmin' >&2; exit 1; }

python3 - "$mode" <<'PY'
import subprocess, sys

mode = sys.argv[1]

def query(sql):
    result = subprocess.run(
        ['runuser', '-u', 'postgres', '--', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-d', 'postgres'],
        input=sql, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    if result.returncode:
        raise SystemExit('ตรวจ PostgreSQL ไม่ผ่าน; ไม่มีการแสดง SQL หรือ secret')
    return result.stdout.strip()

def apply(sql):
    result = subprocess.run(
        ['runuser', '-u', 'postgres', '--', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-q', '-d', 'postgres'],
        input=sql, text=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
    )
    if result.returncode:
        raise SystemExit('ตั้งค่า role สำหรับ backup ไม่สำเร็จ; ไม่มีการแสดง SQL หรือ secret')

version = query('show server_version_num;')
if not version.startswith('150'):
    raise SystemExit(f'คาดว่า server เป็น PostgreSQL 15; พบ {version}')

owner = query("select rolcanlogin || ':' || rolinherit || ':' || rolsuper || ':' || rolbypassrls from pg_roles where rolname = 'dcontact_uat_owner';")
app = query("select rolcanlogin || ':' || rolinherit || ':' || rolsuper || ':' || rolbypassrls from pg_roles where rolname = 'dcontact_app';")
database_owner = query("select pg_get_userbyid(datdba) from pg_database where datname = 'dcontact_uat';")

if owner not in ('true:true:false:false', 'true:true:false:true'):
    raise SystemExit('role dcontact_uat_owner ไม่ตรงกับ UAT owner ที่คาดไว้; หยุดเพื่อตรวจด้วยมือ')
if app != 'true:true:false:false':
    raise SystemExit('role dcontact_app ต้องเป็น LOGIN INHERIT NOBYPASSRLS; หยุดเพื่อตรวจด้วยมือ')
if database_owner != 'dcontact_uat_owner':
    raise SystemExit('เจ้าของ database dcontact_uat ไม่ใช่ dcontact_uat_owner; หยุดเพื่อตรวจด้วยมือ')

if mode == '--check':
    if owner == 'true:true:false:true':
        print('CHECK ผ่าน: dcontact_uat_owner เป็น BYPASSRLS สำหรับ migrate/backup; dcontact_app ยังเป็น NOBYPASSRLS')
        sys.exit(0)
    raise SystemExit('dcontact_uat_owner ยังเป็น NOBYPASSRLS ทำให้ pg_dump ตาราง FORCE RLS ล้ม; รัน --apply เพื่อซ่อมเฉพาะ role UAT นี้')

apply('ALTER ROLE dcontact_uat_owner BYPASSRLS;')
owner_after = query("select rolcanlogin || ':' || rolinherit || ':' || rolsuper || ':' || rolbypassrls from pg_roles where rolname = 'dcontact_uat_owner';")
app_after = query("select rolcanlogin || ':' || rolinherit || ':' || rolsuper || ':' || rolbypassrls from pg_roles where rolname = 'dcontact_app';")
if owner_after != 'true:true:false:true' or app_after != 'true:true:false:false':
    raise SystemExit('ตรวจ role หลังแก้ไม่ผ่าน; หยุดเพื่อตรวจด้วยมือ')
print('APPLY ผ่าน: dcontact_uat_owner เป็น BYPASSRLS เฉพาะ migrate/backup; dcontact_app ยังเป็น NOBYPASSRLS')
PY
