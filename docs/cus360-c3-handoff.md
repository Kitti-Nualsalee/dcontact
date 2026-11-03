# Cus360 C3 handoff — contact points, legacy และ compatibility bridge

อัปเดตล่าสุด: 2026-11-03 · issue #793 · สัญญาต้นทาง: E1 A/C/D/E/G (#764) และ R1 B/E/J (#763)

เอกสารนี้บอกว่า C3 ส่งอะไรให้ C4 (เปิด writer) และงาน rollout ใช้อย่างไร รวมถึงสิ่งที่ **ยังไม่ได้ทำ**
รายละเอียดการ implement อยู่ใน PR และ commit message ของแต่ละ slice

## สถานะ slice

| slice | PR | merge SHA | ขอบเขต |
|---|---|---|---|
| S1 parser | #851 | รอ merge | `@d-contact/contact-points`: phone/email/tag normalization v1 และ runtime manifest |
| S2 owner point service | #853 | รอ merge | add/retire/replace, quota, NO_OP, revision, provenance |
| S3 legacy | #855 | รอ merge | inventory และ import `ContactIdentity` → contact point ผ่าน operator |
| S4 consumer bridge | #858 | รอ merge | guard ของ consumer ที่ lookup จากค่า |
| S5 compatibility | (PR นี้) | รอ merge | compatibility matrix, rollback guard และเอกสารนี้ |

## สำหรับ C4 (writers)

- **Parser:** ใช้ `normalizeC360Phone(raw, explicitCountry?)`, `normalizeC360Email(raw)` และ `normalizeC360TagName`
  จาก `@d-contact/contact-points` เท่านั้น ห้ามมี parser หรือ toLowerCase ของตัวเองใน API/UI
  - error code ของ parser (`PHONE_INVALID`, `PHONE_COUNTRY_REQUIRED`, `PHONE_EXTENSION_UNSUPPORTED`, `EMAIL_INVALID`,
    `EMAIL_DOMAIN_INVALID`, `PHONE_TOO_LONG`, `EMAIL_TOO_LONG`, `PHONE_COUNTRY_UNSUPPORTED`) ส่งออกได้ตรง ๆ เป็น
    validation code ของ R1 ไม่มีการตัดส่วนเกินทิ้ง
  - ประเทศต้องมาจากที่ผู้ใช้เลือกเอง (`explicitCountry`, ISO 3166 alpha-2 ตัวใหญ่) ห้ามเดาจาก locale/timezone/IP
- **Runtime:** เรียก `assertC360ContactPointRuntime()` จาก `@d-contact/contact-points/runtime-manifest` ตอน API start
  ถ้ารุ่นหรือ phone metadata SHA256 ไม่ตรงกับ E1 ให้ fail closed และบันทึก manifest ลง release evidence
  manifest ยังไม่มี container digest และ package integrity ตาม E1 C ให้เติมจาก release metadata ตอนเปิด writer
- **Point writer:** ใน `perform` ของ `executeC360ProfileCommand` หลัง `fenceC360ContactMutation` และ `access.manage === true`
  เรียก `addC360ContactPoint` / `retireC360ContactPoint` / `replaceC360ContactPoint` ซึ่งคืน `C360ProfileEffect` ให้ engine
  - expected revision คือ `expectedProfileRevision` (decimal string) ของ R1 F; mismatch = `REVISION_CONFLICT` (409)
  - quota 10 ACTIVE ต่อชนิดต่อ contact (`POINT_QUOTA_EXCEEDED`); legacy ที่เกินเพดาน retire/replace ได้
  - ค่าที่ ACTIVE อยู่แล้ว / retire ซ้ำ = NO_OP; replace point ที่ RETIRED = `POINT_RETIRED`; ต่างชนิด = `POINT_KIND_MISMATCH`
  - owner ปฏิเสธ contact ที่ identity head ไม่ ACTIVE (`IDENTITY_NOT_ACTIVE`) และ point ของ contact อื่น (`POINT_NOT_FOUND`)
- **Audit/PII:** effect ที่คืนไม่มีค่า phone/email; response ของ C4 ต้องอ่าน point กลับตามสิทธิ์ ไม่ใช้ receipt แทนข้อมูล
- **point ใหม่ไม่ใช่ identity:** point ที่ C4 สร้างไม่มี `ContactIdentity` คู่กัน จึงไม่ถูกใช้ dispatch ของ CG/Voice
  (`eligibleLegacyIdentityByKey` คืนเฉพาะ point ที่มาจาก legacy identity) ห้ามสร้าง identity เพื่อให้โทรออกผ่าน

## Compatibility matrix

