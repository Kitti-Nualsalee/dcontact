# Cus360 C3 handoff — contact points, legacy และ compatibility bridge

อัปเดตล่าสุด: 2026-11-05 · issue #793 · สัญญาต้นทาง: E1 A/C/D/E/G (#764) และ R1 B/E/J (#763)

เอกสารนี้บอกว่า C3 ส่งอะไรให้ C4 (เปิด writer) และงาน rollout ใช้อย่างไร รวมถึงสิ่งที่ **ยังไม่ได้ทำ**
รายละเอียดการ implement อยู่ใน PR และ commit message ของแต่ละ slice

## สถานะ slice

| slice | PR | merge SHA | ขอบเขต |
|---|---|---|---|
| S1 parser | #851 | `376dc938` | `@d-contact/contact-points`: phone/email/tag normalization v1 และ runtime manifest |
| S2 owner point service | #853 | `28440b5f` | add/retire/replace, quota, NO_OP, revision, provenance |
| S3 legacy | #855 | ดูสถานะใน PR | inventory และ import `ContactIdentity` → contact point ผ่าน operator |
| S4 consumer bridge | #858 | ดูสถานะใน PR | guard ของ consumer ที่ lookup จากค่า |
| S5 compatibility | #864 | ดูสถานะใน PR | compatibility matrix, rollback guard และเอกสารนี้ |

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
- **ข้อตกลงของ point ที่ถูกแทนที่ตั้งแต่ import:** แถว `LEGACY_IDENTITY` ที่ `retired_command_id = created_command_id`
  (และ actor เดียวกัน) หมายถึงค่าซ้ำบน contact เดียวที่ bridge ตัดสินตาม ACTIVE ตัวเดียวกัน writer ของ C4 ห้ามสร้างแล้ว
  retire แถวเดียวกันใน command เดียว (เช่น merge/undo ในคำสั่งเดียว) เพราะจะถูกตีความเป็นแถวที่ถูกแทนที่
  แถวที่ถูกแทนที่ใช้ได้ทุกครั้งที่มี ACTIVE ค่าเดียวกันบน contact เดียวกัน ไม่ว่า ACTIVE นั้นมาจากไหน: ถ้า ACTIVE จาก import
  ถูก retire แล้วค่าเดิมถูกเพิ่มกลับผ่าน profile command แถวที่ถูกแทนที่จะพา journey/dispatch ไปถึง contact ได้อีก
  ส่วน identity ของ ACTIVE เดิมที่ retire แล้วยังใช้ไม่ได้ (ตัดสินแล้วใน review ของ #793 และมี test pin ไว้)
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
journey จะได้ `DEFERRED` (`IDENTITY_MAPPING_PENDING`) และ Kafka retry ได้ไม่เกิน `identityMappingRetryWindowMs`
(ค่าเริ่มต้น 15 นาที นับจาก `created_at` ของ inbox) ระหว่างนี้ไม่บันทึกผลถาวร แต่ partition ของ consumer จะรอ
พ้นช่วงแล้ว Governance บันทึก `REVIEW` ด้วย reason `IDENTITY_MAPPING_PENDING` (แยกจาก `IDENTITY_NOT_FOUND`)
ส่วน click-to-call เบอร์ภายนอกจะยังโทรไม่ได้จนกว่า import ครบ จึงยังควรทำตามลำดับข้างบน

event ที่ได้ reason นี้ไม่ถูกประมวลผลซ้ำเอง (error นี้ไม่ไป DLQ) หลัง import ครบให้หาด้วย
`cg_decision_logs.reason_code = 'IDENTITY_MAPPING_PENDING'` ที่ `source = 'JOURNEY'` แล้วตัดสินเป็นรายกรณี
คำสั่ง re-drive ของ operator แบบมี audit ยังไม่มี (journey recovery ตอนนี้ replay ได้เฉพาะ owner action)

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
- case folding มี test ตรวจ fingerprint ของ Unicode 17 C+F ทั้ง 1,585 mapping เทียบกับ UCD ตามหลักฐาน review #851;
  NFC/ICU และ package integrity ของ release ยังคงเป็น gate แยกก่อนเปิด writer
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
- HTTP route และ UI สำหรับเขียน point อยู่ใน C4; การค้น PHONE/EMAIL ของ C2 ใช้ parser กลางแล้ว (#869)
- test import สองคำสั่งพร้อมกันไม่ได้บังคับ interleave จึงพิสูจน์แค่ว่า unique index กันแถวซ้ำ

### C4: release gate ของ writer

API ตรวจ parser และ metadata ตอนเริ่มต้นเสมอ และใน `NODE_ENV=production` writer จะตอบ
`WRITE_RUNTIME_UNAVAILABLE` จนกว่าจะมี release manifest ที่ตรงกับ runtime และ image digest;
read routes และระบบอื่นไม่ถูกปิดตาม writer. ให้สร้าง manifest **ภายใน image ที่จะ release** ด้วย
`C360_IMAGE_DIGEST=sha256:<digest> node dist/customer-360-release-manifest.js`
จากนั้นส่ง JSON เป็น `C360_WRITE_RELEASE_MANIFEST` และส่ง digest เดียวกันเป็น `C360_IMAGE_DIGEST`
ผ่าน deployment configuration. เก็บ manifest, digest ที่ตรวจจาก registry/deployment และผลทดสอบไว้ใน release evidence.

Manifest ระบุ Node/ICU/Unicode, normalization versions, phone metadata SHA-256 และ lockfile package
integrity ที่ pin รวม transitive `punycode`. ค่า integrity เป็นหลักฐานจาก lockfile ไม่ใช่การพิสูจน์ว่าไฟล์ใน image
ไม่ถูกแก้; ผู้ deploy ยังต้องตรวจ digest ของ image จากแหล่ง deployment ที่เชื่อถือได้ และกระบวนการ build/install
ตาม lockfile ก่อนเปิด writer. การสร้าง manifest จากค่าที่ป้อนเองเพียงอย่างเดียวไม่ใช่หลักฐาน release ผ่าน.
