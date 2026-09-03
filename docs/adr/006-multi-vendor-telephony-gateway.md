# ADR 006: Multi-vendor telephony — deployment profile (SaaS = FreeSWITCH, on-prem = Asterisk)

- **สถานะ:** Accepted
- **วันที่:** 2026-07-15

> **อัปเดต (2026-08-09):** `dc.fs.events` → `dc.telephony.events` ตาม [ADR-023](023-conversation-vs-interaction.md) ข้อ 6
> (ชื่อเดิมขัดกับ ADR นี้เองที่รองรับ Asterisk)


## บริบท

[ADR-002](002-esl-vs-mod_callcenter.md) เลือก FreeSWITCH + ESL เป็น media layer และ
[ADR-001](001-unified-interaction-model.md) วางให้ router ตัวเดียวกระจายงานทุก channel
โดยไม่ผูกกับ media server

ตอนนี้ต้องรองรับ **Asterisk** เพิ่มด้วย โดยมีรูปแบบการขายสองแบบชัดเจน:

- **SaaS** (cloud, multi-tenant) → ใช้ **FreeSWITCH**
- **On-prem** (ที่ลูกค้า, มักเป็น single-tenant) → ใช้ **Asterisk** (ลูกค้าหลายรายมี Asterisk PBX เดิม)

เงื่อนไขสำคัญคือ **ต้องเพิ่มโดยไม่แก้ router และ downstream เลย** และ **deployment หนึ่งใช้ vendor เดียว**
เป็นเคสหลัก (ไม่ใช่คละ vendor ในระบบเดียว)

## การตัดสินใจ

### 1. Gateway abstraction — vendor เลือกที่ระดับ deployment profile

vendor ถูกซ่อนหลัง gateway + envelope กลาง ดังนั้น "รัน gateway ตัวไหน" เป็นเรื่อง **packaging/deploy
ไม่ใช่โค้ด** — kernel (api/router/channels) + DB/Kafka/Redis/Keycloak เป็น **image เดียวกันเป๊ะ** ทุก profile

| Profile | Gateway ที่ deploy | Media server |
|---|---|---|
| **SaaS** (เคสหลัก) | `apps/telephony` (ESL) เท่านั้น | FreeSWITCH |
| **On-prem** | `apps/asterisk-gateway` (ARI) เท่านั้น | Asterisk |
| _Dual-stack_ (variant, ไม่ใช่เคสหลัก) | ทั้งสอง | ทั้งสอง — ดูข้อ 6 |

- ทั้งสอง gateway **normalize** call event ของตัวเองเป็น **DC envelope เดียวกัน** แล้ว produce ลง
  **`dc.fs.events` topic เดียวกัน** — **key = `callUuid` คงเดิม** — router มองเห็นเหมือนกันหมด
  ไม่รู้/ไม่สนใจว่ามาจาก vendor ไหน
- deployment ที่รัน vendor เดียว = มี gateway ตัวเดียว, consumer เดียว → **ปัญหา command routing
  ในข้อ 5 ไม่เกิดเลย** (filter ยังคงอยู่ในโค้ดแต่ no-op)

> หมายเหตุชื่อ topic: `dc.fs.events` (ตั้งตอนมี FreeSWITCH อย่างเดียว) ตอนนี้กลายเป็น
> "call/media events จากทุก vendor" — ไม่เปลี่ยนชื่อเพื่อเลี่ยง breaking change,
> ถือเป็น alias เชิงประวัติศาสตร์ (documented) เหมือนกรณี SIP-domain-as-tenant-key

### 2. Asterisk ใช้ **ARI** ไม่ใช่ AMI

ARI (Asterisk REST Interface) = WebSocket event stream + REST control ผ่าน **Stasis app** —
โมเดลใกล้ ESL ที่สุด (รับ event → สั่งกลับ) และเป็น structured JSON ต่างจาก AMI ที่ text-based
และ loose contract; inbound call เข้า Stasis app แทน `park` ของ FreeSWITCH แต่แนวคิด
"ค้างสายไว้ให้ router ตัดสินใจ" เหมือนกัน (ADR-002)

### 3. Envelope contract เป็นสัญญากลางใน `packages/shared`

Event contract (`eventId, tenantId, callUuid, direction, caller, destination, type, ts`)
นิยามครั้งเดียวใน `packages/shared` — **ทั้งสอง gateway ต้อง implement ให้ตรง** และมี
**contract test** ยืนยันว่า event ชนิดเดียวกันจาก FS และ Asterisk ออกมา envelope หน้าตาเดียวกัน
Gateway คือชั้นที่แปลง vendor-specific event (ESL `CHANNEL_CREATE` / ARI `StasisStart`) →
DC event type กลาง (`call.created`, `call.answered`, `call.hangup`)

### 4. Vendor header + ปลายทางบันทึกไว้ที่ interaction

- ทุก message ที่ gateway produce แนบ header **`vendor` = `freeswitch` | `asterisk`**
  (คู่กับ `tenantId` header ตาม ADR-003)
- Router ตอน intake อ่าน `vendor` แล้ว **persist ลง interaction** (`interactions.metadata.vendor`
  หรือคอลัมน์ `telephony_vendor` — เลือกตอน implement) เพื่อให้ทุก command ในอนาคตของสายนี้
  รู้ว่าต้องส่งกลับ vendor ไหน

### 5. เส้น command ขากลับ — filter ด้วย vendor (สำคัญเฉพาะ dual-stack)

- gateway แต่ละตัวเป็น **consumer group แยกกัน** (`gw-freeswitch`, `gw-asterisk`) อ่าน
  `dc.telephony.commands` แล้ว **ประมวลผลเฉพาะ message ที่ `vendor` header ตรงกับตัวเอง**
