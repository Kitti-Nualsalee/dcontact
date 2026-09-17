-- IAM.2: runtime scope authorization must deny a deactivated team.
ALTER TABLE "teams" ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT TRUE;
