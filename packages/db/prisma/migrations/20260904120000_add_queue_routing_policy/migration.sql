CREATE TYPE "QueueRoutingStrategy" AS ENUM (
  'LONGEST_AVAILABLE_IDLE',
  'LONGEST_SINCE_LAST_INTERACTION',
  'ROUND_ROBIN'
);
CREATE TYPE "QueueMaxWaitAction_new" AS ENUM ('WAIT', 'CALLBACK', 'VOICEMAIL');

ALTER TABLE "tenants"
  ADD COLUMN "default_offer_timeout_sec" INTEGER NOT NULL DEFAULT 20,
  ADD COLUMN "default_offer_timeout_action" "QueueOfferTimeoutAction" NOT NULL DEFAULT 'COOLDOWN_REQUEUE',
  ADD COLUMN "default_offer_cooldown_sec" INTEGER NOT NULL DEFAULT 60,
  ADD COLUMN "default_max_wait_sec" INTEGER,
  ADD COLUMN "default_max_wait_action" "QueueMaxWaitAction_new" NOT NULL DEFAULT 'VOICEMAIL';

ALTER TABLE "queues" ALTER COLUMN "max_wait_action" DROP DEFAULT;
ALTER TABLE "queues"
  ALTER COLUMN "max_wait_action" TYPE "QueueMaxWaitAction_new"
  USING CASE "max_wait_action"::text
    WHEN 'REQUEUE' THEN 'WAIT'::"QueueMaxWaitAction_new"
    WHEN 'ABANDON' THEN 'VOICEMAIL'::"QueueMaxWaitAction_new"
  END;
DROP TYPE "QueueMaxWaitAction";
ALTER TYPE "QueueMaxWaitAction_new" RENAME TO "QueueMaxWaitAction";

ALTER TABLE "queues"
  ALTER COLUMN "offer_timeout_sec" DROP NOT NULL,
  ALTER COLUMN "offer_timeout_sec" DROP DEFAULT,
  ALTER COLUMN "offer_timeout_action" DROP NOT NULL,
  ALTER COLUMN "offer_timeout_action" DROP DEFAULT,
  ALTER COLUMN "offer_cooldown_sec" DROP NOT NULL,
  ALTER COLUMN "offer_cooldown_sec" DROP DEFAULT,
  ALTER COLUMN "max_wait_action" DROP NOT NULL,
  ADD COLUMN "routing_strategy" "QueueRoutingStrategy" NOT NULL DEFAULT 'LONGEST_AVAILABLE_IDLE';

UPDATE "queues"
SET "offer_timeout_sec" = NULL,
    "offer_timeout_action" = NULL,
    "offer_cooldown_sec" = NULL,
    "max_wait_action" = NULL;
