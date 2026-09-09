CREATE TABLE "kafka_consumer_inbox" (
    "consumer_group" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "event_id" TEXT NOT NULL,
    "completed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "kafka_consumer_inbox_pkey" PRIMARY KEY ("consumer_group", "tenant_id", "event_id")
);

CREATE INDEX "kafka_consumer_inbox_tenant_id_completed_at_idx"
ON "kafka_consumer_inbox"("tenant_id", "completed_at");

ALTER TABLE "kafka_consumer_inbox"
ADD CONSTRAINT "kafka_consumer_inbox_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "kafka_consumer_inbox" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "kafka_consumer_inbox"
USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "kafka_consumer_inbox" TO dcontact_app;
