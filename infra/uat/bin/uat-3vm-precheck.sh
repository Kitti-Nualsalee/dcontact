#!/usr/bin/env bash
# Check that all 3 VMs are ready before installing UAT (read-only; changes nothing on the VMs)
#
#   VM1 nginx      osdadmin@192.168.102.114  (web front / reverse proxy / TLS)
#   VM2 docker     osdadmin@192.168.102.112  (compose stack)
#   VM3 postgresql osdadmin@192.168.102.113  (database)
#
# Usage (run from a machine that can ssh into all 3 VMs without a password):
#   bash infra/uat/bin/uat-3vm-precheck.sh
#   PG_PASSWORD='...' bash infra/uat/bin/uat-3vm-precheck.sh   # also checks Postgres login/privileges
#
# Overridable variables: VM_NGINX VM_DOCKER VM_PG SSH_USER UAT_HOST PG_USER PG_PORT SSH_OPTS
# the password is never written to a file and never passed through argv (only over ssh's stdin)
set -u

VM_NGINX="${VM_NGINX:-192.168.102.114}"
VM_DOCKER="${VM_DOCKER:-192.168.102.112}"
VM_PG="${VM_PG:-192.168.102.113}"
SSH_USER="${SSH_USER:-osdadmin}"
UAT_HOST="${UAT_HOST:-dcontact-uat.osd.co.th}"
PG_USER="${PG_USER:-id24}"
PG_PORT="${PG_PORT:-5432}"
SSH_OPTS="${SSH_OPTS:--o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new}"

PASS=0; WARN=0; FAIL=0
ok()   { PASS=$((PASS + 1)); printf '  [ OK ] %s\n' "$*"; }
warn() { WARN=$((WARN + 1)); printf '  [WARN] %s\n' "$*"; }
bad()  { FAIL=$((FAIL + 1)); printf '  [FAIL] %s\n' "$*"; }
info() { printf '  [info] %s\n' "$*"; }
head_() { printf '\n== %s ==\n' "$*"; }

# rmt <host> <script...> : run a bash script on the VM (read from stdin)
rmt() { local h="$1"; shift; ssh $SSH_OPTS "${SSH_USER}@${h}" 'bash -s' "$@" 2>&1; }

# tcp <from-host> <to-host> <port> : test TCP from one VM to another VM
tcp() {
  local from="$1" to="$2" port="$3"
  rmt "$from" <<EOF >/dev/null
timeout 5 bash -c 'exec 3<>/dev/tcp/${to}/${port}' 2>/dev/null
EOF
}

reach() {
  local name="$1" host="$2"
  if ssh $SSH_OPTS "${SSH_USER}@${host}" true 2>/dev/null; then
    ok "$name ($host): ssh with key works"; return 0
  fi
  bad "$name ($host): ssh failed (check key/network); skipping the checks for this VM"; return 1
}

common_checks() {
  local host="$1" out
  out=$(rmt "$host" <<'EOF'
. /etc/os-release 2>/dev/null
echo "os=${PRETTY_NAME:-unknown}"
echo "kernel=$(uname -r)"
echo "cpu=$(nproc)"
echo "mem_mb=$(awk '/MemTotal/{printf "%d",$2/1024}' /proc/meminfo)"
echo "disk_free_gb=$(df -BG --output=avail / | tail -1 | tr -dc 0-9)"
echo "ntp=$(timedatectl show -p NTPSynchronized --value 2>/dev/null || echo unknown)"
echo "tz=$(timedatectl show -p Timezone --value 2>/dev/null || echo unknown)"
if sudo -n true 2>/dev/null; then echo "sudo=nopasswd"; else echo "sudo=needs-password-or-none"; fi
echo "ufw=$(sudo -n ufw status 2>/dev/null | head -1 || echo n/a)"
echo "fw_pkgs=$(command -v ufw firewall-cmd 2>/dev/null | tr '\n' ' ')"
EOF
)
  local v
  get() { printf '%s\n' "$out" | sed -n "s/^$1=//p" | head -1; }
  info "OS: $(get os) / kernel $(get kernel)"
  info "CPU $(get cpu) core, RAM $(get mem_mb) MB, free disk / $(get disk_free_gb) GB, timezone $(get tz)"
  v=$(get ntp); [ "$v" = yes ] && ok "time synced (NTP)" || warn "NTP is not synced ($v); Keycloak TLS/TOTP is sensitive to time"
  v=$(get sudo); [ "$v" = nopasswd ] && ok "sudo without a password" || warn "sudo needs a password or is not permitted; the install step may need it"
  info "firewall: ufw=$(get ufw) pkgs=$(get fw_pkgs)"
}

