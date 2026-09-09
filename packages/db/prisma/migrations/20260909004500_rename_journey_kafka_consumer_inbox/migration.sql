ALTER TABLE "kafka_consumer_inbox" RENAME TO "jr_kafka_consumer_inbox";

ALTER TABLE "jr_kafka_consumer_inbox"
RENAME CONSTRAINT "kafka_consumer_inbox_pkey" TO "jr_kafka_consumer_inbox_pkey";

ALTER INDEX "kafka_consumer_inbox_tenant_id_completed_at_idx"
RENAME TO "jr_kafka_consumer_inbox_tenant_id_completed_at_idx";

ALTER TABLE "jr_kafka_consumer_inbox"
RENAME CONSTRAINT "kafka_consumer_inbox_tenant_id_fkey" TO "jr_kafka_consumer_inbox_tenant_id_fkey";
