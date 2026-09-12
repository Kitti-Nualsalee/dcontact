-- S1.7: บังคับ immutable binding ของ Dialer raw attempt ใน tenant เดียวกัน
-- เพื่อปฏิเสธ contact/identity/reservation swap ข้าม tenant ที่ระดับฐานข้อมูล.

ALTER TABLE "ob_attempts"
  ADD CONSTRAINT "ob_attempts_tenant_contact_fkey"
  FOREIGN KEY ("tenant_id", "contact_id") REFERENCES "contacts"("tenant_id", "id")
  NOT VALID;
ALTER TABLE "ob_attempts" VALIDATE CONSTRAINT "ob_attempts_tenant_contact_fkey";

ALTER TABLE "ob_attempts"
  ADD CONSTRAINT "ob_attempts_tenant_identity_fkey"
  FOREIGN KEY ("tenant_id", "identity_id") REFERENCES "contact_identities"("tenant_id", "id")
  NOT VALID;
ALTER TABLE "ob_attempts" VALIDATE CONSTRAINT "ob_attempts_tenant_identity_fkey";

ALTER TABLE "ob_attempts"
  ADD CONSTRAINT "ob_attempts_tenant_reservation_fkey"
  FOREIGN KEY ("tenant_id", "reservation_id") REFERENCES "cg_reservations"("tenant_id", "id")
  NOT VALID;
ALTER TABLE "ob_attempts" VALIDATE CONSTRAINT "ob_attempts_tenant_reservation_fkey";
