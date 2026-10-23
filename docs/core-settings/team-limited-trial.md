# Limited trial หน้า Team และเมนู Core Settings

Authority: [หน้า Team เมนู Settings และ browser integration จริง](https://github.com/Kitti-Nualsalee/dcontact/issues/728), [Phase Contract](https://github.com/Kitti-Nualsalee/dcontact/issues/723) และ [owner amendment 24 ตุลาคม 2569](https://github.com/Kitti-Nualsalee/dcontact/issues/723#issuecomment-6370929347)

Owner ให้เริ่มพัฒนาและลอง Team UI บน local หลังหน้าองค์กรผ่าน local acceptance ขณะ VM ไม่พร้อม การปรับลำดับนี้ไม่ปิดงานหน้าองค์กร ไม่แทน VM acceptance และไม่ยกเลิก gates ก่อน limited trial บน VM

## UI และสิทธิ์

ทางเข้าจริง `?view=core-settings&page=organization|teams&tenant=<slug>` และ detail `&team=<uuid>` ใช้ Core app เดียวใน settings area ตาม server registry/capabilities; Console ใหม่กับ API รุ่นเก่าที่ไม่มี pages มีลิงก์ในเนื้อหาตาม capability ไม่มี prototype fixture ID ใน production registry

Admin สร้าง active Team, เปลี่ยนชื่อ active/inactive และปิดทีมหลัง explicit confirmation ได้บนจอกว้างกว่า760px เท่านั้น Supervisor อ่านเฉพาะ own active Team ไม่มีปุ่มเปลี่ยนข้อมูล Agent/Compliance/บัญชีไม่มี verified proof ถูกปฏิเสธ ทุก mutation/read/receipt ใช้ server authority เดิม ไม่เพิ่ม enrollment หรือ bypass

ปิดทีมเมื่อ Team API ผ่าน atomic guards ของ [inventory](./team-reference-inventory.md) เท่านั้น UI แสดงชนิดและจำนวน blockers โดยไม่มี force/unassign/auto-revoke/reactivate การปิดไม่ลบ UUID หรือประวัติ ชื่อ normalize/validation และ case-sensitive uniqueness ตาม server

คำสั่งหนึ่งใช้ commandId เดิมจน terminal/readback; reload เก็บเฉพาะ commandId ของ tenant/identity/resource ไม่มีร่างหรือ token ใน Core storage การสร้างใช้ client resource UUID เดิมใน URL และ command receipt; การยกเลิก dialog ก่อนสร้างสำเร็จคืนหน้าก่อนหน้า ร่างอยู่ memory เท่านั้น Busy/unknown ต้องตรวจคำสั่งเดิม ไม่กด mutation ใหม่เพื่อหลบ pending

## ก่อนขึ้น VM

ทำตาม [gates/package/deploy/rollback ของหน้าองค์กร](./organization-limited-trial.md) ทั้งหมด โดยขยาย implemented routes/menu เป็นองค์กร+ทีม และใช้ evidence ของ SHA ที่ release จริง:

1. Review/CI บน candidate เดียวกัน; หลัง merge ต้องมี immutable main evidence ตามADR032 ไม่ใช้ผล local ที่มี source changes เป็นผลของ main
2. ตรวจ deployed base/image digests/config/realm/proxy/Workspace overlay บน VM จริงเมื่อ VM กลับมา ไม่เดาจาก deployment record เก่า ไม่เปลี่ยนบัญชีพัก UAT ที่ owner ให้คงไว้
3. ซ้อม additive migration/RLS และ old API/new schema กับ deployed base จริง พร้อม backup/checksum/restore readiness ของฐานจริงก่อน migrate ไม่มี migration ใหม่ในงาน UI นี้
4. API ก่อน Console เพื่อเพิ่ม registry pages แบบ additive; ถ้า rollback API เมนู fallback ยังเข้า implemented pages ตาม capability ได้ คง `uat`/`uat-e1` ปิด Core routes และเปิดเฉพาะ default/`uat-workspace` ตามเดิม
5. ประสาน Voice idle ไม่มีรอ/ring/active/WRAPUP แล้วใช้ runner prepare → backup → migrate → deploy → smoke; ไม่รัน keycloak/provision หรือเปลี่ยน switches โดยอัตโนมัติ
6. Authenticated Core smoke และ actual Voice smoke ต้องผ่านก่อน record; VM ใช้งานไม่ได้ให้รายงาน NOT_RUN ไม่สร้าง VM PASS จาก local/CI

## Authenticated route smoke

ใช้ script เดิมใน ops image ของ candidate เพิ่ม Team mode โดยรับ token ส่วนตัวที่มีอายุสั้นผ่าน environment ไม่ echo หรือใส่ command line:

```bash
export CORE_SETTINGS_BASE_URL='https://dcontact-uat.osd.co.th'
export CORE_SETTINGS_INCLUDE_TEAMS=true
# ตั้ง CORE_SETTINGS_ACCESS_TOKEN ผ่านช่องทางส่วนตัว
node scripts/core-settings-organization-smoke.mjs
unset CORE_SETTINGS_ACCESS_TOKEN CORE_SETTINGS_INCLUDE_TEAMS
```

Supervisor ใช้ `CORE_SETTINGS_EXPECT_WRITE=false` และต้องมี own active Team. Team mode ตรวจ capabilities/menu/list/detail/no-store และ unauthenticated POST ถูกปฏิเสธจริง ไม่มี config/command/identity mutation ไม่เก็บชื่อทีม/token ในรายงาน `voiceSmoke=NOT_RUN`, `vmTrial=NOT_PROVEN` เสมอ จึงต้องทำ business checks ด้านล่างแยก

## Business checks

| Case      | ขั้นตอนและ expected                                                                                                                               |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| TEAM-TR01 | Admin สร้างทีมผ่าน UI → receipt/readback → URL UUID จริง; trim/no-op/validation/ชื่อซ้ำไม่สร้างข้อมูลซ้ำ                                          |
| TEAM-TR02 | เปลี่ยนชื่อโดย UUID เดิม; Adminสองคนแก้ revision เดียวกัน คนหลังได้ conflict และร่างไม่ถูกเขียนทับ                                                |
| TEAM-TR03 | ยืนยัน/ยกเลิกปิดทีม, keyboard/Escape/focus trap/return focus; inactive ยัง rename ได้ ไม่มี reactivate                                            |
| TEAM-TR04 | User/Queue/Skill/สิทธิ์/current ownership/งานค้างบล็อกจริง แสดงชนิด+count; history-only ไม่บล็อก; unresolved legacy บล็อกเฉพาะปิดทีม              |
| TEAM-TR05 | Lost response/readback/reauth/reload ตรวจ receipt เดิมก่อนแก้ต่อ; createไม่ซ้ำ; busy/late POST ถูก reconcile/fence; storage มีเฉพาะ commandId     |
| TEAM-TR06 | Supervisor own team readonly; Agent/Compliance/foreign/missing/revoked proof ไม่เห็น metadata หรือ mutation; ไม่ใช้ cached capability             |
| TEAM-TR07 | production deep links/back/forward/refresh/dirty warning/TH-EN และ narrow≤760 readonly; ย่อระหว่างร่างเก็บ memory ขยายกลับตรวจ revision/authority |
| TEAM-TR08 | API รุ่นก่อน/Console ใหม่ navigation fallback; runtime allowlist ไม่เปิด test hooks/prototype และ profiles uat/uat-e1 ยังปิด                      |
| TEAM-TR09 | SIP caller → offer → รับ → เสียงสองทาง → WRAPUP/disposition+โน้ต → save/readback; แก้ชื่อ/defaults ระหว่างสายไม่เปลี่ยนงานสด                      |

เก็บ case/browser/version/run/timezone/actor alias/expected-actual/tested+deployed SHA/image+config digests/fixture version/checksum ของหลักฐาน ห้าม raw JWT/password/HAR/storageState ใน issue. Trace/video ปิดตามเดิม หน้าองค์กรและทีม limited trialไม่ใช่ final slice PASS; final UATยังต้องสองรอบต่อเนื่องบน build/configเดียวกัน ChromeและEdgeจริง ไม่มีS1/S2ค้าง และowner/ผู้แทนทีมรับรอง

## Local และ CI

ใช้ disposable loopback PostgreSQL/RLS + Keycloak26.7.5 และ synthetic verified proof ตาม browser harness เดิม ห้ามต่อฐาน VM. `pnpm --filter @d-contact/console test:core-settings:browser` discover organization/teams/navigation specs ทั้งหมด งาน CI `settings-browser` รัน browserจริงและ evidence manifest; unit/model/typecheck/build/i18n/CSS เพิ่มตาม explicit scripts เดิม ไม่ใช้ route.fulfill เป็น proof ของ Core API

Local/CI PASS และ synthetic proofไม่แทน Admin proof ของ kittin หรือบัญชี UAT. ไม่ activateบัญชีพักจากการทดสอบ local

## Rollback

Rollback API/Console/proxy ไป digest ที่บันทึกก่อนหน้า คง DB/schema/data/revisions/audit/receipts/tombstones แล้วตรวจ old API/new schemaและnavigation fallback ไม่ down-migrate/drop history. Restore DBเป็น DRแยก มีownerรับผิดชอบจุดย้อนข้อมูล ไม่ทำอัตโนมัติเมื่ออ่านกลับล้มเหลว
