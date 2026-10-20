# UAT Organization SSO hotfix

Authority: #736 (technical gap ของ #733), ADR-004/026, Keycloak26.7.5 ของ deployment ปัจจุบัน

## สาเหตุและผลของ patch

`CookieAuthenticator` ของ Keycloak26.7.5 คืน attempted เมื่อขอ Organization scope เพื่อให้ native `organization` resolve membership/context ก่อน success [source](https://github.com/keycloak/keycloak/blob/26.7.5/services/src/main/java/org/keycloak/authentication/authenticators/browser/CookieAuthenticator.java#L80) Flow UAT เดิมมี Cookie → forms(password REQUIRED + OTP REQUIRED) จึงกู้ Organization SSO ไม่ได้ แม้ cookie ยัง valid

เพิ่ม native Organization แบบ ALTERNATIVE ระหว่าง Cookie กับ forms เมื่อมี SSO จะ resolve organization แล้ว success; เมื่อ login ใหม่ด้วยบัญชี local จะไป forms และบังคับ password/OTP เช่นเดิม [source](https://github.com/keycloak/keycloak/blob/26.7.5/services/src/main/java/org/keycloak/organization/authentication/authenticators/browser/OrganizationAuthenticator.java#L192)

รอบนี้ใช้กับ UAT ที่ไม่มี Identity Provider/broker ทั้งระดับ realm และ Organization จึงต้องผ่าน guard นี้ทุกครั้งก่อน apply การเพิ่ม broker ในอนาคตต้องมี decision เรื่อง MFA ของเส้นทางนั้นก่อน

## หลักฐานก่อนขึ้น VM

- `node --test scripts/u1-uat-organization-sso.test.mjs scripts/u1-uat-keycloak-users.test.mjs`
- workflow `UAT Organization SSO`: HTTPS loopback ที่ trust cert ของตน → imageเดียวกับ UATพร้อม DC providerจริง → legacy RED → patch GREEN, fresh password/OTP, OTPหาย/ผิด, no-cookie, foreign org, no-op และ rollback ข้อมูลทั้งหมดเป็น fixture ใหม่
- Review Standards/Spec และ CI ของ source SHA ที่ใช้จริง; main artifact `boundary.json`/`boundary.tap` ระบุ SHA, image, check results และ `vmUat=NOT_RUN` เก็บ artifact ID/digest พร้อม checksum ของ scripts ที่ส่งขึ้น VM

## Operator ของ realm เดิม

ใช้ช่วงที่ operator รายเดียวเป็นผู้แก้ authentication config ตรวจ container IDs/images ของ API/Keycloak/Voice/Console และ deployment record ก่อนทำงาน ขั้นนี้เป็น Admin API patch จึงคง processes และ active sessions เดิม

1. เก็บ snapshot current/previous deployment records และ baseline component digests ลง directory ส่วนตัว บันทึก Console27619719ที่ใช้กับ backend/schemae3f2197 และ pending Console evidence ตาม #733
2. ใช้ Node runtime จาก ops imageเดิมบน internal network พร้อม read-only mount scripts ที่ตรวจ SHA/checksumแล้ว และ evidence directory writable0600/0700 ส่ง admin credentials ผ่าน secret envfileส่วนตัว ใช้ `KEYCLOAK_ADMIN_URL=http://keycloak:8080/auth` การ plan/apply ใช้ credentials เดียวกับ operatorเดิม โดยไม่ส่งผ่าน public proxy
3. Plan:
   `node scripts/u1-uat-organization-sso.mjs --plan --record /evidence/plan.json`
   ตรวจ action/digest และ preimage: active realm flowตรง, Cookie ALTERNATIVE, forms ALTERNATIVE, password/OTP REQUIRED, ไม่มี broker, Consoleไม่มีflowoverride และมีช่อง priority สำหรับ Organization
4. Apply โดยตั้ง `SOURCE_SHA=<tested-main-sha>`:
   `node scripts/u1-uat-organization-sso.mjs --apply --expected-digest <digest-from-plan> --record /evidence/patch.json`
   Script rechecks preimageก่อน mutation สร้าง DISABLED ตั้ง priorityของexecutionใหม่นั้นให้อยู่ระหว่าง Cookie/forms แล้วตรวจ protected config ก่อน enable เป็นคำสั่งสุดท้าย เก็บ record ก่อน mutationและแต่ละขั้น จึงกู้กรณีหยุดกลางทางได้
5. ตรวจ postimage digest/readback และ container IDs/start timesเดิม จากนั้น kittin บน `tenant=dcontact-uat` เดิน Home/Account/Integrations/History, reload/direct URL/Back/Forward โดยไม่ถาม credentials ซ้ำ ให้ผู้ใช้ login ครั้งแรกใน browser เองเมื่อไม่มี SSO cookie
6. หลัง actual UAT ผ่าน เขียน component records ของ Consoleและrealm patchตามจริง: Console SHA27619719/image581f60c6, realm patch source SHA/script hashes/pre-post flow digests/record path และหลักฐาน actual browser แยกจาก main sandbox result รักษา API/schema sourceฐานe3f2197 และ base provisioning digestใน snapshot; ระบุ effective realm hotfixแยกต่างหาก ไม่สร้างผล full provisioning/migration ใหม่จาก patchนี้ Full Core/People releaseถัดไปต้องรวม #733+#736 และตรวจ effective flowก่อน/หลัง release

## Rollback และ drift

`SOURCE_SHA=<tested-main-sha> node scripts/u1-uat-organization-sso.mjs --rollback --record /evidence/patch.json`

เมื่อเป็น APPLIED ต้องตรง postimageเดิมทั้งหมดจึง disableแล้วถอนเฉพาะexecutionที่สร้าง เมื่อค้าง CREATED_DISABLED/POSITIONED_DISABLED ต้องตรง protected preimageและUUID/statusของexecutionนั้นก่อนถอน เก็บ rollback resultในrecordเดิม หาก config driftหรือpartial stateไม่ตรงหลักฐาน ให้ operatorตรวจจากpreimage/progressก่อนแก้ต่อ ไม่มีการเดาหรือ reconcile MFA executionsอื่นให้เอง

การถอน Organization step คืน behaviorเดิมที่ Organization SSO ไม่ผ่าน จึงใช้เมื่อ patch validationไม่ผ่าน ระหว่างนี้ #733 ยังคง OPEN จนผ่าน actual UAT และบันทึก component provenanceครบ Core#726 ยังรอ verified proof/Voice trialตามเกณฑ์ของตน
