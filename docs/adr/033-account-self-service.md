# ADR 033: Self-service บัญชีผ่าน API ของ D-Contact บน Keycloak fine-grained admin permissions v2

- **สถานะ:** Accepted (ส่วน identity plane — AC0, extension `dc-account` — AC2, API self-service — AC4, UI — AC5, ซ่อนร่องรอย Keycloak — AC6)
- **วันที่:** 2026-10-02
- **ที่มา:** Phase Contract [#589](https://github.com/Kitti-Nualsalee/dcontact/issues/589) (เจ้าของงานยืนยัน 2026-10-02),
  [AC0 #592](https://github.com/Kitti-Nualsalee/dcontact/issues/592),
  [R1 #593](https://github.com/Kitti-Nualsalee/dcontact/issues/593) (ชื่อ cookie), [AC6 #599](https://github.com/Kitti-Nualsalee/dcontact/issues/599)

## บริบท

ลูกค้าต้องจัดการบัญชีของตัวเอง (รหัสผ่าน, 2FA, ชื่อ/email) ได้ในหน้าของ D-Contact ทั้งหมด
โดยไม่เห็นหรือถูกพาไปหน้าของ Keycloak (#589 D3, D6)
Account Console ของ Keycloak จึงใช้ไม่ได้ และเบราว์เซอร์ต้องไม่เรียก endpoint ของ Keycloak เพื่อจัดการบัญชี

API ของ D-Contact ต้องแก้ข้อมูลผู้ใช้แทนเจ้าของบัญชีผ่าน Keycloak Admin REST
บน Keycloak 26.0 วิธีเดียวคือให้ service account มี realm-management `manage-users` ซึ่งครอบผู้ใช้ทุกคนของ realm `dcontact`
รวม platform operator/auditor และ service account ของระบบ (realm เดียวตาม ADR-004)
เจ้าของงานไม่ยอมรับความเสี่ยงนี้ และให้ upgrade ก่อน (#589 Q4)

## การตัดสินใจ

1. **Upgrade Keycloak เป็น 26.7.5** (pin ด้วย digest ทั้ง dev, image ของ UAT และ extension build)
   - ย้าย dev จาก `quay.io` เป็น `docker.io` เพื่อให้ทุก environment ใช้ image เดียวกัน
2. **เปิด fine-grained admin permissions v2 ใน realm `dcontact`**
   - สร้าง service account `dcontact-account-service` โดยไม่มี realm-management role ใดเลย
3. **สิทธิ์ของ `dcontact-account-service`** (สคริปต์ `scripts/keycloak-account-service-setup.mjs`, idempotent)
   - **อนุญาต:** `Users` scope `view`, `manage`, `reset-password` บนผู้ใช้ทุกคน
     ไม่มี `map-roles`, `manage-group-membership`, `impersonate`
   - **ปฏิเสธทุก scope** กับผู้ใช้ที่ไม่เป็นสมาชิก Organization ใดเลย ได้แก่ platform operator/auditor, service account ของทุก client และ admin ของ realm
     - รายชื่อนี้คำนวณใหม่ทุกครั้งที่รันสคริปต์ จึงต้องรันซ้ำหลังสร้าง platform user ใหม่
     - งาน `platform-operator-setup` ของ UAT รันให้อัตโนมัติ
4. **ชั้นที่สอง:** API ของ D-Contact (AC4) ส่งคำสั่งได้เฉพาะกับผู้ใช้เจ้าของ token ใน tenant เดียวกันเท่านั้น
   ไม่รับ user id จาก browser — สิทธิ์ใน Keycloak เป็นตัวจำกัดความเสียหายถ้า secret รั่ว ไม่ใช่ตัวตัดสินหลัก

5. **Extension `dc-account` (AC2 [#595](https://github.com/Kitti-Nualsalee/dcontact/issues/595))** —
   `infra/keycloak/extensions/dc-account` build คู่กับ `invitation-guard` (`scripts/keycloak-extensions-build.sh`, image ของ UAT)
   - realm resource `/realms/dcontact/dc-account` รับเฉพาะ access token ของ service account `dcontact-account-service`
     (token อื่น = 403) และไม่ log secret/code
   - `POST /users/{id}/totp/verify-and-create` `{ tenantId, secret, code, label }`:
     ตรวจ code ด้วย OTP policy ของ realm ก่อนเขียน — code ผิด = ไม่สร้าง credential
     - ผู้ใช้ต้องเป็นสมาชิก Organization ที่มี `tenant_id` ตรงกัน จึงแตะ platform user หรือผู้ใช้ tenant อื่นไม่ได้
     - `secret` เก็บตามตัวอักษร (QR ใช้ Base32 ของ UTF-8 bytes) และ label ซ้ำ = 409
   - `PUT /organizations/by-tenant/{tenantId}/mfa-required` `{ required }` แก้เฉพาะ attribute `dc_mfa_required`
     โดยคัดลอก attribute เดิมทั้งหมด (`setAttributes` ของ Keycloak แทนทั้งชุด)
   - condition `dc-org-mfa-required` ใน browser flow ของ tenant `dcontact-browser` (copy จาก `browser`):
     - subflow "Org 2FA" = condition + `auth-otp-form` แบบ REQUIRED: ยังไม่มี OTP → `CONFIGURE_TOTP`; มีแล้ว → ถาม OTP
     - subflow 2FA เดิมได้ condition เดียวกันแบบ negate จึงไม่ถาม OTP สองรอบ
     - ประเมินตอน login เท่านั้น จึงมีผล login ครั้งถัดไปและไม่ตัด session เดิม
     - `platform-console` มี flow ของตัวเอง จึงไม่กระทบ
6. **sync `dc_mfa_required` ผ่าน extension ไม่ใช่ Admin REST** (เจ้าของงานเลือก 2026-10-06)
   - Admin REST ต้องให้ account service มี `manage` บน Organizations ซึ่งแก้ชื่อ/domain, ปิด org
     และเพิ่ม/ลบสมาชิกได้ทุก tenant
   - extension แก้ได้แค่ attribute เดียว account service จึงยังไม่มีสิทธิ์จัดการ Organization ตามข้อ 2–3
   - port ของ AC1 คือ `KeycloakOrganizationMfa` (`apps/api/src/keycloak-account-service.ts`)
     - ล้ม = `IDENTITY_UNAVAILABLE` (503) และนโยบายไม่ถูกบันทึก
     - ไม่ตั้ง `KEYCLOAK_ACCOUNT_SERVICE_SECRET` = ไม่มี port → เปิดบังคับ 2FA ได้ 409

7. **API self-service `/api/v1/me/account/*` (AC4 [#597](https://github.com/Kitti-Nualsalee/dcontact/issues/597))**
   - **เป้าหมายมาจาก token เท่านั้น:** `dc_user_id` + tenant → แถว `users` ภายใต้ RLS → `keycloak_id`
     ไม่มี user id ใน path/body; ผู้ใช้ทุก role ของ tenant ใช้ได้ (`agent`/`supervisor`/`admin`/`compliance`)
   - **ทุกการเปลี่ยนทำใน transaction ของ tenant พร้อม lock ต่อผู้ใช้ และเรียก Keycloak เป็นขั้นสุดท้าย**
     ก่อน commit — Keycloak ล้มแล้ว audit, email และแถวใน DB ถูกยกเลิกทั้งหมด
     นี่คือ compensation ของ saga ใน `docs/iam-architecture.md` §7 และ `users.display_name` ยังเป็นแหล่งจริงของชื่อ
   - **TOTP secret ที่ยังไม่ยืนยัน:** เข้ารหัสด้วย AES-256-GCM จาก `ACCOUNT_SECRET_KEY` (base64 32 bytes, env ของ API)
     - ผูกกับ tenant/ผู้ใช้/enrolment ผ่าน AAD; อายุ 10 นาที และลองได้ 5 ครั้ง
     - otpauth URI ใช้ค่าเริ่มต้นของ OTP policy (SHA1, 6 หลัก, 30 วินาที) — ถ้า realm เปลี่ยน policy ต้องแก้คู่กัน
   - **token ยืนยัน email:** สุ่ม 256 bit และ DB เก็บแค่ SHA-256; ไม่บอกว่า token ผิด, ใช้แล้ว หรือหมดอายุ
   - **error ของ password policy:** Keycloak บอกทีละกฎ API จึงคืน `rules[]` เฉพาะกฎแรกที่ไม่ผ่าน
     ผู้ใช้อาจต้องแก้หลายรอบ

8. **ซ่อนร่องรอย Keycloak จากลูกค้า (AC6 [#599](https://github.com/Kitti-Nualsalee/dcontact/issues/599), R1 [#593](https://github.com/Kitti-Nualsalee/dcontact/issues/593))**
   เกณฑ์: ไม่มีคำว่า "Keycloak" ในข้อความที่มองเห็น, `<title>`, อีเมล และชื่อ cookie ของ realm `dcontact`;
   path `/auth/realms/...` ยอมรับได้ (#589 D9)
   - **ชื่อ cookie → `DC_*`** (`DcCookieProvider`, provider id `dc` ของ SPI `cookie` ใน extension `dc-account`)
     - เจ้าของงานยอมรับความเสี่ยงของ SPI `cookie` ที่ Keycloak ระบุว่า internal (R1 #593, 2026-10-07)
     - implement `CookieProvider` ตรง ๆ ไม่ใช้ reflection และไม่ extend `DefaultCookieProvider`; ชื่อใหม่คำนวณจาก `CookieType.getName()`
       (`KEYCLOAK_*`/`KC_*` → `DC_*`) จึงรวมชนิด cookie ที่ Keycloak เพิ่มภายหลังโดยอัตโนมัติ
     - path/SameSite/Secure/HttpOnly/อายุคงตาม `CookieType` ทุกประการ; เฉพาะ realm ใน `--spi-cookie--dc--realms` (ค่าเริ่มต้น `dcontact`) — realm `master` ใช้ชื่อเดิม
     - **rollout:** ผู้ใช้ที่ถือ cookie ชื่อเดิมอ่านได้ต่อ (SSO ไม่หลุด) แล้วชื่อเดิมถูกหมดอายุเมื่อเขียนชื่อใหม่ — Keycloak ไม่ส่งชื่อเดิมให้ผู้ใช้ใหม่เลย
     - **iframe ของ session management:** iframe ต้นฉบับอ่าน `KEYCLOAK_SESSION` ตรง ๆ และ override ด้วย theme ไม่ได้ —
       extension เสิร์ฟ `/realms/dcontact/dc-account/login-status-iframe.html` จาก template ต้นฉบับของ image ที่รันอยู่ แทนเฉพาะชื่อ cookie
       (ไม่เจอชื่อเดิม = 500 ไม่ส่ง iframe ที่ทำงานผิดเงียบ ๆ); Console/Workspace อ่านจาก `metadataSeed.check_session_iframe`
     - theme มีสำเนา `authChecker.js` และ `passkeysConditionalAuth.js` (อ่าน `KEYCLOAK_AUTH_SESSION_HASH`/`KEYCLOAK_SESSION`) ที่แก้ชื่อ cookie
     - **ทุกครั้งที่ upgrade Keycloak:** (1) gate `A1-F-KEYCLOAK-EXTENSION` ต้อง compile ผ่าน (2) เทียบ `login-status-iframe.ftl`,
       `authChecker.js`, `passkeysConditionalAuth.js` กับ upstream (3) รัน `pnpm test:keycloak-cookie-names` และ `pnpm test:identity-traces`
   - **Account Console ใช้ไม่ได้:** account theme `dcontact` ตั้ง `accountResourceProvider=dc-account-landing` —
     `/realms/dcontact/account/` (HTML) redirect ไป `baseUrl` ของ client `account-console` ซึ่ง `pnpm infra:identity:branding` ตั้งเป็น `CONSOLE_PUBLIC_URL`
     (ไม่ตั้ง = 404, ไม่ redirect วน); Account REST API (`Accept: application/json`) ไม่ผ่านจุดนี้ — การเปลี่ยนภาษาของ `@d-contact/i18n` ยังใช้ได้
     - client `account` ปิดไม่ได้: อีเมลเชิญ (`execute-actions-email` ไม่ส่ง `client_id`) ใช้เป็นค่าเริ่มต้น — ตั้ง `baseUrl` เป็น Console เพื่อให้ลิงก์ "กลับแอป" หลังตั้งรหัสผ่านพาไป D-Contact
   - **`displayName` ของ realm = "D-Contact"** ทุก environment (realm JSON + `infra:identity:branding` สำหรับ realm ที่มีอยู่แล้ว)
   - **attribute ภายใน** (`tenant_id`, `tenant_slug`, `dc_user_id`, `zoneinfo`) ผู้ใช้ไม่เห็น/แก้ไม่ได้ (`view: [admin]`):
     หน้า required action "ปรับปรุงข้อมูลบัญชี" เคยแสดงเป็นช่องฟอร์ม; claim ใน token มาจาก mapper ที่อ่าน attribute ตรง จึงไม่กระทบ
   - **ข้อความ/อีเมล:** theme `dcontact` ใส่ข้อความไทยที่ Keycloak 26.7.5 ยังไม่มี, อีเมล `email-verification` และ `password-reset` (html + text, th/en)
     ใช้ layout เดียวกับอีเมลเชิญ ไม่แสดงชื่อ realm/ผู้ใช้; `emailTestSubject` ถูก override (เดิมขึ้นต้นด้วย `[KEYCLOAK]`)
   - **หลักฐาน:** `pnpm test:identity-traces` (Chromium + dev stack) สแกนหน้า login/required action/error/logout และอีเมลทุกฉบับทั้งไทยและอังกฤษหา `/keycloak/i`
     ใน title/ข้อความ/ชื่อ cookie พร้อม negative control (หน้าของ realm `master` ต้องถูกจับได้) และ gate ว่า Account Console เข้าไม่ถึง
     — ผลบน 26.7.5: ผ่านทั้ง `th` และ `en`; `pnpm test:keycloak-cookie-names` 16/16
   - **ขอบเขตที่ไม่ได้ซ่อน:** ชื่อ path `/auth/realms/...` และ URL ของ resource ใต้ `/resources/.../keycloak/...` (ชื่อไฟล์ static ที่ browser ไม่แสดงให้ผู้ใช้อ่าน) — D9

## สิ่งที่ probe บน 26.7.5 แล้วพบ (กำหนดรูปแบบการตัดสินใจข้างบน)

| เรื่อง | ผล |
|---|---|
| deny ผ่าน `Groups` (`manage-members`, `view-members`) | กันการดูและแก้ข้อมูลได้ แต่ **ไม่กัน `reset-password`** จึงต้อง deny เป็นราย user |
| deny ราย user (`Users` + resources) | กันทุก scope รวม `reset-password` และการอ่าน credential |
| `GET /users` | ไม่คืน service account user — สคริปต์จึงดึงจาก client ที่เปิด service account เพิ่ม |
| `view` บน `Users` | อ่าน role mapping ได้ (แยก scope ไม่ได้) แต่ map role ไม่ได้ |
| `manage` บน `Users` ทั้งชุด | สร้าง/ลบผู้ใช้ได้ด้วย — API ไม่ใช้ แต่เป็นขอบเขตที่เหลืออยู่ของสิทธิ์ |
| เปิด FGAP v2 แล้ว list/ค้น Organization | กรองตามสิทธิ์แบบ fine-grained ทันที ยกเว้นผู้มี `view-organizations`/`manage-organizations` |

ผลของแถวสุดท้าย: provisioner ซึ่งเดิมมีแค่ `manage-realm` ได้รายการ Organization ว่าง และ provisioning saga พังทั้งหมด
แก้โดยให้ `dcontact-provisioner` ได้ role `manage-organizations` เพิ่ม (`scripts/keycloak-provisioning-setup.mjs`)

## ผลที่ตามมา

- (+) secret ของ account service รั่ว ก็ยังแตะ platform user, service account, client หรือ role ไม่ได้
- (+) role `manage-organizations` เปิดทางให้ถอด `manage-realm` ออกจาก provisioner ภายหลัง (ยังไม่ทำในงานนี้)
- (−) `manage` บน Users ยังสร้างและลบ tenant user ได้ — ยอมรับ และ API ไม่เปิดคำสั่งเหล่านี้
- (−) platform user ที่สร้างนอกสคริปต์ จะไม่ถูกป้องกันจนกว่าจะรัน `pnpm infra:identity:account` ซ้ำ (มีใน runbook)
- (−) extension ใช้ SPI ที่ Keycloak ระบุว่า internal (`realm-restapi-extension`, `authenticator`) แบบเดียวกับ
  `invitation-guard` (`actionTokenHandler`) — compile เทียบ image ที่ pin digest ทุกครั้ง (`A1-F-KEYCLOAK-EXTENSION`)
  และต้องรัน `account-mfa.boundary.ts` ใหม่ทุกครั้งที่ upgrade Keycloak
- (−) sync `dc_mfa_required` เกิดใน transaction ของ API ก่อน commit — ถ้า commit ล้มหลัง sync สำเร็จ ค่าใน Keycloak
  จะนำหน้าฐานข้อมูลจนกว่า admin จะบันทึกครั้งถัดไป (sync idempotent)
- (−) SPI `cookie` เป็น internal API: Keycloak รุ่นใหม่อาจเปลี่ยน `CookieType`/`CookiePath`/`RealmsResource.realmBaseUrl` — extension จะ compile ไม่ผ่าน (จับได้ที่ gate ไม่ใช่ตอน deploy)
  และ iframe/`authChecker.js` ที่คัดลอกจาก upstream ต้องเทียบทุกครั้งที่ upgrade (ข้อ 8)
- (−) SPI `account-resource` (landing ของ Account Console) ก็ถูกระบุว่า internal เช่นกัน (log `KC-SERVICES0047`) — เปลี่ยนแล้ว extension compile ไม่ผ่านเช่นเดียวกัน
- (−) **Keycloak downgrade ไม่ได้** — rollback ข้ามการ upgrade นี้ต้อง restore ฐานข้อมูล Keycloak จาก backup ที่ทำก่อน migrate
  (`docs/u1-uat-deployment.md` §9)

## ทางเลือกที่ไม่เลือก

- **คง 26.0 + `manage-users`:** เจ้าของงานไม่ยอมรับ (#589 Q4)
- **deny ผ่าน group อย่างเดียว:** ไม่กัน `reset-password` (ผล probe)
- **ให้สิทธิ์ผ่าน group ของผู้ใช้ tenant:** ต้องย้ายผู้ใช้ทุกคนเข้า group และแก้ provisioning saga
  ส่วนการใช้สมาชิกภาพ Organization ซึ่งมีอยู่แล้วเป็นตัวแบ่งนั้นไม่ต้องย้ายข้อมูล
- **26.8.0:** เพิ่งออก (2026-10-01) — เลือก 26.7.5 ซึ่งผ่านรอบแก้ bug มาแล้ว
