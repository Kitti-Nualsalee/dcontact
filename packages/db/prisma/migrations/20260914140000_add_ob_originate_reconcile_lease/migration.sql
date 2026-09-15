-- J2.9 follow-up: crash ระหว่างสอง transaction ของ originate barrier ทิ้ง target/callback
-- ค้างใน ORIGINATING ถาวร เพราะไม่มี lease ให้รู้ว่าค้างตั้งแต่เมื่อไร และไม่มี state ปลายทาง
-- ที่บอกว่า "ต้อง reconcile ห้าม originate ซ้ำ" — เติมทั้งสองอย่างตามแบบ dl_outbox_entries
-- ที่ DeliveryTestAdapter.reconcileExpired ใช้อยู่แล้ว
ALTER TYPE "ObCampaignTargetState" ADD VALUE 'RECONCILING';
ALTER TYPE "ObCallbackState" ADD VALUE 'RECONCILING';

ALTER TABLE "ob_campaign_targets"
  ADD COLUMN "originate_lease_expires_at" TIMESTAMP(3);
ALTER TABLE "ob_callbacks"
  ADD COLUMN "originate_lease_expires_at" TIMESTAMP(3);

-- sweeper สแกนเฉพาะแถวที่ค้างใน ORIGINATING และ lease หมดแล้วเท่านั้น
CREATE INDEX "ob_campaign_targets_originate_lease_idx"
  ON "ob_campaign_targets" ("tenant_id", "state", "originate_lease_expires_at");
CREATE INDEX "ob_callbacks_originate_lease_idx"
  ON "ob_callbacks" ("tenant_id", "state", "originate_lease_expires_at");