| สถานการณ์ | ผล | หลักฐาน |
|---|---|---|
| API เก่า + schema ใหม่ | ทำงานได้: C3 ไม่มี migration; schema ของ contact point มาจาก C1 ซึ่ง additive | ไม่มีไฟล์ใน `packages/db/prisma/migrations` ใน diff ของ C3 |
| API ใหม่ + ข้อมูลเดิมที่ยังไม่ import | journey ได้ `DEFERRED` แล้ว retry (ไม่บันทึก NOT_FOUND ถาวร ไม่สร้าง enrollment/decision); click-to-call เบอร์ภายนอกได้ NOT_FOUND (ไม่โทรออก) ทั้งสองไม่ fallback ไป raw value | `contact-point-bridge.integration.ts`, `journey-processor.integration.ts`, `click-to-call.integration.ts` |
| API ใหม่ + import ครบแล้ว | resolve เฉพาะ ACTIVE ที่ไม่ shared; review/retired/shared ไม่ resolve | journey suites และ click-to-call 10/10 |
| rollback ไป image ก่อน S4 ขณะมี contact point | **ห้าม**: จะคืน raw resolver; guard ตอบ `ROLLBACK_CONTACT_POINT_BRIDGE_REQUIRED` | `scripts/cus360-contact-point-rollback-guard.test.mjs` |
| rollback ไป image ก่อน S4 ขณะยังไม่มี contact point | ทำได้: ไม่มีสถานะ shared/retired/review ให้ข้าม | guard ตอบ PASS |
| เบอร์ภายใน sandbox (`^1\d{3}$`) | คงพฤติกรรมเดิมทั้ง click-to-call และ dispatch | decision gap #857 |
| `ContactIdentity`, consent และหลักฐาน CG เดิม | ไม่ถูกแก้ ไม่ถูกย้าย | test ของ S2/S3 เทียบแถวก่อน–หลัง |

## ลำดับ rollout ที่ต้องรักษา

1. deploy release ที่มี S1–S3 (parser, point service, operator import) โดย **ยังไม่มี** S4
2. ต่อ tenant: `dryRun: true` ของ `LEGACY_POINT_IMPORT` เก็บ inventory เป็นหลักฐาน แล้วรันจริงจน `remaining = 0`
   (`importAllC360LegacyContactPoints` ทำให้ครบทีละ batch)
3. ตรวจ inventory รอบหลัง: `pending` เป็น 0 และทบทวน `reviewReasons`/`sharedKeys`/`contactsOverQuota`
4. deploy release ที่มี S4 (bridge) — ตั้งแต่จุดนี้ rollback ต้องผ่าน guard
5. identity ที่ legacy writer สร้างเพิ่มภายหลังต้องรัน import ซ้ำ (รันซ้ำได้ ไม่สร้างแถวซ้ำ)

**ตาข่ายกันพลาด:** stack ของ C3 merge เป็นลำดับเดียว ถ้า deploy ทั้ง stack พร้อมกันโดยยังไม่ import
journey จะได้ `DEFERRED` (`IDENTITY_MAPPING_PENDING`) และ Kafka retry จนกว่า import ครบ ไม่บันทึกผลถาวร
ส่วน click-to-call เบอร์ภายนอกจะยังโทรไม่ได้จนกว่า import ครบ จึงยังควรทำตามลำดับข้างบน
event ที่ค้าง retry ยาวต้องดูที่ DLQ/metrics ของ journey consumer ถ้า import ไม่ถูกรัน

## Operator runbook: `LEGACY_POINT_IMPORT`

`POST /api/v1/customer-360/operator/commands` (realm role `platform-operator`)

```json
{ "commandId": "<uuid>", "evidenceRef": "ticket:OPS-123", "reasonCode": "LEGACY_POINT_MIGRATION",
  "dryRun": true, "command": { "action": "LEGACY_POINT_IMPORT", "batchSize": 100 } }
```

- dry-run คืน inventory: จำนวน identity ต่อชนิด, imported/pending, `reviewReasons`, `contactsOverQuota`, `sharedKeys`
  พร้อม digest ที่ผูก tenant และสถานะ identity head ไม่มีค่า phone/email ดิบ
- ของจริง import หนึ่ง batch (≤200) และคืน `committedRevisions.remaining`; ไม่มี pending = NO_OP
- `REVIEW_REQUIRED` เกิดจาก: ไม่มีประเทศ (`PHONE_COUNTRY_REQUIRED`), extension หรือรูปแบบผิด — ต้องให้คนตรวจ
  ไม่มีการเดาหรือแก้ค่าอัตโนมัติ ส่วนค่าซ้ำใน contact เดียวนับแยกเป็น `pendingSuperseded`

## Rollback guard

