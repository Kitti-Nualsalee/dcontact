# D-Contact Agent Workspace — HTML Prototype

ไฟล์สำหรับเปิดใช้งาน: `../d-contact-agent-workspace.html`

เปิดไฟล์ด้วย browser บน desktop โดยไม่ต้องติดตั้งแพ็กเกจหรือเริ่ม server ไฟล์รวม React, CSS, icons และโลโก้ไว้ภายใน ไม่ต้องใช้เครือข่าย ข้อมูลเปลี่ยนในหน่วยความจำของหน้านี้เท่านั้น เปิดใหม่หรือกดคืนข้อมูลตัวอย่างเพื่อเริ่มใหม่

## ทดลองใช้งาน

1. เลือก Interaction จากแผงซ้าย หรือกรอง Channel มี Voice, Video, LINE, Facebook, Instagram, WhatsApp, Web Chat, Email และ SMS
2. Customer 360 แสดงลูกค้าของรายการที่เลือกพร้อมประวัติ 2 รายการ ใช้ Edit เพื่อแก้ข้อมูลลูกค้า การเปลี่ยนชื่อจะสะท้อนในเมนูรายการและหน้ารายชื่อลูกค้า
3. ใช้ View / Edit / Delete ในประวัติหรือหน้า Interactions การลบคืนค่าได้จาก Undo ในแจ้งเตือน
4. แท็บ Voice / Conversation แสดงข้อความที่สัมพันธ์กับรายการ ส่งข้อความจำลองแล้วข้อความและ Events จะเพิ่มให้รายการนั้น
5. Voice/Video มีรับสายสำหรับรายการ Ringing และ Mute, Hold, Transfer, Keypad, Hang up สำหรับรายการที่รับสายแล้ว ไม่มีการเปิดไมโครโฟน กล้อง หรือโทรจริง
6. Notes มี Disposition และบันทึกร่าง วางสายก่อนปิด Voice/Video; เลือก Disposition ก่อนปิดงาน
7. AI ผู้ช่วยใช้ข้อมูลของ Interaction ที่เลือก ร่างข้อความ/สรุปและแทรกในบันทึกหรือช่องตอบกลับโดยไม่ส่งให้อัตโนมัติ เป็นการจำลองไม่เชื่อม AI จริง
8. ลากเส้นแบ่งแผงหรือใช้ปุ่มลูกศรเมื่อ focus บน separator ดับเบิลคลิกคืนความกว้าง เมนูซ้ายย่อเป็น icon และ utility rail ขวามีปุ่มขยาย label; แผงรายละเอียดปิด/เปิดได้
9. Agent status อยู่ข้าง User Profile มุมขวาบน; โมดูลเพิ่มเติมแสดงเป็น icons โดยยังไม่ทำรายละเอียด

## ข้อจำกัดการตรวจ

Build และ server-side React render ผ่าน พร้อมตรวจความสัมพันธ์ของตัวอย่าง 27 Interactions และลูกค้า 9 คน แต่ยังไม่ได้ทดสอบการคลิกหรือ visual QA ใน browser เนื่องจาก environment ไม่อนุญาต local server และ browser ไม่เปิด file:// ดู `design-qa.md`

## สร้างไฟล์ซ้ำ

`node node_modules/vite/bin/vite.js build` แล้ว `node scripts/export-html.mjs`

`node scripts/verify-prototype.mjs` ตรวจข้อมูลและ initial render

สภาพแวดล้อมปัจจุบันใช้แพ็กเกจ React/Vite/Lucide ที่มีในเครื่องผ่าน symlink เนื่องจาก registry เข้าไม่ได้ ไฟล์ HTML ที่ส่งมอบรวมแพ็กเกจแล้วและไม่ใช้ symlink เหล่านี้
