# D-Contact ASR Provider Protocol v1

สัญญา HTTP ระหว่าง QM worker (`apps/qm`) กับ ASR provider ทุกตัว ตาม [ADR-010](adr/010-quality-management.md) ข้อ 6
ที่กำหนดว่า ASR อยู่หลัง `TranscriptionProvider`, ใช้ 1 provider ต่อ deployment, สลับด้วย config และ contract test ต้องผ่านทุก provider

- provider จริงแต่ละเจ้า (cloud หรือโมเดลที่รันเองในองค์กร) ต้องมี gateway ที่พูด protocol นี้ QM ไม่มีโค้ดเฉพาะเจ้า
- ระหว่างที่ยังไม่มีโมเดลจริง ใช้ ASR simulator (`apps/qm/src/asr-simulator.ts`) ที่ผ่าน contract ชุดเดียวกัน
- type และ validator อยู่ใน `apps/qm/src/asr-provider-protocol.ts` ส่วน contract test อยู่ใน `apps/qm/src/asr-provider-contract.ts`

## ภาพรวม

1. สายจบ แล้ว Telephony เก็บไฟล์เสียง WAV ใน object storage
2. QM สร้าง signed URL แบบ HTTPS อายุ 5 นาทีของไฟล์นั้น แล้ว `POST` ไปที่ provider
3. provider ดาวน์โหลดไฟล์จาก signed URL ถอดเสียง แล้วตอบ segment กลับใน response เดียวกัน (synchronous)
4. QM ตรวจ response ตามสัญญานี้แล้วเก็บเป็น transcript

## คำขอ

```
POST {QM_TRANSCRIPTION_ENDPOINT}
```

`QM_TRANSCRIPTION_ENDPOINT` คือ URL เต็มของ endpoint ถอดเสียง ต้องเป็น `https:` และควรลงท้ายด้วย `/v1/transcriptions`

| Header | ค่า | หมายเหตุ |
| --- | --- | --- |
| `content-type` | `application/json` | |
| `authorization` | `Bearer {QM_TRANSCRIPTION_API_KEY}` | QM ไม่ส่งถ้าไม่ได้ตั้ง key; provider ที่ต้องใช้ key ต้องตอบ `401` |
| `x-dcontact-data-use` | `no-training` | ห้ามนำเสียงหรือข้อความไปฝึกโมเดล ไม่มี header นี้ต้องตอบ `400 DATA_USE_REQUIRED` |
| `x-dcontact-asr-protocol` | `1` | major version ไม่ตรงต้องตอบ `400 PROTOCOL_UNSUPPORTED`; ไม่มี header ให้ถือว่าเป็น `1` |

Body:

```json
{
  "mediaUrl": "https://media.example/recordings/<tenantId>/<file>.wav?X-Amz-Signature=...",
  "mediaUrlExpiresAt": "2026-11-23T03:05:00.000Z",
  "channelLayout": "STEREO",
  "languageHint": "th-TH",
  "dataUse": "NO_TRAINING"
}
```

| Field | ความหมาย |
| --- | --- |
| `mediaUrl` | signed URL แบบ HTTPS ของไฟล์ WAV (PCM 16-bit, 8–48 kHz) เป็น credential ชั่วคราว: ห้าม log query string และห้ามเก็บ |
| `mediaUrlExpiresAt` | เวลาหมดอายุของ URL (ISO 8601) provider ต้องเริ่มดาวน์โหลดก่อนเวลานี้ ถ้าหมดแล้วตอบ `400 MEDIA_URL_EXPIRED` |
| `channelLayout` | `STEREO` = 2 channel แยกฝั่ง, `PER_LEG` = เสียงรวม channel เดียว |
| `languageHint` | ภาษาที่คาดไว้ เช่น `th-TH` |
| `dataUse` | ต้องเป็น `NO_TRAINING` ค่าอื่นตอบ `400 DATA_USE_REQUIRED` |

### Channel ของไฟล์ STEREO

ไฟล์ STEREO มาจาก `RECORD_STEREO` ของ FreeSWITCH:

- channel ซ้าย (index 0) = ผู้โทร ซึ่งเป็นลูกค้าในสายขาเข้า: ใช้ speaker `CONTACT`
- channel ขวา (index 1) = สิ่งที่ผู้โทรได้ยิน ได้แก่ Agent (และเสียง IVR หรือระบบ ถ้าแยกได้): ใช้ speaker `AGENT` (`IVR`/`SYSTEM`)

