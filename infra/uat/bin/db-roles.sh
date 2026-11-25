#!/bin/sh
# U1.6 (#434): Postgres roles in UAT; runs in the postgres container (compose service `db-roles`)
#
# - the Keycloak role/database (password from UAT_KEYCLOAK_DB_PASSWORD)
# - `dcontact_app` (the API role, NOBYPASSRLS from rls.sql) gets its password from UAT_APP_DB_PASSWORD
#   rls.sql creates the role with the dev password, so it must be overwritten every time (never share credentials with dev)
# - `dcontact_platform`/`dcontact_provisioner` are not used in the UAT first slice → NOLOGIN with no password
# runs both before and after migrate (idempotent)
#
# passwords go through psql variables over stdin, so they never appear in a command line or log
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

-- before the first migrate the application role does not exist yet; create it as NOLOGIN in advance and rls.sql grants privileges later
SELECT 'CREATE ROLE dcontact_app NOLOGIN NOBYPASSRLS'
  WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dcontact_app') \gexec
ALTER ROLE dcontact_app WITH LOGIN NOBYPASSRLS PASSWORD :'app_password';

-- migration/rls.sql creates the Platform roles with the dev password if they do not exist; create them as NOLOGIN first
-- so there is never a window where these roles can log in with the dev password (the UAT first slice does not use Platform)
SELECT format('CREATE ROLE %I NOLOGIN NOBYPASSRLS', name)
  FROM unnest(ARRAY['dcontact_platform', 'dcontact_provisioner']) AS name
  WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = name) \gexec
SELECT format('ALTER ROLE %I NOLOGIN PASSWORD NULL', rolname)
  FROM pg_roles WHERE rolname IN ('dcontact_platform', 'dcontact_provisioner') \gexec
SQL

echo '{"type":"u1.uat.db-roles","status":"PASS"}'
