# J3 handover — สถานะและกับดักที่ต้องรู้ก่อนทำต่อ

อัปเดตล่าสุด: 2026-09-16

เอกสารนี้เขียนไว้ให้คนที่มารับงาน J3 ต่อ ไม่ใช่สรุปสิ่งที่ทำไปแล้ว (นั่นอยู่ใน commit message และ
PR description ซึ่งละเอียดกว่า) แต่เป็น **สิ่งที่ไม่ได้อยู่ในโค้ดและถ้าไม่รู้จะเสียเวลาซ้ำ**

## สถานะงาน

| issue | สถานะ | ต้องทำอะไรต่อ |
|---|---|---|
| #215 J3.4 SEGMENT_ENTRY definition | โค้ดครบ | ปิดใบได้เมื่อ harness เขียว |
| #216 J3.5 persistence | โค้ดครบ | — |
| #217 J3.6 consumer + orchestration | **ครบวงจร** | — |
| #218 J3.7 re-filter + cancellation | ครบสามสไลซ์ | เหลือส่วนรอ owner ตอบกลับ (`applyResult` ของ J2 รองรับแล้ว) |
| #219 J3.8 query/recovery API | **ครบทั้งใบ** | — |
| #221 J3.10 migration/backfill/rollout | สามสไลซ์ | เหลือ crash/kill drill ระหว่าง stage |
| #222 J3.11 convergence acceptance | **ยังไม่เริ่ม** | สร้าง harness แบบ `cxa-cg4-readiness.mjs` |
| #220 J3.9 IAM/Governance conformance | **ติด ทำไม่ได้** | อ่านหัวข้อถัดไป |

## #220 ติดอะไร และทำไมห้ามปั้นให้ผ่าน

`TeamContactScopeAuthorizer` ใน `packages/cxa-contracts/src/scope-authorization.ts` **เป็น interface
ล้วน ไม่มี implementation จริงใน repo เลย** ทุกจุดที่ใช้งาน (`journey-processor`,
`journey-outcome-trigger-processor`, `journey-segment-trigger-processor`, `journey-composition`)
รับมันเป็น port แล้ว inject test double และ **ไม่มีตาราง team→contact scope grant ใน schema**

