# ADR 037: Workspace ควบคุม external softphone และเริ่มจาก control simulator

- สถานะ: Accepted — ทิศทางผลิตภัณฑ์ยืนยัน 10 พฤศจิกายน 2569; เลือก Chrome extension ชื่อ D-Phone สำหรับตัวแรก
- ที่มา: owner เลือกใช้ใน Workspace จริง และเริ่มตัวจำลองก่อนใน #796

Workspace เป็นหน้าควบคุมและแสดงข้อมูลงาน ส่วน external softphone เป็นผู้ถือเสียงและการเชื่อมต่อสาย เพื่อลดการผูกอายุ media กับหน้า Workspace. ข้อนี้เพิ่มทางเลือกให้ ADR-026 โดยไม่ย้าย session/lease ของ embedded owner เดิมหรือเปลี่ยน ownership ของ tenant ที่ยังใช้ browser phone

รอบแรกส่งมอบ `external-simulator` เป็น build-time opt-in ใน Workspace ที่ผ่าน auth/scope เดิม มีเพียงเริ่มตัวจำลอง สายเข้า รับสาย และจบสาย สถานะอยู่ใน memory และแยกจาก SIP, Interaction, routing, customer, wrap-up และ history ของ server ทั้งหมด ห้ามจำลอง AVAILABLE/ACTIVE/WRAPUP บน server หรือขอ SIP credentials/ไมค์จาก browser ในโหมดนี้ การมีงานจริงหรือเสียสิทธิ์ควบคุมให้พักและล้างสถานะจำลอง

D-Phone ใช้แท็บของ Chrome extension ถือ WebRTC/SIP และแสดงความพร้อมของไมค์ Workspace เปิดช่องควบคุมไปยัง extension ID ที่กำหนดไว้ ตัวรับตรวจ origin แบบตรงทั้งหมด รับเฉพาะแท็บหลัก และให้หนึ่งแท็บถือการควบคุมต่อครั้ง ผู้ใช้อนุญาตไมค์จาก D-Phone ก่อนเริ่มเชื่อมต่อ

Workspace ขอ SIP credentials ด้วย Work Session Lease เดิมและส่งผ่าน Chrome Port ไปยัง D-Phone เพื่อเริ่ม session ในหน่วยความจำ คำสั่งรอบแรกมีรับสายและวางสาย Router/API เป็นผู้ยืนยัน Interaction และ WRAPUP การรับสายหรือวางสายผ่าน UI ไม่เขียนสถานะงานแทน Router เมื่อช่องควบคุมปิด D-Phone ถอนการลงทะเบียน SIP และคืนสิทธิ์หลัง cleanup

ใช้ Chrome extension ผ่าน `VITE_SOFTPHONE_CONTROL=chrome-extension` ตามคู่มือ dev ส่วน browser และ embedded ยังใช้ค่าตาม ADR-026 ตัวจำลองใช้ตรวจ UI และการรับรองเสียงใช้การทดสอบสายจริงแยกกัน
