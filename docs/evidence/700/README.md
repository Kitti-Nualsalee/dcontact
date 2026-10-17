# V1-A1 — หลักฐานพัฒนา save/result ของ Voice

วันที่ตรวจ: 17 ตุลาคม 2026 · authority: #699 / #700 · base: `e71a10f922bb1323b08360348b8ba372c122300c`

สถานะ: **IMPLEMENTATION** ยังไม่ใช่ completion evidence หรือ VM UAT PASS และยังไม่มี candidate SHA/PR/CI ของแพตช์นี้

## สิ่งที่ลงมือทำ

- Queue default LEGACY, stamp policy ของ inbound Voice ฝั่ง DB, immutable Interaction policy และ deferred result/completion guards
- Additive result table แยกจาก metadata พร้อม composite owner FK, note/disposition constraints, tenant RLS และสิทธิ์ append-only ของ application role
- Save/result/command-status HTTP API พร้อม domain AGENT authorization, normalized note, payload digest, command replay และ atomic result/event/availability/receipt
- Legacy HTTP ปฏิเสธ note แทนการทิ้ง field; HTTP/Router ปฏิเสธการปิดงาน V1 ผ่านช่องทาง legacy
- Workspace เพิ่มฟอร์ม TH/EN, Unicode code-point count, saved summary จากผล committed และ minimum same-component unknown lock/retry/check-result โดยไม่ส่ง note ผ่าน event ของ Embedded dphone
- เพิ่ม wrap-up browser spec ใน CI discovery; ยังไม่มีลิงก์ Console history ที่หน้า/API ไม่พร้อม

## จุดทดสอบและผลที่มี

ใช้ PostgreSQL dev ใหม่ที่แยกจาก VM/โครงการอื่น ทดสอบ HTTP ด้วย `dcontact_app` ที่ไม่เป็น superuser และเป็น NOBYPASSRLS; owner ใช้เฉพาะ setup/cleanup/fault injection ของ fixture สังเคราะห์

- ทดสอบ RED พบ legacy HTTP รับแล้วทิ้ง note; หลังแก้ test ผ่านและ disposition เดิมยังใช้ได้
- HTTP/RLS พิสูจน์ save/readback, CRLF/trim/Unicode boundaries, concurrent same-command, payload mismatch, competing intents, cross-tenant isolation และ atomic rollback เมื่อ result/event/state-log/receipt เขียนไม่สำเร็จ
- Readback/receipt summary ไม่ส่ง note ผ่าน receipt; no-store และ correlation ID ตรวจจาก HTTP response
- Old-writer test ตรวจ **persisted state หลัง transaction** ว่ายังคง WRAPUP และไม่มี result ไม่ใช้ promise rejection เพียงอย่างเดียวเป็นหลักฐาน เพราะ interactive transaction อาจไม่ส่ง deferred commit error กลับในรูปแบบที่ test คาด
- Save ใหม่บังคับตรวจ deferred constraints ภายใน transaction ก่อนคืนค่า เพื่อไม่สร้าง saved summary จาก transaction ที่ guard ปฏิเสธ
- Affected Agent/availability/SIP credential/work-session HTTP regression: 21 tests ผ่าน; Router integration ผ่าน
- API unit 92/92 และ Workspace unit 92/92 ผ่าน
- Workspace browser regression 60/60 ผ่าน; focused wrap-up 3/3 ครอบ response loss → read ยังไม่พบ → retry ได้ 401 → retry intent เดิมสำเร็จ รวม snapshot หลัง save ล้ม
- API/Workspace typecheck, Workspace production/embedded build, catalog/literals/CSS ผ่านในรอบพัฒนา

ผลข้างต้นเป็นผลแต่ละรอบใน worktree ไม่ใช่การรับรอง required CI บน final candidate ทุกคำสั่งต้องตรวจซ้ำตาม affected diff ก่อนส่ง review/release

## เกตที่ยังไม่ผ่าน

- Final affected integration/boundary และ compatibility coverage ทั้งหมดของ #700 พร้อม independent review และ required CI บน candidate เดียวกัน
- ยังไม่ผ่าน #701 recovery ที่อยู่ข้าม auth render/identity change, #702 Console history หรือ #703 release/media/headset trial
- ไม่มี VM mutation, account creation, email invitation, provider egress, เสียงจริง หรือ final V1 acceptance ในหลักฐานนี้

Browser harness ใช้ fake media และ HTTP routes เพื่อพิสูจน์ UI เท่านั้น ไม่ใช้แทน persistence หรือหลักฐานเสียงสองทาง ไม่แนบ raw HAR/trace/token/credentials/OTP/PII ในเอกสารนี้