ยิ่งกว่านั้น `AuthorizeTeamContactScopeInput` บังคับ `contactId` ซึ่งเป็น per-contact runtime
authorization — ที่ publish time (เช่นใน #215) ยังไม่มี contact จึงเรียกไม่ได้โดยธรรมชาติ ต้องมี
config-capability port คนละตัว

**ห้ามสร้าง port ที่ตอบ ALLOW เสมอเพื่อให้ acceptance ผ่าน** — นั่นคือหลักฐานปลอม และเป็นสิ่งเดียว
กับที่ acceptance ชุดนี้ออกแบบมาเพื่อกัน ถ้าจะทำ #220 ต้องมีคนสร้าง IAM team-scope จริงก่อน

## กับดักของ environment ที่เสียเวลาไปแล้วจริง

### 1. `pnpm lint` ผ่านหลอกถ้ายังไม่ `git add`

script คือ `git ls-files -z | xargs -0 prettier --check` — **ไฟล์ที่ยัง untracked มองไม่เห็นเลย**
เคยทำให้ PR ผ่าน lint ในเครื่องแล้วไป break main

ลำดับที่ถูก: `git add -A <path>` → `pnpm lint` → `git commit`

### 2. `dist/` ค้างทำให้เข้าใจผิดว่า main พัง

`tsc` ของ app อ่าน type จาก `dist/` ของ package ไม่ใช่จาก `src/` พอ schema หรือ package เปลี่ยน
จะฟ้อง error ที่ดูเหมือน main พัง ทั้งที่ `pnpm typecheck` (ผ่าน turbo) ผ่าน 33/33

rebuild ตามลำดับ: `pnpm db:generate` → `pnpm --filter @d-contact/db build` →
`pnpm --filter @d-contact/journey build` → แล้วค่อย typecheck app

เจอสองครั้งในเซสชันเดียว ครั้งแรกกับ `@d-contact/kafka` ครั้งที่สองกับ `contact-governance`

### 3. `prisma migrate diff` ใช้กับ repo นี้ไม่ได้

มัน drop/recreate FK ทั้ง schema **141 จุด** เพราะ migration ของ repo เขียนมือและไม่ตรงกับสิ่งที่
Prisma จะ generate **เขียน migration เองตามแบบแผนเดิม** ดูตัวอย่างที่
`20260915130000_add_j3_segment_persistence`

### 4. Postgres: enum ใหม่ใช้ในทรานแซกชันเดียวกับที่ `ADD VALUE` ไม่ได้

ถ้า migration ต้องใช้ค่า enum ใหม่ใน DDL ต้องแยกเป็นสอง migration ดูตัวอย่างที่
`20260915060000_add_c360_outbox_quarantine` กับ `20260915060100_update_c360_outbox_guard`

ถ้าแค่ `ADD VALUE` เฉย ๆ โดยไม่ใช้ใน DDL อยู่ migration เดียวกันได้

### 5. อ่านฐานข้อมูลนอก tenant transaction จะเจอ `invalid input syntax for type uuid: ""`

RLS policy ใช้ `current_setting('app.tenant_id', true)::uuid` ซึ่งนอก transaction จะเป็นสตริงว่าง
ต้องอ่านผ่าน `withTenantDatabaseTransaction` เสมอ

### 6. time bomb ในเทส

**อย่า hardcode วันที่ใกล้ ๆ ตอนเขียนเทส** ถ้านาฬิกาคงที่ต้องเทียบกับข้อมูลที่สร้างด้วยเวลาจริง
(`now()` ของฐานข้อมูล) ให้ใช้ปี 2099

เคยทำให้ `CG4-OB01` ล้มทุก run ตั้งแต่ `2026-09-15T05:00Z` เป็นต้นมา และทุกคนเข้าใจผิดว่าเป็น
flaky test อยู่หลายวัน จนกระทั่ง diagnostic ของ `#247`/`#250` เก็บบรรทัดที่บอกสาเหตุได้

นาฬิกาคงที่ที่สอดคล้องกันเองทั้งไฟล์ (ทั้ง `now` และข้อมูลถูก hardcode) **ปลอดภัย** — อันตรายเฉพาะ
ตอนนาฬิกาคงที่ไปเจอข้อมูลที่สร้างด้วยเวลาจริง

## นิสัยการทำงานที่ควรรักษาไว้

### เทสที่ผ่านแต่ไม่ได้พิสูจน์อะไร

เจอสามครั้งในเซสชันเดียว ทุกครั้งคือเทสที่ **ชื่อบอกอย่างหนึ่งแต่ code path ไปอีกอย่าง**:

- เทสชื่อว่าทดสอบ `IGNORED_SUPERSEDED` แต่ได้ `DUPLICATE` ทุกเคสเพราะ logical unique ดักก่อน
- เทส `AMBIGUOUS`/`NOT_FOUND` ที่จริง ๆ แล้วเผยว่า receipt ที่ค้าง `REVIEW` บล็อกทั้ง stream
- เทสที่ assert `undefined` เพราะ helper ไม่ได้ `return` ค่า

**ถ้าเทสผ่านตั้งแต่ครั้งแรกโดยไม่เคยเห็นมันล้ม ให้สงสัยไว้ก่อน** วิธีที่ใช้ได้ผลคือเขียนเทสให้ล้มก่อน
(red) แล้วค่อยแก้โค้ด

### แก้ที่เทส ไม่ใช่แก้โค้ดให้เทสผ่าน

หลายครั้งที่เทสล้มเพราะสมมติฐานของเทสผิด ไม่ใช่โค้ดผิด เช่น `contacts.id` เป็น PK ระดับ global
จึง reuse ข้าม tenant ไม่ได้, `jr_enrollments.journey_id` เป็น `@db.Uuid`, Prisma escape ภาษาไทย
ใน error string ทำให้ regex ไม่ match

### สไลซ์ให้เล็กและอธิบายได้

PR ที่ใหญ่เกินจะ review ไม่ได้ แต่ละสไลซ์ควรตอบได้ว่า "ถ้า merge แค่นี้ ระบบยังทำงานถูกต้องไหม"

## คำสั่งที่ใช้บ่อย

```bash
pnpm --filter @d-contact/journey test              # unit
pnpm --filter @d-contact/journey test:integration  # ต้องมี Postgres + Redpanda
pnpm --filter @d-contact/db test:integration       # RLS/constraint
pnpm --filter @d-contact/api test:integration      # API
pnpm cxa:j3:schema                                 # J3-MG01 schema readiness
pnpm test:cxa-j3-schema-readiness                  # unit ของ readiness เอง
```

ชุด integration ใช้เวลานาน (journey ~4 นาที) **สะสมงานแล้วรันเป็นชุดตอนท้าย** ไม่ใช่รันทุกขั้น

## ตัวที่ยังหาสาเหตุไม่ได้

ชุด integration ของ journey เคยล้มแบบ file-level บน CI ด้วย `signal: 'SIGSEGV'` โดยเทสข้างในผ่านหมด
ไฟล์ที่ล้มเปลี่ยนไปเรื่อย ๆ และ **ไม่สัมพันธ์กับจำนวน `PrismaClient` ที่สร้าง** (ไฟล์ที่สร้าง 34 ตัว
ไม่เคยล้ม ส่วนที่สร้าง 4 ตัวล้ม)

รีโปรในเครื่องไม่ได้เลยจาก 16 รอบ รวมทั้งอัด CPU และ probe ที่สร้าง/ทำลาย client 160 ตัวรวด
Prisma อยู่ที่ 5.22.0 ซึ่งเป็นตัวล่าสุดของ v5 แล้ว

`engineType = "binary"` ทดสอบแล้วใช้งานได้และ**เร็วกว่า 11%** แต่ยังพิสูจน์ไม่ได้ว่าแก้ SIGSEGV
และ deprecated ใน Prisma 6 — ยังไม่ควรเอามาใช้จนกว่าจะมีข้อมูลความถี่จริง

**อัปเดต 2026-09-18 (J2.10):** อาการนี้บล็อก J2 acceptance สองรอบติด (SIGSEGV ที่
`tenant-queue-api.integration.ts` แล้วรอบถัดมาที่ `contact-governance-api.integration.ts`
ทั้งสองรอบไม่มี assertion แดงเลย) `scripts/phase-zero-readiness.mjs` จึงรันคำสั่งซ้ำหนึ่งครั้ง
เฉพาะกรณีที่ **ทุก** บล็อกที่ล้มตายด้วย signal — มี assertion แดงปนแม้ตัวเดียวจะไม่รันซ้ำ และ
ตายซ้ำรอบสองถือว่าแดงจริง diagnostic ที่มีการรันซ้ำจะมีฟิลด์ `retriedAfterSignal` ติดไว้เสมอ
ใช้ฟิลด์นี้นับความถี่จริงจาก evidence manifest ได้ ถ้าความถี่สูงขึ้นค่อยกลับมาหาเหตุที่ native layer
