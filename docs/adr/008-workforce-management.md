# ADR 008: Workforce Management (WFM) — forecast/schedule เป็น Python service แยก, ตารางกะเป็น soft constraint

- **สถานะ:** Accepted
- **วันที่:** 2026-08-07

## บริบท

D-Contact มีข้อมูลดิบที่ WFM ต้องใช้ครบแล้ว แต่ยังไม่มีตัว WFM:

| WFM ต้องการ | มีอยู่แล้ว |
|---|---|
| ปริมาณงาน + AHT ย้อนหลังต่อคิว/ช่วงเวลา | `dc.interaction.events` ([ADR-003](003-kafka-event-backbone.md)) + `interactions` / `interaction_events` |
| สถานะ agent ตามเวลาจริงและย้อนหลัง | `dc.agent.events` + `agent_state_logs` (คอมเมนต์ใน schema ระบุไว้แต่แรกว่าใช้ทำ occupancy/adherence) |
| ใครรับงานคิวไหนได้ | `skills` / `agent_skills` / `queue_skills` / `teams` |
| เป้าหมายบริการต่อคิว | `queues.sla_threshold_sec` |
| การแยกข้อมูลและ customize ต่อ tenant | [ADR-005](005-multitenant-metadata-architecture.md) |

สิ่งที่ต้องสร้างคือ 6 ก้อน: schedule/shift, time-off, real-time adherence (RTA),
forecasting, intraday management, agent self-service

ข้อจำกัดที่กำหนดขอบเขตการออกแบบ (ตัดสินไว้แล้ว):
**1,000 agent ต่อ tenant · จัดกะล่วงหน้า 4 สัปดาห์ · รองรับหลายประเทศ ·
voice + chat ก่อน (email/social ทีหลัง) · agent เลือกกะเองไม่ได้**

## การตัดสินใจ

1. **WFM เป็น 2 service แยกภาษา ไม่ใช่ module ใน api**
   - `apps/wfm` (TypeScript/NestJS) — CRUD กะ/ลา/activity/site, publish schedule,
     คำนวณ adherence + RTA จาก `dc.agent.events`, intraday monitor
   - `apps/wfm-engine` (**Python**) — forecasting, staffing requirement (Erlang),
     schedule optimization ด้วย OR-Tools CP-SAT

   นี่คือการรับ **ภาษาที่สองเข้า monorepo อย่างจงใจ** เพราะ ecosystem ของ
   constraint solver และ time-series forecasting อยู่ฝั่ง Python ทั้งหมด
   และคุณภาพตารางกะคือสิ่งที่ WFM ถูกตัดสิน — ขอบเขตของ Python ถูกล้อมไว้แคบ:
   **รับ input เป็น JSON คืน output เป็น JSON ห้ามแตะ auth, ห้ามเป็นเจ้าของ business state,
   ห้ามเขียน Postgres นอกตาราง `wfm_jobs` + ตารางผลลัพธ์ที่ระบุไว้**

2. **สองตัวคุยกันแบบ async job ผ่าน Kafka ไม่ใช่ HTTP request/response** —
   จัดกะ 1,000 agent × 4 สัปดาห์ ใช้เวลาระดับนาที ไม่มี HTTP timeout ใดรอไหว
   เพิ่ม 2 topic: **`dc.wfm.jobs`** (key = `jobId`, wfm → wfm-engine) และ
   **`dc.wfm.events`** (key = `tenantId`, wfm/wfm-engine → api สำหรับ WS fan-out)
   ผลลัพธ์ลง Postgres, สถานะงานลง `wfm_jobs` — ได้ replay/audit ตามหลักเดิมของ ADR-003

3. **ตารางกะเป็น soft constraint — router ไม่รู้จัก WFM เลย**
   agent ที่อยู่นอกกะยัง login และรับงานได้ตามปกติ ตารางกะมีผลกับ *การวัด*
   (adherence/intraday) เท่านั้น ไม่มีผลกับ *การจับคู่งาน*
   → WFM ไม่เพิ่มความซับซ้อนให้ router และไม่เกิด coupling ที่ ADR-007 อุตส่าห์กันไว้
   ถ้าวันหนึ่งต้องการ hard constraint ให้ทำโดย WFM เขียนค่าลง tenant config cache
   ไม่ใช่ router ยิงถาม WFM ตอน runtime

