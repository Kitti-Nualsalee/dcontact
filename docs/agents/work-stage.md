# ขั้นตอนทำงานแบบ Lead และ specialist

เอกสารนี้แทน Work Stage Protocol เดิม ชื่อไฟล์คงไว้เพื่อให้ลิงก์จาก issue เก่ายังใช้ได้
ใช้ขั้นตอนนี้แทนข้อบังคับ Wayfinder/stage ใน issue เก่า โดยคงขอบเขตผลิตภัณฑ์ สัญญาข้อมูล
สิทธิ์ ความปลอดภัย acceptance และคำตัดสิน owner ที่ยังมีผล

## ลำดับงาน

1. อ่านคำสั่งและ issue/PR ที่เกี่ยวข้อง ตรวจ branch และ working tree เท่าที่จำเป็น
2. สรุปผลลัพธ์ที่ต้องการและวิธีตรวจ ถ้าชัดแล้วให้ลงมือ ไม่สร้าง spec หรือ decision ticket เพิ่มโดยอัตโนมัติ
3. Lead ทำเองหรือแบ่งงานอิสระตาม `parallel-work.md` พร้อมระบุเจ้าของและขอบเขต
4. ตรวจ diff และรัน checks ที่เกี่ยวข้อง ใช้ reviewer สำหรับ logic สำคัญ security, migration หรือการเปลี่ยนข้าม context
5. ส่งผลพร้อม acceptance ที่ผ่าน/ยังไม่ผ่านและข้อจำกัด อัปเดต issue เมื่อมีผลสำคัญ ไม่ comment ทุกก้าว

ไม่ต้องมี stage label, status card, map synchronization หรือ `ready-for-agent` ก่อนทำงาน
งานเล็กไม่ต้องสร้าง issue ส่วนงานยาวหรือมี handoff ใช้ issue เดียวต่อผลลัพธ์ที่ส่งมอบได้

## การตัดสินใจและโมเดล

Lead เลือกรายละเอียดวิศวกรรมที่ย้อนกลับได้ตาม pattern เดิมและบันทึกเหตุผลสั้น ๆ เมื่อมีผลต่อผู้ตรวจ
ถาม owner เฉพาะเรื่องผลิตภัณฑ์/สิทธิ์/ข้อมูลที่ยังไม่มีคำตอบ หรือข้อกำหนดที่ขัดกันจริง
หยุดเฉพาะส่วนที่ติดปัญหาแล้วทำส่วนอิสระต่อ ไม่เปิด decision gap ticket ทุกครั้ง

ใช้โมเดลสมดุลสำหรับงานทั่วไป โมเดลเร็วสำหรับการค้นข้อเท็จจริง และโมเดล reasoning สูงเฉพาะการตัดสินใจหรือ review ที่เสี่ยง
ไม่ต้องเปลี่ยนโมเดลหรือสร้าง agent เพียงเพราะชื่อขั้นตอนเปลี่ยน

## Context ที่ส่งให้ specialist

ส่งเฉพาะเป้าหมาย/issue, acceptance, ขอบเขตไฟล์, constraints และลิงก์เอกสารที่จำเป็น
เพิ่ม branch/worktree/DB และคำสั่งตรวจเมื่อเกี่ยวข้อง ไม่ส่ง chat history หรือ map ทั้งชุด
ให้รายงานผล หลักฐานที่ตรวจ และข้อที่ติดขัดอย่างกระชับ

## งานเดิม

Wayfinder maps เป็นประวัติ ใช้ implementation issue และ PR เป็นงานปัจจุบัน
Closed map/spec หรือ merged PR ไม่ยืนยันว่า runtime/acceptance ผ่านครบ
ตรวจคำแก้ไขล่าสุดของ owner ก่อนใช้ข้อความเก่า และเมื่อสถานะขัดกันให้ยึดหลักฐานล่าสุดที่ตรงขอบเขต
หากยังตัดสินไม่ได้ ให้รายงานความขัดกันและหยุดเฉพาะ mutation ที่ได้รับผล
ไม่ลบ dependency ที่จำเป็นต่อความถูกต้องเพื่อให้เริ่มงานได้เร็วขึ้น และไม่รัน acceptance เดิมซ้ำโดยไม่มีเหตุจากการเปลี่ยนแปลง

## แผนส่งมอบทีละ Use case — owner ยืนยัน 9 พฤศจิกายน 2569

- งานหลักรอบแรก #796 และ backlog ที่พัก #888 เป็น authority ล่าสุดสำหรับขอบเขต/acceptance ที่แทนแผนเดิม ไม่คืนข้อบังคับใน issue ที่ปิด NOT_PLANNED เป็น gate โดยอัตโนมัติ
- ทำ flow หลักให้ทดลองได้จนบันทึกและอ่านผลก่อนเพิ่ม feature/recovery/abstraction เผื่ออนาคต หนึ่ง issue ต่อ Use case ที่ส่งมอบได้
- Unit test เป็นหลัก ใช้ fake dependencies/clock ตรวจ validation, business rules, UI state และ error mapping เฉพาะส่วนที่แก้
- Integration ตรวจเฉพาะ seams ที่ได้รับผลกระทบ: persistence/transaction/readback, RLS/server authorization, duplicate/stale side effects และ auth/provider จริงเมื่อแก้ boundary นั้น
- ไม่ทดสอบ validation เดิมซ้ำทุกชั้น ไม่สร้าง full role×tenant×state×race matrix หรือ readiness/evidence harness เพิ่มโดยไม่มีความจำเป็นจากงานจริง
- Dev trial ใช้ environment แยกและ browser หลักหนึ่งตัวหนึ่งรอบ ไม่บังคับ VM ซ้ำหรือสองรอบ Chrome/Edge; ขยายเมื่อ browser-specific change หรือ release requirement ต้องใช้
- ไม่ลบ test เดิมเพื่อให้จำนวนลด ไม่ถอด guard ด้านสิทธิ์/ข้อมูล และไม่ถือ fixture UI/API เป็นหลักฐานเสียงจริง
- Migration/deployment/rollback ตรวจตามผลกระทบจริง #868/#879 แยกจาก dev trial; ADR-032/marker ของ acceptance chain เดิมยังมีผลเฉพาะ chain นั้น
- ดูคำสั่งและขอบเขตหลักฐานใน `docs/agent-usecase-dev.md`
