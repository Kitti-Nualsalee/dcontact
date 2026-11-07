# การทำงานแบบหลาย Agent

Lead agent คุยกับผู้ใช้ รับผิดชอบผลรวม และเป็นผู้เขียน tracker เพียงรายเดียวในทีม
ใช้ `work-stage.md` สำหรับขั้นตอนหลัก โดยไม่บังคับจำนวน agent หรือบทบาทครบทุกงาน

## เลือกใช้ให้คุ้ม

- งานสั้น ชัดเจน หรือมีลำดับพึ่งพากัน ให้ Lead ทำเอง
- ใช้ explorer ค้นคำถามเฉพาะเมื่อช่วยลด context ของ Lead
- แบ่ง implementer เมื่อ scope อิสระและไม่เขียนไฟล์ทับกัน เริ่มจาก 1–2 ตัว เพิ่มได้ไม่เกิน 3 ตัวเมื่อคุ้ม
- package เดียวกันทำขนานได้เมื่อแบ่งไฟล์และ contract ชัด หากแตะไฟล์ร่วมให้ทำตามลำดับหรือมีผู้รวมคนเดียว
- ใช้ code reviewer กับความเสี่ยงสำคัญ และ UX/UI specialist เมื่อ flow หรือหน้าจอเปลี่ยนอย่างมีนัยสำคัญ
- Reviewer อ่านอย่างเดียว ใช้ context ใหม่เมื่อเครื่องมือรองรับ ไม่ต้องตั้งทีม review สำหรับการแก้เอกสารเล็กน้อย

บทบาทอ้างอิงอยู่ใน `.claude/agents/` ไม่จำเป็นต้องสร้าง session ใหม่สำหรับทุกบทบาท

## Ownership และทรัพยากร

ก่อนแก้ตรวจงานล่าสุดของผู้ร่วมงาน เมื่อพบงานชนให้ประสานผ่าน Lead และทำส่วนอิสระต่อ
บันทึก branch/ขอบเขตใน issue เมื่อมี handoff หรือหลายคนทำ ไม่ต้อง claim/comment ก่อนทุก mutation

ผู้เขียนโค้ดขนานใช้คนละ branch/worktree โดยใช้ worktree ที่ app จัดการได้
Lead ที่ทำงานคนเดียวใช้ checkout ที่สะอาดและเหมาะสมได้ ไม่ต้องสร้าง worktree ทุก ticket
Agent ที่ถูกมอบหมายแก้เฉพาะ scope ของตนและไม่เปลี่ยน tracker หรือ merge เอง

งาน DB ใช้ฐานแยก เช่น `dcontact_<ticket>` ห้าม migration/integration test บนฐาน `dcontact` ร่วม port 5433
ตั้ง `DATABASE_URL`, `APPLICATION_DATABASE_URL` และ `CXA_ACCEPTANCE_DATABASE_NAME` ให้ชี้ฐานแยก
Migration sequence ทำทีละ PR และ rebase บน main ที่มี migration ล่าสุดก่อนรวม

UAT VM, shared DB และ deploy ใช้ทีละงาน ตรวจ ownership/protected state ล่าสุดและถือ lock ก่อนเปลี่ยน runtime
comment ถือ/คืน UAT lock บน issue และตรวจ state บน VM ไม่ใช้ snapshot เก่าแทน lock
cleanup เฉพาะ worktree/branch/DB ของงานที่จบและไม่มีผู้ใช้งาน ห้ามลบทรัพยากรของ session อื่น

## การส่งงาน

Lead ส่งเป้าหมาย acceptance ขอบเขตไฟล์ และ constraints สั้น ๆ พร้อม environment และคำสั่งตรวจที่เกี่ยวข้อง
Specialist ส่งสิ่งที่เปลี่ยน หลักฐานและ blocker กลับ Lead ไม่ส่งรายงานซ้ำหรือ polling ถี่โดยไม่มีความคืบหน้า
เมื่อขอบเขตคลุมเครือ ให้หยุดเฉพาะส่วนนั้นและเสนอทางเลือกที่ Lead ตัดสินได้
