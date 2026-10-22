# Platform Console

## ฐาน UI และภาษา (#744)

โหลด token จาก `@d-contact/ui` ทุกครั้ง ใช้ base components ของ `@d-contact/ui-react` ในหน้า
login/session และ header โดยคง platform shell, routes และ OIDC เดิมตาม ADR-028/#605

`PlatformLocaleProvider` ครอบ root ตำแหน่งเดียวทั้งก่อน/หลัง login ใช้ `LocaleProvider` และ
formatter กลางโดยไม่เรียก Tenant Navigation/locale-defaults หรือ Keycloak Account API และยังขอ
scope `openid` เท่านั้น ภาษาเลือกจาก `sessionStorage` key `dcontact.platform.locale` (รับเฉพาะ
`th`/`en`) → browser → `th`; storage อ่าน/เขียนไม่ได้ยังเปลี่ยนภาษาใน memory ได้
timezone ของ operator คง `Asia/Bangkok` แยกจาก locale/timezone ของ tenant draft

### ขอบเขตที่ยังรอ #745

TH/EN ใน #744 ครอบ `main.tsx`, `auth-screen.tsx`, `platform-header.tsx`, `language-switcher.tsx`
และ `src/i18n/` เท่านั้น `i18n:literals` ตรวจไฟล์เหล่านี้โดยไม่ใช้ blanket ignore

ข้อความธุรกิจใน `app.tsx`/`model.ts` ได้แก่ list/search, wizard/review, validation, progress,
recovery, invitation/handoff, Action history, rollout/read-only notices และ formatter ของหน้าเดิม
ยังรอย้ายใน [#745](https://github.com/Kitti-Nualsalee/dcontact/issues/745)
หน้าเหล่านี้ยังเป็นภาษาไทยแม้ header เปลี่ยนเป็น EN; ยังไม่ promote ขึ้น UAT แทน release ที่ตรวจรับแล้ว

## การตรวจสอบ

- `pnpm --filter '@d-contact/platform-console...' build` สร้าง dependencies ก่อนแอป
- `pnpm --filter @d-contact/platform-console i18n:check` ตรวจ catalog TH/EN
- `pnpm --filter @d-contact/platform-console i18n:literals` ตรวจข้อความในส่วนที่ย้ายแล้ว
- `pnpm --filter @d-contact/platform-console lint:css` ตรวจ token ทุก stylesheet ของแอป
- `pnpm --filter @d-contact/platform-console test` ตรวจ model, locale/storage และ OIDC settings
- `pnpm --filter @d-contact/platform-console test:e2e` ตรวจ regression และ foundation ด้วยข้อมูลสังเคราะห์

CI ของ platform รัน browser checks และ Docker build ด้วย dependency graph เดียวกับ workspace
การ deploy และ browser/token acceptance บน UAT 3 VM ยังคงติดตามแยกใน #574