- Router produce command โดย **stamp `vendor`** (จากที่ persist ไว้ข้อ 4) + **key = callUuid**
  → ordering ต่อสายคงเดิม, ส่งถึง gateway เจ้าของสายเสมอ
- **ไม่แยก topic ต่อ vendor** — สอดคล้อง ADR-003 (shared topic + header ไม่ใช่ topic-per-X)
- **single-vendor deployment: กลไกนี้ no-op** (มี consumer เดียว, vendor เดียว) — เขียน filter ไว้
  ให้ dual-stack ทำงานได้โดยไม่ต้องแก้โค้ด แต่ไม่มี cost ในเคสหลัก

### 6. Dual-stack (variant) — คละ vendor ต่อ tenant ในระบบเดียว

_ไม่ใช่เคสหลัก_ แต่ abstraction เดียวกันรองรับได้ฟรี: ถ้าอยากให้ SaaS deployment เดียวมีทั้ง
FreeSWITCH และ Asterisk (บาง tenant ใช้คนละตัว) แค่ deploy ทั้งสอง gateway — vendor ของสาย
กำหนดจาก media server ที่ SIP trunk ของ tenant ชี้อยู่ (tenant metadata, ADR-005), gateway ที่รับสาย
คือคน stamp vendor ตั้งแต่ต้น ข้อ 4–5 คือกลไกที่ทำให้เคสนี้ทำงานถูกต้อง

### 7. Command set เป็น subset ร่วม

Router สั่งได้เฉพาะ command ที่ **ทั้งสอง vendor ทำได้** (bridge, park, hangup, record,
playback, DTMF) — gateway เป็นคนแปลงเป็น ESL app / ARI operation ของตัวเอง;
feature เฉพาะ vendor (เช่น FreeSWITCH mod เฉพาะทาง) ห้ามรั่วขึ้นมาถึง router

## ทางเลือกที่ปัดตก

- **แยก topic ต่อ vendor** (`dc.telephony.commands.fs` / `.ast`) — ชัดกว่าแต่ topic ระเบิดตาม
  vendor และขัดหลัก ADR-003; router ต้องรู้จัก topic ต่อ vendor (leak abstraction)
- **Asterisk ผ่าน AMI** — text-based, event contract หลวม, สั่ง control ยากกว่า ARI
- **แทน FreeSWITCH ด้วย Asterisk ทั้งหมด** — เสีย investment ADR-002 และ ESL ที่ทดสอบผ่านแล้ว
- **SBC/vendor เชิงพาณิชย์ (Twilio ฯลฯ) แทน self-hosted** — ขัดแนว self-hosted ของโปรเจค
  แต่ abstraction นี้เปิดทางไว้: เพิ่ม gateway ตัวที่สามได้ด้วย pattern เดียวกัน

## ผลที่ตามมา

- (+) **router / API / reporting / billing ไม่ต้องแก้แม้แต่บรรทัดเดียว** — เพิ่ม vendor = เพิ่ม gateway
- (+) **single-vendor deployment ง่ายกว่า dual-stack**: รัน gateway ตัวเดียว, ไม่มี command routing
  ที่ต้อง filter — SaaS (FreeSWITCH) และ on-prem (Asterisk) ใช้ kernel image เดียวกัน ต่างแค่ gateway container
- (+) on-prem มักเป็น **single-tenant (N=1)** — machinery multi-tenant ทำงานกับ 1 tenant ได้เลย
  ไม่ต้องแก้โค้ด แค่ config ง่ายลง (1 Keycloak org)
- (+) dual-stack เป็น variant ที่ได้ฟรีจาก abstraction เดียวกัน; เปิดทาง gateway ตัวที่ 3 (SBC/cloud)
- (−) ต้อง maintain **2 codebase + 2 normalization mapping** ให้ envelope ตรงกันเป๊ะ — ถึงแต่ละ
  deployment รัน vendor เดียว โค้ดฝั่งที่ไม่ใช่ตัวหลักจะ "เน่า" เงียบได้ →
  **contract test ใน CI ต้องเขียวทั้งคู่เสมอ** (นี่คือต้นทุนหลักที่เหลือ ไม่ใช่ runtime)
- (−) command set จำกัดที่ **ความสามารถร่วม** ของทั้งคู่ — feature เฉพาะ vendor ต้องออกแบบพิเศษ;
  ระวัง feature skew ระหว่าง product SaaS กับ on-prem
- (−) ARI ต้องมี Stasis dialplan + external media handling ที่ต่างจาก ESL park model —
  งาน Asterisk gateway ไม่ใช่แค่ "แปล ESL เป็น ARI" ตรง ๆ
- (−) **on-prem = distribution model ใหม่** (ลูกค้ารัน Kafka/Postgres/Keycloak เองหรือ bundle single-node,
  licensing, update/patch, air-gapped, data residency) — งานใหญ่กว่าการเลือก vendor มาก ตัว vendor เป็นส่วนที่ง่ายสุด

## สถานะ

เคสหลัก Phase 1 = **SaaS profile (FreeSWITCH เท่านั้น)** — `apps/telephony` เป็น gateway ตัวแรกที่ implement
`apps/asterisk-gateway` (on-prem profile) เป็น **Phase 1+** เอกสารนี้ล็อกสัญญา (envelope, vendor header,
command routing) ไว้ก่อน เพื่อให้ตอน implement telephony ตัวแรกวาง interface ให้ถูกตั้งแต่ต้น ไม่ต้อง retrofit
ภายหลัง data flow ฉบับเต็มดู [interaction-data-flow.md §3b](../interaction-data-flow.md)
