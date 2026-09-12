-- J2.8: jr_owner_command_outbox needs the full J2OwnerCommandPayloadV1 envelope to
-- actually relay to Cases/Dialer ports, and a PROCESSING claim state so a relay
-- worker's SKIP LOCKED claim survives across the two transactions it needs
-- (claim, then call the owner port outside any transaction, then settle).

ALTER TYPE "JrOwnerCommandState" ADD VALUE 'PROCESSING';

-- The real J2OwnerResultStatus vocabulary includes SUPERSEDED (from
-- SUPERSEDE_CALLBACK/SUPERSEDE_CAMPAIGN_TARGET), which J2.3's original
-- ACKNOWLEDGED/REJECTED/ACK_UNKNOWN/CANCELLED/TOO_LATE/RECONCILING vocabulary
-- was missing entirely.
ALTER TYPE "JrOwnerActionState" ADD VALUE 'SUPERSEDED';
ALTER TYPE "JrOwnerResultKind" ADD VALUE 'SUPERSEDED';

ALTER TABLE "jr_owner_command_outbox" ADD COLUMN "payload" JSONB;
