-- J3.2 (#213): ปิดช่องเขียนตรงข้าม lifecycle/result invariants แม้ข้าม owner repository

ALTER TABLE "c360_segment_definitions"
  ADD CONSTRAINT "c360_segment_definitions_lifecycle_check" CHECK (
    ("status" = 'DRAFT' AND "effective_from" IS NULL AND "effective_to" IS NULL AND "published_at" IS NULL)
    OR (
      "status" = 'PUBLISHED'
      AND "effective_from" IS NOT NULL
      AND "effective_to" IS NULL
      AND "published_at" IS NOT NULL
    )
    OR (
      "status" = 'SUPERSEDED'
      AND "effective_from" IS NOT NULL
      AND "effective_to" IS NOT NULL
      AND "published_at" IS NOT NULL
    )
  );

ALTER TABLE "c360_segment_definition_heads"
  ADD CONSTRAINT "c360_segment_definition_heads_state_check" CHECK (
    ("head_version" = 0 AND "current_version" IS NULL AND "current_digest" IS NULL)
    OR ("head_version" >= 1 AND "current_version" IS NOT NULL AND "current_digest" IS NOT NULL)
  );

ALTER TABLE "c360_segment_evaluations"
  DROP CONSTRAINT "c360_segment_evaluations_outcome_check",
  ADD CONSTRAINT "c360_segment_evaluations_outcome_check" CHECK (
    ("outcome" = 'MATCH' AND "matched" IS TRUE AND "error_code" IS NULL)
    OR ("outcome" = 'NO_MATCH' AND "matched" IS FALSE AND "error_code" IS NULL)
    OR ("outcome" = 'ERROR' AND "matched" IS NULL AND "error_code" IS NOT NULL)
  );
