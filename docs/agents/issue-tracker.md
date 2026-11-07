# Issue tracker: GitHub

ใช้ `gh` CLI สำหรับ GitHub ของ repo นี้ GitHub issue เป็นที่ติดตามเป้าหมายและการตัดสินใจ ส่วน PR เป็นหลักฐานการเปลี่ยนโค้ด

## ขนาดของงาน

งานเล็กทำจากคำสั่งผู้ใช้ได้โดยไม่ต้องเปิด issue งานยาว มี dependency หรือ handoff ใช้หนึ่ง issue ต่อผลลัพธ์ที่ส่งมอบได้
body ระบุเป้าหมาย ขอบเขต เงื่อนไขเสร็จ และข้อจำกัด/dependency ที่จำเป็น แตก child เฉพาะงานที่แยกส่งมอบได้จริง
ไม่สร้าง research/prototype/grilling tickets หรือ Phase Contract โดยอัตโนมัติ

## การใช้งาน

- อ่านงาน: `gh issue view <n> --comments` และตรวจ PR/labels ที่เกี่ยวข้องเท่าที่จำเป็น
- สร้าง/แก้ body หรือ comment หลายบรรทัด: เขียนไฟล์ UTF-8 แล้วส่ง `--body-file <path>`
- ปิด issue เมื่อเงื่อนไขเสร็จผ่านจริง ถ้ายกเลิกใช้ `gh issue close <n> --reason 'not planned'` พร้อมเหตุผลและลิงก์งานที่ไปต่อ
- ให้ Lead เป็นผู้เขียน tracker รายเดียวในทีม อัปเดตเมื่อมี decision, blocker, handoff หรือผลส่งมอบสำคัญ
- คง native dependency ที่จำเป็นต่อความถูกต้อง ตรวจ gate จริงก่อนเริ่มส่วนที่ต้องพึ่ง ไม่ถือ closed issue แทน acceptance โดยอัตโนมัติ

## Wayfinder เดิม

เลิกสร้าง map และไม่ต้อง claim frontier, เปลี่ยน stage label หรือ sync Current work state
`wayfinder:*`, `stage:*` และ `ready-for-agent` ที่เหลือเป็น metadata เดิม ไม่ใช่ gate ของกระบวนการใหม่
ข้อกำหนดผลิตภัณฑ์ API/data/security และ acceptance ที่ owner ยืนยันแล้วยังใช้จนมีคำแก้ไขที่ชัดเจน
เก็บ map และ decision ที่ปิดไว้เป็นหลักฐาน อ้างลิงก์เฉพาะส่วนที่จำเป็นจาก issue งานได้ ไม่คัดลอก map ทั้งชุด
การปิด map เพื่อเปลี่ยนกระบวนการไม่ปิด child issue ไม่ลบ dependency และไม่รับรอง runtime
