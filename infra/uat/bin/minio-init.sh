#!/bin/sh
# U1.6 (#434) + U1.5 (#433): bucket หลักฐาน UAT และบัญชี MinIO ของ API แบบ least-privilege
# รันใน container minio (compose service `minio-init`, one-shot) — idempotent ทุก deploy
#
# - bucket `uat-evidence` แบบ private: ไม่ตั้ง anonymous/bucket policy ใด ๆ (API ปฏิเสธการบูตถ้ามี policy)
# - user ของ API ได้ policy `uat-evidence-api` เท่านั้น: action ที่ `ensureBucket()` และ put/get/delete ใช้
#   จำกัดที่ bucket นี้ และ object ใต้ prefix `uat-evidence/` (key ของ UatEvidenceObjectStorage)
# - retention 90 วัน (lifecycle) API ตั้งเองตอนบูต
# credential อยู่ใน env ของ container เท่านั้น — ไม่อยู่ใน compose file หรือ log
set -eu

: "${MC_HOST_uat:?MC_HOST_uat is required}"
: "${UAT_MINIO_ROOT_USER:?UAT_MINIO_ROOT_USER is required}"
: "${UAT_MINIO_API_ACCESS_KEY:?UAT_MINIO_API_ACCESS_KEY is required}"
: "${UAT_MINIO_API_SECRET_KEY:?UAT_MINIO_API_SECRET_KEY is required}"

bucket=uat-evidence
policy=uat-evidence-api

if [ "$UAT_MINIO_API_ACCESS_KEY" = "$UAT_MINIO_ROOT_USER" ]; then
  echo '{"type":"u1.uat.minio-init","status":"FAIL","reason":"API_USES_ROOT_CREDENTIAL"}' >&2
  exit 1
fi

mc mb --ignore-existing "uat/${bucket}" >/dev/null

# image pgsty/minio (ubi9-micro) ไม่มี grep — ตรวจข้อความด้วย `case` ของ shell เท่านั้น
# ตรวจอย่างเดียว: bucket ต้องไม่มี anonymous access (ไม่ตั้ง policy ให้ bucket)
anonymous="$(mc anonymous get "uat/${bucket}")"
case "$anonymous" in
  *private*) ;;
  *)
    echo '{"type":"u1.uat.minio-init","status":"FAIL","reason":"BUCKET_NOT_PRIVATE"}' >&2
    exit 1
    ;;
esac

policy_file="$(mktemp)"
trap 'rm -f "$policy_file"' EXIT
cat >"$policy_file" <<POLICY
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:CreateBucket",
        "s3:PutLifecycleConfiguration",
        "s3:GetLifecycleConfiguration",
        "s3:GetBucketPolicy",
        "s3:GetBucketLocation",
        "s3:ListBucket"
      ],
      "Resource": ["arn:aws:s3:::${bucket}"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      "Resource": ["arn:aws:s3:::${bucket}/uat-evidence/*"]
    }
  ]
}
POLICY

# create = สร้างหรือแทนที่ policy เดิม; user add = สร้างหรืออัปเดต secret (rotate ได้ด้วยการ deploy ซ้ำ)
mc admin policy create uat "$policy" "$policy_file" >/dev/null
mc admin user add uat "$UAT_MINIO_API_ACCESS_KEY" "$UAT_MINIO_API_SECRET_KEY" >/dev/null
user_info="$(mc admin user info uat "$UAT_MINIO_API_ACCESS_KEY")"
case "$user_info" in
  *"$policy"*) ;;
  *) mc admin policy attach uat "$policy" --user "$UAT_MINIO_API_ACCESS_KEY" >/dev/null ;;
esac

echo '{"type":"u1.uat.minio-init","status":"PASS","bucket":"uat-evidence","policy":"uat-evidence-api"}'
