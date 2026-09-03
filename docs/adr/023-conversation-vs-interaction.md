# ADR 023: Conversation ≠ Interaction ≠ Case — สามชั้นที่แยกกันชัดเจน และกติกาการกลับมาคุยต่อ

- **สถานะ:** Accepted
- **วันที่:** 2026-08-09
- **แก้ไข:** [ADR-001](001-unified-interaction-model.md) (เพิ่มชั้น thread ใต้ interaction) · schema Phase 0

## บริบท

`Conversation.interactionId` ปัจจุบันเป็น `@unique` — หนึ่ง thread ผูกได้กับงานเดียวตลอดกาล
ซึ่งถูกสำหรับเว็บแชทที่จบแล้วปิดหน้าต่างไป **แต่ผิดสำหรับ LINE/WhatsApp/Facebook/อีเมล**
ซึ่งเป็นช่องทางหลักของตลาดไทย:

```
ลูกค้าคนเดิม ห้อง LINE เดิม
  จันทร์ 09:00  ถามเรื่องพัสดุ        → งานที่ 1 (สมชายรับ, ปิดแล้ว)
  พุธ   14:30  ถามเรื่องใบกำกับภาษี  → งานที่ 2 (สมหญิงรับ)
  ศุกร์ 11:00  ตอบกลับเรื่องเดิม     → งานที่ 3? หรือต่อจากงานที่ 2?
```

ด้วยโครงปัจจุบัน ระบบต้องสร้าง `Conversation` ใหม่ทุกครั้ง แปลว่า **ประวัติในห้องเดิมขาดเป็นท่อน ๆ**
agent เห็นแค่ท่อนของตัวเอง และเราตอบไม่ได้ว่า "ลูกค้าคนนี้ทักมาในห้องนี้กี่ครั้งแล้ว"

พร้อมกันนั้น [ADR-016](016-case-management.md) เพิ่มชั้น `case` เข้ามาอีกชั้น ทำให้ตอนนี้มีสามคำ
ที่ฟังดูคล้ายกันและยังไม่เคยถูกวาดในรูปเดียวกัน — ถ้าไม่นิยามตอนนี้ ทีมจะสร้าง FK มั่วภายในสองสัปดาห์

## การตัดสินใจ

1. **สามชั้น หน้าที่คนละอย่าง ห้ามยุบรวม**

   | ชั้น | คือ | อายุ | ตัวอย่าง |
   |---|---|---|---|
   | **Conversation** | *ช่องทางที่เราคุยกับคนนี้* — thread ถาวรฝั่ง provider | ตลอดชีวิตความสัมพันธ์ | ห้อง LINE ของ `@napha.c` |
   | **Interaction** | *งานหนึ่งชิ้นที่มอบให้ agent* — หน่วยของ routing/SLA/AHT/billing | นาที–ชั่วโมง | "รับเรื่องพัสดุล่าช้า" |
   | **Case** | *เรื่องหนึ่งเรื่องของลูกค้า* ที่กินหลายงานหลายวัน | ชั่วโมง–สัปดาห์ | "เคลมสินค้าชำรุด CS-4821" |

   ความสัมพันธ์: `Conversation 1—N Interaction` · `Case 1—N Interaction` ·
   **conversation กับ case ไม่ผูกกันตรง ๆ** (เจอกันผ่าน interaction เท่านั้น) —
   เพราะเรื่องหนึ่งเรื่องเกิดข้ามช่องทางได้ และห้องหนึ่งห้องมีได้หลายเรื่อง

2. **`Conversation.interactionId @unique` ถูกยกเลิก → `Interaction.conversationId` แทน**
   คีย์ธรรมชาติของ thread คือ **`(tenantId, channel, channelAccountId, externalThreadId)`**
   — ต้องมี `channelAccountId` เพราะ id ฝั่ง provider **มี scope ต่อบัญชี** (Facebook PSID
   ต่างกันต่อ Page, LINE userId ต่างกันต่อ OA) tenant ที่เชื่อมสอง Page จึงชนกันได้
   และคอลัมน์นี้ต้อง **NOT NULL** เพราะ Postgres ไม่บังคับ unique ให้แถวที่คอลัมน์เป็น `NULL`
   — ใส่แบบ nullable แล้วจะเหมือนมี unique แต่จริง ๆ ไม่มี ซึ่งแย่กว่าไม่ใส่

   `externalThreadId` = id ของ **ห้อง** (LINE conversation id · Messenger thread · widget session ·
   สำหรับอีเมลคือ `Message-ID` chain ที่ต่อผ่าน `In-Reply-To`/`References`) —
   **คนละตัวกับ `Message.providerMessageId`** ซึ่งเป็น id ของ *ข้อความหนึ่งใบ* และใช้ทำ dedupe
   ([ADR-024](024-message-delivery-media.md) ข้อ 2) สองค่านี้ทำคนละงานและมีข้อกำหนดคนละแบบ:
   ตัวแรกไว้ต่อ thread (ผู้ส่งกำหนดได้ ไม่เป็นไร) ตัวหลังไว้กันซ้ำ (ห้ามให้ผู้ส่งกำหนด)

   voice ไม่มี conversation (เป็น `null`) — ไม่ใช่การบังคับสร้าง thread ปลอมให้ครบทุกช่องทาง