# ---------------------------------------------------------------- VM2 docker
check_docker() {
  head_ "VM2 docker — ${VM_DOCKER}"
  reach docker "$VM_DOCKER" || return
  common_checks "$VM_DOCKER"
  local out get
  out=$(rmt "$VM_DOCKER" <<'EOF'
echo "docker=$(docker --version 2>/dev/null || echo missing)"
echo "compose=$(docker compose version 2>/dev/null || echo missing)"
echo "daemon_active=$(systemctl is-active docker 2>/dev/null || echo unknown)"
echo "in_docker_group=$(id -nG | tr ' ' '\n' | grep -qx docker && echo yes || echo no)"
echo "docker_cli=$(docker info >/dev/null 2>&1 && echo ok || echo denied)"
echo "daemon_json=$(cat /etc/docker/daemon.json 2>/dev/null | tr -d '\n ' || echo none)"
echo "userland_proxy_false=$(grep -Eq '"userland-proxy"[[:space:]]*:[[:space:]]*false' /etc/docker/daemon.json 2>/dev/null && echo yes || echo no)"
echo "opt_dir=$(ls -ld /opt/dcontact-uat 2>/dev/null || echo missing)"
echo "running_containers=$(docker ps -q 2>/dev/null | wc -l)"
echo "port80=$(ss -ltn 2>/dev/null | awk '$4 ~ /:80$/' | wc -l)"
echo "port443=$(ss -ltn 2>/dev/null | awk '$4 ~ /:443$/' | wc -l)"
echo "ghcr=$(curl -sS -o /dev/null -m 8 -w '%{http_code}' https://ghcr.io/v2/ 2>/dev/null || echo fail)"
echo "dns_uat=$(getent hosts UAT_HOST_PLACEHOLDER | awk '{print $1}' | head -1)"
EOF
)
  out=${out//UAT_HOST_PLACEHOLDER/$UAT_HOST}
  get() { printf '%s\n' "$out" | sed -n "s/^$1=//p" | head -1; }
  case "$(get docker)" in missing) bad "docker not found";; *) ok "$(get docker)";; esac
  case "$(get compose)" in missing) bad "docker compose plugin not found";; *) ok "$(get compose)";; esac
  [ "$(get daemon_active)" = active ] && ok "docker daemon active" || bad "docker daemon is not active ($(get daemon_active))"
  [ "$(get in_docker_group)" = yes ] && ok "${SSH_USER} is in the docker group" || warn "${SSH_USER} is not in the docker group (needs sudo or add the user)"
  [ "$(get docker_cli)" = ok ] || warn "cannot run the docker CLI as ${SSH_USER} ($(get docker_cli))"
  if [ "$(get userland_proxy_false)" = yes ]; then
    ok "daemon.json already sets userland-proxy=false"
  else
    warn "\"userland-proxy\": false is not yet set in /etc/docker/daemon.json (daemon.json=$(get daemon_json))"
  fi
  case "$(get opt_dir)" in missing) warn "/opt/dcontact-uat does not exist yet (create it per section 4.3 of the runbook)";; *) ok "$(get opt_dir)";; esac
  info "running containers: $(get running_containers); port 80 listen=$(get port80), 443 listen=$(get port443)"
  case "$(get ghcr)" in 200|401|403) ok "ghcr.io reachable (HTTP $(get ghcr))";; *) bad "cannot reach ghcr.io ($(get ghcr)); images must be pulled (proxy/firewall?)";; esac
  [ -n "$(get dns_uat)" ] && info "DNS ${UAT_HOST} from this VM -> $(get dns_uat)" || info "this VM cannot resolve ${UAT_HOST}"
}

