#!/usr/bin/env bash
# U1.6 (#434): set up the runner's SSH to the UAT VM from the `uat-preview` environment secrets
#
# takes values from env (the workflow passes `secrets.*` to this step only) and writes them as 0600 files in $RUNNER_TEMP
# installs the `uat-ssh`, `uat-scp`, `uat-deploy` wrappers onto the PATH of later steps; never echoes secret values
# StrictHostKeyChecking=yes: the host key must match the UAT_SSH_KNOWN_HOSTS verified at the provisioning gate
set -euo pipefail
umask 077

for name in UAT_SSH_PRIVATE_KEY UAT_SSH_KNOWN_HOSTS UAT_SSH_HOST UAT_SSH_USER; do
  if [[ -z "${!name:-}" ]]; then
    echo "missing secret: ${name} (provisioning gate incomplete)" >&2
    exit 1
  fi
done

# values derived from a secret must be masked too (the runner masks only exact secret values)
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
# runs this checkout's infra/uat/bin/uat-deploy.sh on the VM: copy it to a temporary file first, then run it
# (not run straight from stdin because `docker compose exec/run` would swallow the rest of the script's stdin)
cat >"$dir/bin/uat-deploy" <<WRAPPER
#!/usr/bin/env bash
set -euo pipefail
script="\${GITHUB_WORKSPACE:?}/infra/uat/bin/uat-deploy.sh"
exec ssh -F '${dir}/config' uat \
  "umask 077; f=\\\$(mktemp); trap 'rm -f \\\$f' EXIT; cat >\\\$f; UAT_ROOT='\${UAT_ROOT:-/opt/dcontact-uat}' bash \\\$f \$*" <"\$script"
WRAPPER
chmod 700 "$dir/bin/uat-ssh" "$dir/bin/uat-scp" "$dir/bin/uat-deploy"
echo "$dir/bin" >>"${GITHUB_PATH:?}"

# confirm it is reachable and the host key matches before doing anything else
ssh -F "$dir/config" uat true