4. **Shift template เก็บเป็นเวลาท้องถิ่น (wall clock) + timezone —
   materialize เป็น UTC instant ตอน publish เท่านั้น**
   กะ "จันทร์ 09:00–18:00" ถ้าเก็บเป็น UTC instant พอถึงวันเปลี่ยน DST ตารางทั้งชุด
   จะเลื่อน 1 ชั่วโมงโดยไม่มีใครสั่ง และวันเปลี่ยน DST มี 23 หรือ 25 ชั่วโมง —
   scheduler ห้ามสมมติว่าทุกวันมี 24 ชั่วโมง (ไทยไม่มี DST แต่เราตกลงว่าเผื่อหลายประเทศ)

5. **เพิ่ม entity `Site`** ถือ timezone + ปฏิทินวันหยุด + ชุดกฎแรงงาน
   `User` ผูกกับ Site — หนึ่ง tenant มีหลายไซต์คนละประเทศได้ (เคส BPO)
   **กฎแรงงานเป็น tenant/site metadata ตาม ADR-005 ไม่ใช่ค่าคงที่ในโค้ด**
   (ชม./วัน, ชม./สัปดาห์, พักขั้นต่ำระหว่างกะ, ระยะเวลาก่อนได้พัก, วันหยุดขั้นต่ำ/สัปดาห์)
   ทุกกฎกลายเป็น constraint ที่ป้อนเข้า CP-SAT ตรง ๆ — เพิ่มประเทศ = เพิ่มข้อมูล ไม่ใช่แก้โค้ด

6. **Forecast อ่านจากตาราง aggregate `wfm_interval_stats` (ช่วงละ 15 นาที) เท่านั้น
   ห้าม query `interactions` ตรง** — rollup จาก `dc.interaction.events` แบบ streaming
   ทำให้ forecast ไม่แตะ read path ของ production และ replay สร้างใหม่ได้ทั้งชุด

7. **แยก staffing model ตาม "คลาสของช่องทาง" ไม่ใช่ตามชื่อช่องทาง**
   - *immediate* (voice) → Erlang C
   - *concurrent* (webchat/LINE/FB/WhatsApp) → Erlang C ที่ปรับด้วย concurrency + AHT inflation
   - *deferrable* (email/social ที่ SLA เป็นชั่วโมง) → **backlog model ไม่ใช่ Erlang C** — เฟสถัดไป

   Erlang C กับงาน deferrable ให้จำนวนคนที่มากเกินจริงหลายเท่า ต้องแยกตั้งแต่ออกแบบ
   v1 implement 2 คลาสแรก แต่ schema ให้ `channel` เป็นมิติของข้อมูลไม่ใช่เงื่อนไขใน code

8. **Multi-skill จัดการด้วย "planning group" ไม่ใช่ simulation** —
   Erlang C สมมติว่า agent ทุกคนรับงานได้เท่ากัน แต่ router เราจับคู่ด้วย skill + level
   v1 ให้ผู้ใช้จัดคิว/สกิลเป็น planning group ที่ agent ภายในกลุ่มถือว่าเท่าเทียมกัน
   แล้วคำนวณแยกกลุ่ม (ทางเลือกที่เหลือ — pooling factor และ discrete-event simulation
   ที่ replay router logic จริง — เปิดทางไว้แต่ไม่ทำใน v1)

9. **Manual/imported forecast เป็น first-class ไม่ใช่ fallback** —
   tenant ใหม่ไม่มีข้อมูลย้อนหลัง ถ้า WFM ใช้ไม่ได้เดือนแรกของทุก tenant ก็ไม่มีใครเริ่มใช้
   `forecast_intervals.source` มีค่า `MODEL | MANUAL | IMPORT` ตั้งแต่แรก
   และ planner override ค่าราย interval ได้เสมอโดยไม่ต้องแก้โมเดล

