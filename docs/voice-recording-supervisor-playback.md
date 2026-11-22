# Voice Recording: Supervisor เปิดฟังเสียงบันทึกของทีม

งานติดตามที่ [#967](https://github.com/Kitti-Nualsalee/dcontact/issues/967) ย่อจาก Voice Recording ใน backlog
[#888](https://github.com/Kitti-Nualsalee/dcontact/issues/888) (#845–#848) ตาม Phase Contract Voice Recording v1 ใน
[#836](https://github.com/Kitti-Nualsalee/dcontact/issues/836)

Supervisor เปิดหน้า "เสียงบันทึกของทีม" ใน Console เห็นสายที่ทีมตัวเองรับและบันทึกผลจบแล้ว แล้วกดฟังได้
เสียงออกทาง API เป็นช่วงสั้น และ API ตรวจสิทธิ์ใหม่ทุกครั้งที่ขอช่วงถัดไป

## สิทธิ์

- **ทีมที่รับสาย**: Router บันทึก Agent และทีมของ Agent ลง `voice_interaction_handling_attributions`
  ใน transaction เดียวกับที่สายเปลี่ยนเป็น ACTIVE (ทั้ง managed runtime และ router เดิม) แถวแรกของสายชนะ
  และแอปแก้หรือลบแถวไม่ได้
- **ผู้ฟัง**: ต้องมี role `supervisor` ใน token, เป็น `SUPERVISOR` ที่ active ใน DB และทีมปัจจุบันตรงกับทีมที่รับสาย
  Agent และ Admin ฟังผ่าน route นี้ไม่ได้
- สายที่ไม่มีแถวหลักฐาน (สายก่อนเปิดใช้ หรือ Agent ไม่มีทีมตอนรับสาย) เปิดฟังไม่ได้ ไม่เติมย้อนหลังจากทีมปัจจุบัน
- เปิดฟังได้เฉพาะสายที่ `COMPLETED`, ไฟล์ archive แล้ว และยังไม่ถูกลบตาม retention
- ของทีมอื่น ของ tenant อื่น และรายการที่ไม่มีจริง ตอบ 404 เหมือนกัน

## Endpoint

Prefix `/api/v1/recordings` ทุก route ต้องมี role `supervisor` และตอบ `Cache-Control: no-store`

| Method และ path                             | ผล                                                                            |
| ------------------------------------------- | ----------------------------------------------------------------------------- |
| `GET /history?from=&to=&limit=&cursor=`     | รายการของทีม ค่าเริ่มต้น 30 วัน สูงสุด 90 วัน, `limit` 20 สูงสุด 100            |
| `GET /:id`                                  | สถานะ `READY` หรือ `ARCHIVING` และ `capabilities.play`                         |
| `POST /:id/playback-sessions`               | เปิด session อายุ 5 นาที คืนรูปแบบเสียงและ `transport: API_CHUNKS`              |
| `POST /:id/playback-sessions/:sid/chunks`   | body `{ startFrame, frameCount }` คืน `audio/wav` ไม่เกิน 2 วินาที              |
| `POST /:id/playback-sessions/:sid/close`    | ปิด session ปิดซ้ำได้ ตอบ 204                                                  |

รายการไม่มีข้อมูลลูกค้า โน้ต หรือ storage key ไม่มี presigned URL และไม่มี route ดาวน์โหลดทั้งไฟล์

Session ไม่ใช่สิทธิ์ ทุก chunk ตรวจผู้ใช้ ทีม หลักฐานทีมที่รับสาย และ session ใหม่ ทั้งก่อนอ่าน storage
และก่อนส่ง byte Session ใช้ข้ามผู้ใช้ไม่ได้ ผู้ใช้หนึ่งคนมี session ที่เปิดอยู่ได้ครั้งละหนึ่ง
การเปิด session บันทึก audit `PLAYBACK_ACCESSED` พร้อม `transport` และ `sessionId`

API รองรับไฟล์ WAV แบบ PCM 16 bit mono หรือ stereo เท่านั้น รูปแบบอื่นตอบ 422
Telephony ตั้ง `RECORD_STEREO` ของ channel ตาม `recording_channel_layout` ของคิวก่อน `uuid_record start`:
`STEREO` ได้ไฟล์ stereo (ผู้โทรซ้าย สิ่งที่ผู้โทรได้ยินขวา) ส่วน `PER_LEG` ยังไม่มีไฟล์แยกขา จึงได้ mono ผสมสองฝั่ง

## การ archive ของ Telephony

- `call.answered` ไม่รองานบันทึกเสียง งานเตรียมโฟลเดอร์, ประกาศ และ `uuid_record` ทำหลังส่ง event
- `call.hangup` รอไม่เกิน 3 วินาที: ตั้ง `endedAt` (DB อย่างเดียว ไม่รอ storage) แล้ว archive ถ้าเกินเพดาน ส่ง event ก่อนแล้ว archive ต่อเบื้องหลัง
  กรณีปกติ QM เห็น `endedAt` และ object ใน storage แล้วตอนได้ `interaction.ended` เหมือนเดิม
  แต่ถ้า archive ช้าหรือล้ม `interaction.ended` ไม่รับประกันว่า object มีอยู่แล้ว (QM worker ยังไม่ตรวจ `archivedAt`)
- การเตรียมโฟลเดอร์ (`prepare`) มี timeout 5 วินาที และ archive มี timeout 60 วินาที ถ้าเตรียมไม่ทันจะไม่เริ่มบันทึกและลบแถวทิ้ง
- รอบ retry ทุก 5 วินาทีลองทีละรายการ รายการที่ล้มเว้นนานขึ้นทีละเท่า (5 วินาที ถึง 5 นาที) และรอบไม่ซ้อนกัน
- ไฟล์ไม่มี (`ENOENT`) เช่น ผู้โทรวางสายก่อน FreeSWITCH สร้างไฟล์ จะหยุดลองเมื่อครบทุกข้อ: วางสายมาแล้วเกิน 30 นาที,
  Telephony process เดียวกันเห็นไฟล์หายต่อเนื่องเกิน 10 นาที และมี archive อื่นของ node สำเร็จหลังเห็นไฟล์หายครั้งแรก
  (กันกรณี mount หายทั้งก้อน) และไม่ติด legal hold จากนั้นตั้ง `deletedAt` และบันทึก audit `ARCHIVE_ABANDONED`
  (reason `SOURCE_FILE_MISSING`) พร้อม node, `endedAt`, เวลาที่หายไป และจำนวนครั้งที่ลอง
- กู้แถวที่หยุดลองผิด: หาใน `recording_audit_events` ที่ action `ARCHIVE_ABANDONED` แล้วล้าง `deleted_at` ของแถวนั้น รอบ retry จะลองใหม่
- ไฟล์ที่อ่านไม่ได้ด้วยเหตุอื่น (NFS ค้าง, storage ล่ม) ลองต่อโดยไม่หยุด
- คิว `STEREO` (ค่าเริ่มต้นของคิว) ได้ไฟล์ stereo ใหญ่กว่า mono เท่าตัว ทั้งบน NFS, หน่วยความจำตอน archive และ object storage

## หน้า Console

`/?view=team-recordings` เลือกช่วงวันที่ เปิดรายการ แล้วกด "ฟัง" ตัวเล่นใช้ `fetch` พร้อม token ใน header
และ WebAudio ขอเสียงทีละช่วง กันล่วงหน้าไม่เกิน 4 วินาที และทิ้งเสียงที่รอเล่นทันทีเมื่อหยุด เลื่อนตำแหน่ง
หรือ API ปฏิเสธ เมื่อสิทธิ์ถูกถอน เสียงที่ส่งไปแล้วเรียกคืนไม่ได้ จึงหยุดได้ช้าสุดเท่าเสียงที่กันไว้

Session หมดอายุระหว่างฟัง ตัวเล่นเปิด session ใหม่เองหนึ่งครั้ง ซึ่งผ่านการตรวจสิทธิ์ปัจจุบันอีกรอบ

## เปิดใช้

ปิดเป็นค่าเริ่มต้น ตั้ง `RECORDING_SUPERVISOR_PLAYBACK=on` ที่ API เพื่อเปิด ตอนเริ่ม API จะ log
`recording.supervisor_playback.readiness` หนึ่งบรรทัด

- ปิด: route ข้างบนตอบ 403, เมนูไม่แสดง และ `POST /:id/playback` เดิมที่ออก presigned URL ทำงานเหมือนเดิม
- เปิด: เมนู "เสียงบันทึกของทีม" แสดงให้ Supervisor และ `POST /:id/playback` เดิมตอบ 403 ทุก role
  ปุ่ม "ขอสิทธิ์ฟัง recording" ในหน้า QM เดิมของ Console จึงใช้ไม่ได้
- Presigned URL ที่ออกไปก่อนเปิดยังใช้ได้จนหมดอายุ 300 วินาที

ต้อง deploy Router รุ่นนี้ก่อน สายที่รับก่อนหน้านั้นไม่มีหลักฐานทีมและเปิดฟังไม่ได้
Migration `20261122100000_voice_recording_supervisor_playback` เพิ่มสองตาราง ไม่แก้ตารางเดิม

## ทดลองและตรวจ

ใช้ฐานแยก `dcontact_<ticket>` ไม่ใช้ฐาน `dcontact` ร่วม

```sh
pnpm --filter @d-contact/api exec tsx --test src/recording-wav.test.ts src/navigation-registry.test.ts
pnpm --filter @d-contact/api exec tsx --test --test-concurrency=1 src/recording-playback-api.integration.ts
pnpm --filter @d-contact/router exec tsx --test --test-concurrency=1 src/managed-voice-runtime.integration.ts
pnpm --filter @d-contact/console exec tsx --test src/team-recordings.test.ts
pnpm --filter @d-contact/console exec playwright test e2e/team-recordings.spec.ts --project=chromium
```

- `recording-playback-api.integration.ts`: HTTP → PostgreSQL ด้วย application role ที่ไม่ bypass RLS
  storage เป็น in-memory ที่เก็บ WAV จริง ครอบคลุมทีมอื่น tenant อื่น สายที่ไม่มีหลักฐาน ย้ายทีมหรือปิดบัญชีระหว่างฟัง
  ถอนสิทธิ์ระหว่างอ่าน storage, session ข้ามผู้ใช้ หมดอายุ และ feature ปิด
- `team-recordings.spec.ts`: หน้า Console กับ API จำลอง วัดว่าขอเสียงล่วงหน้าไม่เกิน 4 วินาทีและหยุดเมื่อถูกปฏิเสธ

## ข้อจำกัดของรอบนี้

- ยังไม่ได้ทดลองกับสายจริง FreeSWITCH และ object storage จริง (RustFS/SeaweedFS) รวมถึง `Range` ของ S3 adapter
- ไม่มีโควตา chunk ต่อผู้ใช้หรือ tenant และไม่บันทึก audit ของการปฏิเสธหรือการเลื่อนตำแหน่ง
- Cursor ของรายการเป็นตำแหน่งธรรมดา ไม่เข้ารหัสและไม่ผูกกับผู้ขอ (สิทธิ์ตรวจใหม่ทุก request)
- `recording_playback_sessions` อ้าง `recordings(id)` คอลัมน์เดียว ยังไม่ผูก tenant ที่ระดับ FK (RLS และ API ตรวจ tenant อยู่แล้ว)
- ช่องวันที่และแถบเวลาใช้ element ของ browser เพราะ `@d-contact/ui-react` ยังไม่มี DateField และ Slider
- รองรับทีมที่รับสายทีมเดียวต่อสาย ยังไม่รองรับสายที่โอนข้ามทีม
- ยังไม่ทำ: announcement ที่พิสูจน์ว่าผู้โทรได้ยิน, durable command และ ack ของ pause/resume,
  checksum และขนาดไฟล์จาก storage ack, retention กับ legal hold แบบ serialize, queue recording policy revision,
  UAT และการรับรองเสียงจริง

งานที่เหลือของ #845–#848 อยู่ใน backlog #888
