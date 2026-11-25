#!/usr/bin/env bash
# #566 / ADR-031: a server block for the public hostname for the LINE webhook on VM1 only (run with sudo)
#
#   sudo UAT_LINE_PUBLIC_HOST=<host> bash vm1-nginx-line-webhook.sh [--check|--apply|--remove]
#
# the public hostname (DNS + NAT 443 from the network team) may open only `POST /webhook/line`; any other path 404, any other method 403
# the LAN server `dcontact-uat.osd.co.th` is not touched; the config file is separate per host and additive only (ADR-030)
# `--remove` = kill the receiving leg at the edge: remove the config then reload (LINE gets a connection error and redelivers later)
set -euo pipefail

mode="${1:---check}"
[[ "$mode" == --check || "$mode" == --apply || "$mode" == --remove ]] || {
  echo 'usage: sudo UAT_LINE_PUBLIC_HOST=<host> bash vm1-nginx-line-webhook.sh [--check|--apply|--remove]' >&2
  exit 64
}
[[ "$(id -u)" -eq 0 ]] || { echo 'must run with sudo on VM1' >&2; exit 1; }

host="${UAT_LINE_PUBLIC_HOST:?UAT_LINE_PUBLIC_HOST is required}"
[[ "$host" =~ ^[a-z0-9-]+\.osd\.co\.th$ ]] || { echo 'host must be under the wildcard *.osd.co.th' >&2; exit 1; }
[[ "$host" != dcontact-uat.osd.co.th ]] || { echo 'the LAN host must not be used as the public host' >&2; exit 1; }
vm1=192.168.102.114
vm2=192.168.102.112
cert=/etc/nginx/ssl/star.osd.co.th_bundle.crt
key=/etc/nginx/ssl/star.osd.co.th.key
config="/etc/nginx/conf.d/${host}.conf"

ip -4 -o addr show | grep -Fq "$vm1/" || { echo "this machine does not have IP $vm1" >&2; exit 1; }

if [[ "$mode" == --remove ]]; then
  [[ -e "$config" ]] || { echo "$config does not exist"; exit 0; }
  grep -Fq '# D-Contact UAT LINE webhook' "$config" || { echo "$config does not belong to this script; stopping" >&2; exit 1; }
  rm -f "$config"
  nginx -t
  systemctl reload nginx
  printf 'REMOVE passed: %s\n' "$config"
  exit 0
fi

[[ -f "$cert" && -f "$key" ]] || { echo 'expected cert/key not found' >&2; exit 1; }
openssl x509 -in "$cert" -noout -checkhost "$host" | grep -q 'does match' || { echo 'cert does not cover the host' >&2; exit 1; }
openssl x509 -in "$cert" -noout -checkend 2592000 >/dev/null || { echo 'cert expires within 30 days' >&2; exit 1; }
nginx -t >/dev/null

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
cat >"$tmp" <<NGINX
# D-Contact UAT LINE webhook (#566): host สาธารณะรับแค่ POST /webhook/line แล้วส่งต่อ Caddy บน VM2
server {
    listen 80;
    server_name ${host};
    return 404;
}

server {
    listen 443 ssl http2;
    server_name ${host};
    ssl_certificate ${cert};
    ssl_certificate_key ${key};
    ssl_protocols TLSv1.2 TLSv1.3;

    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options "nosniff" always;

    location = /webhook/line {
        limit_except POST { deny all; }
        client_max_body_size 1m;
        proxy_pass http://${vm2}:8080;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Connection "";
        proxy_connect_timeout 5s;
        proxy_read_timeout 30s;
    }

    location / {
        return 404;
    }
}
NGINX

if [[ -e "$config" ]] && ! cmp -s "$tmp" "$config"; then
  echo "found $config with mismatched content; stopping so it can be checked by hand" >&2
  exit 1
fi

printf 'host: %s\n' "$host"
printf 'nginx config: %s\n' "$config"
printf 'upstream: %s:8080 (POST /webhook/line only)\n' "$vm2"

if [[ "$mode" == --check ]]; then
  echo 'CHECK passed; --apply will add the config, run nginx -t and reload nginx'
  exit 0
fi

created=0
if [[ ! -e "$config" ]]; then
  install -o root -g root -m 0644 "$tmp" "$config"
  created=1
fi
if ! nginx -t; then
  if [[ "$created" -eq 1 ]]; then rm -f "$config"; fi
  echo 'nginx -t failed; removing the config that was just added' >&2
  exit 1
fi
systemctl reload nginx
printf 'APPLY passed: %s\n' "$config"
