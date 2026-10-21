# Tenant People identity boundary

Implementation ของ [B2 #709](https://github.com/Kitti-Nualsalee/dcontact/issues/709) และส่วน provider intent/SMTP ของ [B3 #710](https://github.com/Kitti-Nualsalee/dcontact/issues/710) ตาม [สัญญา #704](https://github.com/Kitti-Nualsalee/dcontact/issues/704) และ [ADR-035](../../../../docs/adr/035-tenant-people-identity-authority.md) ยังไม่ใช่การเปิดใช้ provisioning บน UAT หรือ production

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

Private endpoints ใต้ `operations/{operationId}/invitations/1/intent` และ `/dispatch` รับเฉพาะ tenant service client เดิม พร้อม accepted descriptor, `providerAttemptRef`, `fencingToken` และ `leaseOwner` ไม่รับ SMTP configuration, action link หรือ redirect URI จาก caller ต้องมี provisioning proof และตรวจ identity/role/Organization/required actions/credential state ใหม่ก่อนส่ง User Profile ของ `dc_invitation_not_before` ต้องเป็น admin-only แบบเดียวกับ classification attributes

Intent กับ not-before fence จาก Keycloak server clock commit ใน transaction เดียวกัน ส่วน dispatch claim commit ก่อน callback ส่ง SMTP ด้วย transaction ใหม่ Callback ตรวจสิทธิ์และ pending identity ซ้ำ ถือ tenant gate ระหว่างส่ง และบันทึก immutable finished receipt หลัง synchronous sender คืนผล รองรับเฉพาะ `DefaultEmailSenderProvider` ของ pinned distribution; provider อื่นไม่ถูกถือว่าให้ quiescence proof โดยอัตโนมัติ

SMTP accepted ให้ `SENT` และ quiescence proof ของ attempt เดิมเท่านั้น ส่วน SMTP exception ให้ `UNKNOWN` หาก claim commit แล้วแต่ callback/finished receipt ล้ม จะคง `DISPATCHING` และไม่มี blind retry หรือ re-arm จากเวลา/lease เมลที่ถึง Mailpit แต่ไม่มี finished receipt ไม่ใช่เหตุให้ปลด quiescence gate

Runner ตรวจ concurrent intent/dispatch/replay, profile guard, atomic rollback ของ fence/intent, durable readback หลัง Keycloak restart, exact-attempt SMTP subject, required actions และอายุ token 72 ชั่วโมงจาก Keycloak clock รวม fault หลังส่งจริงแต่ก่อน finished receipt ลิงก์อ่านเฉพาะใน memory ของ mailbox test ไม่เก็บใน evidence/log/operation result

Runner compile และ mount `invitation-guard` จาก source ตัวเดียวกับ production บน pinned distribution ด้วย ตรวจลิงก์ที่ยังไม่เคยเปิด: fence สูงกว่า `iat` ต้องถูกปฏิเสธด้วยหน้า expired action และหลังคืน fence ลิงก์ pending ต้องเปิดได้ อีกลิงก์ที่ยังไม่เคยเปิดต้องถูกปฏิเสธเมื่อ fixture ไม่มี required actions ค้าง การแก้ fixture ใช้ user representation ครบเพื่อไม่ให้ admin update ล้าง email แล้วเกิดผลบวกลวงจาก invalid-email error ขั้นนี้ยังไม่ใช่หลักฐาน generation supersession แบบ monotonic/no-in-flight, การหมดอายุจริง หรือ fresh activation ผ่าน password/TOTP/login ซึ่งมีเกตแยก

ฝั่ง application มี `TenantPeopleKeycloak.invitationPort()` สำหรับ dispatch/readback โดยใช้ tenant service credentials เดิม Worker โหลด accepted payload และตรวจ digest ก่อนเรียก provider รับเฉพาะ `SENT` ที่มี field ตรง private contract ทั้งหมดและ quiescence proof ของ operation/user/generation/attempt/fence/send owner เดิม ไม่รับ field เกินหรืออนุมานผลจาก HTTP status อย่างเดียว หาก response หาย รอบถัดไปอ่านด้วย GET เท่านั้น

Boundary ฝั่ง real JWT HTTP → PostgreSQL/RLS → Keycloak → SMTP ตรวจครบสาม roles ว่าคืนสถานะ `SENT` ผ่าน API หลัง lost response และปฏิเสธ proof ที่มี field เกิน บัญชียัง inactive/PENDING ไม่สร้าง SIP credential หรือ work-session lease

`TenantPeopleRuntime` รับ `invitations` เป็น tenant-bound port แบบ opt-in เท่านั้น ค่าเริ่มต้นว่าง และ composition ปกติยังไม่ส่ง port นี้ ก่อน claim ต้องผ่าน DB principal/binding, provisioning readiness และ invitation readiness ที่ตอบ `invitationReady: true` อย่างชัดเจน รุ่น provider ที่ไม่มี field นี้ถือว่ายังไม่พร้อม งาน invitation ใช้ batch budget ร่วมกับ provisioning สลับคิวต่อ tenant และเลื่อน cursor เพื่อไม่ให้ attempt ที่ยังไม่ทราบผลขวางรายการอื่น ภายใน batch เดียวไม่ทำ attempt เดิมซ้ำ ไม่มี transaction ครอบ provider call; shutdown รอ in-flight drain จบ

Boundary ตรวจ gate ปิดแล้วสถานะยัง `INTENT`/ไม่มี dispatch, gate เปิดแล้ว response หายเป็น `AMBIGUOUS`, proof ผิดรูปไม่ผ่าน และ runtime ใหม่อ่าน finished receipt เดิมผ่าน GET จนเป็น `SENT` โดย POST รวมเพียงครั้งเดียวต่อ role ยังไม่เปิด public invitation capability หรือส่งเมลจาก runtime ปกติ

ส่วนนี้ยังรองรับ generation แรกเท่านั้น รุ่นถัดไปถูกปฏิเสธ ไม่มี Console resend/activation เปิดใช้งาน การทดสอบ provider นี้ยังไม่ใช่ acceptance ของ B3 ทั้งหมด โดยเฉพาะ resend cap, monotonic supersession, old/expired/activated-link guard และ fresh activation proof ยังต้องผ่านเกตของตนเอง

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