`scripts/cus360-contact-point-rollback-guard.mjs` ยังไม่ได้เชื่อมเข้า `infra/uat/bin/uat-deploy.sh` เพื่อไม่ชนกับ #812
ขั้นเชื่อมใน `rollback_preflight`:

1. รัน `CONTACT_POINT_LEDGER_SQL` ผ่าน probe แบบ read-only เดียวกับ ledger probe เดิม ด้วย role ที่เห็นข้อมูลครบ
   (owner/BYPASSRLS เช่น `dcontact_uat_owner`) role ที่ติด tenant RLS จะได้ `ROLE_INSUFFICIENT` และ guard ไม่ผ่าน
2. ถ้าได้ `PRESENT` รัน `CONTACT_POINT_BRIDGE_PROBE` ใน image ปลายทางแบบ `--network none --read-only` เหมือน capability probe เดิม
   probe ตรวจทั้ง export ของ `@d-contact/db` และ consumer ที่มีใน image (`/app/dist/click-to-call.js`, journey-composition)
3. ส่งผลเข้า `decideContactPointRollback` ถ้า FAIL ให้ `fail` ด้วย reason ที่คืน

จนกว่าจะเชื่อม การ rollback ของ release ที่มี bridge ต้องรัน guard ด้วยมือ (`node --test` ใช้ตรวจตัว guard เอง)

## Collision และ evidence

- shared normalized key ข้าม contact เก็บได้ตาม R1 และถูกนับใน inventory (`sharedKeys`) — bridge ไม่ resolve ค่าเหล่านี้
- vector ของ parser ครบตาม E1 C (`packages/contact-points/src/normalize.test.ts`) และ phone metadata SHA256 ตรงกับ E1
- case folding ตรึง mapping ของ Unicode 16 และ Latin Extended-D ชุดใหม่ (A7CE/A7D2/A7D4) ที่ reviewer ระบุว่าเป็นของ
  Unicode 17 ไว้ใน test แล้ว ยังไม่ได้เทียบกับ UCD 17 ทั้งไฟล์
- ค่าซ้ำบน contact เดียว (identity หลายแถวที่ normalize แล้วเท่ากัน) เก็บเป็น point ที่ถูกแทนที่ตั้งแต่ import
  (RETIRED โดย command เดียวกับที่สร้าง) bridge ตัดสินตาม ACTIVE ค่าเดียวกันบน contact เดียวกัน (เจ้าของงานเลือก)
  UI ของ C2/C4 ควรแสดงแถวนี้เป็น "ซ้ำกับค่าที่ใช้อยู่" ไม่ใช่ประวัติที่ผู้ใช้ retire

## Tests และวิธีรัน

ใช้ DB แยก (`DATABASE_URL` ของ owner และ `APPLICATION_DATABASE_URL` ของ `dcontact_app`)

| suite | ไฟล์ | ผลล่าสุด (PostgreSQL 15.4) |
|---|---|---|
| parser vectors | `packages/contact-points/src/normalize.test.ts` | 8/8 |
| point service | `apps/api/src/customer-360-points.integration.ts` | 5/5 (race ใช้ trigger barrier) |
| legacy import | `apps/api/src/customer-360-legacy-points.integration.ts` | 3/3 |
| bridge (click-to-call) | `apps/api/src/click-to-call.integration.ts` | 10/10 |
| bridge (journey) | `packages/journey-composition/src/contact-point-bridge.integration.ts` และ `apps/journey/src/journey-{processor,event-consumer,send-executor,governance-cg4,governance-invalidation,outcome-trigger-processor}.integration.ts` | ผ่านครบ |
| rollback guard | `scripts/cus360-contact-point-rollback-guard.test.mjs` | 5/5 เมื่อมี DB/build (รวม role ที่ติด RLS = `ROLE_INSUFFICIENT`), 3/3 + skip 2 เมื่อไม่มี |

```sh
pnpm --filter @d-contact/contact-points test
pnpm test:cus360-rollback-guard
cd apps/api && npx tsx --test --test-concurrency=1 src/customer-360-points.integration.ts src/customer-360-legacy-points.integration.ts src/click-to-call.integration.ts
```

## ยังไม่ครอบคลุม

- dispatch จาก `ContactIdentity` ID และเบอร์ภายในของ sandbox → decision gap #857
- การเชื่อม rollback guard เข้า `uat-deploy.sh` → หลัง #812 merge
- HTTP route และ UI ของ point (C4) และการค้น PHONE/EMAIL ของ C2 ด้วย parser นี้ (follow-up ของ #792)
- test import สองคำสั่งพร้อมกันไม่ได้บังคับ interleave จึงพิสูจน์แค่ว่า unique index กันแถวซ้ำ
