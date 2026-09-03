# ADR 025: Journey Orchestration — ชั้น CX automation ที่อยู่กับ "ลูกค้า" ไม่ใช่กับ "สาย"

- **สถานะ:** Accepted
- **วันที่:** 2026-08-10

## บริบท

ทุกอย่างที่เราออกแบบมาถึง ADR-024 เริ่มต้นที่ **ลูกค้าติดต่อเข้ามา** — นั่นคือ CCaaS
แต่ตำแหน่งที่ตั้งใจจะยืนคือ **CCaaS + CX automation (CXA)** ซึ่งต่างกันที่จุดเริ่ม:

| | CCaaS (ที่เรามี) | CXA (ที่ยังขาด) |
|---|---|---|
| จุดเริ่ม | ลูกค้าติดต่อเข้ามา | **เหตุการณ์ในธุรกิจ** — ของออกจากคลัง · จ่ายเงินไม่ผ่าน · ใกล้หมดอายุ |
| หน่วยของงาน | interaction (นาที–ชั่วโมง) | **journey** ที่กินหลายวันหลายจุดสัมผัส |
| เป้าหมาย | รับงานให้ทัน จ่ายให้ถูกคน | **ทำให้เรื่องที่คาดเดาได้ไม่ต้องกลายเป็นงานของคน** |

ของที่มีอยู่แล้วและเป็นฐานจริง: flow engine 18 node · outbound + proactive messaging พร้อม consent/DNC ·
closed loop ของ CSAT ที่เปิดเคสเอง ([ADR-012](012-feedback-survey.md)) · customer-360 ·
event backbone + webhook สองทาง ([ADR-015](015-integration-platform.md))

สิ่งที่ขาดคือ **ตัวที่มีความจำข้ามวัน** — flow ของเราตายพร้อม interaction จึงรอสามวันแล้วค่อยทำต่อไม่ได้

## การตัดสินใจ

1. **Journey เป็นชั้นใหม่ ไม่ใช่ flow ที่อายุยาวขึ้น**

   | | Flow ([ADR-007](007-flow-engine.md)) | Journey |
   |---|---|---|
   | ผูกกับ | interaction | **contact** |
   | ชีวิต | วินาที–นาที | ชั่วโมง–สัปดาห์ |
   | เริ่มโดย | สายเข้า/ข้อความเข้า | เหตุการณ์ · ตารางเวลา · เข้าเงื่อนไข segment · ผลของ interaction |
   | หน้าที่ | ตัดสินใจ**ก่อนงานเข้าคิว** | ตัดสินใจว่า**ควรเกิดงานหรือไม่ตั้งแต่แรก** |

   การยืด flow ให้ข้ามวันแปลว่า router ต้องถือ state ของลูกค้าทั้งฐานไว้ตลอดเวลา —
   ขัดกับความเสี่ยงอันดับ 1 ที่ [flow-engine §13](../flow-engine.md) ระบุไว้เองว่าห้ามให้ router
   กลายเป็น durable state machine

2. **Journey ห้ามสร้าง interaction เอง**
   มันสั่งผ่าน `apps/channels` (ส่งข้อความ) / `apps/dialer` (โทร/แคมเปญ) / `apps/cases` (เปิดเคส) เท่านั้น
   วินัยเดียวกับ [ADR-011](011-outbound-campaign.md) ข้อ 1 ที่ dialer ผลิต *งาน* แล้วให้ router เป็นคนจ่าย —
   ถ้า journey สร้าง interaction เองได้ เราจะมีทางเข้าสองทางที่มีกติกา capacity คนละชุด

3. **Contact policy อยู่ระดับลูกค้า และทุกการติดต่อขาออกต้องผ่าน Contact Governance**
   วันนี้เพดานอยู่ระดับแคมเปญ ([ADR-011](011-outbound-campaign.md)) พอมี journey หลายตัวทำงานพร้อมกัน
   ลูกค้าคนเดียวจะโดนติดต่อ 5 ครั้งในวันเดียวโดยไม่มีใครรู้ — **นี่คือจุดที่แพลตฟอร์ม CXA พังจริงที่สุด**

   ```
   ทุกการติดต่อขาออก (journey · campaign · broadcast · survey invite) ผ่านสามด่านตามลำดับ
     1. Contact Governance       ← restriction/consent/preference/เวลา/frequency
     2. กฎเฉพาะโมดูล            ← survey 30 วัน · retry ของแคมเปญ
     3. authorize + reserve       ← คำสั่งเดียวจาก Contact Governance
     → ถูกกดที่ชั้นไหนต้องบันทึกแยกกัน ไม่ใช่หายเงียบและไม่ใช่ตัวเลขเดียวกัน
   ```

   **การตรวจกับการจองต้องเป็นก้าวเดียวกัน (`authorizeAndReserve()`)** — ถ้าเป็น check-then-act
   journey สองตัวกับแคมเปญหนึ่งตัวจะอ่านพร้อมกันว่าเหลือโควตา แล้วส่งครบทั้งสาม
   เป็นบั๊กชนิดเดียวกับที่ [ADR-024](024-message-delivery-media.md) ข้อ 3 แก้ไว้ในกล่องส่งข้อความ
   และการจอง **ต้องมีอายุ + คืนโควตาเมื่อส่งไม่สำเร็จ** ไม่งั้น worker ที่ตายกลางทาง
   จะกินเพดานของลูกค้าถาวรโดยที่เขาไม่เคยได้รับอะไร (รายละเอียดใน
   [journey-orchestration §5.2](../journey-orchestration.md))

   รายละเอียดการตัดสิน, hard restriction, Attempt/Touch และ Approved exception อยู่ที่
   [ADR-027](027-contact-governance.md) ซึ่งยกระดับเครื่องจักร consent/DNC เดิมเป็นโมดูลกลาง

