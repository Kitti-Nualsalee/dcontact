#!/usr/bin/env bash
# A1.9 (#574): รันจากเครื่อง operator ที่ SSH เข้า VM2/VM3 ได้หลัง vm3-platform-db-uat.sh --apply
# ส่ง bundle ผ่าน scp -3 แล้วรวมเป็น env บน VM2 (mode 600); ไม่พิมพ์ secret
set -euo pipefail
ssh_opts=(-o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new)
user=osdadmin
vm2=192.168.102.112
vm3=192.168.102.113
root=/opt/dcontact-uat/platform
bundle=/home/osdadmin/dcontact-platform-uat-db-credentials.env

ssh "${ssh_opts[@]}" "$user@$vm3" "test -f '$bundle' && test \$(stat -c %a '$bundle') = 600"
ssh "${ssh_opts[@]}" "$user@$vm2" "install -d -m 700 '$root' && test ! -e '$root/db-credentials.transfer' && test ! -e '$root/platform.env'"
scp -3 -p -q "${ssh_opts[@]}" "$user@$vm3:$bundle" "$user@$vm2:$root/db-credentials.transfer"
ssh "${ssh_opts[@]}" "$user@$vm2" "python3 - '$root'" <<'PY'
import os, secrets, string, sys
from pathlib import Path

root = Path(sys.argv[1])
transfer = root / 'db-credentials.transfer'
env = root / 'platform.env'
uat = Path('/opt/dcontact-uat/uat.env')
if transfer.stat().st_mode & 0o077:
    raise SystemExit('credential transfer permission ไม่ใช่ 600')
if env.exists():
    raise SystemExit('platform.env มีอยู่แล้ว; หยุดก่อนเขียนทับ')
def read_values(path):
    values = {}
    for line in path.read_text().splitlines():
        if not line or line.startswith('#'): continue
        key, separator, value = line.partition('=')
        if not separator: raise SystemExit('รูปแบบ env ไม่ถูกต้อง')
        values[key] = value.strip().strip('"')
    return values
db = read_values(transfer)
existing = read_values(uat)
if set(db) != {'PLATFORM_DB_PASSWORD', 'PROVISIONER_DB_PASSWORD'}:
    raise SystemExit('credential bundle มี key ไม่ตรงที่คาดไว้')
if not all(v.isalnum() and len(v) == 48 for v in db.values()):
    raise SystemExit('credential bundle มีค่าไม่ตรงรูปแบบ')
allowed = existing.get('UAT_ALLOWED_CIDRS', '')
if not allowed:
    raise SystemExit('UAT_ALLOWED_CIDRS ว่าง')
alphabet = string.ascii_letters + string.digits
secret = ''.join(secrets.choice(alphabet) for _ in range(48))
content = '\n'.join([
    f'PLATFORM_DB_PASSWORD={db["PLATFORM_DB_PASSWORD"]}',
    f'PROVISIONER_DB_PASSWORD={db["PROVISIONER_DB_PASSWORD"]}',
    f'KEYCLOAK_PROVISIONER_SECRET={secret}',
    f'PLATFORM_ALLOWED_CIDRS="{allowed}"',
    'PLATFORM_SIP_BASE_DOMAIN=sip.uat.osd.co.th',
    'PLATFORM_PROVISIONING_ENABLED=false',
    'PLATFORM_OPERATOR_ALLOWLIST=',
    'PLATFORM_UAT_OPERATOR_USERNAME=kittin.platform',
    'PLATFORM_UAT_OPERATOR_EMAIL=kittin.platform@uat.invalid',
]) + '\n'
fd = os.open(env, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as out:
    out.write(content)
    out.flush()
    os.fsync(out.fileno())
transfer.unlink()
print(f'platform.env installed: {env} (mode 600; rollout disabled)')
PY
echo 'VM2 env พร้อม; หลังตรวจว่า platform.env มีแล้ว ให้ลบ credential bundle ต้นทางบน VM3'
