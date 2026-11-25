#!/usr/bin/env bash
# #537: run from an operator machine that can SSH into VM2/VM3, to send the credential bundle without printing secrets
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

# -3 forces scp to relay through the operator machine; no SSH key is needed between VMs and the bundle is not saved on this machine's filesystem
scp -3 -q "${ssh_opts[@]}" "${SSH_USER}@${VM3}:$BUNDLE" "${SSH_USER}@${VM2}:$VM2_BUNDLE"
ssh "${ssh_opts[@]}" "${SSH_USER}@${VM2}" \
  "python3 '$HELPER' '$VM2_BUNDLE'; stat -c '%a %U:%G %n' /opt/dcontact-uat/uat.env"

echo "VM2 is ready; once the check above passes, run on VM3: shred -u $BUNDLE"
