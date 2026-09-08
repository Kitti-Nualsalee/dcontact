# Work Stage Protocol

เอกสารนี้ทำให้ผู้ใช้สั่งเพียง “เดินงานต่อจากสถานะปัจจุบัน” ได้ โดย Agent ตรวจขั้นตอน งานที่กำลังทำ
และระดับโมเดลจากหลักฐานใน GitHub กับ Git เอง ไม่อาศัยความจำจากบทสนทนา

## หลักการ

1. GitHub issue/map เป็นแหล่งจริงของขอบเขตและการตัดสินใจ
2. branch และ pull request เป็นหลักฐานของการลงมือทำและการ review
3. acceptance comment หรือ evidence bundle เป็นหลักฐานของ completion
4. งานหนึ่งขอบเขตมี Stage เดียว หากหลักฐานขัดกันให้ใช้ `STATE_CONFLICT`
5. ใช้โมเดลเก่งกับการตัดสินใจที่เปลี่ยนยาก ใช้โมเดลสมดุลกับ implementation และใช้โมเดลเร็วกับงานเชิงกล
6. วาง roadmap ทุกเฟสที่ความละเอียดต่ำ และทำรายละเอียดแบบ just-in-time เฉพาะเฟสที่กำลังจะเริ่ม

## Status card

ก่อนใช้ tool ครั้งแรก ให้ Agent แจ้งขอบเขต, Stage แบบ provisional จากบริบทที่มี และหลักฐานที่จะตรวจ
จากนั้นใช้ read-only tools เท่าที่จำเป็นเพื่อยืนยัน tracker, Git, PR และ acceptance evidence ก่อน mutation

หลังยืนยันหลักฐานและก่อนแก้ไฟล์หรือ tracker ให้แจ้ง status card นี้:

```text
สถานะ: <STAGE>
ขอบเขต: <ชื่อ map หรือ phase>
งานปัจจุบัน: <ชื่อ issue/PR หรือ “ยังไม่มี”>
โมเดลแนะนำ: <tier และ reasoning>
Next gate: <หลักฐานที่ต้องมีเพื่อไปขั้นถัดไป>
```

ถ้าผู้ใช้เลือกโมเดลที่ต่างจากคำแนะนำ ให้ทำงานต่อได้เมื่อโมเดลนั้นรองรับงาน แต่ต้องแจ้งเฉพาะเมื่อความต่าง
เพิ่มความเสี่ยงต่อผลลัพธ์อย่างมีนัยสำคัญ

## Stage และ model routing

| Stage            | หลักฐานที่ทำให้ Stage นี้เป็นคำตอบเดียว                                                                    | งานที่อนุญาต                                                  | Model tier                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `WAYFINDING`     | map เปิด, ไม่มี child ถูก claim และมี unblocked frontier                                                   | ตั้ง Destination, สร้าง decision tickets, dependency          | `ARCHITECT` `high/xhigh`                                                       |
| `DECISION`       | มี Wayfinder child ถูก claim และ child นั้นเป็น primary artifact                                           | research, grilling, prototype และบันทึกคำตอบ                  | `ARCHITECT` `high/xhigh`; ใช้ tier ต่ำกว่าสำหรับ research เชิงกลได้            |
| `PHASE_SPEC`     | decision blockers ที่จำเป็นปิดครบ แต่ implementation-ready specification ยังไม่ผ่าน                        | สร้าง implementation-ready spec และแตก implementation tickets | `ARCHITECT` `high`                                                             |
| `IMPLEMENTATION` | spec มี `ready-for-agent`, มี implementation branch และยังไม่มี PR ของ branch นั้น                         | เขียนโค้ดและ tests ตาม ticket                                 | `IMPLEMENTER` `medium/high`; `MECHANICAL` สำหรับงานซ้ำรูปแบบ                   |
| `REVIEW`         | มี PR เปิด และ review ยังไม่ clear, มี finding เปิด หรือ required preliminary CI ยังไม่ผ่าน                | review เทียบ spec/ADR, แก้ findings, ตรวจ diff                | `ARCHITECT` `high` สำหรับ review; `IMPLEMENTER` สำหรับ remediation             |
| `ACCEPTANCE`     | มี PR เปิด, review findings ปิดและ preliminary CI ผ่าน แต่ completion/acceptance gate หรือ merge ยังไม่ครบ | รัน integration/release gates และเก็บ evidence                | `IMPLEMENTER` `medium/high`; ใช้ `ARCHITECT` วิเคราะห์ failure ที่ข้าม context |
| `COMPLETE`       | merge เข้า target ที่ถูกต้องและ completion evidence ถูกบันทึกครบ                                           | อัปเดต map และเปิด frontier ถัดไป                             | ไม่ต้องใช้โมเดลเก่ง เว้นแต่ต้องตัดสินใจใหม่                                    |
| `STATE_CONFLICT` | primary artifact มีหลาย `stage:*` label หรือ identity/base/spec/evidence ของ linked artifacts ขัดกันจริง   | ตรวจและคืนแหล่งจริงให้สอดคล้อง                                | `ARCHITECT` `high` หากต้องตัดสินผลกระทบ                                        |

