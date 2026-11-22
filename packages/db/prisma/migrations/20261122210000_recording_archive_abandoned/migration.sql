-- Telephony หยุดลอง archive recording ที่ไฟล์ต้นทางไม่มีวันมี และบันทึกหลักฐานใน recording_audit_events
ALTER TYPE "RecordingAuditAction" ADD VALUE IF NOT EXISTS 'ARCHIVE_ABANDONED';
