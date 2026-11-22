# การประเมินคุณภาพโดยคน (#971)

Admin สร้างฟอร์มประเมินและ publish เวอร์ชัน → Supervisor ให้คะแนนสายที่ทีมตัวเองรับ บันทึกร่างแล้ว publish → Agent เห็นคะแนนและคำตอบรายข้อของสายตัวเอง

เป็นส่วน "ให้คะแนนมือ + หน้าคะแนนของ agent" ของเฟส Q2 ใน [quality-management.md](quality-management.md) ตาม [ADR-010](adr/010-quality-management.md) ข้อ 9 (ฟอร์มมีเวอร์ชันและ snapshot) ต่อจาก [voice-recording-supervisor-playback.md](voice-recording-supervisor-playback.md) (#967)

## เปิดใช้

ตั้ง `QM_HUMAN_EVALUATION=on` ที่ API ค่าเริ่มต้นปิด: route ใหม่ตอบ `403 FEATURE_DISABLED` และเมนูไม่แสดง ค่าที่ไม่ใช่ `on`/`off` ทำให้ API ไม่ start route QM เดิม (transcript, auto-QM draft) ไม่ขึ้นกับสวิตช์นี้

ต้อง apply migration `20261122130000_qm_human_evaluation` และ `pnpm db:rls` ก่อนเปิด

## สิทธิ์

| ผู้ใช้ | ทำอะไรได้ |
|---|---|
| Admin (role `ADMIN` ใน DB และ active) | สร้างฟอร์ม แก้ร่าง publish ออกเวอร์ชันใหม่ อ่านทุกเวอร์ชัน |
| Supervisor (role `SUPERVISOR` ใน DB, active, มีทีม) | อ่านฟอร์มที่ใช้อยู่ ประเมินสายที่จบแล้วซึ่งทีมปัจจุบันของตนรับจริง ยกเว้นสายที่ตนรับเอง |
| Agent (active) | อ่านผลที่ publish แล้วของตัวเองเท่านั้น |

- role ใน token เป็นด่านแรก บทบาท สถานะ และทีมปัจจุบันอ่านจาก DB ทุก request ย้ายทีมหรือปิดบัญชีแล้วเสียสิทธิ์ทันที
- ทีมที่รับสายมาจาก `voice_interaction_handling_attributions` ที่ Router เขียนตอนรับสาย (#967) สายที่ไม่มีหลักฐานประเมินไม่ได้
- ของทีมอื่น tenant อื่น และที่ไม่มี ตอบ `404 RESOURCE_NOT_FOUND` เหมือนกัน
- Supervisor ทุกคนในทีมเดียวกันแก้ร่างเดียวกันได้ ผู้ประเมิน (`evaluatorId`) คือคนที่บันทึกหรือ publish ล่าสุด

## ฟอร์มและสูตรคะแนน

คำถามรอบนี้: `YES_NO`, `SCALE` (ช่วงจำนวนเต็ม 0–10) และ `TEXT` (ไม่คิดคะแนน) พร้อม `allowNa` และ `autoFail` (เฉพาะ `YES_NO`) คิดแบบ `WEIGHTED_POINTS` ตาม §8 ของ quality-management.md

```
score_section = Σ(คะแนนที่ได้) / Σ(คะแนนเต็มของข้อที่ไม่ใช่ N/A)
raw_score     = Σ(score_section × weight) / Σ(weight ของ section ที่มีข้อให้คะแนน) × 100
final_score   = autoFailed ? 0 : raw_score
SCALE         = points × (ค่า − ต่ำสุด) / (สูงสุด − ต่ำสุด)
```

- N/A ออกจากตัวหาร section ที่ไม่มีข้อให้คะแนนเหลือออกจากตัวหารของ weight
- `requireCommentBelow` (1–100): คะแนนสุดท้ายต่ำกว่าค่านี้ต้องมีความเห็นก่อน publish
- server คำนวณคะแนนเอง client ส่งเฉพาะคำตอบ เก็บเป็นร้อยละสองตำแหน่ง
- เวอร์ชันที่ publish แล้วแก้ไม่ได้ (trigger `QM_FORM_VERSION_IMMUTABLE`) แก้ = ออกร่างเวอร์ชันใหม่ เวอร์ชันเดิมเป็น `SUPERSEDED`
- ผลประเมินเก็บ `form_snapshot` (ชื่อฟอร์ม เวอร์ชัน definition) จึงอ่านย้อนหลังได้แม้ฟอร์มเปลี่ยนชื่อหรือเวอร์ชัน
- ผลประเมินที่ publish แล้วแก้และลบไม่ได้ (trigger `QM_EVALUATION_IMMUTABLE`) จนกว่าจะมี appeal

## Endpoint (`/api/v1/qm`)

| Method | Path | ผู้ใช้ | หมายเหตุ |
|---|---|---|---|
| GET | `/forms` | Admin, Supervisor | Supervisor เห็นเฉพาะฟอร์มที่มีเวอร์ชันใช้อยู่ |
| POST | `/forms` | Admin | `{commandId, name, definition?}` สร้างฟอร์มพร้อมร่างเวอร์ชัน 1 |
| GET | `/forms/:formId` | Admin | ทุกเวอร์ชัน ร่าง และเวอร์ชันที่ใช้อยู่ |
| PUT | `/forms/:formId/draft` | Admin | `{revision, definition, name?}` |
| POST | `/forms/:formId/draft` | Admin | `{commandId}` ออกร่างใหม่จากเวอร์ชันที่ใช้อยู่ |
| POST | `/forms/:formId/draft/publish` | Admin | `{commandId, revision}` |
| GET | `/form-versions/:versionId` | Admin, Supervisor | Supervisor อ่านได้เฉพาะเวอร์ชันที่ใช้อยู่ |
| GET | `/team-interactions` | Supervisor | `from`, `to` (ไม่เกิน 90 วัน ค่าเริ่มต้น 30), `status` = `NOT_EVALUATED`/`DRAFT`/`PUBLISHED`, `limit`, `cursor` |
| GET | `/interactions/:id/human-evaluation` | Supervisor | สายพร้อมผลประเมิน (หรือ `null`) |
| PUT | `/interactions/:id/human-evaluation` | Supervisor | `{commandId, formVersionId, answers, comment?, revision?}` สร้าง/แก้ร่าง ตอบไม่ครบได้ |
| POST | `/interactions/:id/human-evaluation/publish` | Supervisor | `{commandId, revision}` |
| GET | `/my-evaluations` | Agent | ผลที่ publish แล้วของตัวเอง เรียงล่าสุดก่อน |
| GET | `/my-evaluations/:evaluationId` | Agent | คำตอบรายข้อ ความเห็น และฟอร์มจาก snapshot |

`answers` เป็น `{ [questionId]: { value } | { na: true } }` ร่างที่ตอบครบทุกข้อที่ให้คะแนนแสดงคะแนนตัวอย่าง (`score.preview = true`)

ข้อผิดพลาดที่ผู้ใช้ทำต่อได้: `422 VALIDATION_FAILED` พร้อม `errors[{path, code}]` (เช่น `REQUIRED`, `COMMENT_REQUIRED`, `EMPTY_FORM`), `409 STALE_REVISION` (มีคนแก้ก่อน ให้โหลดใหม่), `409 EVALUATION_PUBLISHED`, `409 FORM_VERSION_NOT_AVAILABLE` (เริ่มร่างใหม่ต้องใช้เวอร์ชันปัจจุบัน ร่างเดิมใช้เวอร์ชันเดิมต่อได้), `409 FORM_NAME_TAKEN`, `409 DRAFT_EXISTS`, `403 SELF_EVALUATION_NOT_ALLOWED`

คำสั่งที่มี `commandId` ใช้ `command_receipts`: ส่งซ้ำด้วย payload เดิมได้ผลเดิม payload ต่างได้ `409 COMMAND_PAYLOAD_MISMATCH`

## Audit

`qm_audit_events` บันทึก `FORM_VERSION_PUBLISHED` และ `EVALUATION_PUBLISHED` (`details.source = HUMAN`, คะแนนสุดท้าย, auto-fail)

## นอกขอบเขต (อยู่ใน #888)

Appeal, calibration, quality plan/assignment, coaching → WFM, รายงาน trend ของทีม, Admin ประเมินข้ามทีม, คำถาม `SINGLE_CHOICE`/`MULTI_CHOICE`, การรวมกับ auto-QM draft และ entitlement `qm.enabled` ตาม ADR-009

ข้อจำกัดที่ยอมรับ: คะแนนข้ามฟอร์มเทียบกันไม่ได้ (§8) และหนึ่งสายมีผลประเมินโดยคนได้หนึ่งใบ
