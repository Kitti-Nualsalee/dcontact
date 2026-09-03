# ADR 011: Outbound & Campaign — dialer เป็น service ที่ "ป้อนงาน" ให้ router ไม่ใช่ระบบโทรของตัวเอง

- **สถานะ:** Accepted
- **วันที่:** 2026-08-08

## บริบท

ระบบที่ออกแบบไว้จนถึง ADR-010 เป็น **inbound ล้วน** — ทุก interaction เกิดจากลูกค้าติดต่อเข้ามา
แต่ตลาดที่ขายจริง (collection, telesales, appointment reminder, delivery confirm) ซื้อ **ขาออก**
เป็นหลัก และคู่แข่งมีครบ (NICE = Personal Connection, Zoom = Outbound Campaigns)

สิ่งที่มีอยู่แล้วและ outbound ต้องใช้:

| Outbound ต้องการ | มีอยู่แล้ว |
|---|---|
| สั่งโทรออกโดยไม่ผูก vendor | `dc.telephony.commands` ([ADR-006](006-multi-vendor-telephony-gateway.md)) |
| งาน 1 ชิ้น = 1 interaction ทุกช่องทาง | [ADR-001](001-unified-interaction-model.md) |
| จับคู่งานกับ agent | `apps/router` ([interaction-data-flow §4](../interaction-data-flow.md)) |
| อัดเสียง + ตรวจคุณภาพ | `recordings` + `apps/qm` ([ADR-010](010-quality-management.md)) |
| ปฏิทินคนว่าง | `apps/wfm` ([ADR-008](008-workforce-management.md)) |
| ตัวเลขว่าโทรไปเท่าไหร่ (billing) | `dc.interaction.events` ([ADR-003](003-kafka-event-backbone.md)) |

ข้อจำกัดที่กำหนดขอบเขต: **agent คนเดียวต้องรับได้ทั้งเข้าและออก · ต้องเคารพกฎห้ามโทร
(DNC/PDPA/ช่วงเวลา) โดยผิดพลาดไม่ได้ · abandonment rate ต้องมีเพดานที่บังคับได้จริง ·
ต้องรันบน Asterisk ได้เหมือน FreeSWITCH**

## การตัดสินใจ

1. **`apps/dialer` เป็น service แยก และผลิต "งาน" ไม่ใช่ "สาย"**
   dialer เลือกว่าจะติดต่อใครต่อไป แล้ว **ส่งเข้า router เป็น interaction ปกติ**
   (`direction=OUTBOUND`) — router ไม่รู้และไม่ต้องรู้ว่าใครสร้างงานนี้
   ผลคือ skill matching, SLA, recording, QM, adherence ทำงานกับสายขาออกทันทีโดยไม่ต้องแก้อะไร
   ถ้ายัด pacing loop ลงใน router เราจะได้ router ที่มีสองบุคลิกและทดสอบไม่ได้

2. **การโทรจริงเป็น telephony command เท่านั้น — dialer ห้ามคุย ESL/ARI**
   dialer สั่ง `originate` ลง `dc.telephony.commands` แล้วรอ event กลับ
   (วินัยเดียวกับที่ QM ไม่แตะ ESL ใน [ADR-010](010-quality-management.md) ข้อ 2)
   ทำให้ predictive dialer ทำงานบน gateway ไหนก็ได้ตาม [ADR-006](006-multi-vendor-telephony-gateway.md)

3. **Blended = reserve capacity ที่ router ไม่ใช่การแยก agent pool**
   agent มี `outboundReserve` (0–100%) ต่อ queue; router กันช่องว่างไว้ให้ inbound เสมอ
   dialer ขอ "จำนวนที่นั่งว่างที่โทรออกได้ตอนนี้" จาก router ผ่าน API เดียว
   การแยก pool คือคำตอบที่ง่ายกว่าแต่ทำให้ SLA inbound พังตอนแคมเปญเดิน และแก้ทีหลังแปลว่ารื้อ router

