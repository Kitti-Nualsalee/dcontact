# Platform Console

## ฐาน UI และภาษา (#744)

โหลด token จาก `@d-contact/ui` ทุกครั้ง ใช้ base components ของ `@d-contact/ui-react` ในหน้า
login/session และ header โดยคง platform shell, routes และ OIDC เดิมตาม ADR-028/#605

`PlatformLocaleProvider` ครอบ root ตำแหน่งเดียวทั้งก่อน/หลัง login ใช้ `LocaleProvider` และ
formatter กลางโดยไม่เรียก Tenant Navigation/locale-defaults หรือ Keycloak Account API และยังขอ
scope `openid` เท่านั้น ภาษาเลือกจาก `sessionStorage` key `dcontact.platform.locale` (รับเฉพาะ
`th`/`en`) → browser → `th`; storage อ่าน/เขียนไม่ได้ยังเปลี่ยนภาษาใน memory ได้
timezone ของ operator คง `Asia/Bangkok` แยกจาก locale/timezone ของ tenant draft

### ขอบเขต migration (#745)

ทุก production `.ts/.tsx` อยู่ใต้ `i18n:literals` โดยไม่ใช้ blanket ignore ข้อความของ model เก็บเป็น
message keys และแปลตอน render รวม validation, errors, progress/recovery, invitation และ Action history
รหัสหรือสถานะที่ไม่รู้จักใช้ generic localized fallback พร้อม reference เดิม ไม่แสดง raw server title
ข้อมูลผู้ใช้, API codes/IDs และ request payload คงค่าเดิม

controls ที่มี primitive ตรงหน้าที่ใช้ Button, Badge, TextField/SearchField, Select, Checkbox และ Table
จาก `ui-react` ส่วน stepper, progress และ timeline เป็น layout เฉพาะงานตามเดิม
recovery/resend คงเป็น inline region; Escape/ปิดกลับไปยังปุ่มที่เปิด (หรือหัวข้อคำขอเมื่อปุ่มหมดอายุ)
ไม่เพิ่ม modal/แท็บใหม่ใน workflow ที่เดิมไม่มี

สลับภาษาไม่ย้าย focus ออกจากช่องที่กำลังกรอก ไม่ reset draft/review/recovery หรือรัน preview/execute ซ้ำ
เวลาทุกหน้าผ่าน formatter ของ provider: TH ปี พ.ศ., EN en-GB, 24 ชั่วโมงใน Asia/Bangkok
การตรวจ UI migration ไม่แทน browser/token acceptance หรือ deploy gate บน UAT 3 VM ของ #574

## การตรวจสอบ

- `pnpm --filter '@d-contact/platform-console...' build` สร้าง dependencies ก่อนแอป
- `pnpm --filter @d-contact/platform-console i18n:check` ตรวจ catalog TH/EN
- `pnpm --filter @d-contact/platform-console i18n:literals` ตรวจข้อความทุก production file
- `pnpm --filter @d-contact/platform-console lint:css` ตรวจ token ทุก stylesheet ของแอป
- `pnpm --filter @d-contact/platform-console test` ตรวจ model/message keys, locale/storage และ OIDC settings
- `pnpm --filter @d-contact/platform-console test:e2e` ตรวจ TH/EN regression และ foundation ด้วยข้อมูลสังเคราะห์

CI ของ platform รัน browser checks และ Docker build ด้วย dependency graph เดียวกับ workspace
การ deploy และ browser/token acceptance บน UAT 3 VM ยังคงติดตามแยกใน #574
