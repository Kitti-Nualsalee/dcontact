# ADR 033: Self-service บัญชีผ่าน API ของ D-Contact บน Keycloak fine-grained admin permissions v2

- **สถานะ:** Accepted (ส่วน identity plane — AC0); ส่วน API/UI ตามมาใน AC1–AC6
- **วันที่:** 2026-10-02
- **ที่มา:** Phase Contract [#589](https://github.com/Kitti-Nualsalee/dcontact/issues/589) (เจ้าของงานยืนยัน 2026-10-02),
  [AC0 #592](https://github.com/Kitti-Nualsalee/dcontact/issues/592)

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
- (−) **Keycloak downgrade ไม่ได้** — rollback ข้ามการ upgrade นี้ต้อง restore ฐานข้อมูล Keycloak จาก backup ที่ทำก่อน migrate
  (`docs/u1-uat-deployment.md` §9)

## ทางเลือกที่ไม่เลือก

- **คง 26.0 + `manage-users`:** เจ้าของงานไม่ยอมรับ (#589 Q4)
- **deny ผ่าน group อย่างเดียว:** ไม่กัน `reset-password` (ผล probe)
- **ให้สิทธิ์ผ่าน group ของผู้ใช้ tenant:** ต้องย้ายผู้ใช้ทุกคนเข้า group และแก้ provisioning saga
  ส่วนการใช้สมาชิกภาพ Organization ซึ่งมีอยู่แล้วเป็นตัวแบ่งนั้นไม่ต้องย้ายข้อมูล
- **26.8.0:** เพิ่งออก (2026-10-01) — เลือก 26.7.5 ซึ่งผ่านรอบแก้ bug มาแล้ว
