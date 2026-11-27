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
- เปิด job ที่ `FAILED` ด้วย `RECORDING_NOT_ARCHIVED` ใหม่ได้ผ่าน `POST qm/interactions/:id/transcription-jobs` (#990)
  - ทำได้เมื่อ recording archive แล้ว ถ้ายังไม่ archive จะได้ `409` พร้อม `code = RECORDING_NOT_ARCHIVED`
  - job เดิมกลับเป็น `PENDING` ที่ `attempts = 0`, failureCode ถูกล้าง และ publish attempt แรก
  - audit เป็น `TRANSCRIPTION_REQUESTED` ที่มี actor, `reopened: true`, `requestTrigger: MANUAL` และ `jobTrigger` (trigger ของ job ไม่เปลี่ยน)
  - ไม่ reset `createdAt` เพราะเพดานรอใช้เฉพาะตอน `archivedAt` เป็น null และ Telephony ไม่เคยล้าง `archivedAt` กลับ ถ้าวันหลังมี flow ที่ล้าง `archivedAt` ต้องทบทวนจุดนี้
  - ใช้สิทธิ์เดียวกับ manual request: Admin หรือ Supervisor ของทีมที่รับสาย
- job `FAILED` แบบอื่นยังเปิดใหม่ไม่ได้ เช่น `RECORDING_DELETED` (recording ถูกลบจึงได้ `404`) หรือ provider ล้มครบ `maxAttempts` ซึ่ง API คืน job เดิม

## Dispatch

- workflow และ API ตั้ง `dispatchedAt` ก่อน publish (claim ก่อน publish) และ publish เฉพาะ job ที่ยังไม่มี `nextAttemptAt`
- `QmRetryDispatcher` หยิบ job ที่ `PENDING` เมื่อถึง `nextAttemptAt` ไม่ว่า attempt เท่าไร
  - หยิบ job ที่ `dispatchedAt` ค้างเกิน 5 นาทีด้วย เผื่อ process ตายระหว่าง claim กับ publish
  - หยิบ job ใหม่ที่ไม่มีทั้ง `dispatchedAt` และ `nextAttemptAt` เมื่อสร้างมาเกิน 5 นาที (publish ล้มแล้วไม่มีใครเรียกซ้ำ)
  - log `[qm] re-dispatched stale transcription job` ทุกครั้งที่หยิบ job สองแบบนี้
  - คืน job ที่ค้าง `PROCESSING` นานเกินเวลาที่ job หนึ่งทำได้ (เวลารอ provider ทุกตัว + 3 นาที) เพราะ worker ตายกลางทาง เช่น deploy ระหว่าง job
    บันทึก `failureCode = WORKER_INTERRUPTED` แล้วคืน attempt นั้นและส่งใหม่ทันที ไม่นับเป็นครั้งที่ลอง (owner ตัดสิน 27 พ.ย. 2569)
    เกิน `QM_FREE_INTERRUPTIONS` (3) ครั้งต่อ job จึงนับเป็นครั้งที่ลอง และปิดเป็น `FAILED` เมื่อครบจำนวน กันไฟล์ที่ทำให้ worker ตายทุกครั้ง
    log `[qm] recovered an interrupted transcription job`
- worker บันทึกผล (READY หรือล้ม) เฉพาะ claim ของตัวเอง (attempt และ `startedAt` ตรง) ผลที่มาช้าจาก claim ที่ถูกคืนแล้วจะถูกทิ้ง
- message ที่มาก่อนถึงเวลา หรือมาถึง job ที่ `FAILED` แล้ว เป็น no-op ไม่ throw

## Provider contract

QM เรียก ASR ตาม [D-Contact ASR Provider Protocol v1](../../docs/qm-asr-provider-protocol.md) ซึ่งเป็นสัญญากลางของทุก provider

- `QM_MEDIA_ENDPOINT` และ `QM_TRANSCRIPTION_ENDPOINT` เป็น `https:` เท่านั้น ค่า credential/API key ต้องมาจาก environment-specific secret boundary
- `QM_TRANSCRIPTION_TIMEOUT_MS` เวลารอ provider ต่อคำขอ ค่าเริ่มต้น 300000 (5 นาที)
- `QM_SCORING_TIMEOUT_MS` เวลารอ scorer ต่อคำขอ ค่าเริ่มต้น 120000 (2 นาที)
- ระหว่างรอ provider worker ส่ง heartbeat ของ Kafka ทุก 5 วินาที และ rebalance timeout ของ consumer job เท่ากับเวลารอ provider รวมกันบวก 60 วินาที
- response ต้องผ่าน `parseTranscriptionResult()` ใน `src/asr-provider-protocol.ts`: `modelId`, `language`, `confidenceAvg` และ `segments` ที่มี speaker/timestamp/text
- provider ใหม่ต้องผ่าน `runAsrProviderContract()` ใน `src/asr-provider-contract.ts`

## ASR simulator

ระหว่างที่ยังไม่มีโมเดลจริง ใช้ `src/asr-simulator-main.ts` (`dist/asr-simulator-main.js`) ซึ่งผ่าน contract เดียวกัน
ดาวน์โหลดไฟล์เสียงจริงและหาช่วงที่มีเสียงของแต่ละ channel แต่ข้อความเป็นประโยคจำลองที่ขึ้นต้นด้วย `[จำลอง]`

```bash
ASR_SIMULATOR_API_KEY=<token เดียวกับ QM_TRANSCRIPTION_API_KEY> \
ASR_SIMULATOR_MEDIA_HOSTS=<host ของ QM_MEDIA_ENDPOINT> \
pnpm --filter @d-contact/qm asr-simulator
```

simulator ฟัง HTTP ที่ `PORT` (ค่าเริ่มต้น 8090) ต้องมี reverse proxy ที่จบ TLS อยู่ข้างหน้า เพราะ QM เรียกเฉพาะ HTTPS

ถ้าต้องการ auto-QM ให้กำหนด `QM_SCORING_*` ด้วย ทุกคำตอบที่ไม่มีหลักฐานอ้างอิง transcript segment จะถูกแปลงเป็น `INSUFFICIENT_EVIDENCE` และผลจะยังเป็น `DRAFT` จน Supervisor/Admin ที่มีสิทธิ์กด publish

ดูชื่อตัวแปรทั้งหมดใน `.env.example`
