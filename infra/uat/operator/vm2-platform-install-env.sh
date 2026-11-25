#!/usr/bin/env bash
# A1.9 (#574): run from an operator machine that can SSH into VM2/VM3, after vm3-platform-db-uat.sh --apply
# send the bundle via scp -3 then merge it into an env on VM2 (mode 600); does not print secrets
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
    raise SystemExit('credential transfer permission is not 600')
if env.exists():
    raise SystemExit('platform.env already exists; stopping before overwriting')
def read_values(path):
    values = {}
    for line in path.read_text().splitlines():
        if not line or line.startswith('#'): continue
        key, separator, value = line.partition('=')
        if not separator: raise SystemExit('invalid env format')
        values[key] = value.strip().strip('"')
    return values
db = read_values(transfer)
existing = read_values(uat)
if set(db) != {'PLATFORM_DB_PASSWORD', 'PROVISIONER_DB_PASSWORD'}:
    raise SystemExit('credential bundle has keys that do not match what is expected')
if not all(v.isalnum() and len(v) == 48 for v in db.values()):
    raise SystemExit('credential bundle has values that do not match the expected format')
allowed = existing.get('UAT_ALLOWED_CIDRS', '')
if not allowed:
    raise SystemExit('UAT_ALLOWED_CIDRS is empty')
alphabet = string.ascii_letters + string.digits
secret = ''.join(secrets.choice(alphabet) for _ in range(48))
# #592: the service account for account self-service (#589); a secret separate from the provisioner
account_secret = ''.join(secrets.choice(alphabet) for _ in range(48))
content = '\n'.join([
    f'PLATFORM_DB_PASSWORD={db["PLATFORM_DB_PASSWORD"]}',
    f'PROVISIONER_DB_PASSWORD={db["PROVISIONER_DB_PASSWORD"]}',
    f'KEYCLOAK_PROVISIONER_SECRET={secret}',
    f'KEYCLOAK_ACCOUNT_SERVICE_SECRET={account_secret}',
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
echo 'VM2 env is ready; after checking that platform.env exists, delete the source credential bundle on VM3'
