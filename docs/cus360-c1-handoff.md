# Cus360 C1 handoff — สัญญาที่ C2–C5 ใช้ต่อ

อัปเดตล่าสุด: 2026-11-02 · issue #791 · สัญญาต้นทาง: E1 (#764) และ R1 (#763)

เอกสารนี้บอกว่า C1 ส่งอะไรให้งานถัดไป ใช้อย่างไร และอะไร **ยังไม่ได้ทำ** รายละเอียดการ implement
อยู่ใน PR และ commit message ของแต่ละ slice

## สถานะ slice

| slice | PR | merge SHA | ขอบเขต |
|---|---|---|---|
| S1 schema | #816 | `9a69806` | ตาราง/คอลัมน์ตาม E1 A/H, composite tenant FK, RLS, append-only |
| S2 command engine | #817 | `664a4c5` | admission/digest/try-lock/receipt/tombstone/reconcile ตาม E1 B |
| S3 authorization + HTTP | #818 | `8c04e06` | predicate เดียวสำหรับ detail/list/count, IAM freshness, capabilities endpoint |
| S4 owner fences | #823 | `eeb5a71` | fence ร่วมกับ canonical/membership/IAM writers ตาม E1 G |
| S5 operator + fixtures | #824 | ดูใน #791 | operator commands, tag normalization, fixture matrix, เอกสารนี้ |

merge SHA ของ S5 (PR ที่เพิ่มเอกสารนี้) บันทึกไว้ใน comment ปิดของ #791

## สำหรับ C2 (read/composition)

- ใช้ SQL fragments จาก `@d-contact/customer-360` บน alias `c` ของ `contacts`:
  `c360ReadableContactSql(actor)` สำหรับรายการที่อ่านได้ และ `c360DeferredContactSql(actor)` สำหรับรายการ
  ที่ตัดสินไม่ได้ (IAM ยังไม่ทัน owner) ห้ามประกอบเงื่อนไขสิทธิ์เองและห้ามนับ DEFER เป็นศูนย์
- Detail ใช้ `authorizeC360ContactAccess(tx, actor, contactId)` ผล `ALLOW{read, manage, basis, identity}`,
  `DEFER{SCOPE_CONTEXT_STALE}` หรือ `DENY`. HTTP: DENY กับไม่พบตอบ 404 `RESOURCE_NOT_FOUND` เหมือนกัน,
  DEFER ตอบ 503 `SCOPE_UNAVAILABLE` (retryable)
- `identity = LEGACY_MISSING_HEAD` แปลว่ายังไม่มี identity head: อ่านได้แต่แก้ไม่ได้ GET ห้ามสร้าง head
- Actor มาจาก `c360CurrentActor(tx, identity)` ใน `apps/api/src/customer-360-api.ts` ซึ่งตรวจ active User และ
  proof binding ใน transaction เดียวกับการอ่าน
- `GET /api/v1/customer-360/contacts/:id/capabilities` เป็น seam ของ C1 ให้ UI ใช้เป็น hint เท่านั้น
  server ตรวจซ้ำทุก mutation

## สำหรับ C3 (bridge)

- `c360_contact_points` ที่ค่าเหมือนกันบนหลาย contact เป็นเรื่องปกติ (ไม่มี unique ข้าม contact)
  point ACTIVE ไม่ใช่ verified identity หรือ consent ห้าม resolver เดิมตีความว่าเป็นตัวเดียวกัน
- identity head ที่ขาดสร้างได้ทางเดียวคือ owner `initializeC360IdentityHead` ใต้ canonical fence
  (operator command `IDENTITY_HEAD_INIT`) ถ้ามี lineage อ้าง contact อยู่แล้วแต่ head หาย จะได้
  `IDENTITY_LINEAGE_CONFLICT` ต้องตรวจด้วยคน ไม่สร้างทับ

## สำหรับ C4 (writers)

- ทุก mutation ผ่าน `executeC360ProfileCommand(db, actor, input, authorization, perform)`:
  effect, audit และ receipt อยู่ใน transaction เดียว, business rejection โยน
  `C360ProfileCommandRejection(code, 404|409|422)` เพื่อได้ REJECTED receipt โดย effect ถูก rollback
- ใน `perform` เรียก `fenceC360ContactMutation(tx, actor, contactIds)` ก่อนแตะ profile/tag/point rows
  ลำดับ Team → IAM scope-version → User → identity → IAM projection ทุกตัวเป็น try/NOWAIT;
  ล็อกไม่ได้ = `RESOURCE_BUSY` ที่ engine retry ให้ ห้าม catch แล้วทำต่อ
- แก้ได้เฉพาะ `access.manage === true` (MANAGE custodian + identity ACTIVE) IAM VIEW/WORK ให้แค่อ่าน
  ถ้าต้องการให้ WORK แก้ได้ต้องเปิด decision gap ก่อน
- Create ต้องผ่าน `authorizeC360ContactCreate(tx, actor)` (capability `CONTACT_CREATE` จาก operator) และใน
  transaction เดียวกันต้องสร้าง Contact + identity head + creator MANAGE grant (`origin=CREATOR`,
  `actor_user_id = grantee_user_id`) + audit + receipt
- ชื่อ tag ใช้ `normalizeC360TagName` (`C360_TAG_NORMALIZATION_VERSION`) เท่านั้น ห้ามใช้ toLowerCase/locale
  ชื่อของ tag ที่ RETIRED ถูกสงวน

