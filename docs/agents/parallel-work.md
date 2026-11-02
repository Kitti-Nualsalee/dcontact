# การทำงานแบบหลาย Agent

เอกสารนี้กำหนดบทบาทและกติกาเมื่อใช้ agent หลายตัวทำงานพร้อมกัน ต่อยอดจาก
[`work-stage.md`](work-stage.md) ซึ่งยังเป็นแหล่งจริงของ Stage, model tier และ context packet

## หลักการ

1. เพิ่ม agent เมื่องานแยกกันได้จริง ไม่ใช่เพื่อให้ดูเร็ว ตัวจำกัดความเร็วจริงคือเวลา review ของเจ้าของงาน
2. tracker มีผู้เขียนคนเดียว คือ Orchestrator
3. agent ที่เขียนโค้ดหนึ่งตัวต่อหนึ่ง ticket ต่อหนึ่ง worktree ต่อหนึ่ง DB
4. reviewer เริ่มจาก context ใหม่และอ่านอย่างเดียวเสมอ
5. ทรัพยากรร่วม (UAT VM, shared DB, migration sequence) ใช้ได้ทีละงาน

## Stage ไหนทำคู่ขนานได้

| Stage            | คู่ขนาน      | วิธี                                                                            |
| ---------------- | ------------ | ------------------------------------------------------------------------------- |
| `WAYFINDING`     | ไม่          | Orchestrator ทำกับเจ้าของงานโดยตรง                                              |
| `DECISION`       | บางส่วน      | ส่ง `repo-explorer` หลายตัว research คนละหัวข้อได้ แต่ grilling ถามทีละข้อในแชท |
| `PHASE_SPEC`     | บางส่วน      | `ux-designer` ร่าง UX ของงานที่มีหน้าจอ ส่วน spec มีผู้เขียนคนเดียว             |
| `IMPLEMENTATION` | ได้          | `implementer` หนึ่ง session ต่อ ticket ที่ไฟล์ไม่ทับกัน                         |
| `REVIEW`         | ได้          | `code-reviewer` และ `ui-reviewer` (ถ้ามีหน้าจอ) ต่อ PR                          |
| `ACCEPTANCE`     | ไม่ (บน UAT) | ต้องถือ UAT lock                                                                |

## บทบาท

ไฟล์ agent อยู่ที่ `.claude/agents/`

| บทบาท         | ไฟล์               | Tier          | เขียนได้               | หน้าที่                                                        |
| ------------- | ------------------ | ------------- | ---------------------- | -------------------------------------------------------------- |
| Orchestrator  | session หลัก       | `ARCHITECT`   | tracker, spec          | ตัดสิน Stage, แตก ticket, สร้าง context packet, รวมผล          |
| Implementer   | `implementer.md`   | `IMPLEMENTER` | โค้ดใน worktree ตัวเอง | เขียนโค้ดและ tests ตาม ticket แล้วเปิด PR                      |
| Code reviewer | `code-reviewer.md` | `ARCHITECT`   | ไม่มี                  | review diff เทียบ spec, ADR, `CONTEXT.md`                      |
| Repo explorer | `repo-explorer.md` | `MECHANICAL`  | ไม่มี                  | ค้นโค้ด, สรุป ADR, หา precedent                                |
| UX designer   | `ux-designer.md`   | `ARCHITECT`   | mockup, ร่าง UX spec   | flow, state ครบ, mockup ก่อนเขียนโค้ด                          |
| UI reviewer   | `ui-reviewer.md`   | `IMPLEMENTER` | ไม่มี                  | เปิดหน้าจอจริง ถ่าย screenshot ตรวจตาม `docs/ui-principles.md` |

subagent คุยกับเจ้าของงานโดยตรงไม่ได้ คำถามที่ต้องให้คนตัดสินจะถูกส่งกลับมาที่ Orchestrator
แล้ว Orchestrator ถามทีละข้อในแชท

## กติกา

### Claim และ ownership

- ก่อนเริ่ม implementation ให้ Orchestrator assign issue และ comment ว่า ticket นี้อยู่ที่ branch/worktree ไหน
- ตรวจ comment, label และ state ล่าสุดก่อน mutation ทุกครั้ง เพราะอาจมี agent นอก Claude (เช่น Codex)
  ทำ issue เดียวกันอยู่ ถ้าเจอกิจกรรมที่ไม่ใช่ของ session นี้ ให้หยุดและถามเจ้าของงาน
- `implementer`, `code-reviewer`, `ui-reviewer` ห้ามแก้ label, assignee หรือปิด issue

### ไฟล์และ migration

- ticket สองใบที่แตะ package เดียวกันให้ทำต่อกัน ไม่ทำคู่ขนาน
- งานที่ต้องพึ่ง slice ก่อนหน้า (เช่น S1 → S5 ของ #791) ทำตามลำดับเสมอ
- `packages/db` migration ทำได้ทีละ PR; PR ถัดไปต้อง rebase บน main ที่มี migration ล่าสุดก่อน merge

### Worktree และฐานข้อมูล

- ชื่อ worktree: `D-Contact-<ticket>` หรือ worktree ที่ app สร้างให้ ชื่อ branch ตาม convention ของ repo
- ห้ามรัน migration หรือ integration test บน `dcontact` ร่วม (port 5433) ให้สร้าง DB แยก:

  ```bash
  docker exec d-contact-dev-postgres-1 createdb -U dcontact dcontact_<ticket>
  ```

  migrate ถึง main head ก่อน แล้วค่อย apply migration ใหม่ และตั้ง `DATABASE_URL`,
  `APPLICATION_DATABASE_URL` และ `CXA_ACCEPTANCE_DATABASE_NAME`

### UAT lock

- ก่อนแตะ UAT VM ให้ comment บน issue ว่า "ถือ UAT lock: <VM> โดย <session>" และตรวจไฟล์ state บน VM
- ปล่อย lock ด้วย comment เมื่อเสร็จหรือหยุดงาน

### จำนวนที่รันพร้อมกัน

- implementer พร้อมกันไม่เกิน 3 ตัว
- reviewer และ explorer ไม่จำกัด เพราะอ่านอย่างเดียว

### เก็บกวาด

หลัง PR merge ให้ลบ worktree, branch local และ DB `dcontact_<ticket>` ของ ticket นั้น

```bash
git worktree remove <path>
```

```bash
docker exec d-contact-dev-postgres-1 dropdb -U dcontact dcontact_<ticket>
```

## ลำดับงานมาตรฐาน

```
Orchestrator: ตัดสิน Stage → status card
      │
      ├─ (มีหน้าจอ) ux-designer → flow + states + mockup → Orchestrator ถามเจ้าของงานทีละข้อ → spec
      │
      ├─ implementer × N (worktree + DB ของตัวเอง) → PR
      │
      ├─ code-reviewer ต่อ PR ─┐
      ├─ ui-reviewer ต่อ PR ──┴→ findings → implementer แก้
      │
      └─ เจ้าของงานอนุมัติ → ACCEPTANCE (UAT lock) → merge → เก็บกวาด
```

## Context packet ที่ส่งให้ agent

ใช้รายการใน `work-stage.md` หัวข้อ "Context packet สำหรับ implementation" และเพิ่ม:

- path ของ worktree และชื่อ DB ที่ใช้
- รายการไฟล์หรือ package ที่อนุญาตให้แตะ
- (งานมีหน้าจอ) mockup, รายการ state และหน้าที่ต้อง screenshot
