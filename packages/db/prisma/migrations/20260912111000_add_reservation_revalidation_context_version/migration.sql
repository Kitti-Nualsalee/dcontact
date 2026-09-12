ALTER TABLE "cg_reservations"
  ADD COLUMN "authorization_context_version" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "cg_reservations_authorization_context_version_check"
    CHECK ("authorization_context_version" IN (0, 1));