## สำหรับ C5 (Workspace)

- ตาราง `c360_work_mutation_auth` (1:1 ต่อ tenant/user/lease) มี trigger บังคับว่าการเปลี่ยน state/binding
  ต้องเพิ่ม `auth_epoch` ทุกครั้ง C1 ยังไม่มี writer ของตารางนี้ C5 ต้องทำ CAS/reauth/invalidation ตาม E1 H
- ลำดับ fence ฝั่ง Agent ตาม E1 G ต้องเพิ่ม lease/auth และ Interaction ก่อน identity ซึ่ง
  `fenceC360ContactMutation` ยังไม่รวม (รองรับเฉพาะ Admin/Supervisor generic routes)

## Operator runbook (E1 D)

`POST /api/v1/customer-360/operator/commands` เฉพาะ realm role `platform-operator`

```json
{ "commandId": "<uuid>", "evidenceRef": "ticket:OPS-123", "reasonCode": "APPROVED_CUSTODIAN",
  "dryRun": true, "command": { "action": "CUSTODIAN_GRANT", "contactId": "<uuid>",
  "granteeUserId": "<uuid>", "permission": "MANAGE" } }
```

| action | ผล |
|---|---|
| `CUSTODIAN_GRANT` | ให้ READ/MANAGE แก่ active ADMIN บน contact canonical หรือ legacy |
| `CUSTODIAN_REVOKE` | append-only revocation ไม่แก้ grant เดิม |
| `CUSTODIAN_RECOVER` | ให้ Admin ที่อนุมัติแล้วและถอน grant ที่ระบุใน transaction เดียว |
| `CAPABILITY_GRANT` / `CAPABILITY_REVOKE` | `CONTACT_CREATE` ของ Admin |
| `TAG_SEED` | สร้าง tag ACTIVE ตาม validator เดียวกับ M1, ชื่อที่มีอยู่เป็น NO_OP |
| `IDENTITY_HEAD_INIT` | สร้าง head ACTIVE ให้ legacy ผ่าน owner ใต้ canonical fence |

- ส่ง `dryRun: true` ก่อนเสมอ preview มีแค่ ID/role/state ไม่มีชื่อ email หรือค่าติดต่อ และไม่ admit command
- ส่ง commandId เดิมซ้ำได้ผลเดิม; payload ต่างใต้ ID เดิมได้ 409 `COMMAND_PAYLOAD_MISMATCH`;
  ถ้าได้ 202/503 ให้ใช้ `GET .../commands/:id` หรือ reconcile ด้วย ID เดิม ห้ามสร้าง ID ใหม่
- code ที่ปฏิเสธ: `GRANTEE_NOT_FOUND`, `GRANTEE_NOT_ACTIVE_ADMIN`, `SELF_GRANT_FORBIDDEN`,
  `CONTACT_NOT_FOUND`, `CONTACT_NOT_CANONICAL`, `GRANT_NOT_FOUND`, `GRANT_NOT_REVOCABLE`,
  `RECOVERY_TARGET_IS_REVOKED_HOLDER`, `TAG_NAME_DUPLICATE`, `TAG_NAME_RESERVED`, `IDENTITY_LINEAGE_CONFLICT`
- grant ไม่ตามไป canonical target หลัง merge และไม่มี auto-recovery ไปหา Admin คนแรก

## Tests และวิธีรัน

ใช้ DB แยก (`DATABASE_URL` ของ owner และ `APPLICATION_DATABASE_URL` ของ `dcontact_app` ที่ไม่มี BYPASSRLS)

| suite | ไฟล์ | ผลล่าสุด (PostgreSQL 15.4) |
|---|---|---|
| schema | `packages/db/src/cus360-profile-schema.integration.ts` | 8/8 |
| command engine | `apps/customer-360/src/profile-command.integration.ts` | 12/12 |
| HTTP gates | `apps/api/src/customer-360-api.integration.ts` | 7/7 |
| owner fences | `apps/api/src/customer-360-fences.integration.ts` | 4/4 (3 รอบ) |
| operator + fixture | `apps/api/src/customer-360-operator.integration.ts` | 5/5 (3 รอบ) |
| tag vectors | `apps/customer-360/src/profile-tags.test.ts` | 3/3 |

```sh
pnpm --filter @d-contact/customer-360 build
cd apps/api && npx tsx --test --test-concurrency=1 src/customer-360-*.integration.ts
```

## ยังไม่ครอบคลุม

- race ของ completion/reassignment, lease revoke/reauth (รอ C5) และ tag retire/contact point replace (รอ C4)
- race ของ User team/role/disable กับ writer จริง: helper ถือ User `FOR SHARE NOWAIT` และตรวจซ้ำหลังล็อก
  แต่ยังไม่มี test ที่ใช้ writer ของ tenant-people
- legacy import ของ contact points และ inventory report ตาม E1 D ต้องใช้ parser ตาม E1 C ซึ่งยังไม่ได้ pin
  (`libphonenumber-js`, `email-addresses`, `tr46@5.1.1`) อยู่ในขอบเขต C3/C4
- fixture "shared" ใส่ point ผ่าน owner connection ใต้ command สังเคราะห์ เพราะ writer ของ point ยังไม่มี
