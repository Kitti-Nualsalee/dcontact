# ADR 010: Quality Management (QM) — การอัดเป็นของ telephony, การประเมินเป็นของ QM, คะแนน AI ต้องมีหลักฐานและต้องผ่านมนุษย์

- **สถานะ:** Accepted
- **วันที่:** 2026-08-07

## บริบท

QM ตอบคำถามว่า *"สายที่คุยไปเมื่อวานคุยดีหรือเปล่า และจะทำให้ดีขึ้นยังไง"* —
คนละคำถามกับ WFM ([ADR-008](008-workforce-management.md)) ที่ตอบว่า *"พรุ่งนี้ต้องมีคนกี่คน"*

ของที่มีอยู่แล้วและ QM ต้องใช้:

| QM ต้องการ | มีอยู่แล้ว |
|---|---|
| ไฟล์เสียง + metadata | `recordings` + MinIO/S3 ([interaction-data-flow §7](../interaction-data-flow.md)) |
| เนื้อหาแชต/อีเมล/โซเชียล | `conversations` / `messages` ([ADR-001](001-unified-interaction-model.md)) |
| บริบทของงาน (คิว, agent, disposition, AHT) | `interactions` + `dc.interaction.events` ([ADR-003](003-kafka-event-backbone.md)) |
| ใครฟังสายได้ | permission `listen to recordings` ([iam-architecture §6](../iam-architecture.md)) |
| ปฏิทินสำหรับนัดโค้ช | `wfm_shift_segments` ([ADR-008](008-workforce-management.md)) |
| customize ต่อ tenant | [ADR-005](005-multitenant-metadata-architecture.md) |

สิ่งที่ต้องสร้างคือ 7 ก้อน: recording lifecycle ที่ผ่าน compliance, transcript,
category/analytics, การเลือกสายมาตรวจ, ฟอร์มประเมิน + workflow (ตรวจ/โต้แย้ง/calibrate),
auto-QM, coaching

ข้อจำกัดที่กำหนดขอบเขต (ตัดสินไว้แล้ว):
**ตรวจได้ทุกช่องทางไม่ใช่เฉพาะเสียง · ภาษาไทยเป็นภาษาหลัก · ต้องรันแบบ on-prem ได้ ([ADR-006](006-multi-vendor-telephony-gateway.md)) ·
screen recording ไม่อยู่ใน v1 · ต้นทุน ASR/LLM เป็นต้นทุนผันแปรที่ต้องวัดได้ต่อ tenant**

## การตัดสินใจ

1. **`apps/qm` เป็น TypeScript service เดียว — QM ไม่พาภาษาที่สามเข้ามา**
   งานหนักของ QM คือ ASR กับการให้คะแนนด้วยโมเดล ซึ่งเป็น **การเรียก provider ภายนอก
   ไม่ใช่การคำนวณของเราเอง** ต่างจาก [ADR-008](008-workforce-management.md) ที่ CP-SAT/forecast
   บังคับให้ต้องมี Python จริง ๆ งานประมวลผลสื่อ (แยก stereo, วัดความเงียบ/พูดทับ, ทำ waveform)
   ใช้ `ffmpeg` เป็น CLI จาก Node ได้ทั้งหมด

2. **การอัดเป็นของ telephony การประเมินเป็นของ QM — เส้นนี้ห้ามเบลอ**
   `apps/telephony` สั่งอัดและเขียน `recordings` เหมือนเดิม; `apps/qm` **consume
   `dc.interaction.events` อย่างเดียว ไม่สั่งอัดเอง ไม่แตะ ESL**
   (วินัยเดียวกับที่ WFM ไม่แตะ router)
   ผลคือ **QM ล้มได้โดยเสียงยังถูกอัดครบ** — ถ้ารวมกันเมื่อไหร่ bug ใน QM จะทำให้ไม่มีสายถูกอัด
   ซึ่งเป็นความเสียหายที่ย้อนกลับไม่ได้

