# ADR 012: Feedback & Survey — เสียงลูกค้าเป็น entity ของตัวเอง ไม่ใช่คอลัมน์ใน interaction

- **สถานะ:** Accepted
- **วันที่:** 2026-08-08

## บริบท

[ADR-010](010-quality-management.md) ตัดสินคุณภาพจาก **มุมผู้ตรวจ** อย่างเดียว —
ระบบยังไม่มีมุมของลูกค้าเลย ทั้งที่ CSAT/NPS เป็นตัวเลขที่ผู้บริหารดูก่อนตัวเลขอื่นทั้งหมด
คู่แข่งขายเป็นโมดูลแยก (NICE = Feedback Management/Satmetrix, Zoom = post-interaction survey)

สิ่งที่มีอยู่แล้ว: flow engine เล่นเสียง/รับ DTMF ได้ ([flow-engine.md](../flow-engine.md)),
`apps/channels` ส่งข้อความได้ทุกช่องทาง, `apps/qm` มีฟอร์มเวอร์ชันได้แล้ว

## การตัดสินใจ

1. **`surveys` เป็นโดเมนของตัวเอง อยู่ใน `apps/qm` (ไม่สร้าง service ใหม่)**
   งานของมันคือ CRUD + รับคำตอบ + สรุปผล ซึ่งเป็น pattern เดียวกับฟอร์มประเมิน
   ที่ `apps/qm` ทำอยู่แล้ว การตั้ง service ที่สี่เพื่อรับ webhook วันละไม่กี่พันครั้งไม่คุ้ม
   แต่ **ตารางขึ้นต้น `fb_` แยกจาก `qm_`** เพื่อให้ย้ายออกได้ในวันที่ต้องแยกจริง

2. **คำตอบผูกกับ interaction เสมอ แต่ไม่ถูกเก็บใน `interactions`**
   `fb_responses.interaction_id` เป็น FK — ไม่ใช่คอลัมน์ `csat` ใน `interactions`
   เพราะ (ก) หนึ่งสายอาจถูกถามหลายแบบสำรวจ (ข) แบบสำรวจมีหลายคำถาม
   (ค) คำตอบมาทีหลังหลายชั่วโมง ทำให้ `interactions` กลายเป็นแถวที่แก้ตลอดเวลา

3. **แบบสำรวจมีเวอร์ชันและถูกแช่แข็งเมื่อมีคำตอบแล้ว** — กฎเดียวกับฟอร์มประเมิน
   ([ADR-010](010-quality-management.md)) เพราะไม่งั้นเทียบคะแนนข้ามเดือนไม่ได้

4. **ช่องทางการถามต้องตามช่องทางที่คุย ไม่ใช่ voice-first**
   voice → IVR หลังวางสาย หรือ SMS/LINE ตามที่ tenant เลือก; digital → ส่งลิงก์/quick reply
   ในห้องแชทเดิม การบังคับให้ทุกคนตอบผ่านอีเมลคือวิธีที่ทำให้ response rate ต่ำกว่า 5%

5. **Sampling + suppression เป็นข้อบังคับ ไม่ใช่ตัวเลือก**
   ห้ามถามลูกค้าคนเดิมเกิน 1 ครั้งใน N วัน (ค่าเริ่มต้น 30) ต่อให้ติดต่อ 10 ครั้ง
   ระบบที่ถามทุกครั้งจะได้ response rate ตกและถูกมองเป็น spam — และย้อนกลับไม่ได้

6. **คะแนนต่ำเป็น event ไม่ใช่แค่แถวในรายงาน**
   `fb.response.detractor` → เปิดงานติดตามใน [case-management](../case-management.md)
   และ/หรือส่งเข้าคิวงานตรวจของ QM อัตโนมัติ (closed-loop feedback)
   นี่คือส่วนที่ทำให้ CSAT มีค่ามากกว่าตัวเลขบนสไลด์

7. **คะแนนสำรวจห้ามคำนวณเข้า KPI ของ agent โดยอัตโนมัติเป็นค่าเริ่มต้น**
   sample bias สูงมาก (คนโกรธตอบมากกว่า) — เปิดได้แต่ต้องตั้งใจเปิด และต้องมีเกณฑ์
   จำนวนตัวอย่างขั้นต่ำต่อคนก่อนจะแสดงผล

## ผลที่ตามมา

- flow engine ได้ node ใหม่ 1 ตัว: **`Survey`** (ถามในสาย หรือส่งลิงก์แล้วจบ)
- เพิ่ม topic ใช้ร่วม `dc.qm.events` type ใหม่ `feedback.response.received` / `feedback.detractor`
- entitlement: `modules.feedback.{enabled, csat, nps, closedLoop}` + quota `surveyInvitesPerMonth`
  (การส่ง SMS/LINE มีต้นทุนจ่ายออกจริง จึงต้องมี quota)
- Performance module ([ADR-018](018-performance-gamification.md)) ใช้ `fb_*` เป็นหนึ่งใน input

## ทางเลือกที่ไม่เอา

| ทางเลือก | เหตุผลที่ไม่เอา |
|---|---|
| เก็บ `csat_score` เป็นคอลัมน์ใน `interactions` | รองรับได้แค่แบบสำรวจเดียว คำถามเดียว ตลอดกาล |
| ใช้ Google Form / Typeform ภายนอก | ผูกกลับ interaction/agent ไม่ได้ และข้อมูลลูกค้าออกนอกระบบ (PDPA) |
| สร้าง `apps/feedback` เป็น service ที่สี่ | ปริมาณงานไม่คุ้มค่าดูแล — ตาราง `fb_` แยกไว้แล้วย้ายทีหลังได้ |
| ถามทุกสาย | response rate พัง + ถูกมองเป็น spam |

## เอกสารเกี่ยวข้อง

[feedback-survey.md](../feedback-survey.md)
