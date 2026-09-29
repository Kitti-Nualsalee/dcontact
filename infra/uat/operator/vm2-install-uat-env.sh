#!/usr/bin/env bash
# #537: รันจากเครื่อง operator ที่ SSH เข้า VM2/VM3 ได้ เพื่อส่ง credential bundle โดยไม่พิมพ์ secret
set -euo pipefail
umask 077

VM2="${VM2:-192.168.102.112}"
VM3="${VM3:-192.168.102.113}"
SSH_USER="${SSH_USER:-osdadmin}"
BUNDLE=/home/osdadmin/dcontact-uat-db-credentials.env
VM2_BUNDLE=/opt/dcontact-uat/operator/dcontact-uat-db-credentials.env
HELPER=/opt/dcontact-uat/operator/vm2-create-uat-env.py

ssh_opts=(-o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new)

ssh "${ssh_opts[@]}" "${SSH_USER}@${VM3}" \
  "test -f '$BUNDLE' && test \"\$(stat -c %a '$BUNDLE')\" = 600"
ssh "${ssh_opts[@]}" "${SSH_USER}@${VM2}" \
  "test -x '$HELPER' && test ! -e /opt/dcontact-uat/uat.env"

# -3 บังคับให้ scp ส่งผ่านเครื่อง operator; ไม่ต้องมี SSH key ระหว่าง VM และไม่บันทึก bundle ใน filesystem ของเครื่องนี้
scp -3 -q "${ssh_opts[@]}" "${SSH_USER}@${VM3}:$BUNDLE" "${SSH_USER}@${VM2}:$VM2_BUNDLE"
ssh "${ssh_opts[@]}" "${SSH_USER}@${VM2}" \
  "python3 '$HELPER' '$VM2_BUNDLE'; stat -c '%a %U:%G %n' /opt/dcontact-uat/uat.env"

echo "VM2 พร้อมแล้ว; เมื่อตรวจผลข้างต้นผ่าน ให้รันบน VM3: shred -u $BUNDLE"
