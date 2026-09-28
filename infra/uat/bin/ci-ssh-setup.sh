#!/usr/bin/env bash
# U1.6 (#434): ตั้ง SSH ของ runner ไปยัง UAT VM จาก secrets ของ environment `uat-preview`
#
# รับค่าจาก env (workflow ส่ง `secrets.*` มาเฉพาะ step นี้) แล้วเขียนเป็นไฟล์ 0600 ใน $RUNNER_TEMP
# ติดตั้ง wrapper `uat-ssh`, `uat-scp`, `uat-deploy` ลง PATH ของ step ถัดไป — ไม่ echo ค่า secret
# StrictHostKeyChecking=yes: host key ต้องตรงกับ UAT_SSH_KNOWN_HOSTS ที่ verify ไว้ใน provisioning gate
set -euo pipefail
umask 077

for name in UAT_SSH_PRIVATE_KEY UAT_SSH_KNOWN_HOSTS UAT_SSH_HOST UAT_SSH_USER; do
  if [[ -z "${!name:-}" ]]; then
    echo "missing secret: ${name} (provisioning gate ยังไม่ครบ)" >&2
    exit 1
  fi
done

# ค่าที่ derive จาก secret ต้อง mask ด้วย (runner mask เฉพาะค่า secret ตรงตัว)
echo "::add-mask::${UAT_SSH_USER}@${UAT_SSH_HOST}"

dir="${RUNNER_TEMP:?}/uat-ssh"
mkdir -p "$dir/bin"
printf '%s\n' "$UAT_SSH_PRIVATE_KEY" >"$dir/key"
printf '%s\n' "$UAT_SSH_KNOWN_HOSTS" >"$dir/known_hosts"
cat >"$dir/config" <<CONFIG
Host uat
  HostName ${UAT_SSH_HOST}
  User ${UAT_SSH_USER}
  IdentityFile ${dir}/key
  IdentitiesOnly yes
  UserKnownHostsFile ${dir}/known_hosts
  StrictHostKeyChecking yes
  BatchMode yes
  LogLevel ERROR
  ServerAliveInterval 30
CONFIG

cat >"$dir/bin/uat-ssh" <<WRAPPER
#!/usr/bin/env bash
exec ssh -F '${dir}/config' uat "\$@"
WRAPPER
cat >"$dir/bin/uat-scp" <<WRAPPER
#!/usr/bin/env bash
exec scp -q -F '${dir}/config' "\$@"
WRAPPER
# รัน infra/uat/bin/uat-deploy.sh ของ checkout นี้บน VM: คัดลอกเป็นไฟล์ชั่วคราวก่อนแล้วค่อยรัน
# (ไม่รันจาก stdin ตรง ๆ เพราะ `docker compose exec/run` จะกลืน stdin ที่เหลือของ script)
cat >"$dir/bin/uat-deploy" <<WRAPPER
#!/usr/bin/env bash
set -euo pipefail
script="\${GITHUB_WORKSPACE:?}/infra/uat/bin/uat-deploy.sh"
exec ssh -F '${dir}/config' uat \
  "umask 077; f=\\\$(mktemp); trap 'rm -f \\\$f' EXIT; cat >\\\$f; UAT_ROOT='\${UAT_ROOT:-/opt/dcontact-uat}' bash \\\$f \$*" <"\$script"
WRAPPER
chmod 700 "$dir/bin/uat-ssh" "$dir/bin/uat-scp" "$dir/bin/uat-deploy"
echo "$dir/bin" >>"${GITHUB_PATH:?}"

# ยืนยันว่าเข้าถึงได้และ host key ตรง ก่อนทำอะไรต่อ
ssh -F "$dir/config" uat true
