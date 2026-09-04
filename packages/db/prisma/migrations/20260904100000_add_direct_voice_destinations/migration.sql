-- Direct voice destinations are tenant metadata. The composite foreign key
-- makes it impossible for a destination to point at another tenant's queue.
CREATE TYPE "VoiceDestinationEntryMode" AS ENUM ('DIRECT_QUEUE');

CREATE UNIQUE INDEX "queues_tenant_id_id_key" ON "queues"("tenant_id", "id");

CREATE TABLE "voice_destinations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "destination" TEXT NOT NULL,
    "entry_mode" "VoiceDestinationEntryMode" NOT NULL DEFAULT 'DIRECT_QUEUE',
    "queue_id" UUID NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "voice_destinations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "voice_destinations_tenant_id_destination_key"
ON "voice_destinations"("tenant_id", "destination");

CREATE INDEX "voice_destinations_tenant_id_queue_id_idx"
ON "voice_destinations"("tenant_id", "queue_id");

ALTER TABLE "voice_destinations"
ADD CONSTRAINT "voice_destinations_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "voice_destinations"
ADD CONSTRAINT "voice_destinations_tenant_id_queue_id_fkey"
FOREIGN KEY ("tenant_id", "queue_id") REFERENCES "queues"("tenant_id", "id")
ON DELETE RESTRICT ON UPDATE CASCADE;
