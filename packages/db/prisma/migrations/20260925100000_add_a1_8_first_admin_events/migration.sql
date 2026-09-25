-- A1.8 (#413): เหตุการณ์ฝั่ง First admin ใน Action history (#391 timeline แยก actor)
-- worker reconcile จาก Keycloak user events — บันทึกแค่ชนิดเหตุการณ์และเวลา ไม่มี email/IP/details
ALTER TYPE "PfActorKind" ADD VALUE IF NOT EXISTS 'FIRST_ADMIN';
ALTER TYPE "PfActionKind" ADD VALUE IF NOT EXISTS 'FIRST_ADMIN_EMAIL_VERIFIED';
ALTER TYPE "PfActionKind" ADD VALUE IF NOT EXISTS 'FIRST_ADMIN_PASSWORD_SET';
ALTER TYPE "PfActionKind" ADD VALUE IF NOT EXISTS 'FIRST_ADMIN_TOTP_ENROLLED';
ALTER TYPE "PfActionKind" ADD VALUE IF NOT EXISTS 'FIRST_ADMIN_ACTIVATED';