# ---------------------------------------------------------------- VM1 nginx
check_nginx() {
  head_ "VM1 nginx — ${VM_NGINX}"
  reach nginx "$VM_NGINX" || return
  common_checks "$VM_NGINX"
  local out get
  out=$(rmt "$VM_NGINX" <<'EOF'
echo "nginx=$( (nginx -v 2>&1 || /usr/sbin/nginx -v 2>&1) | head -1)"
echo "active=$(systemctl is-active nginx 2>/dev/null || echo unknown)"
echo "conf_test=$(sudo -n nginx -t 2>&1 | tail -1 | tr -d '\n' || echo n/a)"
echo "port80=$(ss -ltn 2>/dev/null | awk '$4 ~ /:80$/' | wc -l)"
echo "port443=$(ss -ltn 2>/dev/null | awk '$4 ~ /:443$/' | wc -l)"
echo "sites=$(ls /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null | tr '\n' ' ')"
echo "certs=$(sudo -n find /etc/nginx /etc/ssl /etc/letsencrypt -maxdepth 3 \( -name '*.crt' -o -name '*.pem' \) 2>/dev/null | head -8 | tr '\n' ' ')"
echo "ws_upgrade_map=$(grep -rqs 'Upgrade' /etc/nginx 2>/dev/null && echo yes || echo no)"
EOF
)
  get() { printf '%s\n' "$out" | sed -n "s/^$1=//p" | head -1; }
  case "$(get nginx)" in *nginx/*) ok "$(get nginx)";; *) bad "nginx not found";; esac
  [ "$(get active)" = active ] && ok "nginx active" || warn "nginx is not active ($(get active))"
  info "nginx -t: $(get conf_test)"
  info "listen: 80=$(get port80) 443=$(get port443); sites: $(get sites)"
  [ -n "$(get certs)" ] && info "cert files found: $(get certs)" || warn "no cert files found under /etc/nginx|/etc/ssl|/etc/letsencrypt (a cert for ${UAT_HOST} is required)"
  # the DNS of UAT_HOST must point to VM1
  local resolved
  resolved=$(getent hosts "$UAT_HOST" 2>/dev/null | awk '{print $1}' | head -1)
  if [ -z "$resolved" ]; then
    warn "the machine running the script cannot resolve ${UAT_HOST} (set DNS/hosts to point to ${VM_NGINX})"
  elif [ "$resolved" = "$VM_NGINX" ]; then
    ok "DNS ${UAT_HOST} -> ${resolved}"
  else
    warn "DNS ${UAT_HOST} -> ${resolved} (not ${VM_NGINX})"
  fi
}

# ---------------------------------------------------------------- VM3 postgres
check_pg() {
  head_ "VM3 postgresql — ${VM_PG}"
  reach postgres "$VM_PG" || return
  common_checks "$VM_PG"
  local out get
  out=$(rmt "$VM_PG" <<EOF
echo "psql=\$(psql --version 2>/dev/null || echo missing) (client)"
echo "active=\$(systemctl is-active postgresql 2>/dev/null || echo unknown)"
echo "listen=\$(ss -ltn 2>/dev/null | awk '\$4 ~ /:${PG_PORT}\$/{print \$4}' | tr '\n' ' ')"
echo "hba=\$(sudo -n grep -hEv '^[[:space:]]*(#|\$)' /etc/postgresql/*/main/pg_hba.conf 2>/dev/null | tr '\n' ';' | head -c 900)"
echo "listen_addresses=\$(sudo -n grep -hE '^[[:space:]]*listen_addresses' /etc/postgresql/*/main/postgresql.conf 2>/dev/null | tr -d ' ' | head -1)"
echo "max_connections=\$(sudo -n grep -hE '^[[:space:]]*max_connections' /etc/postgresql/*/main/postgresql.conf 2>/dev/null | tr -d ' ' | head -1)"
echo "disk_pg_gb=\$(df -BG --output=avail /var/lib/postgresql 2>/dev/null | tail -1 | tr -dc 0-9)"
EOF
)
  get() { printf '%s\n' "$out" | sed -n "s/^$1=//p" | head -1; }
  info "$(get psql); service=$(get active); listen=$(get listen)"
  [ "$(get active)" = active ] || warn "service postgresql is not active ($(get active)); if the cluster has another name, check it yourself"
  [ -n "$(get listen)" ] || warn "nothing listening on port ${PG_PORT}"
  info "$(get listen_addresses) $(get max_connections)"
  [ -n "$(get hba)" ] && info "pg_hba: $(get hba)" || info "cannot read pg_hba.conf (needs sudo or a different path)"
  info "free disk at /var/lib/postgresql: $(get disk_pg_gb) GB"

  if [ -z "${PG_PASSWORD:-}" ]; then
    info "PG_PASSWORD is not set; skipping the login/privilege check (set it and rerun to check)"
    return
  fi
  # send the password over stdin on the first line, not through argv/a file
  local q
  q=$(printf '%s\n' "$PG_PASSWORD" | ssh $SSH_OPTS "${SSH_USER}@${VM_PG}" "IFS= read -r PGPASSWORD; export PGPASSWORD; psql -X -A -t -F'|' -h 127.0.0.1 -p ${PG_PORT} -U ${PG_USER} -d postgres -v ON_ERROR_STOP=1 <<'SQL'
select 'version|'||version();
select 'role|super='||rolsuper||' createdb='||rolcreatedb||' createrole='||rolcreaterole||' bypassrls='||rolbypassrls from pg_roles where rolname=current_user;
select 'databases|'||string_agg(datname, ',' order by datname) from pg_database where not datistemplate;
select 'roles|'||string_agg(rolname, ',' order by rolname) from pg_roles where rolname !~ '^pg_';
select 'ext|'||string_agg(name, ',' order by name) from pg_available_extensions where name in ('pgcrypto','uuid-ossp','citext','pg_trgm','btree_gin','btree_gist');
SQL" 2>&1)
  if printf '%s' "$q" | grep -q '^version|'; then
    ok "Postgres login with ${PG_USER} succeeded"
    printf '%s\n' "$q" | sed -n 's/^version|/  [info] /p'
    local r; r=$(printf '%s\n' "$q" | sed -n 's/^role|//p')
    info "privileges of ${PG_USER}: $r"
    case "$r" in
      *super=true*|*createrole=true*) ok "${PG_USER} can create roles (db-roles.sh is usable)";;
      *) bad "${PG_USER} has no superuser/createrole; cannot create the dcontact_app/keycloak roles";;
    esac
    case "$r" in
      *super=true*|*createdb=true*) ok "${PG_USER} can create databases";;
      *) bad "${PG_USER} has no createdb";;
    esac
    info "databases: $(printf '%s\n' "$q" | sed -n 's/^databases|//p')"
    info "roles: $(printf '%s\n' "$q" | sed -n 's/^roles|//p')"
    info "extensions available: $(printf '%s\n' "$q" | sed -n 's/^ext|//p')"
  else
    bad "Postgres login failed: $(printf '%s' "$q" | tail -2 | tr '\n' ' ')"
  fi
}