3. **`Message` ต้องรู้ว่าตัวเองอยู่ในงานชิ้นไหน — `Message.interactionId` (nullable)**
   พอ thread ยืนยาวข้ามหลายงาน ข้อความที่ไม่ผูกงานจะทำให้ QM ตรวจไม่ได้ว่า agent คนไหนพูดอะไร
   ในงานของใคร และ AHT/analytics นับผิด
   `null` = ข้อความที่เข้ามาตอนยังไม่มีงาน (เช่น ลูกค้าทักมาแล้วบอตตอบจนจบ)

4. **กติกาการกลับมาคุยต่อ (reopen window) = 30 นาที — และงานที่ปิดแล้วห้ามถูกเปิดกลับมา**

   ```
   ลูกค้าส่งข้อความเข้า thread เดิม
     → มี interaction ที่ยัง ACTIVE/WRAPUP อยู่ไหม → ต่อที่งานนั้นเลย
     → ไม่มี แต่งานล่าสุดปิดไป <= 30 นาที
         → สร้าง interaction ใหม่ที่มี reopenedFromInteractionId ชี้กลับไปงานเดิม
           (conversation เดิม → ประวัติไม่ขาด)
         → agent คนเดิมยัง online และมี slot ว่าง → ส่งให้คนเดิม (last-agent routing)
         → ไม่ว่าง → เข้าคิวปกติ
     → เกิน 30 นาที → interaction ใหม่ ไม่มี reopenedFrom
     → conversation = BLOCKED → ไม่สร้างงาน (ข้อความยังถูกเก็บ)
   ```

   **แถวของงานที่ `COMPLETED` แล้วห้ามถูกแก้ทุกกรณี** — การกลับไป `QUEUED/ASSIGNED`
   จะเขียนทับ `endedAt` ทำให้ AHT/SLA ของงานที่ปิดไปแล้วเปลี่ยนย้อนหลัง,
   ยิง `interaction.ended` ซ้ำเข้า metering, และผลประเมิน QM ที่ publish ไปแล้วผูกอยู่กับงานที่ถูกเปิดใหม่
   เหตุผลเดียวกับที่ ADR นี้ปฏิเสธ "ไม่มี reopen window" ในตารางข้างล่าง —
   **รายงานย้อนหลังต้องให้คำตอบเดิมเสมอไม่ว่าจะรันวันไหน**

   ผลที่ตามมาซึ่งต้องตัดสินพร้อมกัน ไม่งั้นตัวเลขจะเพี้ยนคนละแบบ:

   | ตัวชี้วัด | กติกาของ chain |
   |---|---|
   | **FCR / repeat contact** | งานที่มี `reopenedFrom` **ไม่นับเป็นการติดต่อซ้ำ** — เป็นบทสนทนาเดิมที่ยังไม่จบ |
   | **Metering / billing** | เก็บคนละแถวใน DB แต่รายงานและแพ็กเกจ **ยุบทั้ง chain เป็น 1 หน่วย** — ลูกค้าไม่ควรจ่ายเพิ่มเพราะคนพิมพ์ต่อ |
   | **การสุ่มตรวจ QM** | สุ่มได้ **หนึ่งใบต่อ chain** ไม่งั้นผู้ตรวจได้บทสนทนาเดียวกันสองรอบ |
   | **AHT** | คิดต่อ interaction ตามปกติ — ไม่รวมเวลาทั้ง chain เพราะเวลาที่ลูกค้าหายไปไม่ใช่เวลาทำงาน |

   ตัวเลข 30 นาทีเป็น **tenant metadata** ([ADR-005](005-multitenant-metadata-architecture.md))
   ไม่ใช่ค่าคงที่ในโค้ด แต่ต้องมีค่าเริ่มต้นที่ไม่เป็นศูนย์ — ระบบที่สร้างงานใหม่ทุกข้อความ
   จะได้ตัวเลข "จำนวนงาน" ที่เฟ้อและ AHT ที่ต่ำอย่างหลอกตา