Mapping ปัจจุบันเมื่อโมเดลเหล่านี้มีให้ใช้:

- `ARCHITECT`: `gpt-5.6-sol`
- `IMPLEMENTER`: `gpt-5.6-terra`
- `MECHANICAL`: `gpt-5.6-luna` หรือ `gpt-5.4-mini`

ชื่อโมเดลเป็น mapping ที่เปลี่ยนได้ แต่ความหมายของ tier และ Stage เป็น contract ของ repository

## วิธีตรวจ Stage

ตรวจเฉพาะขอบเขตที่ผู้ใช้สั่ง โดยเรียงหลักฐานดังนี้:

1. หา issue/map จากชื่อที่ผู้ใช้ระบุ หรือจาก branch/PR ปัจจุบัน
2. อ่าน issue body, comments, labels, assignee และ child/dependency state
3. ตรวจ branch, base branch, working tree และ commit ที่เกี่ยวข้อง
4. ตรวจ PR state, review decision และ CI
5. ตรวจ acceptance criteria และ evidence ล่าสุด

ตัดสิน Stage ด้วย precedence ต่อไปนี้และหยุดที่ข้อแรกที่ตรง:

1. หาก primary artifact มีหลาย `stage:*` label หรือ linked identity/base/spec/evidence ขัดกันจริง → `STATE_CONFLICT`
2. หาก merge เข้า target และ completion evidence ครบ → `COMPLETE`
3. หากมี PR เปิดและ review clear แต่ acceptance gate หรือ merge ยังไม่ครบ → `ACCEPTANCE`
4. หากมี PR เปิดแต่ review/required preliminary CI ยังไม่ clear → `REVIEW`
5. หากมี implementation issue/branch แต่ยังไม่มี PR → `IMPLEMENTATION`
6. หาก Wayfinder child ถูก claim → `DECISION`
7. หาก decision blockers ปิดครบและยังไม่มี implementation-ready specification → `PHASE_SPEC`
8. หาก map เปิด, ไม่มี child ถูก claim และมี unblocked frontier → `WAYFINDING`

การที่ map มี frontier พร้อมกับ child ที่ถูก claim หรือ PR มี CI ผ่าน ไม่ใช่ conflict; precedence ข้างต้น
ใช้แยก progression ปกติเหล่านี้ให้เหลือ Stage เดียว

อย่าใช้ open issue ทั้ง repository เพื่อเดา Stage หากมีหลาย effort ทำคู่ขนาน ให้ระบุ map/phase ที่กำลังตอบเสมอ

## Context packet สำหรับ implementation

เพื่อประหยัด token โมเดล implementation ต้องได้รับเฉพาะ:

- ชื่อและ URL ของ implementation issue
- Destination และ Phase Contract ที่เป็น authority
- ADR/`CONTEXT.md` ที่เกี่ยวข้องโดยตรง
- invariants และ out-of-scope
- API/event/error/state contracts
- acceptance criteria และคำสั่งทดสอบ
- stop condition: หากต้องตัดสินใจนอก spec ให้หยุด implementation และเปิด decision gap

อย่าคัดลอก map, ADR หรือ chat history ทั้งหมดลง prompt ให้ลิงก์ไปยังแหล่งจริงและอ่านเฉพาะส่วนที่เกี่ยวข้อง

## การเปลี่ยน Stage

เมื่อเปลี่ยน Stage ให้ทำเป็นชุดเดียว:

1. ตรวจว่า Next gate ของ Stage เดิมผ่านจริง
2. ย้าย `stage:*` label บน primary artifact ให้เหลือหนึ่งค่า
3. อัปเดต `Current work state` ใน Notes ของ map
4. comment หลักฐานหรือเหตุผลของ transition บน issue/PR
5. แจ้ง status card ใหม่แก่ผู้ใช้

การสร้าง branch, เปิด PR, merge หรือปิด issue ไม่ได้แปลว่า Stage ถัดไปผ่านเอง ต้องตรวจ completion boundary
ของขอบเขตนั้นด้วย
