# ADR 037: Workspace ควบคุม external softphone และเริ่มจาก control simulator

- สถานะ: Accepted — ทิศทางผลิตภัณฑ์ยืนยัน 10 พฤศจิกายน 2569; connector ของ softphone จริงยังไม่ได้เลือก
- ที่มา: owner เลือกใช้ใน Workspace จริง และเริ่มตัวจำลองก่อนใน #796

Workspace เป็นหน้าควบคุมและแสดงข้อมูลงาน ส่วน external softphone เป็นผู้ถือเสียงและการเชื่อมต่อสาย เพื่อลดการผูกอายุ media กับหน้า Workspace. ข้อนี้เพิ่มทางเลือกให้ ADR-026 โดยไม่ย้าย session/lease ของ embedded owner เดิมหรือเปลี่ยน ownership ของ tenant ที่ยังใช้ browser phone

รอบแรกส่งมอบ `external-simulator` เป็น build-time opt-in ใน Workspace ที่ผ่าน auth/scope เดิม มีเพียงเริ่มตัวจำลอง สายเข้า รับสาย และจบสาย สถานะอยู่ใน memory และแยกจาก SIP, Interaction, routing, customer, wrap-up และ history ของ server ทั้งหมด ห้ามจำลอง AVAILABLE/ACTIVE/WRAPUP บน server หรือขอ SIP credentials/ไมค์จาก browser ในโหมดนี้ การมีงานจริงหรือเสียสิทธิ์ควบคุมให้พักและล้างสถานะจำลอง

ยังไม่เลือก desktop app/Chrome extension, protocol, credential exchange หรือการรับรองเสียงจริง. เมื่อเลือก target จึงต่อ connector ตามความสามารถจริงและตรวจ command/event/session ownership ก่อนเปิดรับงานจริง โหมด browser/embedded เดิมคงทำงานตาม ADR-026; simulator ไม่ใช่หลักฐานว่า external softphone พร้อมใช้งานจริง