ไฟล์ `PER_LEG` เป็นเสียงรวม provider ต้องแยกผู้พูดเอง (diarization) และระบุ speaker ตามที่ทำได้ดีที่สุด

## Response สำเร็จ (`200`)

```json
{
  "modelId": "thai-asr-2026-11",
  "language": "th-TH",
  "confidenceAvg": 0.91,
  "segments": [
    { "speaker": "AGENT", "startMs": 480, "endMs": 1720, "text": "สวัสดีค่ะ", "confidence": 0.93 },
    { "speaker": "CONTACT", "startMs": 2000, "endMs": 3480, "text": "สวัสดีครับ", "confidence": 0.88 }
  ]
}
```

| Field | กติกา |
| --- | --- |
| `modelId` | ชื่อโมเดลพร้อม version ที่ใช้จริง (เก็บกับ transcript เพื่อเทียบเมื่อเปลี่ยนโมเดล) |
| `language` | ภาษาที่ถอดได้ |
| `confidenceAvg` | 0–1 |
| `segments` | อย่างน้อย 1 รายการ เรียงตาม `startMs` |
| `segments[].speaker` | `AGENT`, `CONTACT`, `SYSTEM` หรือ `IVR` |
| `segments[].startMs`, `endMs` | จำนวนเต็ม ms นับจากต้นไฟล์ `startMs < endMs` และไม่เกินความยาวไฟล์ |
| `segments[].text` | ข้อความที่ไม่ว่าง |
| `segments[].confidence` | ไม่บังคับ 0–1 |

- ไฟล์ที่ไม่มีเสียงพูดเลย ให้ตอบ segment `SYSTEM` เดียวที่ครอบความยาวไฟล์ เพราะ QM v1 ไม่รับ `segments` ว่าง
- field อื่นที่ provider ส่งมา QM ตัดทิ้ง ไม่เก็บ

## Error

ทุก response ที่ไม่ใช่ `2xx` ใช้ body เดียวกัน:

```json
{ "error": { "code": "MEDIA_UNSUPPORTED", "message": "only PCM WAV is supported" } }
```

| HTTP | `code` | เมื่อไร |
| --- | --- | --- |
| 400 | `INVALID_REQUEST` | body ไม่ใช่ JSON หรือ field ไม่ครบ |
| 400 | `DATA_USE_REQUIRED` | ไม่มี `x-dcontact-data-use: no-training` หรือ `dataUse` ไม่ใช่ `NO_TRAINING` |
| 400 | `PROTOCOL_UNSUPPORTED` | major version ของ `x-dcontact-asr-protocol` ไม่รองรับ |
| 400 | `MEDIA_URL_NOT_ALLOWED` | `mediaUrl` ไม่ใช่ HTTPS หรือ host ไม่อยู่ในรายการที่ provider อนุญาต |
| 400 | `MEDIA_URL_EXPIRED` | `mediaUrlExpiresAt` ผ่านไปแล้ว |
| 401 | `UNAUTHORIZED` | ไม่มี bearer token หรือ token ผิด |
| 413 | `REQUEST_TOO_LARGE` | body เกิน 64 KiB |
| 422 | `MEDIA_UNSUPPORTED` | ไฟล์ไม่ใช่ WAV ที่รองรับ หรือไม่มีเสียง |
| 422 | `MEDIA_TOO_LARGE` | ไฟล์ใหญ่เกินที่ provider รับ |
| 429 | `RATE_LIMITED` | provider รับงานไม่ไหวชั่วคราว |
| 502 | `MEDIA_FETCH_FAILED` | ดาวน์โหลดไฟล์ไม่สำเร็จ |
| 500 | `INTERNAL` | ข้อผิดพลาดอื่นของ provider |

QM บันทึก `HTTP {status} {code}` เป็นเหตุผลของ attempt ที่ล้ม แล้ว retry ตาม `transcriptionMaxAttempts` ของคิวทุกกรณี v1 ยังไม่แยก error ที่ retry ไม่ได้

## เวลาและขนาด

- QM รอ response ไม่เกิน `QM_TRANSCRIPTION_TIMEOUT_MS` (ค่าเริ่มต้น 300000 = 5 นาที) แล้วนับเป็น attempt ที่ล้ม
- signed URL มีอายุ 5 นาที ไฟล์เสียงจึงต้องเริ่มดาวน์โหลดทันทีที่รับคำขอ
- reverse proxy ข้างหน้า provider ต้องตั้ง read timeout มากกว่า `QM_TRANSCRIPTION_TIMEOUT_MS`

