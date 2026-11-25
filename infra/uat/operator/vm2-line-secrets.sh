#!/usr/bin/env bash
# #565 / ADR-031: place the LINE pilot secrets on VM2 for the `uat-line` overlay; run on VM2 with sudo
#
#   sudo infra/uat/operator/vm2-line-secrets.sh            first time: token + channel secret + a random payload key
#   sudo infra/uat/operator/vm2-line-secrets.sh --rotate   rotate the token/channel secret (e.g. v4 → v5) and then run
#                                                          `uat-deploy.sh line-reload <sha>`
#
# values are accepted over stdin only (not echoed on a terminal), so they never land in shell history or process arguments
# line 1 = channel access token, line 2 = channel secret
# the payload key is random once and never rotated: a new key would make stored webhook payloads undecryptable
# files are 0400 owned by uid 10001 (the user in the api/ops image); the script prints no values
set -euo pipefail
umask 077

CREDENTIAL_DIR="${UAT_LINE_CREDENTIAL_DIR:-/opt/dcontact-uat/secrets/line}"
OWNER=10001:10001
ACCESS_FILE=line-channel-access-token
CHANNEL_FILE=line-channel-secret
KEY_FILE=line-webhook-payload-key

fail() {
  echo "{\"type\":\"u1.uat.line-secrets\",\"status\":\"FAIL\",\"reason\":\"$1\"}" >&2
  exit 1
}

rotate=false
case "${1:-}" in
  '') ;;
  --rotate) rotate=true ;;
  *) echo 'usage: vm2-line-secrets.sh [--rotate]' >&2; exit 64 ;;
esac

[[ "$(id -u)" == 0 ]] || fail 'ROOT_REQUIRED'
if [[ "$rotate" == false && -e "$CREDENTIAL_DIR/$ACCESS_FILE" ]]; then fail 'ALREADY_PRESENT_USE_ROTATE'; fi
if [[ "$rotate" == true && ! -e "$CREDENTIAL_DIR/$ACCESS_FILE" ]]; then fail 'NOTHING_TO_ROTATE'; fi

read_secret() {
  local prompt="$1" value
  if [[ -t 0 ]]; then
    IFS= read -rs -p "$prompt: " value
    echo >&2
  else
    IFS= read -r value || true
  fi
  printf '%s' "$value"
}

token="$(read_secret 'channel access token')"
channel_secret="$(read_secret 'channel secret')"
# token: only the characters of a JWT/long-lived token; the LINE channel secret = 32 hex characters
[[ "$token" =~ ^[A-Za-z0-9._~+/=-]{20,4096}$ ]] || fail 'TOKEN_FORMAT'
[[ "$channel_secret" =~ ^[0-9a-f]{32}$ ]] || fail 'CHANNEL_SECRET_FORMAT'

install -d -m 0700 -o root -g root "$CREDENTIAL_DIR"

write_secret() {
  local name="$1" value="$2" temporary
  temporary="$(mktemp "$CREDENTIAL_DIR/.$name.XXXXXX")"
  printf '%s' "$value" >"$temporary"
  chown "$OWNER" "$temporary"
  chmod 0400 "$temporary"
  mv -f "$temporary" "$CREDENTIAL_DIR/$name"
}

write_secret "$ACCESS_FILE" "$token"
write_secret "$CHANNEL_FILE" "$channel_secret"
unset token channel_secret
if [[ ! -e "$CREDENTIAL_DIR/$KEY_FILE" ]]; then
  write_secret "$KEY_FILE" "$(head -c 32 /dev/urandom | base64 | tr -d '\n')"
fi

for name in "$ACCESS_FILE" "$CHANNEL_FILE" "$KEY_FILE"; do
  [[ "$(stat -c '%a %u' "$CREDENTIAL_DIR/$name")" == "400 10001" ]] || fail 'PERMISSIONS'
done
echo "{\"type\":\"u1.uat.line-secrets\",\"status\":\"PASS\",\"rotated\":$rotate}"
if [[ "$rotate" == true ]]; then
  echo 'next: uat-deploy.sh line-reload <current sha>, then register the new credential with line-pilot-setup credential' >&2
fi