3. **PCI pause/resume อยู่ใน v1 และเป็น telephony command ไม่ใช่ฟีเจอร์ QM**
   เพิ่ม `recording.pause` / `recording.resume` ใน `dc.telephony.commands` +
   ช่วงที่หยุดถูกบันทึกใน `recordings.pause_intervals`
   เหตุผลที่ห้ามเลื่อน: ระบบที่อัดเลขบัตรลง object storage ไปแล้วหกเดือน **แก้ทีหลังไม่ได้** —
   ต้องไล่ลบของเก่าและอธิบายกับผู้ตรวจสอบ ต้นทุนตอนใส่ทีหลังสูงกว่าตอนใส่แต่แรกหลายเท่า

4. **Transcript เป็น entity ของตัวเอง แยกจาก recording และมีอายุของตัวเอง**
   ทุกอย่างข้างบน (ค้นหา, category, auto-QM, หลักฐานประกอบคะแนน) ขึ้นกับ transcript
   ถ้าฝังเป็นคอลัมน์ของ `recordings` จะทำ versioning ตอนเปลี่ยนโมเดล ASR ไม่ได้
   และ **transcript ต้องอยู่ได้นานกว่าไฟล์เสียง** — ลบเสียงตาม retention แล้วยังวิเคราะห์ย้อนหลังได้
   โดยไม่ถือครองข้อมูลเสียงเกินจำเป็น (ดีต่อ PDPA ด้วย)

5. **QM ตรวจทุกช่องทางตั้งแต่วันแรก ไม่ใช่ voice-first**
   ช่องทาง digital ข้ามขั้น ASR ไปเลย — normalize `messages` เข้า `qm_transcript_segments`
   รูปแบบเดียวกับที่ ASR ผลิต ทุกชั้นที่อยู่เหนือขึ้นไปจึงไม่รู้ว่าต้นทางเป็นเสียงหรือข้อความ
   นี่คือผลตรงจาก [ADR-001](001-unified-interaction-model.md) และเป็นข้อได้เปรียบที่ QM
   ซึ่งตั้งต้นจากการอัดเสียงทำไม่ได้

6. **ASR และ scoring model อยู่หลัง provider interface แบบเดียวกับ telephony gateway**
   `TranscriptionProvider` / `ScoringProvider` — 1 provider ต่อ deployment,
   สลับด้วย config ไม่ใช่แก้โค้ด และ **contract test ต้องเขียวทุก provider**
   (วินัยเดียวกับ [ADR-006](006-multi-vendor-telephony-gateway.md))
   เหตุผลบังคับ: **ลูกค้า on-prem ห้ามให้เสียงออกนอกองค์กร** → ต้องมี provider แบบ self-host
   (Whisper) หรือปิด `qm.transcription` / `qm.autoQm` ไปเลย ทั้งสองทางต้องรองรับ

7. **คะแนนจาก AI ต้องผูกหลักฐานเสมอ — ไม่มีหลักฐาน = ไม่ให้คะแนน**
   ทุกคำตอบที่โมเดลให้ต้องแนบ `{segmentIds, startMs, endMs, quote}`
   ข้อไหนหาหลักฐานไม่ได้ให้คืน `INSUFFICIENT_EVIDENCE` แล้วส่งต่อให้คนตัดสิน
   **ห้ามให้ 0 และห้ามเดา** — คะแนนที่กดคนโดยไม่มีหลักฐานคือสิ่งเดียวที่ทำให้ทั้งระบบถูกเลิกใช้

8. **Auto-QM เป็น DRAFT เสมอใน v1 — มนุษย์กด publish ถึงจะมีผลกับ agent**
   AI ทำหน้าที่ *คัดและร่าง* (ตรวจ 100% เพื่อชี้เป้า) ไม่ใช่ *ตัดสิน*
   จะให้ auto-publish ได้ต้องมีตัวเลขก่อนว่าคะแนน AI กับคะแนนคนต่างกันเท่าไร
   (วัดจาก calibration ข้อ 10) — เป็นการตัดสินใจเชิงข้อมูล ไม่ใช่เชิงศรัทธา

