-- J2.8 follow-up: admin recovery API ตาม #136 บังคับ expectedVersion บนทุก mutation
-- (replay/reconcile/cancel) แต่ jr_owner_actions ยังไม่มี optimistic-concurrency token
-- เลย — attempts นับจำนวนครั้งที่ dispatch ไม่ใช่ version ของ aggregate และไม่ขยับตอน
-- cancel จึงใช้แทนกันไม่ได้
ALTER TABLE "jr_owner_actions"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