4. **DNC / consent / ช่วงเวลาห้ามโทร เป็นด่านบังคับ 2 ชั้น และห้ามข้ามด้วย config**
   ชั้นที่ 1 ตอน import list (บอกลูกค้าทันทีว่ากี่เบอร์ถูกตัด), ชั้นที่ 2 **ทุกครั้งก่อน originate**
   ชั้นที่ 2 มีอยู่เพราะ list อาจนิ่งอยู่หลายวันแล้วลูกค้าเพิ่งขอถอนความยินยอม
   เหตุผลเดียวกับ PCI ใน [ADR-010](010-quality-management.md) ข้อ 3: **โทรไปแล้วเรียกคืนไม่ได้**

5. **Abandonment cap เป็น hard constraint ของ pacing ไม่ใช่ตัวชี้วัดที่ดูย้อนหลัง**
   predictive ต้องหยุดเร่งเองเมื่อ abandon rate ใน rolling window แตะเพดานของ tenant/ประเทศ
   (ค่าเริ่มต้น 3%) และต้องมี **safe harbour message** เล่นทุกครั้งที่ไม่มีคนรับสาย

6. **ลำดับ: Preview → Progressive → Predictive**
   predictive ต้องการสถิติ (RPC rate, talk time, AMD accuracy) ที่จะมีก็ต่อเมื่อระบบเดินมาแล้ว
   การทำ predictive ก่อนคือการเดาพารามิเตอร์ที่ยังไม่มีข้อมูล

7. **Proactive messaging ใช้เครื่องจักรตัวเดียวกับ dialer**
   broadcast LINE/SMS/WhatsApp = `campaign.kind = MESSAGE` — ใช้ list, consent, throttle,
   disposition ชุดเดียวกัน ต่างกันแค่ **ไม่กิน agent** และมี opt-out link บังคับ
   การแยกเป็นอีกโมดูลแปลว่าต้องทำ DNC/consent สองชุดซึ่งจะเพี้ยนกันวันใดวันหนึ่ง

8. **AMD (answering machine detection) เป็น provider เสริมและต้องบันทึกผลทุกครั้ง**
   AMD ผิดพลาด = ตัดสายใส่หน้าคนจริง ซึ่งเป็นเรื่องร้องเรียนอันดับหนึ่งของระบบ dialer
   จึงต้องเก็บ `amd_result` + ไฟล์เสียงต้นสายไว้ตรวจย้อนหลังเสมอ และปิดได้ต่อแคมเปญ

## ผลที่ตามมา

- `apps/router` ต้องเพิ่มแนวคิด **reserve capacity** และ endpoint `GET /capacity` (งานจริงข้อเดียว)
- `interactions.direction` ที่มีอยู่แล้วถูกใช้เต็มรูป — รายงาน/QM/WFM แยกเข้า-ออกได้ฟรี
- เพิ่ม topic `dc.dialer.jobs` (pacing → worker) และ `dc.dialer.events`
- WFM ต้องรับ requirement แบบ outbound (ADR-008 §6 เพิ่ม workload type ที่สาม) — เฟส O4
- entitlement key ใหม่: `modules.outbound.{preview,progressive,predictive,proactiveMessaging}`
  พร้อม quota `outboundAttemptsPerMonth` / `messageSegmentsPerMonth`
  ([licensing §2](../licensing.md)) — outbound เป็นโมดูลที่ **มีต้นทุนผันแปรจ่ายออกจริง**
  แบบเดียวกับ ASR จึงต้องมาคู่กับ quota เสมอ

## ทางเลือกที่ไม่เอา

| ทางเลือก | เหตุผลที่ไม่เอา |
|---|---|
| ใช้ `mod_callcenter` / Asterisk queue ทำ outbound | ผูก vendor ทันที ขัด [ADR-006](006-multi-vendor-telephony-gateway.md) |
| ยัด pacing เข้า `apps/router` | router เป็นหัวใจของ inbound — bug ใน pacing จะทำสายเข้าตกทั้งระบบ |
| แยก agent เป็น inbound pool / outbound pool | ปิดทางทำ blended ถาวร และ SLA inbound พังตอนแคมเปญเดิน |
| ทำ predictive ตั้งแต่วันแรก | ไม่มีสถิติจะป้อนโมเดล pacing |
| broadcast SMS เป็นโมดูลแยก | ได้ DNC/consent สองชุดที่จะเพี้ยนกัน |

## เอกสารเกี่ยวข้อง

[outbound-campaign.md](../outbound-campaign.md) — ฉบับเต็ม: pacing, data model, กฎหมาย, แผนเฟส O1–O5