## Health (ไม่บังคับ)

```
GET /v1/health  →  200 {"status":"ok","protocolVersion":"1","modelId":"..."}
```

สำหรับ operator ตรวจว่า provider พร้อม QM ไม่ได้เรียก

## ความปลอดภัย

- endpoint ของ provider และ `mediaUrl` เป็น HTTPS เสมอ QM ไม่ยอมส่งถ้าไม่ใช่
- provider ต้องดาวน์โหลดเฉพาะ host ที่กำหนด (กัน SSRF) ไม่ตาม redirect และจำกัดขนาดไฟล์
- ห้าม log `mediaUrl` ทั้ง URL, bearer token หรือข้อความที่ถอดได้
- signed URL ของ Solo ลงนามด้วย credential ของ object storage reverse proxy ของ media จึงรับเฉพาะ `GET`/`HEAD` ใต้ `/recordings/` ที่มี `X-Amz-Signature`

## Contract test

`runAsrProviderContract()` ใน `apps/qm/src/asr-provider-contract.ts` ตรวจ provider แบบ black-box ผ่าน HTTP:

- ปฏิเสธคำขอที่ไม่มี token, ไม่มี no-training (ทั้ง header และ body), version ไม่รองรับ, media URL ไม่ใช่ HTTPS และ URL หมดอายุ ด้วย status และ `code` ตามตาราง
- ถอดไฟล์ STEREO แล้วได้ response ที่ผ่าน `parseTranscriptionResult()` (validator เดียวกับที่ QM ใช้)
- segment อยู่ในความยาวไฟล์และเรียงตามเวลา
- ถ้าผู้เรียกระบุช่วงเวลาที่รู้ว่าใครพูด speaker ต้องตรงกับ channel

ผู้เรียกต้องเตรียมไฟล์ WAV แบบ STEREO ที่ provider ดาวน์โหลดได้จริง simulator ผ่าน contract ใน `apps/qm/src/asr-simulator.test.ts`
provider จริงต้องรัน contract นี้กับไฟล์เสียงพูดภาษาไทยจริงก่อนใช้กับ deployment

## ASR simulator

`apps/qm/dist/asr-simulator-main.js` เป็น provider ตาม protocol นี้สำหรับ UAT/dev ที่ยังไม่มีโมเดลจริง

- ดาวน์โหลดไฟล์เสียงจริงผ่าน signed URL จึงพิสูจน์เส้นทาง media, TLS, token และ no-training ครบ
- หาช่วงที่มีเสียงของแต่ละ channel ด้วยพลังงานเสียง แล้วใช้เวลานั้นเป็น segment (STEREO: ซ้าย `CONTACT`, ขวา `AGENT`; เสียงรวม: สลับ `AGENT`/`CONTACT`)
- ข้อความเป็นประโยคจำลองที่ขึ้นต้นด้วย `[จำลอง]` เสมอ `modelId` เป็น `dcontact-asr-simulator-v1` และ confidence คงที่ 0.5 ห้ามใช้ผลเป็นหลักฐานประเมินจริง
- ตั้งค่าด้วย `ASR_SIMULATOR_API_KEY` (ค่าเดียวกับ `QM_TRANSCRIPTION_API_KEY`), `ASR_SIMULATOR_MEDIA_HOSTS` (host ของ `QM_MEDIA_ENDPOINT`), `ASR_SIMULATOR_MAX_MEDIA_MB` (ค่าเริ่มต้น 128) และ `PORT` (ค่าเริ่มต้น 8090)
- ฟัง HTTP ธรรมดา ต้องมี reverse proxy ที่จบ TLS อยู่ข้างหน้า
- วิธีเปิดบน UAT Solo อยู่ใน [solo-uat.md](solo-uat.md) หัวข้อ QM worker

## ยังไม่อยู่ใน v1

- งานแบบ asynchronous (ส่งงานแล้ว provider callback หรือ QM ถาม status) สำหรับไฟล์ยาวที่ถอดเกิน timeout
- การแยก error ที่ retry ไม่ได้ (เช่น `MEDIA_UNSUPPORTED`) ออกจาก retry ของ QM
- การส่ง job id ให้ provider ใช้กันงานซ้ำ
