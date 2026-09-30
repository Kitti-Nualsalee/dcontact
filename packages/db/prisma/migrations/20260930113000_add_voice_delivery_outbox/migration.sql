-- E1.18 (#520): PostgreSQL ต้อง commit enum value ก่อน migration ถัดไปจะใช้เป็น default ได้.
ALTER TYPE "DlDeliveryAdapter" ADD VALUE IF NOT EXISTS 'FREESWITCH_ORIGINATE';
