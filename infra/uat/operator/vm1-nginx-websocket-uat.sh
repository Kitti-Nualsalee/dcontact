#!/usr/bin/env bash
# #490: move the SIP WebSocket from the temporary VM1 override back to be managed by Caddy in the release
set -euo pipefail

mode="${1:---check}"
[[ "$mode" == --check || "$mode" == --apply ]] || { echo 'usage: sudo bash vm1-nginx-websocket-uat.sh [--check|--apply]' >&2; exit 64; }
[[ "$(id -u)" -eq 0 ]] || { echo 'must run with sudo on VM1' >&2; exit 1; }

host=dcontact-uat.osd.co.th
vm1=192.168.102.114
vm2=192.168.102.112
config=/etc/nginx/conf.d/dcontact-uat.osd.co.th.conf

ip -4 -o addr show | grep -Fq "$vm1/" || { echo "this machine does not have IP $vm1" >&2; exit 1; }
[[ -f "$config" ]] || { echo "$config not found" >&2; exit 1; }

expected="$(mktemp)"
candidate="$(mktemp)"
backup=""
cleanup() { rm -f "$expected" "$candidate"; }
trap cleanup EXIT

cat >"$expected" <<'NGINX'
# D-Contact UAT: nginx บน VM1 ส่งต่อไป Caddy บน VM2; host อื่นไม่ถูกแก้
server {
    listen 80;
    server_name dcontact-uat.osd.co.th;
    return 308 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name dcontact-uat.osd.co.th;
    ssl_certificate /etc/nginx/ssl/star.osd.co.th_bundle.crt;
    ssl_certificate_key /etc/nginx/ssl/star.osd.co.th.key;
    ssl_protocols TLSv1.2 TLSv1.3;

    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # SIP WebSocket ต้อง stream frame เล็ก ๆ ทันที; generic proxy buffering ทำให้ REGISTER timeout
    location = /sip-ws {
        proxy_pass http://192.168.102.112:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_connect_timeout 5s;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    location / {
        proxy_pass http://192.168.102.112:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_connect_timeout 5s;
        proxy_read_timeout 60s;
    }
}
NGINX

if cmp -s "$expected" "$config"; then
  echo 'CHECK passed: VM1 sends /sip-ws through Caddy without buffering'
  exit 0
fi

python3 - "$config" "$candidate" <<'PY'
from pathlib import Path
import re
import sys

source = Path(sys.argv[1]).read_text()

manual_sip_ws = re.compile(
    r'\n    location = /sip-ws \{\n'
    r'        proxy_pass https://192\.168\.102\.112:5067;\n'
    r'        proxy_ssl_verify off;\n'
    r'        proxy_ssl_server_name on;\n'
    r'        proxy_ssl_name dcontact-uat\.sip\.internal;\n'
    r'        proxy_http_version 1\.1;\n'
    r'        proxy_set_header Host \$host;\n'
    r'        proxy_set_header X-Real-IP \$remote_addr;\n'
    r'        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;\n'
    r'        proxy_set_header X-Forwarded-Proto https;\n'
    r'        proxy_set_header Upgrade \$http_upgrade;\n'
    r'        proxy_set_header Connection "upgrade";\n'
    r'        proxy_buffering off;\n'
    r'        proxy_request_buffering off;\n'
    r'        proxy_read_timeout 3600s;\n'
    r'        proxy_send_timeout 3600s;\n'
    r'    \}\n',
)

source, removed = manual_sip_ws.subn('', source)
if removed > 1:
    raise SystemExit('found more than one /sip-ws override block; stopping to check by hand')
if 'location = /sip-ws {' in source:
    raise SystemExit('found a /sip-ws block that is not the previous override; stopping to check by hand')
source = source.replace(
    '        proxy_set_header Connection "";\n',
    '        proxy_set_header Upgrade $http_upgrade;\n'
    '        proxy_set_header Connection "upgrade";\n',
)
source = source.replace(
    '        proxy_set_header Connection "upgrade";\n'
    '        proxy_read_timeout 60s;\n',
    '        proxy_set_header Connection "upgrade";\n'
    '        proxy_connect_timeout 5s;\n'
    '        proxy_read_timeout 60s;\n',
)
relay_sip_ws = '''    # SIP WebSocket ต้อง stream frame เล็ก ๆ ทันที; generic proxy buffering ทำให้ REGISTER timeout
    location = /sip-ws {
        proxy_pass http://192.168.102.112:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_connect_timeout 5s;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

'''
needle = '    location / {\n'
if needle not in source:
    raise SystemExit('generic location not found; stopping to check by hand')
source = source.replace(needle, relay_sip_ws + needle, 1)
Path(sys.argv[2]).write_text(source)
PY

if ! cmp -s "$expected" "$candidate"; then
  echo 'the UAT config does not match a state the migration recognizes; stopping to check by hand' >&2
  exit 1
fi
if [[ "$mode" == --check ]]; then
  echo 'found the previous WebSocket config; --apply will back up the config, send /sip-ws through Caddy without buffering and reload nginx'
  exit 1
fi

backup="${config}.before-e1-websocket-source-$(date -u +%Y%m%dT%H%M%SZ)"
cp --preserve=mode,ownership "$config" "$backup"
install -o root -g root -m 0644 "$expected" "$config"
if ! nginx -t; then
  cp --preserve=mode,ownership "$backup" "$config"
  nginx -t >/dev/null || true
  echo 'nginx -t failed; restored the config from backup' >&2
  exit 1
fi
systemctl reload nginx
echo "APPLY passed: backup=$(basename "$backup"); /sip-ws is sent through Caddy without buffering"
