# ADR 035: Tenant People ใช้ narrow identity authority และ Keycloak-owned receipt

- **สถานะ:** Accepted ตามสัญญา [V1-B #704](https://github.com/Kitti-Nualsalee/dcontact/issues/704); implementation และ acceptance อยู่ใน [B2 #709](https://github.com/Kitti-Nualsalee/dcontact/issues/709); ขยาย UPDATE_PROFILE/ENABLE_ACCOUNT ตาม [#998](https://github.com/Kitti-Nualsalee/dcontact/issues/998)

Tenant Admin ส่ง intent ผ่าน application API เท่านั้น worker ใช้ client-credentials ของ tenant service client แยกชื่อ `dcontact-tenant-people-<tenantId>` กับ resource `dc-tenant-people` ไม่ขยายสิทธิ์ `dcontact-account-service`, browser หรือ Platform API และไม่ให้ `realm-management` แก่ worker การผูก tenant/Organization/audience/role allowlist เป็น operator-owned configuration ไม่ใช่ payload ที่ Admin เลือกได้

เลือก registered JPA entities และ additive Liquibase changelog ใน Keycloak DB แทน process-local lock หรือ application ledger เพียงฝั่งเดียว เพราะ identity mutation และ immutable outcome receipt ต้อง commit/rollback ใน transaction เดียวกัน tenant gate ใช้ PostgreSQL pessimistic lock; operation descriptor ผูก service client, operation, target และ digest พร้อม monotonic fence การไม่พบ receipt หลัง timeout ไม่ใช่หลักฐานว่า mutation ไม่เกิด จึง reconcile แบบ read-only ไม่สร้างหรือส่งซ้ำโดยเดา และไม่ adopt identity จาก email/username lookup

Identity ที่ provision ใหม่ต้องมี positive classification และ attributes ที่ User Profile อนุญาตเฉพาะ admin แก้ได้ ตรวจ role/Organization/correlation/protected identity ก่อนแต่ละขั้น ไม่ล้างสิทธิ์หรือย้าย Organization เพื่อให้ conflict ผ่าน `PROVISIONED` หมายถึง mapping และ required actions ครบ แต่ domain user ยัง inactive และ `PENDING_ACTIVATION`; B2 ไม่ส่ง email ไม่ตั้ง password/TOTP แทนผู้ใช้ ไม่สร้าง SIP credential หรือ presence การตั้ง password/TOTP ด้วยตนเองใน ADR-033 ไม่เปลี่ยน

Domain คง local-part ของ normalized email ตาม contract แต่ JPA `UserAdapter` ของ pinned Keycloak เก็บ email/username เป็น lowercase จึงตรวจ representation ด้วย `KeycloakModelUtils.toLowerCaseSafe` ตัวเดียวกับ distribution ไม่เปลี่ยน accepted payload/digest หรือใช้ lookup เพื่อ adopt identity การทดสอบต้องมี mixed-case local-part ผ่านจนจบ provisioning ด้วย

## ขยายขอบเขต #998: แก้ชื่อที่แสดงและเปิดบัญชีกลับ

Owner อนุมัติใน [#998](https://github.com/Kitti-Nualsalee/dcontact/issues/998) (23 พ.ย. 2569) ให้ `dc-tenant-people` มีสอง step เพิ่มจากสัญญา #704 ซึ่งเดิมห้ามแก้ผู้ใช้และเปิดบัญชีกลับ:

- `UPDATE_PROFILE` เปลี่ยน `firstName` เป็น `displayName` ที่ application normalize แล้วเท่านั้น ไม่แตะ email/username, role, Organization, attributes หรือ credentials และทำได้เฉพาะ identity ที่ยัง enabled
- `ENABLE_ACCOUNT` เป็นด้านกลับของ `DISABLE_ACCOUNT`: ตั้ง enabled กลับเฉพาะ identity ที่ปิดอยู่และมี password, TOTP, email ยืนยันแล้วและไม่มี required action ค้าง ไม่ตั้งหรือ reset password/TOTP แทนผู้ใช้ ไม่ส่ง email และไม่สร้าง session

ทั้งสอง step ใช้ tenant gate (pessimistic lock), operation descriptor (service client, step, target, identity, role, ชื่อ, Organization และ digest), monotonic fence และ immutable receipt `<step>:0` ใน JPA transaction เดียวกับ mutation เหมือน disable ล็อกแถว identity ก่อนตรวจ positive classification/role/Organization จาก local JPA provider ทุกครั้ง การปฏิเสธก่อนแตะ identity เป็น `REJECTED_NO_EFFECT` ส่วน receipt สำเร็จต้อง readback ว่าชื่อหรือสถานะ enabled พร้อม credentials ยังตรง ถ้า drift หลัง receipt คืน `UNKNOWN` ไม่คืน marker เก่า ไม่ต้องเพิ่ม Liquibase changeSet เพราะใช้ตาราง operation/receipt เดิม readiness เพิ่ม `accountReady`

ฝั่ง application เปลี่ยน `users.display_name` หรือ `User.isActive=true` + lifecycle `ACTIVE` ภายใน definer function เดียวกับที่บันทึก receipt และเฉพาะเมื่อ receipt สำเร็จ, identity ตรงคำสั่ง และ local state ยังตรงกับตอนรับคำสั่ง ผลไม่ชัดเจนคงชื่อเดิม/`DISABLED` เป็น `ACTION_REQUIRED` แล้ว reconcile ด้วย GET อย่างเดียว ไม่ส่ง mutation ซ้ำหลัง attempted การเปิดกลับจอง seat ตั้งแต่รับคำสั่ง ตรวจโควตา Agent ทีม active และหมายเลขภายในเดิมยังเป็นของผู้ใช้ GET reconcile ส่งเฉพาะ SHA-256 ของชื่อ ไม่ส่งชื่อใน URL การปิดบัญชีต้องไม่ถูกขวางถาวรโดยคำสั่งแก้ชื่อที่ไม่รู้ผล จึงปิดคำสั่งแก้ชื่อที่ไม่มี worker ถือเป็น `REJECTED` (`SUPERSEDED_BY_DISABLE`) ใน transaction เดียวกับการรับคำสั่งปิด ปลอดภัยเพราะ `UPDATE_PROFILE` รับเฉพาะ identity ที่ enabled และ app ไม่เปลี่ยนชื่อจากคำสั่งที่ปิดแล้ว identity evidence ก่อนสลับ API เทียบ receipt ของทั้งสอง step ด้วย GET และ readiness ต้องมี `accountReady` เมื่อเปิด flag โดยข้ามคำสั่งที่ถูกแทนด้วยผลสำเร็จใหม่กว่า (แก้ชื่อซ้ำ หรือปิดบัญชีหลังเปิดกลับ) การแก้ชื่อไม่รับบัญชี `PENDING_ACTIVATION` เพราะ invitation resend ผูก `firstName` กับ payload ตอนสร้าง การเปลี่ยนบทบาทและหมายเลขภายในยังอยู่นอกขอบเขต ADR นี้

## Compatibility และ release gate

Custom JPA SPI ไม่ใช่ compatibility guarantee ของ Keycloak จึง compile กับ jars จาก distribution ที่ pin ใน repo และทดสอบกับ Keycloak 26.7.5 + PostgreSQL จริงก่อน merge รวม concurrent create, receipt replay, foreign/protected identity, correlation collision, stale fence และ fault injection ที่พิสูจน์ว่า identity/role/membership ไม่ค้างเมื่อ receipt ล้ม การเปลี่ยน distribution ต้องผ่าน boundary เดิมใหม่ ไม่อ้างเอกสาร latest หรือ HTTP mock เป็นหลักฐานแทน

## Backup และ rollback

Application DB เก็บ reservations, domain users/lifecycle, fenced worker leases และ step receipts ส่วน Keycloak DB เก็บ identity, tenant gate และ provider receipts ต้องสำรองทั้งสองฐานแยกกันพร้อม release/schema versions และ correlation manifest ที่ไม่มี secret ก่อน rollout การคืน snapshot ฝั่งเดียวขณะที่มี operation ค้างอาจทำให้ไม่รู้ผล side effect ห้ามใช้เป็นการชดเชยอัตโนมัติ

Rollback เริ่มจากปิด admission และหยุด worker รับงานใหม่ ตรวจ in-flight leases/receipts ให้ quiescent หรือคงสถานะ unknown เพื่อ operator reconcile ก่อนสลับ binary ใช้ additive schema ต่อได้ ไม่ drop ledger, down-migrate, ลบ identity หรือ restore shared Keycloak DB เพื่อย้อน operation รายคน หาก release เก่าอ่าน ledger ใหม่ไม่ได้ ให้คง feature ปิดแทนการ retry mutation ด้วย release เก่า การกู้ฐานข้อมูลทั้งระบบต้องเป็นแผน operator แยกที่ตรวจทั้งสองฝั่งและพิสูจน์ reconciliation ก่อนเปิด admission

Service secrets อยู่ server-only และ rotate ได้ ไม่อยู่ UI, operation results, audit หรือหลักฐานสาธารณะ privileged bootstrap/enrollment ของบัญชีเดิมยังต้องมีหลักฐาน operator ตามสัญญาเดิม ไม่ตีความ membership หรือ realm role ที่มีอยู่เป็นการยืนยัน mapping โดยปริยาย
