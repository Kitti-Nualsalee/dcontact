# Tenant People identity boundary

Implementation ของ [B2 #709](https://github.com/Kitti-Nualsalee/dcontact/issues/709) และส่วน provider intent/SMTP ของ [B3 #710](https://github.com/Kitti-Nualsalee/dcontact/issues/710) ตาม [สัญญา #704](https://github.com/Kitti-Nualsalee/dcontact/issues/704) และ [ADR-035](../../../../docs/adr/035-tenant-people-identity-authority.md) ยังไม่ใช่การเปิดใช้ provisioning บน UAT หรือ production

## B6: disable identity และ receipt

`POST dc-tenant-people/disable/:operationId` เป็น narrow service-client endpoint ไม่ใช่ public Tenant API
รับ frozen tenant/target/identity/digest/fence/role และรายชื่อ Admin สำรองที่ application ตรวจ local state แล้ว
tenant gate เดียวกับ provisioning serialize การปิดพร้อมกัน และตรวจ identity/role/Organization/credentials
ใหม่จาก local JPA provider (ไม่ใช้ cached UserModel) ใน transaction ก่อนปิดบัญชี Pending Admin,
บัญชี disabled และ identity ที่ไม่ตรงไม่ถูกนับเป็น Admin สำรอง
ล็อกแถว identity ตามลำดับ UUID เพื่อไม่ให้การแก้ enabled แข่งผ่าน guard

ปิด enabled, revoke sessions และ immutable `DISABLE_ACCOUNT` receipt ใน transaction เดียวกัน
`GET dc-tenant-people/disable/:operationId` อ่าน exact tenant/target/digest โดยไม่ส่ง mutation ซ้ำ
ผลสำเร็จต้อง readback ว่า identity ยัง disabled และไม่มี online/offline sessions; manual re-enable
หลัง receipt ทำให้ผลเป็น `UNKNOWN` ไม่คืน successful marker เก่าแทนสถานะจริง
การปฏิเสธก่อนเปลี่ยน identity มี durable `REJECTED_NO_EFFECT` receipt; network error หรือไม่มี receipt
ไม่ใช่หลักฐานสำหรับเปิด local account กลับ

receipt ที่ปฏิเสธเพราะ protected/foreign mapping หรือ identity state conflict เป็นหลักฐานว่า
operation นี้ไม่เปลี่ยน provider ไม่ใช่หลักฐานว่า account ยังปลอดภัยสำหรับ local admission
application ต้องคง deny/reconcile เมื่อพบ drift; ห้ามเปิดบัญชีกลับจาก receipt เพียงอย่างเดียว
เส้นทาง compensation ของ #713 ยังต้องตรวจ digest/revision/current operation และความสอดคล้องของ identity

Bootstrap Admin ที่ไม่มี classification ใหม่จะนับได้เฉพาะ operator ลงทะเบียนคู่
`domainUserId:keycloakIdentityId` จาก bootstrap manifest ที่ตรวจสอบแล้วใน service client attribute
`dc_verified_bootstrap_admins` (คั่นหลายคู่ด้วย comma) และ fresh role/Organization/password/TOTP probe ผ่าน
ไม่ enroll จาก email หรือ tenant membership โดยอัตโนมัติ และ protected classification/roles ยังคงถูกปฏิเสธ
application ต้องมี operator-positive binding เดิมด้วยก่อนส่ง candidate นี้ ไม่มี Tenant UI สำหรับแก้ attribute

ส่วนนี้ยังไม่เปิด public disable capability: application admission/idle closure/durable worker,
local compensation CAS และ UI เป็น gate ของ #713 ที่ต้องทำให้ครบก่อนเปิดใช้

Focused identity loop ใช้ `B6_DISABLE_BOUNDARY_ONLY=1 pnpm voice:tenant-people:boundary`
และพิมพ์ `B6_FOCUSED_IDENTITY_BOUNDARY_PASS` เท่านั้น ไม่ใช่ผลรวม B2/B3/B6
คำสั่งปกติยังรันทุกกรณีรวม real session revoke, concurrent last-Admin, manual identity drift,
protected/bootstrap classification, response readback และ receipt-failure rollback

## ทดสอบ boundary

ต้องมี Node 20, pnpm ตาม `packageManager`, Python 3 และ Docker ที่ทำงานอยู่ ติดตั้ง dependencies และ build dependencies ของ API ก่อน:

```sh
pnpm install --frozen-lockfile
pnpm db:generate
pnpm --filter "@d-contact/api^..." build
pnpm voice:tenant-people:boundary
```

Runner สร้าง network/container ชื่อสุ่มของตัวเอง ใช้ PostgreSQL บน tmpfs, Keycloak 26.7.5 และ Mailpit v1.31.1 ตาม distribution digest ของ repo เปิด port เฉพาะ loopback แบบสุ่ม compile extension กับ jars จาก image นั้นโดยตรง แล้วสร้าง realm/Organization/bootstrap user/service clients สังเคราะห์ Mailpit เก็บ mailbox ใน tmpfs ของตัวเอง โดย runner ส่งเฉพาะเมลทดสอบ `example.test` เข้า Mailpit ไม่อ่าน credentials หรือฐานข้อมูล UAT และไม่ใช้ container ของงานอื่น จะดึง image ที่จำเป็นหากยังไม่มีในเครื่อง และล้างเฉพาะทรัพยากรที่สร้างในรอบนี้เมื่อจบหรือเกิด exception

ทดสอบ service JWT/tenant binding, concurrent create/replay, stale fence/correlation conflict, foreign target no effect และ fault injection ให้ identity/role/membership rollback พร้อม receipt จากนั้นทดสอบ JWT ของ bootstrap user จริงผ่าน HTTP → application RLS → fenced worker → narrow service client → Keycloak ครบ AGENT/SUPERVISOR/ADMIN รวม response loss ที่ reconcile ด้วย readback ไม่ blind-create

บัญชีใหม่ยัง inactive, mapping/role/team ตรง, required actions ครบ และ `PENDING_ACTIVATION` ไม่มี temporary password/SIP credential/work-session lease การมี invitation intent ใน application DB ไม่ได้แปลว่าส่ง email แล้ว การส่งและ activation เป็น B3 ไม่ส่งอีเมลไปภายนอกใน boundary นี้

## B3 provider intent/SMTP ที่ยังอยู่ระหว่าง implementation

Private `readiness` แยก `invitationReady` จาก `ready` ของ provisioning: ตรวจ admin-only invitation profile, SMTP host/from/port, system client และ synchronous sender ของ pinned distribution โดยไม่ส่งอีเมล หาก invitation configuration ยังไม่พร้อมจะคืน `invitationReady: false` โดยไม่ปิด provisioning ที่ผ่านเกตเดิม นี่เป็น configuration readiness ไม่ใช่หลักฐานว่า SMTP ส่งถึงผู้รับได้ และยังไม่เปิด application scheduler หรือ public invitation capability

Private endpoints ใต้ `operations/{operationId}/invitations/{generation}/intent` และ `/dispatch` รับเฉพาะ tenant service client เดิม พร้อม accepted descriptor, `providerAttemptRef`, `fencingToken` และ `leaseOwner` ไม่รับ SMTP configuration, action link หรือ redirect URI จาก caller ต้องมี provisioning proof และตรวจ identity/role/Organization/required actions/credential state ใหม่ก่อนส่ง User Profile ของ `dc_invitation_not_before` ต้องเป็น admin-only แบบเดียวกับ classification attributes

Intent กับ not-before fence จาก Keycloak server clock commit ใน transaction เดียวกัน ส่วน dispatch claim commit ก่อน callback ส่ง SMTP ด้วย transaction ใหม่ Callback ตรวจสิทธิ์และ pending identity ซ้ำ ถือ tenant gate ระหว่างส่ง และบันทึก immutable finished receipt หลัง synchronous sender คืนผล รองรับเฉพาะ `DefaultEmailSenderProvider` ของ pinned distribution; provider อื่นไม่ถูกถือว่าให้ quiescence proof โดยอัตโนมัติ

SMTP accepted ให้ `SENT` และ quiescence proof ของ attempt เดิมเท่านั้น ส่วน SMTP exception ให้ `UNKNOWN` หาก claim commit แล้วแต่ callback/finished receipt ล้ม จะคง `DISPATCHING` และไม่มี blind retry หรือ re-arm จากเวลา/lease เมลที่ถึง Mailpit แต่ไม่มี finished receipt ไม่ใช่เหตุให้ปลด quiescence gate

Provider รับ generation ถัดไปแบบไม่ข้ามเลขเมื่อรุ่นล่าสุดมี immutable finished receipt เป็น `SENT` เท่านั้น โดยถือ tenant gate เดียวกับ callback ส่งเมล ต้องใช้ attempt ใหม่และ fencing token สูงขึ้น และ current user fence ต้องตรงกับ ledger ก่อนเปลี่ยน fence ใหม่เป็นค่าสูงสุดระหว่าง Keycloak clock, fence เดิมบวกหนึ่ง และเวลาออก token เดิมบวกหนึ่ง การเตรียม intent ไม่ส่งเมล; ต้อง readback fence และรอ Keycloak clock ถึงก่อน dispatch claim ส่วน POST รุ่นเก่าถูกปฏิเสธ แต่ finished receipt รุ่นเก่ายังอ่านได้ด้วย descriptor เดิม

Cap ฝั่ง provider จำกัดสาม resend intents ต่อ rolling 60 นาที ไม่นับ generation แรก ใช้ `createdAtEpoch` จาก Keycloak clock และนับภายใต้ tenant gate/transaction เดียวกับ insert intent จึงไม่เพิ่ม slot จาก replay หรือคำขอแข่งกัน Additive Liquibase change เพิ่ม admission epoch โดยให้ intent generation แรกเดิมมีค่า sentinel 0 ได้ ไม่แก้ immutable rows หรือ rewrite changeset เดิม Cap/ledger ฝั่ง application และ Admin command/revision/reason/audit ยังเป็นงานถัดไป

Scenario generation จริงเตรียม/ส่งรุ่น 1–4 ผ่าน provider ตรวจ concurrent replay และการแข่งกันขอ slot สุดท้าย, รุ่นที่ 5 ถูกจำกัด, INTENT/finished-receipt loss ห้ามสร้างรุ่นถัดไป, readback fence กับ Keycloak clock ก่อนส่ง, POST รุ่นเก่าไม่ส่งซ้ำ และ GET receipt เดิมยังอ่านได้ ลิงก์รุ่นแรกที่ยังไม่เคยเปิดถูก guard ปฏิเสธหลัง supersession ส่วนลิงก์รุ่นล่าสุดเปิดได้ การทดสอบนี้ยังไม่ได้รอครบ 60 นาทีเพื่อพิสูจน์การคืน slot ด้วยเวลาจริง

Runner ตรวจ concurrent intent/dispatch/replay, profile guard, atomic rollback ของ fence/intent, durable readback หลัง Keycloak restart, exact-attempt SMTP subject, required actions และอายุ token 72 ชั่วโมงจาก Keycloak clock รวม fault หลังส่งจริงแต่ก่อน finished receipt ลิงก์อ่านเฉพาะใน memory ของ mailbox test ไม่เก็บใน evidence/log/operation result

Runner compile และ mount `invitation-guard` จาก source ตัวเดียวกับ production บน pinned distribution ด้วย ตรวจลิงก์ที่ยังไม่เคยเปิด: fence สูงกว่า `iat` ต้องถูกปฏิเสธด้วยหน้า expired action และหลังคืน fence ลิงก์ pending ต้องเปิดได้ อีกลิงก์ที่ยังไม่เคยเปิดต้องถูกปฏิเสธเมื่อ fixture ไม่มี required actions ค้าง การแก้ fixture ใช้ user representation ครบเพื่อไม่ให้ admin update ล้าง email แล้วเกิดผลบวกลวงจาก invalid-email error ขั้นนี้ยังไม่ใช่หลักฐาน generation supersession แบบ monotonic/no-in-flight, การหมดอายุจริง หรือ fresh activation ผ่าน password/TOTP/login ซึ่งมีเกตแยก

ฝั่ง application มี `TenantPeopleKeycloak.invitationPort()` สำหรับ dispatch/readback โดยใช้ tenant service credentials เดิม Worker โหลด accepted payload และตรวจ digest ก่อนเรียก provider รับเฉพาะ `SENT` ที่มี field ตรง private contract ทั้งหมดและ quiescence proof ของ operation/user/generation/attempt/fence/send owner เดิม ไม่รับ field เกินหรืออนุมานผลจาก HTTP status อย่างเดียว หาก response หาย รอบถัดไปอ่านด้วย GET เท่านั้น

`reconcilePeopleInvitationAttempt` เป็น read-only path แยกจาก worker ที่ส่งคำเชิญ รับ port ที่มีเพียง `readOutcome` ไม่สร้าง dispatch claim ใหม่ หากมีแต่ `INTENT` คืน `NOT_ELIGIBLE` โดยไม่เรียก provider; หากมี frozen dispatch จะใช้ descriptor/owner เดิมอ่าน proof และบันทึกเฉพาะ receipt หรือ ambiguity ตามผลจริง ไม่เปลี่ยน identity หรือส่งเมล

Admin-only `POST /api/v1/tenant-voice/people/users/:id/reconcile` รับ `commandId/expectedRevision/reasonCode/reason` และตอบ 202/Location พร้อม operation/user/generation ไม่มี link บันทึก command digest ที่ผูก tenant/actor/action/resource/revision/reason, immutable admission receipt, accepted/rejected audit และ snapshot generation/attempt/status revision ภายใต้ scoped row locks รองรับ replay/command lookup และปฏิเสธ stale revision, foreign/protected scope และบัญชีที่ activate แล้ว การล็อก lifecycle ใช้ scoped lock-only function ไม่เพิ่มสิทธิ์แก้ lifecycle ให้ application

คิว `tenant_people_invitation_reconciles` แยกจาก create/send operations มี tenant RLS + worker binding; app insert ได้เฉพาะ admission columns ส่วน worker update ได้เฉพาะ processing columns descriptor เปลี่ยนไม่ได้และ terminal state แก้ซ้ำไม่ได้ Worker claim ด้วย bounded lease/UUID token แล้วออกจาก transaction ก่อนอ่าน provider และ finish แบบ token CAS; restart/lease expiry ทำซ้ำได้เฉพาะ read ไม่ส่งเมล `SUCCEEDED` หมายถึงมี delivery receipt เดิม ไม่ใช่ activation สำเร็จ หากไม่มี dispatch/ผลยังไม่ชัด/อ่านไม่ได้จะเป็น `ACTION_REQUIRED` โดยไม่เพิ่ม generation หรือแก้ user.configRevision

Endpoint ต้องผ่าน `canReconcileInvitation` ของ opt-in runtime และมี invitation port ที่พร้อม; composition ปกติไม่ส่ง port นี้จึงยังตอบ `CAPABILITY_NOT_READY` คิวใช้ batch budget ร่วมและสลับกับงานส่งปกติ ไม่เปิด full invitation capability จากการเพิ่ม reconcile endpoint นี้

Application intent key แยก `(tenant, create operation, generation)` และ dispatch fence ต้องไม่น้อยกว่า generation อ่าน frozen dispatch ด้วยทั้ง generation/attempt ที่ command snapshot ไว้ จึง reconcile รุ่นเดิมที่ค้างอยู่ได้แม้มี intent รุ่นใหม่ และไม่ใช้ receipt รุ่นเดิมแทนรุ่นล่าสุด Directory ยังเลือกสถานะจาก generation สูงสุดโดยไม่เปลี่ยน user.configRevision การเปลี่ยน PK ต้องอัปเดต SQL `ON CONFLICT` ของ provisioning worker พร้อม migration นี้ ไม่ถือว่า worker รุ่นเก่าที่ใช้ conflict target เดิมรองรับ schema ใหม่แบบ rolling โดยอัตโนมัติ

Adapter อ่าน exact provider receipt ของ generation ที่ร้องขอได้ รวม historical receipt หลัง supersession แต่ legacy `dispatch`/automatic scheduler ยังคง generation แรก รุ่นใหม่ที่ยังไม่มี preparation/readback barrier จะไม่สร้าง claim หรือ POST ส่งเมล การทดสอบ HTTP/RLS หลาย generation ใช้ fixture ของ approved worker เพื่อพิสูจน์การอ่าน ไม่ใช่หลักฐานว่า public resend capability เปิดใช้แล้ว

Adapter มี `readPreparation` แบบ GET-only สำหรับ exact generation/attempt/digest/fence/owner ตรวจ intent proof ครบทุก field และคืน `clockReached` จาก `serverEpoch >= notBeforeEpoch` ของ Keycloak เท่านั้น ไม่ใช้เวลาบน application หรือ lease expiry เป็นหลักฐาน การอ่านไม่ได้หรือ proof ไม่ตรงไม่เปลี่ยนเป็น permission ส่งเมล และ `INTENT` ไม่ใช่ finished/quiescent receipt; application ยังต้องมี durable preparation barrier และตรวจ no-in-flight ก่อนเปิด sender รุ่นใหม่

Boundary ฝั่ง real JWT HTTP → PostgreSQL/RLS → Keycloak → SMTP ตรวจครบสาม roles ว่าคืนสถานะ `SENT` ผ่าน API หลัง lost response และปฏิเสธ proof ที่มี field เกิน บัญชียัง inactive/PENDING ไม่สร้าง SIP credential หรือ work-session lease

`TenantPeopleRuntime` รับ `invitations` เป็น tenant-bound port แบบ opt-in เท่านั้น ค่าเริ่มต้นว่าง และ composition ปกติยังไม่ส่ง port นี้ ก่อน claim ต้องผ่าน DB principal/binding, provisioning readiness และ invitation readiness ที่ตอบ `invitationReady: true` อย่างชัดเจน รุ่น provider ที่ไม่มี field นี้ถือว่ายังไม่พร้อม งาน invitation ใช้ batch budget ร่วมกับ provisioning สลับคิวต่อ tenant และเลื่อน cursor เพื่อไม่ให้ attempt ที่ยังไม่ทราบผลขวางรายการอื่น ภายใน batch เดียวไม่ทำ attempt เดิมซ้ำ ไม่มี transaction ครอบ provider call; shutdown รอ in-flight drain จบ

Boundary ตรวจ gate ปิดแล้วสถานะยัง `INTENT`/ไม่มี dispatch, gate เปิดแล้ว response หายเป็น `AMBIGUOUS`, proof ผิดรูปไม่ผ่าน และ runtime ใหม่อ่าน finished receipt เดิมผ่าน GET จนเป็น `SENT` โดย POST รวมเพียงครั้งเดียวต่อ role ยังไม่เปิด public invitation capability หรือส่งเมลจาก runtime ปกติ

### Resend admission และ readiness

Admin-only `POST /api/v1/tenant-voice/people/users/:id/invitation/resend` มี readiness gate แยก `canResendInvitation` ซึ่ง normal composition ยังไม่เปิด รับ common command envelope แล้วบันทึก immutable reservation ใน `tenant_people_invitation_resends`, command receipt และ audit ใน transaction เดียว มี generation candidate/Location และ operation read เป็น `QUEUED/PREPARE_INVITATION` แต่ยังไม่สร้าง generation intent, invalidate link หรือส่ง email

ตรวจ user config/status revision, positive verified mapping และ latest local `SENT/quiescent` receipt ภายใต้ user/lifecycle lock ก่อนรับงาน ไม่รับ `INTENT`, ambiguity หรือ activated user; replay command เดิมคืนผลเดิมโดยไม่กิน slot เพิ่ม อีก command ของ generation ที่จองแล้วถูกปฏิเสธ DB trigger ตรวจ eligibility/snapshot/receipt ซ้ำและจำกัด 3 admissions ต่อ rolling 60 นาทีด้วย DB clock และ row lock แยกจาก cap ของ Keycloak ไม่นับ initial send; reservation ที่รับแล้วไม่ถูกปลดจาก timeout/lease expiry application แก้ timestamp ไม่ได้ ledger ห้าม UPDATE/DELETE และ worker อ่านได้เฉพาะ tenant ที่ผูกไว้

การทดสอบ cap ฝั่ง HTTP/RLS ใช้ approved-worker fixtures ของ generation/finished proof เพื่อเดินถึงแต่ละ slot ไม่ใช่หลักฐานของ SMTP ทุก generation มี explicit resend worker และ opt-in scheduler แล้ว แต่ normal readiness ยังปิด การ release slot หลังครบ 60 นาทีและ failure gates ที่ยังไม่ครอบคลุมต้องทดสอบเพิ่มเติมก่อน acceptance

### Durable preparation/readback barrier

`runPeopleInvitationPreparation` รับ reservation ที่ระบุผ่าน approved worker เท่านั้น ล็อก user/lifecycle แล้วตรวจ config/status snapshot, mapping, pending state และ previous `SENT/quiescent` receipt ก่อนบันทึก immutable preparation descriptor และ generation intent ใน transaction เดียว ใช้ fence มากกว่า dispatch รุ่นก่อนและคง owner/attempt/lease เดิมตลอด จากนั้นจึงออกจาก transaction เพื่อ POST preparation ได้เพียงผู้ที่ insert claim สำเร็จ ไม่สร้าง dispatch claim หรือส่งเมลในขั้นนี้

การ restart/concurrent invocation/response loss จะอ่าน frozen descriptor และทำ GET-only readback ไม่ POST preparation ซ้ำ แม้ lease หมดหรือยังไม่พบ provider intent ถ้า clock ยังไม่ถึงหรือ proof ไม่ชัด คง `WAITING_EXTERNAL/READ_INVITATION_FENCE` และไม่มี permission ส่ง เมื่อ exact readback มี monotonic not-before มากกว่ารุ่นก่อนและ Keycloak clock ถึงแล้ว บันทึก immutable preparation proof และแสดง `DISPATCH_INVITATION`; phase `READY` นี้ไม่ใช่ delivery success, activation หรือ authorization ส่งเมลโดยลำพัง sender ยังต้องใช้ descriptor/proof เดิมและตรวจ fresh guard ก่อน side effect

มี HTTP/RLS test ของ response loss, concurrent read-only recovery และ immutable/tenant isolation รวม real HTTP → PostgreSQL → Keycloak preparation/readback ที่ Mailpit ไม่เพิ่มอีเมล ก่อนทดสอบ explicit sender ต่อ

### Generation-aware sender และ terminal delivery operation

`runPeopleInvitationResend` ล็อก user/lifecycle และตรวจ pending mapping/config/status snapshot กับ latest generation อีกครั้ง แล้วสร้าง immutable dispatch claim จาก frozen preparation descriptor ได้เมื่อมี durable preparation proof เท่านั้น fence/owner/attempt คงเดิม มีเพียงผู้ insert dispatch สำเร็จที่เรียก `dispatchPrepared` ได้ adapter อ่าน exact intent/fence/Keycloak clock ใหม่ก่อน POST และ provider ยังตรวจ fresh identity/credential/role/Organization ก่อน SMTP

เมื่อ dispatch claim มีแล้ว restart หรือ worker คู่แข่งจะ GET outcome เท่านั้น แม้ lease หมดและผู้ส่งเดิมยังค้าง ไม่ rearm หรือให้ resend ใหม่จาก timeout เมื่อ response หายจะเป็น `ACTION_REQUIRED/INVITATION_DELIVERY_AMBIGUOUS` จนมี exact finished/quiescent receipt; outcome `SENT` ต้องใช้ not-before เดียวกับ frozen proof แล้วจึงเป็น `SUCCEEDED/INVITATION_FINISHED` receipt มี precedence เหนือ ambiguity เดิม ส่วน `FAILED` เป็น `ACTION_REQUIRED/INVITATION_DELIVERY_FAILED` status revision เพิ่มตาม immutable processing facts โดยไม่เปลี่ยน user.configRevision หรือ activate ผู้ใช้

Real HTTP → PostgreSQL → Keycloak → Mailpit boundary ทดสอบ preparation แล้วส่ง generation 2 จริงใน sandbox จำลอง SMTP response loss และเริ่ม worker อ่านใหม่จนจบ operation นับอีเมลเพิ่มเพียงหนึ่งฉบับ ไม่มี SIP credential/work-session lease หรือ ACTIVE จากการส่งสำเร็จ นี่เป็น explicit-worker integration ไม่ใช่ normal runtime rollout หรือ B3 acceptance ทั้งหมด

### Opt-in resend scheduling

`TenantPeopleRuntime` รับ `resends` map แยกจาก initial `invitations` map ต้องมี full preparation/readback/prepared-dispatch/outcome/readiness port และ tenant อยู่ใน approved identity map จึงประกอบได้ ค่าเริ่มต้นไม่มี resend port และ normal composition ยังไม่ส่ง map นี้ `canResendInvitation` ต้องผ่าน running/healthy, approved least-privilege database principal/binding และ provider readiness แยกจาก initial send/reconcile

Scheduler สลับ resend กับ initial delivery/reconcile และ provisioning ภายใต้ batch/tenant budget เดิม มี UUID cursor ต่อ tenant และ deferred key ต่อ resend ทำได้เพียงหนึ่ง phase ต่อ reservation ต่อ drain จึงไม่วน GET งาน unknown เดิมจนกินทั้ง batch และไม่วน terminal receipt อีก เมื่อมี proof จึงไป sender; ถ้า restart ขณะ preparation ค้างจะอ่าน descriptor เดิมผ่าน GET เท่านั้น ไม่ POST preparation ใหม่ การปิด readiness หยุด phase ใหม่ และ shutdown รอ in-flight phase ก่อนจบ

มี focused HTTP/PostgreSQL/RLS test ด้วย approved login principal ที่แยกเฉพาะ sandbox: default-off, readiness pause/recovery, shutdown ระหว่าง preparation และ restart จน terminal โดยไม่ prepare/send ซ้ำ การทดสอบ SMTP จริงใน boundary ก่อนหน้าเป็น explicit-worker integration; ต้องรัน scheduler + Keycloak/SMTP รวมอีกครั้งก่อน acceptance ไม่ถือว่า mock/controlled port นี้เป็น real SMTP proof

Normal invitation capability ยังปิด Console resend/activation ยังไม่เปิด การทดสอบนี้ยังไม่ใช่ acceptance ของ B3 ทั้งหมด โดยเฉพาะ normal composition, rolling-window release, expiry ด้วยเวลาจริง และ fresh activation proof ผ่าน password/TOTP/login ยังต้องผ่านเกตของตนเอง

ไฟล์ `tenant-people-operations.integration.ts` แยกทดสอบ HTTP/RLS/quotas/claims ด้วย identity port ที่ควบคุมได้ ไม่ใช้ผลชุดนั้นแทน real Keycloak boundary ส่วน `tenant-people-keycloak.boundary.ts` และ `tenant-people-provisioning.boundary.ts` รับ environment ของ runner และ fail หากไม่มี configuration ไม่ skip แล้วนับผ่าน

## สิทธิ์และ rollout

`dc-tenant-people` รับเฉพาะ tenant service client ที่ผูก purpose, tenant, Organization, audience และ role allowlist โดย operator ผู้ใช้ใหม่มี positive classification/operation correlation ที่ user แก้เองไม่ได้ ไม่ให้ realm-management และไม่เพิ่มสิทธิ์ให้ account-service/browser

Application HTTP role เขียน mapping หรือ terminal lifecycle โดยตรงไม่ได้ worker ใช้ NOBYPASSRLS role และ operator-approved database-principal binding ฟังก์ชัน mapping ตรวจ tenant, live fence, accepted payload และ receipt ก่อนแก้เฉพาะ Keycloak reference/verification state ไม่เปิด `isActive` แทน activation

Identity/DB preflight ใช้ service JWT ตรวจ tenant/Organization/audience, User Profile และ role allowlist ที่ Keycloak จริง พร้อมตรวจว่า connection ใช้ worker role ภายใต้ login principal แยกที่เป็น `NOINHERIT`, ไม่เป็น superuser/`BYPASSRLS` และไม่มี role memberships อื่น Binding ต้องเปิดอยู่และตรง `session_user` ทุกครั้ง ไม่ถือว่าบัญชี owner ที่เพียง `SET ROLE` เป็น worker ผ่าน gate นี้ Boundary ใช้ login สังเคราะห์แยกและตรวจ revoke binding/overprivileged principal จริงด้วย

Runtime เริ่ม scheduler แบบ bounded และไม่ทำงานซ้อนกันเมื่อ Nest เริ่ม module; หยุดรับงานและรอ step ที่กำลังทำก่อนปิด connection เมื่อ shutdown การเลือกงาน/lease/receipt อยู่ใน DB ไม่อาศัยคิวใน memory และ unknown outcome อ่านคืนเท่านั้น ไม่ blind-create

หาก provider ยืนยัน `CORRELATION_CONFLICT` หรือ receipt สำเร็จอ้าง identity คนละคน จะเก็บ reason แบบ immutable พร้อม receipt ที่ outcome ยังไม่ยืนยันและเปลี่ยน operation เป็น `ACTION_REQUIRED`/บัญชี `ATTENTION_REQUIRED` worker ไม่ claim งานนั้นซ้ำ ไม่ adopt identity และไม่ทำ destructive compensation ส่วน timeout/unknown ที่ไม่มีหลักฐาน conflict คง `WAITING_EXTERNAL` เพื่ออ่านคืนเท่านั้น

Composition ของ API ปกติและ workspace profile ปิด People provisioning เป็นค่าเริ่มต้น เปิดเมื่อ operator ตั้ง `TENANT_PEOPLE_WORKER_DATABASE_URL` สำหรับ login แยก (`options=-c role=dcontact_tenant_people_worker`) พร้อม `TENANT_PEOPLE_BINDINGS_JSON` เท่านั้น ไม่ fallback ไป application/owner connection แต่ละ binding มี `tenantId`, `issuer`, `clientSecretEnv` (ชื่อ `TENANT_PEOPLE_SECRET_*`) และ `nodes` โดย secret อยู่ใน environment ฝั่ง server ไม่อยู่ใน JSON หรือ browser

แต่ละ node ระบุ `telephonyNodeId`, `releaseDigest`, `dialplanDigest` (SHA-256 hex) และ `extensions` (เลข 4–6 หลักไม่ซ้ำ) ต้องตรงกับ node ที่ตั้งใน `SIP_BROWSER_NODES_JSON` Pool ที่ operator อนุมัติใน policy ต้องเป็น object `{ref, telephonyNodeId, releaseDigest, dialplanDigest}` และตรงกับ manifest นี้ จึงแสดงให้เลือกและรับ AGENT ได้ pool แบบ string เดิมไม่ถือว่าผ่าน infrastructure gate Snapshot ถูกตรึงกับ operation; worker หยุดรอเมื่อ manifest เปลี่ยนไม่ตรงกับ snapshot

Manifest นี้เป็นการรับรอง configuration ของ operator ไม่ใช่ live SIP/media probe หรือหลักฐาน rollout จริง เกต B7 ยังต้องตรวจ node/release/dialplan และ media บน environment เป้าหมาย การมี service secret หรือผ่าน token endpoint อย่างเดียวไม่เพียงพอ

Console เปิดหน้า `view=tenant-people` สำหรับ Admin ผ่าน registry และใช้ capability จาก server ก่อนเปิด create/status บัญชีที่ provision แล้วแสดงรอ activation ไม่ใช่ READY และ recovery หลัง reload เก็บเฉพาะ command/operation reference ไม่เก็บข้อมูลบัญชีหรือ token

List/detail อ่านเฉพาะบัญชีที่มี operator bootstrap proof ตรง scope หรือเป็น target ของ B2 operation/lifecycle ไม่ถือ membership เป็น authority บัญชีเดิมที่ไม่มี lifecycle แสดงสถานะยังไม่ยืนยัน ไม่อนุมานว่า activated จาก `isActive` เพียงอย่างเดียว Cursor ผูก tenant/actor/scope/filter และใช้ keyset `createdAt/id` (default20, limit20–100); `user.configRevision` แยกจาก `statusRevision` ของ lifecycle บัญชีที่เลือกเปิด operation เดิมได้โดยไม่ส่ง create ใหม่

Known legacy Agent/Supervisor/Admin ที่มี operator-positive binding แต่ยังไม่มี B2 lifecycle อ่านได้แบบ read-only/UNKNOWN โดยไม่สร้าง lifecycle, invitation หรือ adopt identity ส่วน unclassified legacy และ proof ที่ถูกถอนยัง fail-closed ไม่ใช้ role/tenant membership ล้วนเป็นเหตุให้นำ platform/service identity มาแสดง หากต้องการแสดงกลุ่มที่ยังแยก classification ไม่ได้ ต้อง resolve authority decision ก่อน ไม่เพิ่ม read authority หรือ provider probe โดยเดา

เมื่อ create ถูกปฏิเสธก่อน accept อย่างแน่นอน UI ปลด pending เพื่อแก้ข้อมูล/ส่งคำสั่งใหม่ แต่ timeout หรือผลไม่ชัดยังอ่าน command เดิมเท่านั้น สถานะ operation ที่เปิดอยู่ poll ทุก 5 วินาทีเฉพาะแท็บ visible ไม่ซ้อน manual refresh และหยุดเมื่อ terminal/หมดสิทธิ์/unmount

ก่อนเปิดใช้จริงต้องมี acceptance/review ครบ รวม extension pool/infra readiness ตามสัญญา B2 การ build extension หรือ boundary ผ่านอย่างเดียวไม่ใช่ production readiness และห้าม bootstrap/แก้ identity บน VM เป็นส่วนหนึ่งของ implementation sandbox
