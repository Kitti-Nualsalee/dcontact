-- CG4.2 follow-up: contract ระบุ lifecycle DRAFT -> IN_REVIEW -> APPROVED.
-- ใช้ migration เพิ่มเติมแทนแก้ history ที่ deploy ใน development database แล้ว.
ALTER TYPE "Cg4PolicyStatus" RENAME VALUE 'PENDING_APPROVAL' TO 'IN_REVIEW';
