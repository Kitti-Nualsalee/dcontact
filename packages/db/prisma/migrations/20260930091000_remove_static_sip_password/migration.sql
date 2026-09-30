-- E1.10 (#484): static SIP password ถูกแทนด้วย one-time credential ที่ผูก work-session lease แล้ว
ALTER TABLE "users" DROP COLUMN "sip_password";
