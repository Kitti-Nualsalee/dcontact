#!/bin/sh
# #923: prepare PostgreSQL on the data VM of UAT Solo — run on the data VM with sudo (idempotent)
#
#   sudo SOLO_ENV=/path/solo.env sh init-db.sh [--reset]
#
# reads passwords from solo.env (created by infra/solo/bin/solo-uat.sh) and never prints secret values
# --reset deletes all Solo databases and recreates them (the owner approved wiping UAT data)
#
# role:
#   dcontact              owner of the app database, a SUPERUSER like dev (infra/docker) because schema guards
#                         such as TEAM_TENANT_CONTEXT_REQUIRED and the full API rely on the owner's superuser session
#                         accepts logins from the app/voice VMs only, per pg_hba
#   dcontact_app          runtime NOBYPASSRLS — created before rls.sql so rls.sql does not give it the dev password
#   dcontact_platform     platform runtime NOBYPASSRLS
#   dcontact_provisioner  provisioning NOBYPASSRLS
#   keycloak              owner of the keycloak database
#   voice_edge_owner      owner of the voice edge database (Kamailio reads it as kamailio_ro from grant-kamailio.sql)
#   dcontact_tenant_people_worker  NOLOGIN, needed by a migration (the owner cannot create the role itself)
set -eu

: "${SOLO_ENV:?SOLO_ENV is required}"
[ -r "$SOLO_ENV" ] || { echo "cannot read $SOLO_ENV" >&2; exit 64; }

value() {
  sed -n "s/^$1=//p" "$SOLO_ENV" | tail -1
}

psql_super() {
  sudo -u postgres psql -v ON_ERROR_STOP=1 -X -q "$@"
}

ensure_role() { # ensure_role <name> <password> <attributes>
  [ -n "$2" ] || { echo "no password for role $1 in solo.env" >&2; exit 64; }
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
  echo "Solo databases deleted"
fi

ensure_role dcontact "$(value SOLO_DB_OWNER_PASSWORD)" 'SUPERUSER'
ensure_role dcontact_app "$(value SOLO_DB_APP_PASSWORD)" 'NOSUPERUSER NOBYPASSRLS'
ensure_role dcontact_platform "$(value SOLO_DB_PLATFORM_PASSWORD)" 'NOSUPERUSER NOBYPASSRLS'
ensure_role dcontact_provisioner "$(value SOLO_DB_PROVISIONER_PASSWORD)" 'NOSUPERUSER NOBYPASSRLS'
ensure_role keycloak "$(value SOLO_KEYCLOAK_DB_PASSWORD)" 'NOSUPERUSER NOBYPASSRLS'
ensure_role voice_edge_owner "$(value SOLO_VOICE_EDGE_OWNER_PASSWORD)" 'NOSUPERUSER NOBYPASSRLS'

# migration 20261020100000 creates this role itself if it does not exist, but the owner has no CREATEROLE — create it first, the same way as the 3-VM UAT
psql_super -d postgres <<'SQL'
SELECT 'CREATE ROLE dcontact_tenant_people_worker NOLOGIN NOBYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dcontact_tenant_people_worker') \gexec
SQL

ensure_database dcontact dcontact
ensure_database keycloak keycloak
ensure_database dcontact_voice_edge voice_edge_owner

# Prisma must create/alter objects in schema public of the app database
psql_super -d dcontact -c 'GRANT ALL ON SCHEMA public TO dcontact; ALTER SCHEMA public OWNER TO dcontact;'
psql_super -d keycloak -c 'ALTER SCHEMA public OWNER TO keycloak;'
psql_super -d dcontact_voice_edge -c 'ALTER SCHEMA public OWNER TO voice_edge_owner;'

echo "Solo databases ready: dcontact, keycloak, dcontact_voice_edge"
