-- IAM.1: application code must never rewrite durable grant evidence.
REVOKE UPDATE, DELETE ON "iam_team_segment_scope_grants" FROM dcontact_app;
