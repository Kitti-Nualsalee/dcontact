#!/usr/bin/env bash
# #490: ย้าย SIP WebSocket จาก VM1 override ชั่วคราวกลับไปให้ Caddy ใน release ดูแล
set -euo pipefail

mode="${1:---check}"
[[ "$mode" == --check || "$mode" == --apply ]] || { echo 'usage: sudo bash vm1-nginx-websocket-uat.sh [--check|--apply]' >&2; exit 64; }
[[ "$(id -u)" -eq 0 ]] || { echo 'ต้องรันด้วย sudo บน VM1' >&2; exit 1; }

host=dcontact-uat.osd.co.th
vm1=192.168.102.114
vm2=192.168.102.112
config=/etc/nginx/conf.d/dcontact-uat.osd.co.th.conf

ip -4 -o addr show | grep -Fq "$vm1/" || { echo "เครื่องนี้ไม่มี IP $vm1" >&2; exit 1; }
[[ -f "$config" ]] || { echo "ไม่พบ $config" >&2; exit 1; }

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
  echo 'CHECK ผ่าน: VM1 ส่ง /sip-ws ผ่าน Caddy แบบไม่ buffer แล้ว'
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
    raise SystemExit('พบ /sip-ws override มากกว่าหนึ่ง block; หยุดเพื่อตรวจด้วยมือ')
if 'location = /sip-ws {' in source:
    raise SystemExit('พบ /sip-ws block ที่ไม่ใช่ override รุ่นเดิม; หยุดเพื่อตรวจด้วยมือ')
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
    raise SystemExit('ไม่พบ generic location; หยุดเพื่อตรวจด้วยมือ')
source = source.replace(needle, relay_sip_ws + needle, 1)
Path(sys.argv[2]).write_text(source)
PY

if ! cmp -s "$expected" "$candidate"; then
  echo 'config UAT ไม่ตรงกับ state ที่ migration รู้จัก; หยุดเพื่อตรวจด้วยมือ' >&2
  exit 1
fi
if [[ "$mode" == --check ]]; then
  echo 'พบ config WebSocket รุ่นเดิม; --apply จะ backup config, ส่ง /sip-ws ผ่าน Caddy แบบไม่ buffer และ reload nginx'
  exit 1
fi

backup="${config}.before-e1-websocket-source-$(date -u +%Y%m%dT%H%M%SZ)"
cp --preserve=mode,ownership "$config" "$backup"
install -o root -g root -m 0644 "$expected" "$config"
if ! nginx -t; then
  cp --preserve=mode,ownership "$backup" "$config"
  nginx -t >/dev/null || true
  echo 'nginx -t ไม่ผ่าน; คืน config จาก backup แล้ว' >&2
  exit 1
fi
systemctl reload nginx
echo "APPLY ผ่าน: backup=$(basename "$backup"); /sip-ws ส่งผ่าน Caddy แบบไม่ buffer"
