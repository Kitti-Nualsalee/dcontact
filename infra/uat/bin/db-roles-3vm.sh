#!/bin/sh
# #537: VM3 bootstrap เป็นผู้สร้าง role/database และตั้ง password; job นี้ตรวจ invariant ก่อน migrate
set -eu
: "${PGHOST:?PGHOST is required}"
: "${PGDATABASE:?PGDATABASE is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGPASSWORD:?PGPASSWORD is required}"
[ "$PGHOST" = db-relay ] && [ "$PGDATABASE" = dcontact_uat ] && [ "$PGUSER" = dcontact_uat_owner ] || exit 1

result="$(psql -X -At -v ON_ERROR_STOP=1 -c "SELECT
  (SELECT count(*) FROM pg_roles WHERE rolname='dcontact_app' AND rolcanlogin AND NOT rolbypassrls),
  (SELECT count(*) FROM pg_roles WHERE rolname='keycloak' AND rolcanlogin),
  (SELECT count(*) FROM pg_roles WHERE rolname IN ('dcontact_platform','dcontact_provisioner') AND NOT rolcanlogin AND NOT rolbypassrls),
  (SELECT count(*) FROM pg_database WHERE datname IN ('dcontact_uat','keycloak_uat'));" )"
[ "$result" = '1|1|2|2' ] || { echo '{"type":"u1.uat.db-roles","status":"FAIL","reason":"BOOTSTRAP_INVARIANT"}' >&2; exit 1; }

echo '{"type":"u1.uat.db-roles","status":"PASS"}'
