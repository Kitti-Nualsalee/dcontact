-- call UUID จาก media server ต้องสร้าง interaction ได้เพียงหนึ่งครั้ง แม้ Kafka ส่งซ้ำ
CREATE UNIQUE INDEX "interactions_tenant_id_external_id_key"
ON "interactions"("tenant_id", "external_id");
