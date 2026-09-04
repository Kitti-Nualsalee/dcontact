CREATE TYPE "QueueOfferTimeoutAction" AS ENUM ('IMMEDIATE_REQUEUE', 'COOLDOWN_REQUEUE', 'ABANDON');
CREATE TYPE "QueueMaxWaitAction" AS ENUM ('REQUEUE', 'ABANDON');

ALTER TABLE "queues"
  ADD COLUMN "offer_timeout_sec" INTEGER NOT NULL DEFAULT 20,
  ADD COLUMN "offer_timeout_action" "QueueOfferTimeoutAction" NOT NULL DEFAULT 'COOLDOWN_REQUEUE',
  ADD COLUMN "offer_cooldown_sec" INTEGER NOT NULL DEFAULT 60,
  ADD COLUMN "max_wait_action" "QueueMaxWaitAction" NOT NULL DEFAULT 'ABANDON';

ALTER TABLE "interactions"
  ADD COLUMN "offer_expires_at" TIMESTAMP(3),
  ADD COLUMN "requeue_at" TIMESTAMP(3);

CREATE INDEX "interactions_tenant_id_offer_expires_at_idx"
  ON "interactions"("tenant_id", "offer_expires_at");
CREATE INDEX "interactions_tenant_id_requeue_at_idx"
  ON "interactions"("tenant_id", "requeue_at");
