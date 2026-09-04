CREATE TYPE "QueueAuditAction" AS ENUM (
    'QUEUE_CREATED',
    'QUEUE_UPDATED',
    'QUEUE_ENABLED',
    'QUEUE_DISABLED',
    'DIRECT_DESTINATION_SET'
);

CREATE TABLE "queue_audit_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "queue_id" UUID NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "action" "QueueAuditAction" NOT NULL,
    "details" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "queue_audit_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "queue_audit_events_tenant_id_created_at_idx"
ON "queue_audit_events"("tenant_id", "created_at");

CREATE INDEX "queue_audit_events_tenant_id_queue_id_created_at_idx"
ON "queue_audit_events"("tenant_id", "queue_id", "created_at");

ALTER TABLE "queue_audit_events"
ADD CONSTRAINT "queue_audit_events_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "queue_audit_events"
ADD CONSTRAINT "queue_audit_events_tenant_id_queue_id_fkey"
FOREIGN KEY ("tenant_id", "queue_id") REFERENCES "queues"("tenant_id", "id")
ON DELETE RESTRICT ON UPDATE CASCADE;
