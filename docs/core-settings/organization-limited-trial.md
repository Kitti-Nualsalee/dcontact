# Limited trial หน้าองค์กร Core Settings

Authority: [หน้าองค์กร API/UI และ defaults สำหรับ tenant เดิม](https://github.com/Kitti-Nualsalee/dcontact/issues/726), [Phase Contract แบบ A](https://github.com/Kitti-Nualsalee/dcontact/issues/723) §§3–6, 8–10 และ [ฐาน command/receipt](./command-foundation.md)

เอกสารนี้ใช้ได้ตั้งแต่งานหน้าองค์กร ไม่ต้องรอ Team UI หรือเครื่องมือ final UAT ของงานถัดไป Limited trial ไม่ใช่ผลผ่านทั้ง slice หรือการรับรอง Chrome/Edge สองรอบของ final UAT

## สิ่งที่ release นี้เปิด

Console `?view=core-settings&page=organization&tenant=<tenant-slug>` ใช้ API `/api/v1/tenant/core-settings/organization` ผ่าน default หรือ `uat-workspace` เท่านั้น `uat`/`uat-e1` ไม่เปิด Core routes เมนู Core app อยู่พื้นที่ตั้งค่าองค์กรและมีเฉพาะหน้าองค์กรที่ทำจริง Tenant Admin แก้ได้บนจอกว้างกว่า 760px; Supervisor ที่ผ่าน verified proof และมี own active Team อ่านได้ Agent/Compliance ไม่เห็น Core แต่ Home/Account เดิมยังใช้ตามสิทธิ์

ชื่อใช้ `Tenant.name`; defaults ใช้ `TenantSettings` ไม่มีการเปลี่ยน slug/domain/Keycloak name หรือ personal preferences เมื่อบันทึก defaults ไม่ push reload/เปลี่ยนภาษาในงาน Voice ที่เปิดอยู่ ค่ารายบุคคลยังมาก่อน tenant defaults

แถว defaults เดิมเก็บ PROVISIONING พร้อม bootstrap fields เดิม แถว CORE_ADMIN ใหม่มี initialized actor/command FK และ bootstrap fields เป็น null การแก้ชื่ออย่างเดียวไม่สร้าง defaults Revision ขององค์กรครอบชื่อและ defaults และ DB capture before snapshot/transaction เดียวกัน เพิ่มหนึ่งครั้งต่อ aggregate effect แล้วตรวจ audit/receipt กับค่าที่ commit จริงก่อนตอบสำเร็จ App ไม่มีสิทธิ์เขียน counter ตรง ส่วน provisioner เดิมยัง seed ขณะ PROVISIONING ตาม saga เดิมได้ การนำเข้า fixture ของข้อมูลเก่าที่มี bootstrap fields ครบใช้ owner ใน sandbox เท่านั้น ไม่ใช้เป็นช่องตั้ง defaults จาก app

## Gates ก่อนแต่ละ trial

1. Candidate ผ่าน review และ CI บน SHA เดียวกัน หลัง merge ต้องมี immutable evidence ของ commit บน main ตาม ADR-032 บันทึก tested SHA แยกจาก current deployed base ห้ามเปลี่ยน SHA ใน evidence ให้ดูเหมือนทดสอบ image อื่น
2. ตรวจ deployment record จริงบน VM2 (`/opt/dcontact-uat/deployments/current.json`) และ image digests/config ของ API/Console/proxy/Keycloak กับ full Workspace overlay ก่อน package งานนี้ไม่ถอด Workspace/Voice overlay หรือเปลี่ยน switches/credentials ระหว่าง deploy
3. ซ้อม migration/RLS ทั้ง fresh/legacy และ old API image กับ schema ใหม่ รวม backup/restore ตามคำสั่งด้านล่าง Migration source/provenance ที่ผ่อน nullable ถูกอนุมัติใน Phase Contract แล้ว release guard pin เฉพาะ bytes ของ migration นี้ ไม่เปิด DROP NOT NULL ทั่วไป ไม่แก้ migration ที่เคย apply แล้ว
4. มี backup ของฐานจริงก่อน migrate พร้อม SHA256/ขนาด/เวลา/ผู้รับผิดชอบและ restore readiness ใช้ `dcontact_uat_owner` ที่มีสิทธิ์ตาม runbookเดิม ไม่ใช้ `dcontact_app` ทำ backup ห้ามแนบ dump/uat.env/token ใน issue หรือ CI artifacts
5. ประสานช่วง deploy กับทีม Voice ให้ไม่มีงานรอ/ring/active/WRAPUP และไม่มีสายจริง ตรวจผ่าน E1 status และ runtime/DB ที่เป็น authority แล้วจึง deploy อย่าสรุปว่า queue ว่างจากหน้า Console อย่างเดียว
6. มีบัญชีทดสอบขององค์กรที่ผ่าน operator verified proof เดิมจริง Admin สองคน, Supervisor มี own active Team และ negatives; tenant เดิม missing defaults กับ provisioned defaultsใช้ข้อมูลที่เตรียมตามหลักฐาน ไม่มี Core enrollment endpoint หรือการรับรองตนเองจาก token/email

## Package และ deploy ด้วยเครื่องมือเดิม

ทำตาม [ขั้นตอน UAT](../u1-uat-deployment.md) และ [operator 3 VM](../../infra/uat/operator/README.md) ของ SHA ที่ deploy ใช้ workflow `uat-operator-package` โดยกรอก `deployed_base_sha` จาก record จริง และ `full_workspace=true` พร้อม hosts เดิมที่ verify แล้ว ตรวจ `release.env` ว่า SOURCE_SHA ตรง candidate และทุก image เป็น digest ก่อนคัดลอก หาก main เคลื่อนไประหว่าง dispatch ให้ตรวจ SHA ของ artifact ใหม่ ห้าม deploy artifact ที่ไม่ตรงโดยอ้างผลเดิม

Stage runtime files ของ `infra/uat` และ `release.env` ใต้ `/opt/dcontact-uat/releases/<candidate-sha>/` ตาม runbookเดิม ต้องมี `docker-compose.uat.workspace.yml` และ E1 overlay/config ที่ใช้อยู่จริง พร้อมบันทึก SHA/config digest ไม่สร้าง uat.env ใหม่หรือแสดงเนื้อหา secret

ใช้ runner ของ release เดียวกันตามลำดับ `prepare → backup → migrate → deploy → smoke → record` เฉพาะหลัง gate ว่างและ backup ผ่าน ไม่รัน keycloak/provision/เปลี่ยน switches เพิ่มโดยไม่มีเหตุจำเป็นจาก release diff การเปิด Core UI ใช้ verified proof ที่มีอยู่ ไม่ต้องสร้าง identity/email ใหม่

```bash
SHA='<candidate SHA 40 ตัวที่ตรวจแล้ว>'
RUNNER="/opt/dcontact-uat/releases/$SHA/bin/uat-deploy.sh"
bash "$RUNNER" current
bash "$RUNNER" prepare "$SHA"
bash "$RUNNER" backup "$SHA"
# ตรวจ checksum และ restore readiness จากหลักฐาน backup ก่อนทำต่อ
bash "$RUNNER" migrate "$SHA"
bash "$RUNNER" deploy "$SHA"
bash "$RUNNER" smoke "$SHA" --token-stdin
# record ทำหลัง authenticated Core + Voice checks ด้านล่างครบตาม runbookเดิม
```

## Authenticated route smoke ของหน้าองค์กร

Ops image รุ่นนี้มี `scripts/core-settings-organization-smoke.mjs` เพิ่มแล้ว รันจากเครื่อง operator ที่มี Node หรือ ops image ของ candidate โดยรับ token ผ่านช่องทางส่วนตัว/env ที่มีอายุสั้น ไม่ใส่ token ใน command line/history/issue

```bash
# รับค่า CORE_SETTINGS_ACCESS_TOKEN โดยไม่ echo และไม่เปิด set -x
export CORE_SETTINGS_BASE_URL='https://dcontact-uat.osd.co.th'
# ใช้เฉพาะเมื่อเครื่องรันต้องชี้ผ่าน VM1 โดยยัง verify TLS/SNI hostname เดิม
export CORE_SETTINGS_CONNECT_HOST='192.168.102.114'
node scripts/core-settings-organization-smoke.mjs
unset CORE_SETTINGS_ACCESS_TOKEN
```

สคริปต์อ่าน runtime profile, capabilities, organization, locale wire และ navigation แล้วตรวจ unauthenticated PATCH เป็น 401 ไม่มี mutation/command/identity I/O ผล PASS นี้เป็น route smoke เท่านั้น รายงานไม่เก็บ token หรือชื่อองค์กรและระบุ `voiceSmoke=NOT_RUN`, `vmTrial=NOT_PROVEN` เสมอ Supervisor ใช้ `CORE_SETTINGS_EXPECT_WRITE=false` ได้ ต้องใช้ TLS ที่ verify ได้ ไม่มีโหมดข้าม certificate verification

## Business checks และหลักฐาน trial

เก็บ case ID, actor alias, expected/actual, browser/version, SHA/image/config/run/timezone และ checksum ของหลักฐาน ไม่เก็บ raw HAR/storageState/token/secret ปิด trace/video เว้นผ่าน redaction/สิทธิ์จัดเก็บ

| Case     | ขั้นตอนและ expected                                                                                                                                                                 |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ORG-TR01 | Admin เปิดจากเมนู server จริง แก้ชื่อ บันทึกแล้วอ่านกลับตรง receipt; ชื่ออย่างเดียวบน legacy ยัง defaults=null                                                                      |
| ORG-TR02 | ตั้ง defaults ครั้งแรกต้องเลือก TH/EN และ IANA/UTC ทั้งคู่; เปิดหน้า/session ถัดไปจึงใช้ค่าใหม่ ผู้มี personal preference ไม่ถูกเปลี่ยน                                             |
| ORG-TR03 | Admin สองคนเปิด revision เดียวกัน คนแรกบันทึก คนที่สองได้ conflict และร่างอยู่ ไม่มี auto-overwrite                                                                                 |
| ORG-TR04 | ขัดการตอบกลับหลัง save และ readback; UI ไม่แจ้งสำเร็จจนตรวจคำสั่งเดิม/readbackได้ Reload เก็บเฉพาะ commandId ไม่มี draft ใน storage                                                 |
| ORG-TR05 | Same-identity reauth หน้าเดิมคงร่างและตรวจ authority/current values/command ก่อนแก้ต่อ Sign-out/เปลี่ยน tenant/identity ล้างร่างและ reference เดิม                                  |
| ORG-TR06 | Supervisor/narrow≤760 อ่านอย่างเดียว; ย่อจอระหว่างร่างเก็บ memory กลับจอกว้าง recheck; Agent/Compliance/missing proof ไม่มี Core access และ Home/Account เดิมยังทำงาน               |
| ORG-TR07 | Keyboard/focus/error summary/TH-EN/dirty warning, back/forward/reload และ direct organization URL ผ่าน ไม่มี Team/People/Calendar placeholder                                       |
| ORG-TR08 | Voice smoke จริงหลัง deploy: SIP test caller → offer → รับสาย → เสียงสองทาง → WRAPUP/disposition+โน้ต → บันทึกและอ่านผลกลับ                                                         |
| ORG-TR09 | ระหว่างสายทดสอบ ให้ Admin แก้ชื่อ/defaults แล้วบันทึกได้ โดยสาย/เสียง/work-session/UI ภาษาของงานสดไม่เปลี่ยน เสร็จแล้วผู้ไม่มี personal preference ใช้ defaults เมื่อโหลดครั้งถัดไป |

Trial พร้อมได้เมื่อ release/migration/compatibility/backup/authenticated/Core/Voice gates ของช่วงนี้ครบ หาก VM/VPN/บัญชี/Voice fixture ไม่พร้อม ให้รายงาน NOT_RUN พร้อม blocker/ผู้ดำเนินการ ไม่ปิดเป็น VM PASS จาก CI/prototype/route smoke เพียงอย่างเดียว Final UAT ยังคงสองรอบ build/configเดียวกัน Chrome และ Edge จริง ไม่มี S1/S2 ค้าง และทีมรับรองตามงาน final UAT

## Rollback และการแก้ค่าผิด

Rollback API/Console/proxy ไป digest ก่อนหน้าที่บันทึกไว้ตาม runner เดิม คง schema, config data, revision/audit/receipt/tombstone แล้วทดสอบ old API/new schema อีกครั้ง ไม่ restore DB อัตโนมัติเพราะ readback ล้มเหลว Restore DB เป็น DR แยกโดย owner ที่รับผิดชอบจุดย้อนข้อมูล หาก config ผิดให้แก้แล้วบันทึก command ใหม่หลังทราบผลเดิมและใช้ revision ล่าสุด ไม่มี undo/ล้าง receipt เพื่อทำคำสั่งซ้ำ

## คำสั่งซ้อมใน sandbox แยก

ตั้ง `DATABASE_URL`/`APPLICATION_DATABASE_URL` ของ PostgreSQL แยก, `CORE_IDENTITY_SANDBOX_URL` loopback Keycloak 26.7.5 และ sandbox admin credential ก่อนรัน ห้ามชี้ migration/tests ไปฐาน VM

```bash
pnpm db:migrate && pnpm db:rls
pnpm --filter @d-contact/api exec tsx --test src/tenant-core-organization.integration.ts src/tenant-core-command.integration.ts
pnpm --filter @d-contact/db exec tsx --test src/tenant-core-organization.integration.ts src/tenant-core-command.integration.ts
pnpm --filter @d-contact/console test:core-settings:browser
node --test scripts/core-settings-evidence.test.mjs scripts/core-settings-release.test.mjs
```

`tenant-core-organization-old-api.boundary.ts` ใช้ image API รุ่นก่อนที่มี source label เป็น ancestor, `CORE_COMPAT_POSTGRES_CONTAINER`/`CORE_COMPAT_KEYCLOAK_CONTAINER` ของ sandbox และ `CORE_COMPAT_OLD_API_IMAGE`; migration rehearsal ใช้ `CORE_COMPAT_OLD_OPS_IMAGE` เพิ่ม สร้าง DB/network ชั่วคราวชื่อ core726_* จาก old ops จริง เตรียม legacy ก่อน apply schema ใหม่, pg_dump/restore ตรวจข้อมูล, apply RLS ซ้ำ และ cleanup เฉพาะทรัพยากรที่สร้าง Workflow Core Settings job organization-compatibility ประกอบ image จาก foundation main ที่ pin แล้วให้เอง ไม่ถือว่า baseline นี้แทนการซ้อม image ของ current deployed base ซึ่ง operator ต้องตรวจเมื่อขึ้น VM