4. **ทุก journey ต้องมี goal ที่วัดได้ · เงื่อนไขออก · และเพดานอายุ**
   ไม่มี journey อมตะ — ลูกค้าที่จ่ายเงินแล้วต้องหลุดจาก journey ทวงถามทันที
   บังคับตอน publish เหมือนที่ flow บังคับ `fallbackNodeId`

5. **Segment เป็นนิยามที่ประเมินตอนใช้ ไม่ใช่รายชื่อที่แช่แข็ง**
   แต่ตอน enroll ต้อง **snapshot เหตุผล** ไว้ (ทำไมคนนี้ถึงเข้า journey นี้) ไม่งั้นตอบลูกค้าไม่ได้ว่า
   "ทำไมฉันได้ข้อความนี้" ซึ่งเป็นคำถามที่ PDPA ให้สิทธิ์ลูกค้าถาม

6. **ห้ามสร้าง DSL ที่สอง** — เงื่อนไขใน journey ใช้ `expression` sandbox
   ([ADR-021](021-flow-expression-node.md)) และแนวคิด subflow ชุดเดียวกับ flow

7. **`apps/journey` เป็น service แยก**
   workload คนละแบบกับทุกตัวที่มี: scheduler ที่ต้องปลุก enrollment เป็นล้านรายการตามเวลา
   และ **ล้มได้โดยการรับสายไม่กระทบ** (เหมือน webhook/QM/WFM) — ถ้าฝังใน router จะได้ router
   ที่มี timer ของลูกค้าทั้งฐาน

8. **สิ่งที่ตั้งใจไม่ทำ: marketing automation**
   ไม่มี email blast/newsletter · ไม่มี attribution/UTM · ไม่มี identity graph ข้ามเว็บไซต์ ·
   ไม่มี lead scoring — เราไม่แข่งกับ HubSpot/Braze และหน้าเว็บขายต้องไม่เขียนให้เข้าใจว่าแข่ง
   ตำแหน่งที่ป้องกันได้คือ **"CCaaS ที่ทำงานเชิงรุกได้ในตัว"**

## ผลที่ตามมา

- service ใหม่ `apps/journey` + topic `dc.journey.events` (ประกาศไว้แล้วใน `packages/shared`) ·
  ตาราง `jr_*`, `sg_*`; ตาราง policy/reservation เป็น `cg_*` ของ Contact Governance
  (อยู่ในเอกสารจนกว่าเฟสจะเริ่ม — ดูธรรมเนียมใน [docs/README](../README.md))
- **event inbox** เป็นของแรกที่ต้องสร้างใน J1: unique `(tenantId, source, eventId)` กัน API retry
  ทำให้ลูกค้าถูกดึงเข้า journey ซ้ำ (envelope อยู่ที่ `packages/shared` → `InboundBusinessEvent`)
- ทุกการกระทำมี `actionKey = enrollmentId:journeyVersion:stepId` ที่ส่งต่อเป็น `clientToken` ของ ADR-024
  — ใช้ทั้งกันส่งซ้ำและใช้ยกเลิกงานที่ค้างเมื่อบรรลุเป้าหมายก่อนเวลา
- `POST /api/v1/events` (public API) กลายเป็นทางเข้าหลักของ CXA — ระบบธุรกิจของลูกค้ายิงเหตุการณ์เข้ามา
- [outbound-campaign.md](../outbound-campaign.md): เพดานการติดต่อของแคมเปญกลายเป็น *ผู้ใช้* contact policy
  ไม่ใช่เจ้าของกติกา
- [customer-360.md](../customer-360.md): เพิ่ม attribute/segment เป็นฐานของการเล็งกลุ่ม
- entitlement: `modules.journey.{enabled, eventTriggers, segments}` + `modules.contactGovernance.*`
  (ด่านพื้นฐานเปิดทุกแพ็กเกจ) + quota `journeyActionsPerMonth`
- ตัววัดใหม่ที่ไม่มีในโลก CCaaS: **สายที่ไม่เกิด** (deflected by journey) — ต้องวัดให้ได้ ไม่งั้นขายคุณค่าไม่ออก

## ทางเลือกที่ไม่เอา

| ทางเลือก | เหตุผลที่ไม่เอา |
|---|---|
| ยืด flow ให้ข้ามวันแทนการมี journey | router กลายเป็น durable state machine ของลูกค้าทั้งฐาน — ความเสี่ยงอันดับ 1 ที่เราระบุไว้เอง |
| ให้ journey สร้าง interaction เอง | ทางเข้าสองทางที่มีกติกา capacity คนละชุด |
| เพดานการติดต่อคงไว้ที่ระดับแคมเปญ | ลูกค้าโดนติดต่อ 5 ครั้ง/วันจาก 5 journey โดยไม่มีใครเห็นภาพรวม |
| ทำ segment เป็นรายชื่อที่ freeze | ตกรถทุกครั้งที่ข้อมูลเปลี่ยน และตอบไม่ได้ว่าทำไมคนนี้ถึงอยู่ในกลุ่ม |
| ทำ marketing automation ให้ครบ | คนละสนาม แพ้ตั้งแต่ยังไม่เริ่ม และทำให้ตำแหน่งของสินค้าอธิบายไม่ได้ |

## เอกสารเกี่ยวข้อง

[journey-orchestration.md](../journey-orchestration.md) · [ADR-027](027-contact-governance.md) · [ADR-011](011-outbound-campaign.md) ·
[ADR-007](007-flow-engine.md) · [ADR-020](020-customer-360.md) · [ADR-015](015-integration-platform.md)
