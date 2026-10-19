# ฐานสิทธิ์และ command ของ Core Settings

Authority: [Phase Contract Core Settings แบบ A](https://github.com/Kitti-Nualsalee/dcontact/issues/723), [งานฐานสิทธิ์และ command/receipt](https://github.com/Kitti-Nualsalee/dcontact/issues/725)

## ขอบเขตของงานฐาน

เปิดเฉพาะ capabilities, command lookup และ reconcile ใน default กับ `uat-workspace` ผ่าน OIDC/verified proof จริง ไม่เพิ่ม Core app ใน registry จนหน้าองค์กร/ทีมพร้อม `uat` และ `uat-e1` คง route boundary เดิม Test-only `CoreCommandProbeController` ใช้พิสูจน์ engine ผ่าน HTTP กับข้อมูลจริงและไม่ถูก import/mount จาก entrypoint

`tenant-config-identity.ts` เป็น evaluator กลาง ส่วน Voice adapter คง public imports เดิมและ policy/quota/lifecycle ของ Voice แอปยังอ่านตาราง proof ได้อย่างเดียว Core ถือ User `FOR SHARE NOWAIT` ซึ่งขัดกับ `FOR UPDATE NOWAIT` ที่ trigger เปลี่ยน proof ของ B1 บังคับอยู่ จึงไม่ต้องเพิ่ม UPDATE grant ให้ proof การเปลี่ยน role/active/team ของ User ถูก serialize ด้วยแถวเดียวกัน ตรวจ Tenant ACTIVE และ Supervisor own active Team จาก DB ด้วย

## การใช้ engine ใน API องค์กรและทีม

1. API ตรวจ request shape/normalize เฉพาะ field ที่แก้ และเรียก `prepareCoreCommand` ด้วย action/resource ที่ server กำหนด ไม่เชื่อ tenant/actor/action จากผู้ใช้
2. `executeCoreCommand` ตรวจ live authority และ durable admission โดยเก็บเฉพาะ metadata/digest ไม่มี raw payload จากนั้นตรวจ authority อีกครั้งใน execution transaction และ replay receipt ก่อนเรียก resource callback
3. Resource callback รับ transaction เดียวกัน ต้องได้ resource/reference locks, อ่าน revision ล่าสุด, CAS ก่อน no-op, ตรวจ domain validation/guards และคืน APPLIED พร้อม before/after หรือ NO_OP โดยไม่แก้ข้อมูล Callback ห้ามทำ network/identity/email I/O
4. Engine บันทึก audit เฉพาะ APPLIED และ terminal receipt พร้อม effects ใน transaction เดียว Domain rejection rollback ถึง savepoint แล้วเก็บ REJECTED ส่วน busy/exception rollback execution ทั้งหมดแต่คง admission ไว้
5. `coreTransaction` บังคับ READ COMMITTED, bounded local timeouts และ `SET CONSTRAINTS ALL IMMEDIATE` ก่อนคืนผลจาก callback จึงไม่ตอบ success จากผล insert ที่ deferred constraint ยังปฏิเสธได้ตอน commit
6. Transport failure ยัง UNKNOWN: lookup ไม่พบไม่พิสูจน์ว่าไม่เกิดผล Reconcile ได้ command lock จึงปิด admission หรือสร้าง NOT_APPLIED tombstone ที่กัน late POST ได้ ถ้า lock ยังอยู่คืน PENDING ห้ามสร้าง ID ใหม่หลบผลเดิม

SQL constraints ผูก command/audit/receipt ตาม tenant/actor identity/command ID, actor/resource/action/revision/snapshot และกัน NO_OP revision เปลี่ยน Ledger append-only และ FORCE RLS พร้อม composite FK ของ actor ใน tenant เดียวกัน `apply-rls` ซ้ำต้องคง revokes รวม proof SELECT-only

Profile revision table ตรวจ deferred effect→receipt โดยต้องมี APPLIED audit/receipt ที่ resource/revision ตรงกันและสร้างใน transaction เดียวกัน ไม่รับ receipt เก่ามารองรับ effect ใหม่ เป็นฐานให้ API องค์กร งานองค์กรต้องต่อ hooks ของ Tenant.name/TenantSettings และ provenance จริง ส่วน Team API ต้องเพิ่ม Team revision/current-writer guards ตาม packet ของตน งานฐานไม่เปิด API mutation องค์กร/ทีมด้วย callback ทดลอง และไม่อ้างว่า resource consumers ของงานถัดไปผ่านแล้ว

## การตรวจ

ใช้ isolated PostgreSQL ที่ระบุ `DATABASE_URL`/`APPLICATION_DATABASE_URL` ชัดเจน ห้ามชี้คำสั่ง migration ไป VM เพื่อรัน tests:

```sh
pnpm db:generate
pnpm --filter '@d-contact/api^...' build
pnpm db:migrate
pnpm db:rls
pnpm --filter @d-contact/api exec tsx --test src/tenant-core-contract.test.ts src/runtime-profile.test.ts src/e1-uat-api.test.ts
pnpm --filter @d-contact/api exec tsx --test --test-concurrency=1 src/tenant-core-command.integration.ts src/tenant-voice-catalog.integration.ts
pnpm --filter @d-contact/db exec tsx --test src/tenant-core-command.integration.ts
```

Real identity boundary ต้องมี disposable loopback Keycloak **26.7.5** ตาม digest ใน `.github/workflows/core-settings.yml` และกำหนด `CORE_IDENTITY_SANDBOX_URL`/`CORE_IDENTITY_SANDBOX_ADMIN_PASSWORD` ก่อนเรียก:

```sh
pnpm --filter @d-contact/api exec tsx --test src/tenant-core-identity.boundary.ts
```

Suite สร้าง realm เฉพาะ `core725-<UUID>`/users/native Organizations ชั่วคราว ตรวจ JWKS/claims จริง และล้างเฉพาะ realm ที่สร้าง ไม่มี verifier stub, token/secret ใน evidence หรือการส่งอีเมล หากไม่ได้กำหนด sandbox จะรายงาน NOT_RUN ไม่ถือว่าผ่าน identity gate CI สร้าง sandbox เองจึงไม่ต้องใช้ secret ของ VM/UAT

ผลทดสอบงานฐานไม่ใช่ VM UAT ของ first slice งานองค์กร/Team UI และ final Chrome/Edge สองรอบพร้อมทีมรับรองยังเป็น gates ของงานถัดไปตาม Phase Contract

## หลักฐาน CI

Workflow แนบ TAP และ manifest ใน immutable artifact แยกตาม run/attempt/job พร้อม SHA/ref/commitOnMain/clean checkout/image IDs/checksums ไม่เก็บ DSN/token/secret รายการที่ไม่รันหรือถูก skip ไม่เป็น PASS PR evidence ยังไม่อยู่ main; หลักฐานหลัง merge จึงตรวจ commitOnMain ตาม ADR-032 ได้ Manifest ระบุ VM UAT เป็น NOT_RUN เสมอสำหรับงานฐานนี้