# ---------------------------------------------------------------- network between VMs
check_links() {
  head_ "Connectivity between VMs"
  local h
  for h in "$VM_NGINX" "$VM_DOCKER" "$VM_PG"; do
    if ! ssh $SSH_OPTS "${SSH_USER}@${h}" true 2>/dev/null; then
      warn "ssh to ${h} failed; skipping the connectivity checks between VMs (results would be unreliable)"
      return
    fi
  done
  if tcp "$VM_DOCKER" "$VM_PG" "$PG_PORT"; then
    ok "VM2 (docker) -> VM3 (postgres) :${PG_PORT}"
  else
    bad "VM2 (docker) cannot reach VM3 :${PG_PORT} (pg_hba/listen_addresses/firewall)"
  fi
  for p in 80 443; do
    if tcp "$VM_NGINX" "$VM_DOCKER" "$p"; then
      ok "VM1 (nginx) -> VM2 (docker) :${p} (open)"
    else
      info "VM1 -> VM2 :${p} is not open yet (normal before deploy; the port the stack's proxy will publish must be decided)"
    fi
  done
  if tcp "$VM_NGINX" "$VM_PG" "$PG_PORT"; then
    warn "VM1 (nginx) can reach Postgres :${PG_PORT}; it should be restricted to VM2 only"
  else
    ok "VM1 (nginx) cannot reach Postgres directly (good)"
  fi
}

echo "UAT 3-VM precheck — $(date '+%F %T')  (read-only)"
check_docker
check_nginx
check_pg
check_links

head_ "Summary"
printf '  OK=%d  WARN=%d  FAIL=%d\n' "$PASS" "$WARN" "$FAIL"
[ "$FAIL" -eq 0 ]
