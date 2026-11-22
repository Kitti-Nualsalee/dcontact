-- #971 Supervisor ประเมินสายของทีมด้วยฟอร์ม แล้ว Agent เห็นคะแนนของตัวเอง
-- ฟอร์มเป็น metadata มีเวอร์ชัน (ADR-010 ข้อ 9): เวอร์ชันที่ publish แล้วแก้ไม่ได้ ต้องออกเวอร์ชันใหม่
-- ผลประเมินเก็บ snapshot ของฟอร์มไว้เสมอ จึงอ่านย้อนหลังได้แม้ฟอร์มเปลี่ยน

CREATE TYPE "QmFormVersionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'SUPERSEDED');

ALTER TYPE "QmAuditAction" ADD VALUE 'FORM_VERSION_PUBLISHED';

CREATE TABLE "qm_forms" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "created_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "qm_forms_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "qm_forms_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "qm_forms_creator_fkey"
    FOREIGN KEY ("tenant_id", "created_by_user_id") REFERENCES "users"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "qm_forms_name_check" CHECK (char_length(btrim("name")) BETWEEN 1 AND 120)
);

CREATE UNIQUE INDEX "qm_forms_tenant_id_id_key" ON "qm_forms"("tenant_id", "id");
-- ชื่อซ้ำใน tenant เดียวกันทำให้ Supervisor เลือกฟอร์มผิด
CREATE UNIQUE INDEX "qm_forms_tenant_name_key" ON "qm_forms"("tenant_id", lower(btrim("name")));

