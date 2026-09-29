#!/bin/sh
# #540 (ADR-029): object storage ของ UAT = SeaweedFS `weed server -s3` (ไม่ใช้ `weed mini` ที่เปิด admin/worker gRPC)
# สร้าง s3.json จาก env ใน tmpfs ของ container เท่านั้น (secret ไม่ลง volume/log) แล้ว exec weed
#
# identity มีแค่ root (bootstrap/lifecycle/migration) กับ uat-evidence-api — ไม่มี anonymous
# สิทธิ์ของ API = policy `uat-evidence-api` แบบ AWS (ตัวเดียวกับที่ MinIO ใช้ใน U1.5 #433) ผ่าน policyNames
# ห้ามใช้ `actions` แบบหยาบกับ API: ไม่มี Admin = ensureBucket บูตไม่ผ่าน, มี Admin = ตั้ง bucket policy public ได้ (spike #539)
set -eu

: "${UAT_S3_ROOT_ACCESS_KEY:?UAT_S3_ROOT_ACCESS_KEY is required}"
: "${UAT_S3_ROOT_SECRET_KEY:?UAT_S3_ROOT_SECRET_KEY is required}"
: "${UAT_S3_API_ACCESS_KEY:?UAT_S3_API_ACCESS_KEY is required}"
: "${UAT_S3_API_SECRET_KEY:?UAT_S3_API_SECRET_KEY is required}"

fail() {
  echo "{\"type\":\"u1.uat.object-storage\",\"status\":\"FAIL\",\"reason\":\"$1\"}" >&2
  exit 1
}

# ค่าเข้า JSON โดยตรง จึงรับเฉพาะตัวอักษรที่ไม่ต้อง escape (secret ของ UAT เป็น hex อยู่แล้ว)
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

# volume.max/volumeSizeLimitMB: หนึ่ง bucket = หนึ่ง collection ที่จองหลาย volume (spike: max=20 หมด)
# UAT มี bucket เดียว (uat-evidence) — 64 MB × สูงสุด 64 volume = 4 GB ต่อ disk ของ VM (retention 90 วัน)
exec /usr/bin/weed -logtostderr=true server \
  -dir=/data \
  -ip.bind=0.0.0.0 \
  -master.volumeSizeLimitMB=64 \
  -volume.max=64 \
  -s3 \
  -s3.config="$config" \
  -s3.port=8333
