-- C1.6: journey-level purpose/senderIdentityId ที่ SEND ทุกโหนดในเวอร์ชันใช้เรียก
-- authorizeAndReserve/enqueue ร่วมกัน แทนที่จะให้แต่ละ SEND step ประกาศเอง
ALTER TABLE "jr_journey_definitions"
ADD COLUMN "purpose" TEXT NOT NULL DEFAULT '',
ADD COLUMN "sender_identity_id" TEXT NOT NULL DEFAULT '';

ALTER TABLE "jr_journey_definitions" ALTER COLUMN "purpose" DROP DEFAULT;
ALTER TABLE "jr_journey_definitions" ALTER COLUMN "sender_identity_id" DROP DEFAULT;