5. **สถานะของ conversation แยกจากสถานะของ interaction**

   | สถานะ conversation | หมายความว่า |
   |---|---|
   | `OPEN` | มีงานที่ยังทำอยู่ |
   | `IDLE` | ไม่มีงานค้าง แต่ห้องยังเปิด ลูกค้าพิมพ์กลับมาได้ตลอด |
   | `RESOLVED` | ปิดเรื่องล่าสุดแล้ว (ยังพิมพ์กลับมาได้ — จะเข้ากติกาข้อ 4) |
   | `BLOCKED` | บล็อกโดยผู้ดูแล (สแปม/ล่วงละเมิด) — ข้อความเข้าไม่สร้างงาน |

   **ปุ่มของ agent คือ "Resolve งาน" ไม่ใช่ "ปิดห้อง"** — agent ไม่มีสิทธิ์ปิดช่องทางที่ลูกค้าใช้ติดต่อเรา
   มีแต่ `BLOCKED` เท่านั้นที่ปิดจริง และเป็นสิทธิ์ของหัวหน้าขึ้นไป + ต้องมีเหตุผล + audit

6. **ชื่อ topic ต้องไม่ผูกกับ vendor** — `dc.fs.events` ถูกแทนด้วย
   **`dc.telephony.events`** (voice ทุก vendor) และ **`dc.channel.events`** (digital ขาเข้า)
   คู่กับ `dc.telephony.commands` / `dc.channel.commands` ที่มีอยู่แล้ว
   ชื่อเดิมผิดสองชั้น: ผูกกับ FreeSWITCH ทั้งที่ [ADR-006](006-multi-vendor-telephony-gateway.md)
   รองรับ Asterisk และเอา digital ไปฝากไว้ใน topic ที่ชื่อบอกว่าเป็น telephony
   **ทำตอนนี้ราคาเกือบศูนย์ (Phase 0 ยังไม่มีข้อมูลจริง) ทำเดือนหน้าคือ dual-write**

## ผลที่ตามมา

- schema: `Conversation` (ตัด `interactionId`, เพิ่ม `channelAccountId`/`contactId`/`state`/timestamps/unique),
  `Interaction.conversationId` + `Interaction.reopenedFromInteractionId` (self-relation),
  `Message.interactionId` — migration เดียว ไม่มีข้อมูล production
- ต้องมี `ChannelAccount` เป็น entity จริงในโมดูล channels (ตอนนี้เก็บเป็น id ทึบไปก่อน)
- router ขั้น 1 (intake) ได้งานใหม่: resolve thread → ตัดสินตามกติกาข้อ 4 ก่อนสร้าง interaction
- `packages/shared` `KAFKA_TOPICS.FS_EVENTS` → `TELEPHONY_EVENTS` + เพิ่ม `CHANNEL_EVENTS`
  (แก้ที่ `apps/telephony`, `apps/router`, `docker-compose.dev.yml`, README และเอกสารทุกฉบับ)
- [customer-360](../customer-360.md) ได้ประโยชน์ตรง: thread ถาวรคือ identity ที่แข็งแรงที่สุดที่เรามี
  (`contact_identities.kind = LINE` ชี้ไปที่ห้องเดิมได้เสมอ)
- QM/analytics นับ AHT ต่อ interaction ได้ถูกต้องเพราะข้อความรู้ว่าตัวเองอยู่งานไหน

## ทางเลือกที่ไม่เอา

| ทางเลือก | เหตุผลที่ไม่เอา |
|---|---|
| คง `Conversation 1:1 Interaction` แล้วให้ UI ไปรวมประวัติเอง | ทุกหน้าจอและทุกรายงานต้อง reimplement การรวม thread เอง แล้วจะรวมไม่ตรงกัน |
| ยุบ conversation เข้า case | เรื่องหนึ่งเรื่องข้ามช่องทางได้ และห้องหนึ่งห้องมีหลายเรื่อง — คนละแกนกัน |
| สร้าง interaction ใหม่ทุกข้อความที่ลูกค้าพิมพ์ | จำนวนงานเฟ้อ AHT ต่ำหลอกตา และ agent ถูกรบกวนทุกบรรทัด |
| ไม่มี reopen window (ต่อของเดิมเสมอ) | งานที่ปิดไปแล้วสามวันถูกเปิดใหม่ ทำให้ SLA และรายงานย้อนหลังเปลี่ยนตลอดเวลา |
| **เปิด `COMPLETED` กลับมาใช้ซ้ำ** (ฉบับร่างแรกของ ADR นี้เสนอไว้) | เขียนทับ `endedAt` → AHT/SLA/billing ของงานที่ปิดแล้วเปลี่ยนย้อนหลัง · ยิง `interaction.ended` ซ้ำ · ผล QM ที่ publish แล้วผูกกับงานที่ถูกเปิดใหม่ |
| ให้ agent กดปิดห้องได้ | ปิดช่องทางที่ลูกค้าใช้ติดต่อเรา — ความเสียหายที่ลูกค้ารู้ก่อนเรา |

## เอกสารเกี่ยวข้อง

[interaction-data-flow.md](../interaction-data-flow.md) · [ADR-001](001-unified-interaction-model.md) ·
[ADR-016](016-case-management.md) · [ADR-024](024-message-delivery-media.md) · [customer-360.md](../customer-360.md)
