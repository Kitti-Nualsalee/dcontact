# ADR 001: Unified Interaction Model

- **สถานะ:** Accepted
- **วันที่:** 2026-07-14

## บริบท

D-Contact ต้องรองรับ Voice, Web Chat, Social (LINE/FB/WhatsApp) และ Email
ทางเลือกคือ (ก) แยกระบบ queue/routing ต่อ channel หรือ (ข) ใช้ model กลางเดียว

## การตัดสินใจ

ใช้ **Interaction** เป็น record กลางของงานทุก channel:

- ทุก channel map เป็น `Interaction` (channel, direction, state, queue, agent, contact, timestamps)
- **Router ตัวเดียว** ตัดสินใจ assignment ทุก channel — agent มี concurrency ต่อ channel
  (เช่น voice 1 สาย หรือ webchat 3 ห้อง) แต่ queue/skill/SLA ใช้ logic ชุดเดียวกัน
- ส่วนที่ต่างกันต่อ channel แยกไว้ที่ **channel gateway** (แปลง protocol เข้า/ออก)
  และตาราง `conversations`/`messages` (เนื้อหา chat) กับ `recordings`/CDR (voice)
- ทุก state change เขียนลง `interaction_events` (append-only) — เป็น source of truth
  ของ historical reporting

## ผลที่ตามมา

- (+) Agent Desktop, Supervisor Dashboard, Reporting เขียนครั้งเดียวใช้ได้ทุก channel
- (+) เพิ่ม channel ใหม่ = เขียน gateway ใหม่ ไม่แตะ router/UI หลัก
- (−) voice-specific state (hold, transfer, conference) ต้อง model เพิ่มบน interaction
  โดยไม่ทำให้ channel อื่นซับซ้อนขึ้น — เก็บใน `metadata` + FS events ก่อน แล้วค่อย normalize
