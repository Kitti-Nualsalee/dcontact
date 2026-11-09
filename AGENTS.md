# แนวทางทำงานสำหรับ Agent

ใช้ Lead agent เป็นเจ้าของงานและเรียก specialist เฉพาะเมื่อช่วยให้งานสำเร็จเร็วขึ้นหรือเพิ่มคุณภาพ
อ่านขั้นตอนใน `docs/agents/work-stage.md` และกติกางานขนานใน `docs/agents/parallel-work.md`

## เริ่มงานและส่งมอบ

- งานเล็กที่ชัดเจนทำจากคำสั่งผู้ใช้ได้เลย; งานที่ต้องติดตามใช้ GitHub issue ตาม `docs/agents/issue-tracker.md`
- ตรวจเฉพาะ issue, PR, Git และเอกสารที่เกี่ยวข้องก่อนแก้ไข แจ้งเป้าหมายและขั้นถัดไปสั้น ๆ
- ไม่บังคับ Wayfinder map, stage label, status card, Phase Contract, mockup หรือ `ready-for-agent` เพื่อเริ่มทุกงาน
- ขอบเขตและ acceptance criteria ที่ owner ยืนยันแล้ว รวม ADR, security, tenant isolation และข้อจำกัด deployment ยังมีผล
- เลือกรายละเอียดที่ย้อนกลับได้เอง ถามเมื่อมีการตัดสินใจผลิตภัณฑ์สำคัญ ข้อกำหนดขัดกัน หรือผลกระทบที่ยังไม่ได้รับอนุญาต
- รัน checks ที่เหมาะกับ diff และรายงานสิ่งที่ส่งมอบ ผลตรวจ และข้อจำกัดตามจริง
- แผนรอบแรกที่ owner ยืนยัน 9 พฤศจิกายน 2569 ใช้ #796 และ backlog #888; ใช้แนวทาง Unit/Integration ตาม `docs/agent-usecase-dev.md` แทนเกต dev trial เดิมที่ยุบแล้ว

## Multi-agent

Lead ทำงานเองเป็นค่าเริ่มต้น แบ่งงานเมื่อมีขอบเขตอิสระและผลลัพธ์ชัดเจน บทบาทอยู่ใน `.claude/agents/`
งาน UI ใช้ `docs/ui-principles.md` เลือก UX/UI specialist ตามขนาดและความเสี่ยง

## Domain docs

ใช้ `CONTEXT-MAP.md` เมื่อมี เพื่ออ่าน `CONTEXT.md` เฉพาะ context ที่เกี่ยวข้อง และ ADR ใน `docs/adr/`
ดู `docs/agents/domain.md` ไม่ต้องอ่านเอกสารทั้ง repo ทุกครั้ง

## ภาษา

ใช้ภาษาไทยสำหรับการสื่อสารและ artifacts ที่คนอ่าน รวม issue, comment, specification, ADR และ handoff
คง code identifiers, API, event, command, product และ technical terms ที่แปลแล้วกำกวมเป็น English
