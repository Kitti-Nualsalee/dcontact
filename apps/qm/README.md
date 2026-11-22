# QM worker

`apps/qm` รับ `interaction.ended` จาก `dc.interaction.events` แล้วสร้าง transcription job โดยไม่เพิ่มงานบน critical call path จากนั้น worker รับงานผ่าน `dc.qm.jobs`, อ่าน recording ด้วย signed HTTPS URL และเรียก provider โดยกำหนด `dataUse=NO_TRAINING`

## Queue policy

- `OFF` — ไม่สร้าง transcription job
- `AUTOMATIC` — สร้าง job หลัง `interaction.ended`
- `MANUAL` — Supervisor/Admin ของทีมเริ่มผ่าน REST API
- `transcriptionMaxAttempts` จำกัดจำนวนครั้งทั้งหมด; retry ใช้ exponential backoff และมี audit
- `autoQmEnabled` สร้าง evaluation สถานะ `DRAFT` เมื่อกำหนด scoring provider

## รอ recording archive

Telephony อาจส่ง `call.hangup` ก่อน archive WAV ขึ้น object storage เสร็จ worker จึงทำตามนี้

- `recording.archivedAt` ยังเป็น null: เลื่อน `nextAttemptAt` 15 วินาทีถึง 5 นาที โดยไม่นับ attempt
  - job ยัง `PENDING` และมี `failureCode = RECORDING_NOT_ARCHIVED`
  - audit เป็น `TRANSCRIPTION_RETRY_SCHEDULED` ที่ `attempt` ไม่เพิ่ม และมี `waitDeadline`
- ถ้ารอครบ 1 ชั่วโมงนับจากสร้าง job แล้วยังไม่ archive จะเป็น `FAILED` ด้วย `RECORDING_NOT_ARCHIVED`
- `recording.deletedAt` มีค่า (เช่น Telephony บันทึก `ARCHIVE_ABANDONED`): เป็น `FAILED` ด้วย `RECORDING_DELETED`
  - audit มีแค่ `TRANSCRIPTION_FAILED` ไม่มี `TRANSCRIPTION_STARTED` นำหน้า
- job ที่ปิดเป็น `FAILED` แล้ว request ใหม่ผ่าน API จะได้ job เดิมกลับมา ยังสั่งถอดเสียงซ้ำไม่ได้

## Dispatch

- workflow และ API ตั้ง `dispatchedAt` ก่อน publish (claim ก่อน publish) และ publish เฉพาะ job ที่ยังไม่มี `nextAttemptAt`
- `QmRetryDispatcher` หยิบ job ที่ `PENDING` เมื่อถึง `nextAttemptAt` ไม่ว่า attempt เท่าไร
  - หยิบ job ที่ `dispatchedAt` ค้างเกิน 5 นาทีด้วย เผื่อ process ตายระหว่าง claim กับ publish
  - หยิบ job ใหม่ที่ไม่มีทั้ง `dispatchedAt` และ `nextAttemptAt` เมื่อสร้างมาเกิน 5 นาที (publish ล้มแล้วไม่มีใครเรียกซ้ำ)
  - log `[qm] re-dispatched stale transcription job` ทุกครั้งที่หยิบ job สองแบบนี้
- message ที่มาก่อนถึงเวลา หรือมาถึง job ที่ `FAILED` แล้ว เป็น no-op ไม่ throw

## Provider contract

กำหนด `QM_MEDIA_ENDPOINT` และ `QM_TRANSCRIPTION_ENDPOINT` เป็น `https:` เท่านั้น ค่า credential/API key ต้องมาจาก environment-specific secret boundary ค่า response ของ transcription provider ต้องมี `modelId`, `language`, `confidenceAvg` และ `segments` พร้อม speaker/timestamp/text

ถ้าต้องการ auto-QM ให้กำหนด `QM_SCORING_*` ด้วย ทุกคำตอบที่ไม่มีหลักฐานอ้างอิง transcript segment จะถูกแปลงเป็น `INSUFFICIENT_EVIDENCE` และผลจะยังเป็น `DRAFT` จน Supervisor/Admin ที่มีสิทธิ์กด publish

ดูชื่อตัวแปรทั้งหมดใน `.env.example`
