# M3-A: service principal และสิทธิ์ต่อ Contact

งาน #841 ตาม Phase Contract #832. สร้างบน main `a460cde` โดยไม่เปลี่ยน human authorization ของ C1 หรือเปิด customer CRUD ให้ service ก่อน slice B

## สิ่งที่ส่งต่อ

- Principal ผูก `(tenant,issuer,subject,clientId)` และ custodian ที่ operator อนุมัติ มี authzEpoch; ไม่มี token/secret ใน DB
- Grants/revocations เป็น append-only, tenant FK/RLS และ exact command evidence. Role `service`/token scope ไม่ให้ Contact READ/CREATE โดยตัวมันเอง
- `currentC360ServicePrincipal(tx,request)` ใช้หลัง global OIDC service guard เท่านั้น และคืน principal ที่ถือ shared row guard ใน transaction นี้
- `authorizeC360ServiceCapability(tx,p)` ตรวจ CONTACT_CREATE + custodian ยัง active domain ADMIN และถือ User row guard
- `authorizeC360ServiceContact(tx,p,contactId)` อนุญาตเฉพาะ persisted READ grant ที่ยังไม่ถูกถอน. ไม่ตาม grant ไป canonical target หลัง merge
- `c360ServiceActor(identity,bindingId)` ใช้เฉพาะ issuer/subject/tenant/client/binding ใน namespace SERVICE; ไม่ใช้ token bytes/roles/sid เป็น command identity
- Operator ใช้ C1 `/api/v1/customer-360/operator/commands`, dryRun/evidence/reason/digest/receipt engine เดิม พร้อม actions SERVICE_BIND_CREATE/DISABLE/REPLACE_CUSTODIAN, SERVICE_CAPABILITY_GRANT/REVOKE และ SERVICE_CONTACT_GRANT/REVOKE
- Operator metadata GET `/api/v1/customer-360/operator/service-principals/:id` ไม่เปิด credential/subject/customer payload. Service-account token รวมถึง mixed workspace claims เรียก operator ไม่ได้

## Lock order และการกู้สิทธิ์

Operator กับ service authorization serialize ที่ principal row: operator UPDATE NOWAIT, service FOR SHARE NOWAIT. Current custodian ใช้ User FOR SHARE NOWAIT หลัง principal ก่อน identity. Revoke/rebind เพิ่ม epoch; no-op ต้อง revision ตรงและไม่เพิ่ม epoch. Disabled binding เปิดกลับไม่ได้: ต้องใช้ provisioning/recovery ที่ทบทวนใหม่ ไม่ hard-delete แล้วสร้าง history ใหม่

Disable/revoke ทำได้แม้ custodian ปิดบัญชีไปแล้ว; grant ใหม่ต้องมี custodian active ADMIN. Replace custodian เป็น operator command ชัดเจน ไม่เลือก Admin คนแรกหรือให้ลูกค้าเลือกผ่าน payload ของ public create

## Contract ให้ slice B

Create ต้องอยู่ transaction เดียวกับ Contact/head/service READ/custody/audit/receipt และใช้ shared owner operations ของ C4. M3-A ไม่เปิด endpoint create นี้

ก่อน insert custody `origin=INTEGRATION`, เรียก `recordC360ServiceCreateEvidence(tx,p,{commandId,actorIdentityKey},contactId)` หลังสร้าง Contact สำเร็จใน owner create transaction. Helper ต้องมี locked principal จาก transaction เดียวกันและ current CREATE capability

Ledger ผูก binding+Contact+command+purpose. DB guard บังคับ command action CONTACT_CREATE/resourceType CONTACT, actorUserId=null, actor key ตรง immutable principal SERVICE key, ไม่ใช่ tombstone และ resourceId ถ้ามีต้องตรง Contact. Custody ที่ไม่มี ledger/คนละ Contact/ใช้ operator หรือคำสั่งอื่นเป็นหลักฐานถูกปฏิเสธ. ไม่แก้ command admission เพื่อยัด resourceId ย้อนหลัง

Human CREATOR/OPERATOR provenance เดิมคงเดิม. INTEGRATION ต้องมี principal FK และ custodian ตรง binding. Slice B ต้องรักษา atomicity ด้วย actual owner writer; positive fixture ของ A ไม่ใช่หลักฐานว่า customer-create API ผ่านแล้ว

## การตรวจสอบที่ทำซ้ำได้

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @d-contact/api test:m3-principal:boundary
```

Runner สร้าง container/port/credentials/DB ของตัวเองบน loopback: PostgreSQL15.4 และ Keycloak26.7.5 ตาม digest ของ repo. Apply main migrations+M3, apply RLS, ตรวจ application role ไม่เป็น superuser/no BYPASSRLS; รัน focused M3 และ human C1 regression แล้วลบเฉพาะ containers ของ runner ใน finally. ไม่เชื่อม shared DB/Keycloak/UAT

Actual service token ได้จาก Keycloak client_credentials; operator ใน HTTP fixture เป็น synthetic trusted verifier ของ C1. แยกข้อเท็จจริงนี้จาก actual machine OIDC proof. Tests ครอบคลุม issuer/audience/scopes/tenant/rotation/unbound/disabled และ mixed-service claims; raw token/secret ไม่ถูกพิมพ์

หลักฐาน DB/HTTP: dry-run zero admission/effect/audit/epoch, idempotency/mismatched digest, stale epoch/no-op, explicit grants/current custodian, tenant RLS/FK, append-only/delete denial, actual locked authorization-vs-revoke/rebind/User-disable และ exact-purpose custody ledger

ยังไม่รวม actual customer-create/read endpoint ของ B, reference service ของ C, full shared API integration suite หรือ VM UAT ของ D. ไม่มี deploy/VM/real customer traffic จาก PR นี้
