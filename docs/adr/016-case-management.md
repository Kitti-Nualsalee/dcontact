# ADR 016: Case Management — เคสเป็นภาชนะของ "เรื่อง" ส่วน interaction ยังเป็นภาชนะของ "การติดต่อครั้งหนึ่ง"

- **สถานะ:** Accepted
- **วันที่:** 2026-08-08

## บริบท

[ADR-001](001-unified-interaction-model.md) ทำให้ทุกช่องทางเป็น interaction เดียวกัน ซึ่งถูกสำหรับ
งานที่จบในครั้งเดียว แต่ **อีเมล โซเชียล และงานหลังบ้านไม่จบในครั้งเดียว** —
ลูกค้าอีเมลมาวันจันทร์ โทรตามวันพุธ ทักไลน์วันศุกร์ ทั้งหมดคือเรื่องเดียว
ตอนนี้ระบบมองเป็นสามงานที่ไม่รู้จักกัน ทำให้ตอบว่า "เรื่องนี้จบหรือยัง" ไม่ได้
(NICE ขายเป็น CXone Cases, Zendesk/ServiceNow ทั้งบริษัทตั้งอยู่บนแนวคิดนี้)

## การตัดสินใจ

1. **เพิ่มชั้นใหม่ ไม่แก้ความหมายของ interaction**
   `case 1 : N interaction` — interaction ยังเป็น "การติดต่อหนึ่งครั้ง" เหมือนเดิมทุกประการ
   ทุกอย่างที่ต่ออยู่กับ interaction (routing, QM, WFM, billing) ไม่ต้องแก้แม้แต่บรรทัดเดียว

2. **เคสมีคิวและ SLA ของตัวเอง แยกจาก SLA ของการรับสาย**
   SLA ของ interaction วัดเป็นวินาที (รับสายทัน), SLA ของเคสวัดเป็นชั่วโมง/วัน (แก้ปัญหาจบ)
   สองอย่างนี้คนละหน่วย คนละเจ้าของ และถ้าปนกันจะไม่มีใครอ่านรายงานรู้เรื่อง

3. **การมอบหมายเคสใช้ router ตัวเดิม — ไม่สร้างเครื่องกระจายงานตัวที่สอง**
   เคสเข้าคิวเป็น work item ชนิด `CASE` ที่ router จับคู่ตาม skill/capacity เหมือน digital
   งานที่ deferrable (ทำวันนี้หรือพรุ่งนี้ก็ได้) ใช้ pull-based เป็นหลัก แต่กลไกเดียวกัน

4. **เคสเปิดได้จากทุกทาง: agent, flow, feedback detractor, API ภายนอก, อีเมลขาเข้า**
   ไม่มีทางเข้าที่มีสิทธิพิเศษ ทุกทางลงที่ `cs_cases` เหมือนกัน

5. **ประเภทเคสเป็น metadata ต่อ tenant ไม่ใช่ enum ในโค้ด**
   ตาม [ADR-005](005-multitenant-metadata-architecture.md) — ฟิลด์, ขั้นตอน, SLA, ฟอร์ม
   เป็นข้อมูลที่ tenant ตั้งเอง ไม่ใช่ schema change ต่อลูกค้าหนึ่งราย

6. **ไม่ทำ workflow engine ตัวที่สอง**
   ขั้นตอนของเคสเป็น state machine ง่าย ๆ (สถานะ + เงื่อนไขข้าม + action) — ถ้าลูกค้าต้องการ
   ตรรกะซับซ้อน ให้เรียก [flow engine](../flow-engine.md) ที่มีอยู่แล้ว

## ผลที่ตามมา

- `interactions` เพิ่ม `case_id` (nullable) — kernel change เดียวของโมดูลนี้
- router รับ work item ชนิดใหม่ `CASE` (deferrable, pull-based, capacity แยกจาก chat)
- topic `dc.case.events` สำหรับ webhook/SLA breach/รายงาน
- entitlement: `modules.cases.{enabled, slaPolicies, customFields, publicPortal}`

## ทางเลือกที่ไม่เอา

| ทางเลือก | เหตุผลที่ไม่เอา |
|---|---|
| ยืดอายุ interaction ให้ครอบหลายวัน | ทำลายความหมายของ AHT/SLA/adherence ทั้งระบบ |
| ใช้ `conversations` เป็นเคส | conversation ผูกกับช่องทางเดียว — เคสข้ามช่องทางโดยนิยาม |
| ต่อ Zendesk ภายนอกแทน | ข้อมูลลูกค้าแตกเป็นสองระบบ + ขาย D-Contact เป็นระบบเดียวไม่ได้ |
| สร้าง router ตัวที่สองสำหรับเคส | สองเครื่องกระจายงานที่แย่ง agent กันเอง |

## เอกสารเกี่ยวข้อง

[case-management.md](../case-management.md)
