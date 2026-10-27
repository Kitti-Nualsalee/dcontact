#!/bin/sh
set -eu
umask 077

fail() { echo 'LOCAL_FREESWITCH_BIND_IP_INVALID' >&2; exit 1; }
media_ip="${LOCAL_RTP_FREESWITCH_MEDIA_ADDRESS:-}"
media_subnet="${LOCAL_RTP_MEDIA_SUBNET:-}"
[ -n "$media_ip" ] && [ -n "$media_subnet" ] || fail
resolved="$(getent ahostsv4 freeswitch-control)" || fail
control_ip="$(printf '%s\n' "$resolved" | awk '{print $1}' | sort -u)"
printf '%s\n' "$control_ip" | awk -F. '
  NR != 1 || NF != 4 { invalid = 1; exit 1 }
  {
    for (field = 1; field <= 4; field++)
      if ($field !~ /^(0|[1-9][0-9]*)$/ || $field > 255) { invalid = 1; exit 1 }
    if (!($1 == 10 || ($1 == 172 && $2 >= 16 && $2 <= 31) || ($1 == 192 && $2 == 168))) { invalid = 1; exit 1 }
  }
  END { if (invalid || NR != 1) exit 1 }
' || fail
owned_ips="$(awk '/\/32 host LOCAL/ { print previous } { previous = $NF }' /proc/net/fib_trie | sort -u)" || fail
[ -n "$owned_ips" ] || fail

printf '%s\n' "$owned_ips" | /bin/sh /e1-local-source/render-local.sh \
  /e1-local-source /e1-freeswitch "$control_ip" "$media_ip" "$media_subnet"
exec /bin/sh /e1-freeswitch/entrypoint.sh
