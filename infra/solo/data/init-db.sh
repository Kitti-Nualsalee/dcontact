#!/bin/sh
# #923: เตรียม PostgreSQL บน VM data ของ UAT Solo — รันบน VM data ด้วย sudo (idempotent)
#
#   sudo SOLO_ENV=/path/solo.env sh init-db.sh [--reset]
#
# อ่านรหัสผ่านจาก solo.env (สร้างโดย infra/solo/bin/solo-uat.sh) ไม่พิมพ์ค่า secret
# --reset ลบฐานทั้งหมดของ Solo แล้วสร้างใหม่ (owner อนุมัติให้ล้างข้อมูล UAT ได้)
#
# role:
#   dcontact              owner ของฐานแอป เป็น SUPERUSER เหมือน dev (infra/docker) เพราะ guard ใน schema
#                         เช่น TEAM_TENANT_CONTEXT_REQUIRED และ API แบบเต็มอาศัย session superuser ของ owner
#                         รับ login เฉพาะ VM app/voice ตาม pg_hba
#   dcontact_app          runtime NOBYPASSRLS — สร้างก่อน rls.sql เพื่อไม่ให้ได้รหัสผ่าน dev ใน rls.sql
#   dcontact_platform     runtime ของ platform NOBYPASSRLS
#   dcontact_provisioner  provisioning NOBYPASSRLS
#   keycloak              owner ของฐาน keycloak
#   voice_edge_owner      owner ของฐาน voice edge (Kamailio อ่านด้วย kamailio_ro จาก grant-kamailio.sql)
#   dcontact_tenant_people_worker  NOLOGIN ที่ migration ต้องใช้ (owner สร้าง role เองไม่ได้)
set -eu

: "${SOLO_ENV:?SOLO_ENV is required}"
[ -r "$SOLO_ENV" ] || { echo "อ่าน $SOLO_ENV ไม่ได้" >&2; exit 64; }

value() {
  sed -n "s/^$1=//p" "$SOLO_ENV" | tail -1
}

psql_super() {
  sudo -u postgres psql -v ON_ERROR_STOP=1 -X -q "$@"
}

ensure_role() { # ensure_role <name> <password> <attributes>
  [ -n "$2" ] || { echo "ไม่มีรหัสผ่านของ role $1 ใน solo.env" >&2; exit 64; }
  psql_super -d postgres -v name="$1" -v password="$2" <<SQL
SELECT format('CREATE ROLE %I LOGIN', :'name')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'name') \gexec
ALTER ROLE :"name" WITH LOGIN PASSWORD :'password' $3;
SQL
}

ensure_database() { # ensure_database <name> <owner>
  psql_super -d postgres -v name="$1" -v owner="$2" <<'SQL'
SELECT format('CREATE DATABASE %I OWNER %I', :'name', :'owner')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'name') \gexec
SQL
}

if [ "${1:-}" = "--reset" ]; then
  for database in dcontact keycloak dcontact_voice_edge; do
    psql_super -d postgres -v name="$database" <<'SQL'
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = :'name' AND pid <> pg_backend_pid();
SELECT format('DROP DATABASE IF EXISTS %I', :'name') \gexec
SQL
  done
  echo "ลบฐานของ Solo แล้ว"
fi

ensure_role dcontact "$(value SOLO_DB_OWNER_PASSWORD)" 'SUPERUSER'
ensure_role dcontact_app "$(value SOLO_DB_APP_PASSWORD)" 'NOSUPERUSER NOBYPASSRLS'
ensure_role dcontact_platform "$(value SOLO_DB_PLATFORM_PASSWORD)" 'NOSUPERUSER NOBYPASSRLS'
ensure_role dcontact_provisioner "$(value SOLO_DB_PROVISIONER_PASSWORD)" 'NOSUPERUSER NOBYPASSRLS'
ensure_role keycloak "$(value SOLO_KEYCLOAK_DB_PASSWORD)" 'NOSUPERUSER NOBYPASSRLS'
ensure_role voice_edge_owner "$(value SOLO_VOICE_EDGE_OWNER_PASSWORD)" 'NOSUPERUSER NOBYPASSRLS'

# migration 20261020100000 สร้าง role นี้เองถ้ายังไม่มี แต่ owner ไม่มี CREATEROLE — สร้างไว้ก่อนแบบเดียวกับ UAT 3 VM
psql_super -d postgres <<'SQL'
SELECT 'CREATE ROLE dcontact_tenant_people_worker NOLOGIN NOBYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dcontact_tenant_people_worker') \gexec
SQL

ensure_database dcontact dcontact
ensure_database keycloak keycloak
ensure_database dcontact_voice_edge voice_edge_owner

# Prisma ต้องสร้าง/แก้ object ใน schema public ของฐานแอป
psql_super -d dcontact -c 'GRANT ALL ON SCHEMA public TO dcontact; ALTER SCHEMA public OWNER TO dcontact;'
psql_super -d keycloak -c 'ALTER SCHEMA public OWNER TO keycloak;'
psql_super -d dcontact_voice_edge -c 'ALTER SCHEMA public OWNER TO voice_edge_owner;'

echo "ฐาน Solo พร้อม: dcontact, keycloak, dcontact_voice_edge"
