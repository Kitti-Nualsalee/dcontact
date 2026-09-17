-- J3.9 (#220): IAM invalidation must schedule a separate re-filter task per owner team.
-- The former key represented only Customer 360 membership changes and would collapse two team
-- revocations for the same segment entry into one cursor, risking cross-team cancellation.
DROP INDEX "jr_segment_refilter_cursors_key";
CREATE UNIQUE INDEX "jr_segment_refilter_cursors_team_scope_key"
  ON "jr_segment_refilter_cursors" ("tenant_id", "contact_id", "segment_id", "membership_revision", "scope_team_id");