9. **ฟอร์มประเมินเป็น metadata แบบมีเวอร์ชัน และผลประเมินเก็บ snapshot ของฟอร์มไว้ด้วย**
   `qm_evaluations.form_snapshot` (JSONB) — เพราะฟอร์มถูกแก้ตลอด
   ถ้าไม่เก็บ snapshot คะแนน 78% ของเดือนที่แล้วจะ**ตีความไม่ได้อีกเลย** และเทียบข้ามเดือนไม่ได้
   ฟอร์มที่ถูกใช้ให้คะแนนไปแล้ว **แก้ไม่ได้ ต้องออกเวอร์ชันใหม่**

10. **Calibration และ Appeal เป็น first-class ตั้งแต่ v1 ไม่ใช่ของเฟสหลัง**
    ถ้าผู้ตรวจ 3 คนให้สายเดียวกัน 70/85/95 แปลว่าคะแนน QM ทั้งระบบไม่มีความหมาย
    และถ้า agent โต้แย้งไม่ได้ ระบบจะกลายเป็นเครื่องมือลงโทษที่ไม่มีใครเชื่อถือภายในไตรมาสเดียว
    (ความเสี่ยงชนิดเดียวกับ adherence ที่ต้องมี grace period ตั้งแต่ v1 ใน [ADR-008](008-workforce-management.md))

11. **Category v1 เป็น saved query ไม่ใช่ ML** — rule DSL (`term NEAR term`, `speaker=AGENT`,
    `withinFirstSec`) คอมไพล์ลง Postgres FTS ผลลัพธ์**อธิบายได้ว่าทำไมสายนี้เข้าเงื่อนไข**
    ซึ่งจำเป็นตอนลูกค้าถาม embedding/ML เปิดทางไว้แต่ไม่ทำใน v1
    ข้อจำกัดที่รับไว้: ภาษาไทยไม่มีช่องว่างระหว่างคำ ต้องใช้ tokenizer เฉพาะ (ดู §6 ของเอกสารออกแบบ)

12. **Coaching เขียนกลับเข้าตาราง WFM ผ่าน API ของ WFM ห้ามเขียน `wfm_*` ตรง**
    เซสชันโค้ชที่ไม่มีเวลาในตารางคือเซสชันที่ไม่เกิดขึ้นจริง — ต้องกลายเป็น
    `wfm_shift_segments` ชนิด `COACHING` และไปโผล่ใน adherence
    ทิศทางเดียว QM → WFM เท่านั้น (WFM ไม่รู้จัก QM)

13. **การเปิดฟัง/ดูทุกครั้งต้องลง audit log** — `qm_media_access_log` (ใคร ฟังสายไหน เมื่อไหร่ จาก IP ไหน)
    recording คือข้อมูลส่วนบุคคลตาม PDPA และ "ใครฟังบ้าง" เป็นคำถามแรกที่ผู้ตรวจสอบถาม

14. **Retention ของ QM มี 3 ชั้นที่แยกกัน และ legal hold ชนะทุกชั้น**
    เสียง (สั้นสุด) < transcript < ผลประเมิน (ยาวสุด — เป็นเอกสารด้าน HR)
    การลบต้องเป็น job ที่มี audit ไม่ใช่ lifecycle rule ของ S3 อย่างเดียว
    เพราะต้องเคารพ `qm_legal_holds` ซึ่ง S3 ไม่รู้จัก

