# ผลตรวจ HTML prototype

final result: blocked

- ภาพอ้างอิง: ../generated_images/exec-c3e23419-4365-4082-9919-2b2bdc18ab96.png (ภาพปรับปรุงจากตัวเลือก 1)
- Viewport เป้าหมาย: desktop 1600 × 1000; รองรับจอเริ่มที่ 1080px ผ่าน horizontal viewport
- ยังไม่มี implementation screenshot หรือการเปรียบเทียบภาพ เพราะไม่สามารถเปิด browser preview ได้
- การเริ่ม local server ถูกปฏิเสธด้วย EPERM; browser policy ไม่อนุญาต file:// จึงหยุดการตรวจ browser
- Build ผ่าน และ render React ฝั่ง server ผ่าน
- ตรวจข้อมูลจำลอง: 9 ลูกค้า, 9 Channels, 27 Interactions, foreign-key ของลูกค้า, ID ไม่ซ้ำ, messages และ events ครบ, ประวัติ 2 รายการต่อคน
- ยังไม่ได้ยืนยันด้วย browser: view/edit/delete/undo, การส่งข้อความ, เปลี่ยน Channel, รับสาย/วางสาย, split drag/keyboard, เมนูยุบขยาย, AI ตามบริบท
- Fonts: ใช้ Inter / Noto Sans Thai ถ้ามีในเครื่อง และ system sans-serif fallback; ไฟล์ HTML ไม่จำเป็นต้องเรียกเครือข่าย
- Layout: คงเมนูซ้าย, รายการ Interaction, phone bar ด้านบน, Customer 360 กลาง, Notes/Details/Events/AI ด้านขวา และ utility rail
- Colors: ใช้ tokens ของ packages/ui ที่คัดลอกไว้ใน prototype
- Assets: ใช้โลโก้เดิมของโครงการและไอคอนจาก Lucide ที่มีในเครื่อง; ไม่สร้างไอคอนเอง
- Copy: ตัวอย่างภาษาไทย ข้อมูลจำลองและเบอร์ถูก mask; โทรศัพท์/ส่งข้อความ/AI เป็นการจำลอง
- ไม่อ้างว่าผ่าน visual QA หรือ browser interaction tests

## แก้ไขหลังพบ UI พัง

- สาเหตุ: export เดิมใช้ regex ตัด @import ถึง semicolon แรก แต่ URL ฟอนต์มี semicolon ภายใน ทำให้ selector :root เสียและ design tokens ไม่ทำงาน
- แก้: ใช้ PostCSS parse ลบเฉพาะ import node และตรวจว่าตัวแปรหลักอยู่ใน :root ที่ถูกต้องก่อนเขียน HTML
- เพิ่ม scripts/verify-html.mjs ตรวจ CSS จากไฟล์ส่งมอบจริงและกรณี URL ฟอนต์มี semicolon
- ส่งไฟล์ v2 เพื่อแยกจากไฟล์เก่า; browser verification ยัง blocked ตามข้อจำกัดเดิม