CREATE TABLE "qm_form_versions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "form_id" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "status" "QmFormVersionStatus" NOT NULL DEFAULT 'DRAFT',
  "definition" JSONB NOT NULL,
  -- revision ของร่าง: กันการแก้ทับกันระหว่าง Admin สองคน
  "revision" INTEGER NOT NULL DEFAULT 1,
  "created_by_user_id" UUID NOT NULL,
  "published_by_user_id" UUID,
  "published_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "qm_form_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "qm_form_versions_form_fkey"
    FOREIGN KEY ("tenant_id", "form_id") REFERENCES "qm_forms"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "qm_form_versions_creator_fkey"
    FOREIGN KEY ("tenant_id", "created_by_user_id") REFERENCES "users"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "qm_form_versions_publisher_fkey"
    FOREIGN KEY ("tenant_id", "published_by_user_id") REFERENCES "users"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "qm_form_versions_version_check" CHECK ("version" >= 1 AND "revision" >= 1),
  CONSTRAINT "qm_form_versions_published_check" CHECK (
    ("status" = 'DRAFT' AND "published_at" IS NULL AND "published_by_user_id" IS NULL)
    OR ("status" <> 'DRAFT' AND "published_at" IS NOT NULL AND "published_by_user_id" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "qm_form_versions_tenant_id_id_key" ON "qm_form_versions"("tenant_id", "id");
CREATE UNIQUE INDEX "qm_form_versions_form_version_key"
  ON "qm_form_versions"("tenant_id", "form_id", "version");
-- หนึ่งฟอร์มมีร่างได้หนึ่งเวอร์ชัน และเวอร์ชันที่ใช้อยู่ได้หนึ่งเวอร์ชัน
CREATE UNIQUE INDEX "qm_form_versions_one_draft_key"
  ON "qm_form_versions"("tenant_id", "form_id") WHERE "status" = 'DRAFT';
CREATE UNIQUE INDEX "qm_form_versions_one_published_key"
  ON "qm_form_versions"("tenant_id", "form_id") WHERE "status" = 'PUBLISHED';

-- เวอร์ชันที่ publish แล้วเปลี่ยนได้อย่างเดียวคือถูกแทนที่ (PUBLISHED → SUPERSEDED) และลบไม่ได้
CREATE FUNCTION "qm_form_versions_guard_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = 'DRAFT' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" = 'PUBLISHED' AND NEW."status" = 'SUPERSEDED'
    AND NEW."definition" = OLD."definition" AND NEW."version" = OLD."version"
    AND NEW."form_id" = OLD."form_id" AND NEW."tenant_id" = OLD."tenant_id"
    AND NEW."revision" = OLD."revision"
    AND NEW."created_by_user_id" = OLD."created_by_user_id"
    AND NEW."published_at" = OLD."published_at"
    AND NEW."published_by_user_id" = OLD."published_by_user_id" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'QM_FORM_VERSION_IMMUTABLE' USING ERRCODE = 'P0001';
END;
$$;

CREATE TRIGGER "qm_form_versions_guard_immutable"
  BEFORE UPDATE OR DELETE ON "qm_form_versions"
  FOR EACH ROW EXECUTE FUNCTION "qm_form_versions_guard_immutable"();

-- ผลประเมินโดยคน: ไม่มี provider/model; ต้องมีฟอร์มและ snapshot เสมอ
ALTER TABLE "qm_evaluations"
  ALTER COLUMN "provider_id" DROP NOT NULL,
  ALTER COLUMN "model_id" DROP NOT NULL,
  ALTER COLUMN "prompt_version" DROP NOT NULL,
  ADD COLUMN "form_version_id" UUID,
  ADD COLUMN "form_snapshot" JSONB,
  ADD COLUMN "raw_score" DECIMAL(5,2),
  ADD COLUMN "final_score" DECIMAL(5,2),
  ADD COLUMN "auto_failed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "comment" TEXT,
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1,
  ADD CONSTRAINT "qm_evaluations_form_version_fkey"
    FOREIGN KEY ("tenant_id", "form_version_id") REFERENCES "qm_form_versions"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "qm_evaluations_source_shape_check" CHECK (
    ("source" = 'AUTO_DRAFT' AND "provider_id" IS NOT NULL AND "model_id" IS NOT NULL
      AND "prompt_version" IS NOT NULL)
    OR ("source" = 'HUMAN' AND "form_version_id" IS NOT NULL AND "form_snapshot" IS NOT NULL
      AND "evaluator_id" IS NOT NULL)
  ),
  ADD CONSTRAINT "qm_evaluations_score_check" CHECK (
    ("raw_score" IS NULL OR "raw_score" BETWEEN 0 AND 100)
    AND ("final_score" IS NULL OR "final_score" BETWEEN 0 AND 100)
    AND ("source" <> 'HUMAN' OR "status" <> 'PUBLISHED'
      OR ("final_score" IS NOT NULL AND "raw_score" IS NOT NULL AND "published_at" IS NOT NULL))
  ),
  ADD CONSTRAINT "qm_evaluations_comment_check" CHECK (
    "comment" IS NULL OR char_length("comment") <= 4000
  ),
  ADD CONSTRAINT "qm_evaluations_revision_check" CHECK ("revision" >= 1);

-- Agent อ่านผลที่ publish แล้วของตัวเองเรียงตามเวลา
CREATE INDEX "qm_evaluations_agent_published_idx"
  ON "qm_evaluations"("tenant_id", "agent_id", "published_at" DESC)
  WHERE "status" = 'PUBLISHED';

-- ผลประเมินโดยคนที่ publish แล้วเป็นเอกสาร HR: แก้ไม่ได้ (appeal จะเพิ่มเส้นทางของตัวเองภายหลัง)
CREATE FUNCTION "qm_evaluations_guard_published_human"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."source" = 'HUMAN' AND OLD."status" = 'PUBLISHED' THEN
    RAISE EXCEPTION 'QM_EVALUATION_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  -- trigger แบบ BEFORE DELETE ต้องคืน OLD ไม่งั้นการลบถูกยกเลิกเงียบ ๆ
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER "qm_evaluations_guard_published_human"
  BEFORE UPDATE OR DELETE ON "qm_evaluations"
  FOR EACH ROW EXECUTE FUNCTION "qm_evaluations_guard_published_human"();
