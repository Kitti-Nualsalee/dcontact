#!/bin/sh
# U1.6 (#434): role ของ Postgres ใน UAT — รันใน container postgres (compose service `db-roles`)
#
# - role/database ของ Keycloak (รหัสผ่านจาก UAT_KEYCLOAK_DB_PASSWORD)
# - `dcontact_app` (role ของ API, NOBYPASSRLS จาก rls.sql) ตั้งรหัสผ่านจาก UAT_APP_DB_PASSWORD
#   rls.sql สร้าง role ด้วยรหัสผ่านของ dev จึงต้องเขียนทับทุกครั้ง (ห้ามใช้ credential ร่วมกับ dev)
# - `dcontact_platform`/`dcontact_provisioner` ไม่ถูกใช้ใน UAT first slice → NOLOGIN ไม่มีรหัสผ่าน
# รันทั้งก่อนและหลัง migrate (idempotent)
#
# รหัสผ่านส่งผ่านตัวแปรของ psql ทาง stdin — ไม่ปรากฏใน command line หรือ log
set -eu

: "${UAT_KEYCLOAK_DB_PASSWORD:?UAT_KEYCLOAK_DB_PASSWORD is required}"
: "${UAT_APP_DB_PASSWORD:?UAT_APP_DB_PASSWORD is required}"

psql -v ON_ERROR_STOP=1 -q \
  -v keycloak_password="$UAT_KEYCLOAK_DB_PASSWORD" \
  -v app_password="$UAT_APP_DB_PASSWORD" <<'SQL'
SELECT 'CREATE ROLE keycloak LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE'
  WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'keycloak') \gexec
ALTER ROLE keycloak WITH LOGIN PASSWORD :'keycloak_password';
SELECT 'CREATE DATABASE keycloak OWNER keycloak'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'keycloak') \gexec

-- ก่อน migrate ครั้งแรก role ของ application ยังไม่มี — สร้างรอไว้แบบ NOLOGIN แล้ว rls.sql ให้สิทธิ์ภายหลัง
SELECT 'CREATE ROLE dcontact_app NOLOGIN NOBYPASSRLS'
  WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dcontact_app') \gexec
ALTER ROLE dcontact_app WITH LOGIN NOBYPASSRLS PASSWORD :'app_password';

-- migration/rls.sql สร้าง role ของ Platform ด้วยรหัสผ่านของ dev ถ้ายังไม่มี — สร้างรอไว้แบบ NOLOGIN ก่อน
-- จึงไม่มีช่วงที่ role เหล่านี้ login ด้วยรหัสผ่านของ dev ได้ (UAT first slice ไม่ใช้ Platform)
SELECT format('CREATE ROLE %I NOLOGIN NOBYPASSRLS', name)
  FROM unnest(ARRAY['dcontact_platform', 'dcontact_provisioner']) AS name
  WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = name) \gexec
SELECT format('ALTER ROLE %I NOLOGIN PASSWORD NULL', rolname)
  FROM pg_roles WHERE rolname IN ('dcontact_platform', 'dcontact_provisioner') \gexec
SQL

echo '{"type":"u1.uat.db-roles","status":"PASS"}'
