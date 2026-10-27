#!/bin/sh
set -eu
umask 077

[ "$#" -eq 5 ] || { echo 'LOCAL_FREESWITCH_BIND_IP_INVALID' >&2; exit 1; }
source_dir="$1"
target_dir="$2"
control_ip="$3"
media_ip="$4"
media_subnet="$5"

LOCAL_FS_CONTROL="$control_ip" LOCAL_FS_MEDIA="$media_ip" LOCAL_FS_SUBNET="$media_subnet" awk '
  function address(value, parts, count, field, result) {
    count = split(value, parts, ".")
    if (count != 4) return -1
    result = 0
    for (field = 1; field <= 4; field++) {
      if (parts[field] !~ /^(0|[1-9][0-9]*)$/ || parts[field] > 255) return -1
      result = result * 256 + parts[field]
    }
    return result
  }
  function private_ip(value) {
    return (value >= 167772160 && value <= 184549375) ||
      (value >= 2886729728 && value <= 2887778303) ||
      (value >= 3232235520 && value <= 3232301055)
  }
  BEGIN {
    control = ENVIRON["LOCAL_FS_CONTROL"]
    media = ENVIRON["LOCAL_FS_MEDIA"]
    subnet = ENVIRON["LOCAL_FS_SUBNET"]
    control_number = address(control)
    media_number = address(media)
    count = split(subnet, cidr, "/")
    network = address(cidr[1])
    if (count != 2 || cidr[2] !~ /^(0|[1-9][0-9]*)$/ || cidr[2] > 29) exit 1
    size = 2 ^ (32 - cidr[2])
    if (!private_ip(network) || !private_ip(network + size - 1) || network % size != 0 ||
      !private_ip(control_number) || media_number != network + 3 ||
      (control_number >= network && control_number < network + size)) exit 1
    valid = 1
  }
  {
    if (address($0) < 0) { invalid = 1; exit 1 }
    if ($0 == control) owned_control = 1
    if ($0 == media) owned_media = 1
  }
  END { if (!valid || invalid || !owned_control || !owned_media) exit 1 }
' || { echo 'LOCAL_FREESWITCH_BIND_IP_INVALID' >&2; exit 1; }

cp -R "$source_dir/." "$target_dir/"
awk -v control="$control_ip" '
  /local_ip_v4=/ { invalid = 1; exit 1 }
  { print }
  /^<include>$/ {
    count++
    print "  <X-PRE-PROCESS cmd=\"set\" data=\"local_ip_v4=" control "\"/>"
  }
  END { if (invalid || count != 1) exit 1 }
' "$source_dir/vars.local.xml" > "$target_dir/conf/vars.xml.tmp"
mv "$target_dir/conf/vars.xml.tmp" "$target_dir/conf/vars.xml"

awk -v control="$control_ip" -v media="$media_ip" '
  /name="sip-ip"/ { sip++; sub(/value="[^"]*"/, "value=\"" control "\"") }
  /name="rtp-ip"/ { rtp++; sub(/value="[^"]*"/, "value=\"" media "\"") }
  /name="ws-binding"/ { ws++; sub(/value="[^"]*"/, "value=\"" control ":5066\"") }
  /name="wss-binding"/ { wss++; sub(/value="[^"]*"/, "value=\"" control ":7443\"") }
  { print }
  END { if (sip != 1 || rtp != 1 || ws != 1 || wss != 1) exit 1 }
' "$source_dir/conf/sip_profiles/internal.xml" > "$target_dir/conf/sip_profiles/internal.xml.tmp"
mv "$target_dir/conf/sip_profiles/internal.xml.tmp" "$target_dir/conf/sip_profiles/internal.xml"

awk -v control="$control_ip" '
  /name="listen-ip"/ { count++; sub(/value="[^"]*"/, "value=\"" control "\"") }
  { print }
  END { if (count != 1) exit 1 }
' "$source_dir/conf/autoload_configs/event_socket.conf.xml" > "$target_dir/conf/autoload_configs/event_socket.conf.xml.tmp"
mv "$target_dir/conf/autoload_configs/event_socket.conf.xml.tmp" "$target_dir/conf/autoload_configs/event_socket.conf.xml"
printf '%s\n' "$control_ip" > "$target_dir/control-ip"
