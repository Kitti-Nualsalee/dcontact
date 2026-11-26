#!/bin/sh
# #540 (ADR-029): UAT object storage = SeaweedFS `weed server -s3` (not `weed mini`, which opens admin/worker gRPC)
# builds s3.json from env only in the container's tmpfs (secrets never land on a volume/log) then execs weed
#
# the identities are only root (bootstrap/lifecycle/migration) and uat-evidence-api; no anonymous access
# the API's permissions = the AWS-style policy `uat-evidence-api` (the same one MinIO used in U1.5 #433) via policyNames
# never use coarse `actions` for the API: without Admin ensureBucket fails to boot, with Admin it can set a public bucket policy (spike #539)
set -eu

: "${UAT_S3_ROOT_ACCESS_KEY:?UAT_S3_ROOT_ACCESS_KEY is required}"
: "${UAT_S3_ROOT_SECRET_KEY:?UAT_S3_ROOT_SECRET_KEY is required}"
: "${UAT_S3_API_ACCESS_KEY:?UAT_S3_API_ACCESS_KEY is required}"
: "${UAT_S3_API_SECRET_KEY:?UAT_S3_API_SECRET_KEY is required}"

fail() {
  echo "{\"type\":\"u1.uat.object-storage\",\"status\":\"FAIL\",\"reason\":\"$1\"}" >&2
  exit 1
}

# values go into the JSON directly, so only characters that need no escaping are accepted (UAT secrets are already hex)
for name in UAT_S3_ROOT_ACCESS_KEY UAT_S3_ROOT_SECRET_KEY UAT_S3_API_ACCESS_KEY UAT_S3_API_SECRET_KEY; do
  eval "value=\${$name}"
  case "$value" in
    *[!A-Za-z0-9_-]*) fail "INVALID_CREDENTIAL_CHARSET" ;;
  esac
  [ "${#value}" -ge 8 ] || fail "CREDENTIAL_TOO_SHORT"
done
if [ "$UAT_S3_API_ACCESS_KEY" = "$UAT_S3_ROOT_ACCESS_KEY" ]; then
  fail "API_USES_ROOT_CREDENTIAL"
fi

bucket=uat-evidence
config=/tmp/s3.json
umask 077
cat >"$config" <<JSON
{
  "identities": [
    {
      "name": "root",
      "credentials": [{ "accessKey": "${UAT_S3_ROOT_ACCESS_KEY}", "secretKey": "${UAT_S3_ROOT_SECRET_KEY}" }],
      "actions": ["Admin", "Read", "List", "Tagging", "Write"]
    },
    {
      "name": "uat-evidence-api",
      "credentials": [{ "accessKey": "${UAT_S3_API_ACCESS_KEY}", "secretKey": "${UAT_S3_API_SECRET_KEY}" }],
      "policyNames": ["uat-evidence-api"]
    }
  ],
  "policies": [
    {
      "name": "uat-evidence-api",
      "content": "{\\"Version\\":\\"2012-10-17\\",\\"Statement\\":[{\\"Effect\\":\\"Allow\\",\\"Action\\":[\\"s3:CreateBucket\\",\\"s3:PutLifecycleConfiguration\\",\\"s3:GetLifecycleConfiguration\\",\\"s3:GetBucketPolicy\\",\\"s3:GetBucketLocation\\",\\"s3:ListBucket\\"],\\"Resource\\":[\\"arn:aws:s3:::${bucket}\\"]},{\\"Effect\\":\\"Allow\\",\\"Action\\":[\\"s3:PutObject\\",\\"s3:GetObject\\",\\"s3:DeleteObject\\"],\\"Resource\\":[\\"arn:aws:s3:::${bucket}/uat-evidence/*\\"]}]}"
    }
  ]
}
JSON
chmod 0400 "$config"
unset UAT_S3_ROOT_SECRET_KEY UAT_S3_API_SECRET_KEY

# volume.max/volumeSizeLimitMB: one bucket = one collection that reserves many volumes (spike: max=20 ran out)
# UAT has a single bucket (uat-evidence): 64 MB × at most 64 volumes = 4 GB per VM disk (90-day retention)
exec /usr/bin/weed -logtostderr=true server \
  -dir=/data \
  -ip.bind=0.0.0.0 \
  -master.volumeSizeLimitMB=64 \
  -volume.max=64 \
  -s3 \
  -s3.config="$config" \
  -s3.port=8333