10. **ไม่มี shift bidding / preference / swap ใน scope** — planner assign อย่างเดียว
    แต่ data model แยก `ShiftInstance` (ใครทำงานเมื่อไหร่) ออกจาก `Schedule` (รอบการวางแผน)
    ไว้แล้ว จึงเติม bidding ทีหลังได้โดยไม่รื้อ

11. **Schedule solve ถูกซอยเป็น 3 ขั้นและแยกตาม planning group** —
    (A) เลือกรูปแบบกะ/จำนวนคนต่อวันให้ครอบคลุม requirement → (B) assign agent จริง
    → (C) วางพักในแต่ละกะ ทั้งหมด time-boxed และใช้คำตอบที่ดีที่สุดที่หาได้ (CP-SAT anytime)
    การ assign ทั้ง 1,000 agent เป็นปัญหาเดียวจะโตเกินไป (รายละเอียดขนาดปัญหาใน
    [workforce-management.md §7](../workforce-management.md))

รายละเอียด data model, สูตร forecast/Erlang/adherence, CP-SAT model, และแผนเฟส
อยู่ใน [`docs/workforce-management.md`](../workforce-management.md)

## ผลที่ตามมา

- (+) **ข้อมูลที่มีอยู่แล้วถูกใช้ซ้ำทั้งหมด** — ไม่ต้องเก็บอะไรใหม่เพื่อทำ adherence
  นอกจาก mapping state→activity ซึ่งเป็น metadata
- (+) soft constraint ทำให้ **WFM ล้มได้โดยไม่กระทบการรับสาย** — เป็น service ชั้นบนล้วน ๆ
  ต่างจาก router/telephony ที่ล้มแล้วธุรกิจหยุด
- (+) กฎแรงงานเป็น constraint ไม่ใช่ logic → ขยายไปประเทศใหม่โดยไม่ deploy
- (+) job แบบ async ทำให้ solve นาน ๆ ไม่ block ใคร และ retry/replay ได้
- (−) **Python เป็นภาษาที่สองในระบบ** — ต้นทุนจริง 3 อย่าง:
  (ก) [ADR-006](006-multi-vendor-telephony-gateway.md) ship on-prem เป็นชุด container
  ตอนนี้ต้องเพิ่ม Python image (OR-Tools มี native binary ต้องคุม platform/arch ให้ตรง)
  (ข) CI ต้องมี Python toolchain + **contract test TS↔Python ต้องเขียวเสมอ**
  (แบบเดียวกับที่ ADR-006 บังคับ contract test 2 gateway)
  (ค) คนดูแลต้องอ่านสองภาษา
  → คุมด้วยขอบเขตที่แคบมากของ wfm-engine (stateless, JSON in/JSON out)
- (−) **คุณภาพตารางกะขึ้นกับคุณภาพ forecast ทั้งหมด** — forecast ผิด ตารางผิดตาม
  และผู้ใช้จะโทษ "ระบบจัดกะ" → ต้องมีหน้าเทียบ forecast vs actual ให้เห็นตลอด (intraday)
- (−) adherence ที่ตั้งค่าไม่ดีจะแดงทั้งกระดานแล้วไม่มีใครเชื่อถืออีกเลย →
  บังคับมี **grace period** + mapping ที่แก้ได้ต่อ tenant ตั้งแต่ v1
- (−) planning group เป็นการประนีประนอมกับ multi-skill — tenant ที่ skill ซ้อนทับกันมาก
  จะได้ requirement ที่สูงเกินจริง (over-staffing) → เอกสารต้องบอกข้อจำกัดนี้ตรง ๆ
  และ mockup ต้องแสดง "ความครอบคลุมของ planning group" ให้ planner เห็น
- (−) ตาราง `wfm_interval_stats` เป็น append-heavy ตัวใหม่
  (tenant × planning group × channel × 96 ช่วง/วัน) → ต้องมี retention + partition
  ตั้งแต่ออกแบบ ตามแนวเดียวกับ `interactions` ใน [multi-tenancy §6](../multi-tenancy.md)
