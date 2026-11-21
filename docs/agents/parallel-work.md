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

## สายงาน — owner ยืนยัน 21 พฤศจิกายน 2569

สายงานคือ session ของ Lead หนึ่งตัวที่ถือแผน แบ่งไฟล์ รวมงาน และรวมคำถามถึง owner เป็นชุดเดียวท้ายงาน
งานขนานในสายงานเดียวกันใช้ subagent ของ Lead ไม่เปิด session อิสระเพิ่มสำหรับงานที่ต้องรวมกัน

- เปิดพร้อมกันไม่เกินสองสายงาน แยกตามแอป เช่น Workspace/Voice กับ Console/Cus360/API
- ไม่เปิดสองสายงานในแอปเดียวกัน งานที่ต้องแก้สองแอปให้อยู่ในสายงานเดียวและทำตามลำดับ
- สายงานที่เขียนโค้ดเริ่มใน worktree ของตัวเอง checkout หลักไม่ใช้เขียนเมื่อมีสายงานอื่นเปิดอยู่
- เมื่อเริ่ม ให้ตรวจ branch `integration/*` และ PR ที่เปิดอยู่ เพื่อรู้ว่าอีกสายงานถือแอปไหน

### ไฟล์ร่วม

ไฟล์ที่เกือบทุกงานต้องแตะมีผู้แก้คนเดียวต่อสายงานคือ Lead และแก้ตามลำดับ ไม่แบ่งให้ implementer:
`apps/workspace/src/workspace-app.tsx`, `apps/workspace/src/agent-workspace.css`, `apps/api/src/main.ts`,
`apps/api/src/navigation-registry.ts`, `package.json`/lockfile และ Prisma schema

i18n catalog (`apps/*/src/i18n/locales/`) ให้ implementer เพิ่ม key ใหม่ได้ แต่ไม่จัดเรียงหรือแก้ key เดิม
Lead แก้ conflict ของ catalog ตอนรวม หาก implementer ต้องแก้ไฟล์ร่วมอื่น ให้ส่งสิ่งที่ต้องเพิ่มกลับให้ Lead

### Dev stack

- Docker infra `d-contact-dev` มีชุดเดียวและใช้ร่วมกัน แยกข้อมูลด้วยชื่อฐานตามหัวข้อถัดไป
- Stack จริงทั้งเส้น (API 3000, Workspace 5173, Keycloak และ Voice) มีช่องเดียว เพราะ realm dev รับ redirect
  เฉพาะ `http://localhost:5173` ใช้ทีละสายงาน ตรวจว่าพอร์ตว่างหรือเสิร์ฟจาก checkout ไหนก่อนเปิด
  และไม่ปิด process ของสายงานอื่น
- สายงานที่ไม่ได้ถือ stack จริงตรวจด้วย Unit, Integration บนฐานแยก และ Playwright fixture
  ซึ่งใช้พอร์ตตายตัวต่อแอป (Workspace 4173/4185, Console 5174/5188)
- Playwright ของ Workspace บนพอร์ต 4173 ใช้ server ที่เปิดค้างอยู่เมื่อรันนอก CI
  ให้ตรวจว่า server นั้นมาจาก checkout ของตัวเองก่อนเชื่อผล

### Integration branch

- งานที่มีมากกว่าหนึ่ง PR: Lead สร้าง `integration/<สายงาน>` จาก main ตั้งเป็น base ของ PR ย่อย
  และ merge PR ย่อยเองเมื่อ checks ตามชนิดของ diff ใน `work-stage.md` ผ่าน
- Lead เป็นผู้เดียวที่ดึง main เข้า integration branch และทำเมื่ออีกสายงานเข้า main แล้ว
- ส่งเข้า main เมื่อจบหนึ่ง Use case ที่ทดลองได้ ไม่สะสมหลาย Use case ใน integration branch เดียว
- ก่อนส่ง: รันชุดเต็มหนึ่งครั้ง ใช้ reviewer ตามความเสี่ยงหนึ่งครั้งบน branch ที่รวมแล้ว
  แล้วเปิด PR เดียวเข้า main พร้อมสมมติฐานที่เลือกแทน owner และคำถามค้าง
- งาน PR เดียวไม่ต้องมี integration branch ส่วน merge เข้า main, UAT และฐานร่วมยังรอ owner เหมือนเดิม

## Ownership และทรัพยากร

ก่อนแก้ตรวจงานล่าสุดของผู้ร่วมงาน เมื่อพบงานชนให้ประสานผ่าน Lead และทำส่วนอิสระต่อ
บันทึก branch/ขอบเขตใน issue เมื่อมี handoff หรือหลายคนทำ ไม่ต้อง claim/comment ก่อนทุก mutation

ผู้เขียนโค้ดขนานใช้คนละ branch/worktree โดยใช้ worktree ที่ app จัดการได้
Lead ที่ทำงานคนเดียวโดยไม่มีสายงานอื่นเปิดอยู่ใช้ checkout ที่สะอาดและเหมาะสมได้ ไม่ต้องสร้าง worktree ทุก ticket
ลบ worktree ของตัวเองเมื่อ branch เข้า main แล้ว ไม่ทิ้งไว้ให้สายงานถัดไปต้องเดาว่ายังใช้อยู่หรือไม่
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
