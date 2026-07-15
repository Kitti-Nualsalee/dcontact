# ADR 002: คุม call routing เองผ่าน ESL แทน mod_callcenter

- **สถานะ:** Accepted
- **วันที่:** 2026-07-14

## บริบท

FreeSWITCH มี `mod_callcenter` ให้ ACD queue สำเร็จรูป (agent, tier, strategy)
ใช้แล้วได้ voice queue เร็ว แต่ logic ทั้งหมดจะติดอยู่ใน FreeSWITCH

## การตัดสินใจ

**ไม่ใช้ mod_callcenter** — inbound call จะถูก `park` ไว้ แล้ว **router service ของเรา
ตัดสินใจเอง** (สั่ง bridge/transfer ผ่าน ESL) เพราะ:

1. ADR 001 ต้องการ router ตัวเดียวสำหรับทุก channel — mod_callcenter ทำได้แค่ voice
   ถ้าใช้จะเกิด queue สองระบบ (voice ใน FS, ช่องทางอื่นใน Node) ที่ต้อง sync agent state กัน
2. Multi-tenant config ของ mod_callcenter จัดการยาก (XML ต่อ queue ต่อ tenant)
3. Routing strategy ที่ซับซ้อน (skill-based, SLA-priority, concurrency ข้าม channel)
   เขียนใน TypeScript ทดสอบง่ายกว่า dialplan/Lua มาก

## ผลที่ตามมา

- (−) ต้องเขียนเองมากขึ้นใน Phase 1: reserve agent, timeout/requeue, MOH ระหว่างรอ
- (−) router กลายเป็น critical path — ถ้า router ตาย สายค้างที่ park
  → ต้องมี fallback dialplan (เช่น requeue/voicemail เมื่อไม่มีคำสั่งภายใน N วินาที)
- (+) FreeSWITCH เป็น media layer ล้วน ๆ เปลี่ยน/สเกล/ทดแทนได้ง่าย
- (+) queue state ทั้งหมดอยู่ใน Redis/Postgres ที่เดียว — dashboard และ reporting ตรงไปตรงมา