15. **`qm.transcription` และ `qm.autoQm` เป็น entitlement แยก และมี quota ผูกด้วย**
    ต่างจาก WFM ตรงที่ **QM มีต้นทุนผันแปรต่อสายจริง** (นาที ASR + token)
    ถ้าเปิดรวมกับ `qm.enabled` เราจะขาดทุนเงียบ ๆ กับ tenant ที่คุยเยอะ
    → `quotas.qmTranscriptionMinutesPerMonth`, `quotas.qmAutoScoredPerMonth`
    ([licensing §2](../licensing.md))

16. **Screen recording ไม่อยู่ใน v1 แต่ data model เผื่อไว้** —
    ต้องมี agent-side capture (desktop client/extension) ซึ่งเป็นงานคนละก้อนกับทุกอย่างในนี้
    `qm_media.kind = AUDIO | SCREEN` มีตั้งแต่แรก เติมทีหลังได้โดยไม่รื้อ

รายละเอียด data model, สคีมาฟอร์ม, สูตรคะแนน, สัญญาหลักฐานของ auto-QM และแผนเฟส
อยู่ใน [`docs/quality-management.md`](../quality-management.md)

## ผลที่ตามมา

- (+) **ข้อมูลเดิมถูกใช้ซ้ำเกือบทั้งหมด** — สิ่งที่ต้องเพิ่มใน kernel มีแค่คอลัมน์ใน `recordings`
  (`kind`, `channel_layout`, `pause_intervals`) ที่เหลืออยู่ในตาราง `qm_*`
- (+) แยกการอัดออกจากการประเมิน → **QM ล้มแล้วธุรกิจไม่หยุดและไม่สูญเสียหลักฐาน**
  (ตรงกับกติกาข้อ 3 ของ [ADR-008](008-workforce-management.md) และกติกาเหล็กของ [ADR-009](009-plan-entitlement-licensing.md))
- (+) ตรวจได้ทุกช่องทางตั้งแต่วันแรกโดยไม่ต้องเขียน pipeline ที่สอง
- (+) provider interface ทำให้ขาย on-prem ได้โดยไม่ต้องมีเงื่อนไขว่า "ต้องต่อเน็ตออกไปหา cloud AI"
- (−) **ต้นทุนผันแปรก้อนใหม่ที่ไม่เคยมีในระบบ** — ASR + token ผูกกับปริมาณสายโดยตรง
  ถ้า metering ผิดพลาดเราจะรู้ตอนสิ้นเดือน → บังคับให้ quota ขึ้นพร้อม feature ไม่ใช่ตามหลัง
- (−) **storage โตเร็วกว่าที่ประมาณไว้** — เสียง + transcript + metrics ต่อสาย
  ต้อง partition และมี retention ตั้งแต่วันแรกเหมือน `interactions` ([multi-tenancy §6](../multi-tenancy.md))
- (−) **คุณภาพ ASR ภาษาไทยคือความเสี่ยงที่คุมไม่ได้ทั้งหมด** — ถ้า WER สูง
  category กับ auto-QM จะพังตามกันหมด → ต้องมีหน้าที่ให้คนแก้ transcript ได้
  และต้องวัด WER บนชุดตัวอย่างของลูกค้าจริงก่อนขาย `qm.autoQm`
- (−) **นี่คือระบบที่ให้คะแนนคน** — ต่างจากทุก ADR ก่อนหน้าที่ประเมินระบบ
  ความเสี่ยงเรื่องความไว้วางใจและแรงงานเป็นความเสี่ยงอันดับหนึ่ง ไม่ใช่ความเสี่ยงทางเทคนิค
  → คุมด้วยข้อ 7, 8, 10 (หลักฐาน, มนุษย์ตัดสิน, โต้แย้งได้) และ agent ต้องเห็นคะแนนตัวเองเสมอ
- (−) การรวมคะแนนหลายฟอร์มหลายเวอร์ชันเป็น "คะแนนคุณภาพของทีม" **ทำถูกได้ยาก** —
  v1 เปรียบเทียบข้ามฟอร์มไม่ได้และเอกสารต้องบอกข้อจำกัดนี้ตรง ๆ
