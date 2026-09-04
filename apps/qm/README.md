# QM worker

`apps/qm` รับ `interaction.ended` จาก `dc.interaction.events` แล้วสร้าง transcription job โดยไม่เพิ่มงานบน critical call path จากนั้น worker รับงานผ่าน `dc.qm.jobs`, อ่าน recording ด้วย signed HTTPS URL และเรียก provider โดยกำหนด `dataUse=NO_TRAINING`

## Queue policy

- `OFF` — ไม่สร้าง transcription job
- `AUTOMATIC` — สร้าง job หลัง `interaction.ended`
- `MANUAL` — Supervisor/Admin ของทีมเริ่มผ่าน REST API
- `transcriptionMaxAttempts` จำกัดจำนวนครั้งทั้งหมด; retry ใช้ exponential backoff และมี audit
- `autoQmEnabled` สร้าง evaluation สถานะ `DRAFT` เมื่อกำหนด scoring provider

## Provider contract

กำหนด `QM_MEDIA_ENDPOINT` และ `QM_TRANSCRIPTION_ENDPOINT` เป็น `https:` เท่านั้น ค่า credential/API key ต้องมาจาก environment-specific secret boundary ค่า response ของ transcription provider ต้องมี `modelId`, `language`, `confidenceAvg` และ `segments` พร้อม speaker/timestamp/text

ถ้าต้องการ auto-QM ให้กำหนด `QM_SCORING_*` ด้วย ทุกคำตอบที่ไม่มีหลักฐานอ้างอิง transcript segment จะถูกแปลงเป็น `INSUFFICIENT_EVIDENCE` และผลจะยังเป็น `DRAFT` จน Supervisor/Admin ที่มีสิทธิ์กด publish

ดูชื่อตัวแปรทั้งหมดใน `.env.example`
