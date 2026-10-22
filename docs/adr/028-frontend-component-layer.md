# ADR 028: Frontend component layer — `packages/ui-react`, React Aria, CSS Modules และ react-i18next

- **สถานะ:** Accepted
- **วันที่:** 2026-09-25
- **ที่มา:** [D1.3 #423](https://github.com/Kitti-Nualsalee/dcontact/issues/423) (ผู้ใช้ตัดสิน 2026-09-24),
  [D1.5 #425](https://github.com/Kitti-Nualsalee/dcontact/issues/425),
  Phase Contract [D1.8 #428](https://github.com/Kitti-Nualsalee/dcontact/issues/428),
  implementation [D1.10 #449](https://github.com/Kitti-Nualsalee/dcontact/issues/449)

> **ขยายขอบเขต (2026-10-22):** Platform Console ใช้ token, base components และแกน i18n ร่วมด้วย
> ตาม [#605](https://github.com/Kitti-Nualsalee/dcontact/issues/605) โดยคง platform shell และ
> authentication/authorization boundary ของ [#387](https://github.com/Kitti-Nualsalee/dcontact/issues/387)
> แยกจาก tenant รายละเอียดอยู่ในภาคผนวกด้านล่าง; การย้ายหน้าจอเป็น implementation งานถัดไป

## บริบท

[ADR-026](026-frontend-app-split.md) แยก `apps/console` กับ `apps/workspace` แต่ข้อ 6 ให้ทั้งสองแอป
หน้าตาเป็นระบบเดียวกัน ตอนนี้ `packages/ui` มีแค่ token (CSS custom property) และโลโก้ ส่วนแต่ละหน้า
เขียน CSS ของตัวเอง (`governance.css`, `journey-authoring.css`, `workspace-app.css`) ปุ่ม ช่องกรอก
และตารางจึงหน้าตา/พฤติกรรมคีย์บอร์ดไม่ตรงกัน และ focus ring มีบ้างไม่มีบ้าง

D1 ต้องการ shell ร่วม (rail, launcher, SubNav) และย้ายหน้า Journeys กับ Agent Workspace มาใช้ชุดเดียวกัน
ต้องตัดสินก่อนเขียน component ตัวแรกว่า component อยู่ที่ไหน ใครรับผิดชอบ accessibility และ style
ด้วยอะไร เพราะเปลี่ยนภายหลังคือเขียนทุกหน้าใหม่

## การตัดสินใจ

1. **package ใหม่ `packages/ui-react`** ถือ React components ร่วมของทั้งสองแอป;
   **`packages/ui` คงเป็น token + โลโก้** ที่ไม่ผูก framework (mockups, dphone ใน iframe และ framework
   อื่นใช้ได้) — `ui-react` อ้าง token ผ่าน `var(--dc-*)` และไม่ประกาศค่าของตัวเอง

2. **React Aria Components เป็น headless layer** รับผิดชอบ keyboard, focus management, ARIA และ
   screen reader; component ของเราเป็นเปลือกบาง ๆ ที่ใส่ className และข้อความ — ห้ามเขียน keyboard
   handling เองซ้ำกับที่ React Aria ทำแล้ว
   - ของที่ React Aria ยังเป็น `UNSTABLE_` (Toast ใน 1.21) ต้องหุ้มไว้ในไฟล์เดียวของเรา
     แอปเรียก API ของเรา (`toastQueue`, `<ToastRegion>`) เท่านั้น
   - วันที่/ปฏิทินตาม locale (รวมปี พ.ศ.) ใช้ `@internationalized/date` เมื่อมี date picker

3. **CSS Modules + token เท่านั้น** — ไม่เพิ่ม Tailwind หรือ CSS-in-JS ใน component layer
   - stylelint บังคับ: ห้าม hex/ชื่อสี/`rgb()` และห้ามค่า px/rem ใน radius, padding, margin, gap
     (ต้องเป็น `var(--dc-radius-*)` / `var(--dc-space-*)`)
   - สถานะของ component ใช้ data attribute ของ React Aria (`[data-hovered]`, `[data-focus-visible]`,
     `[data-selected]`) ไม่ใช้ `:hover` ตรง ๆ — พฤติกรรมตรงกันทั้ง mouse, touch และ keyboard
   - focus ที่มองเห็นได้ใช้ `--dc-focus-ring` ทุก component

4. **ข้อความของ component ผ่าน react-i18next** ใน namespace `ui` ที่ package เป็นเจ้าของ
   (`uiResources`) แอปรวม namespace นี้เข้า resources ของตัวเอง (D1.11) และ component อ่านผ่าน
   i18n instance ของแอป จึงสลับภาษาพร้อมกันโดยไม่ reload
   - `ui-react` **ไม่ประกาศ `CustomTypeOptions`** เพราะแอปเป็นเจ้าของ declaration นั้น —
     ชนิดของ key ภายใน package ตรึงด้วย `UiKey` ที่คำนวณจาก catalog ภาษาไทย
   - ข้อความของงานธุรกิจ (label, placeholder) ส่งเข้ามาทาง props จากแอป ไม่อยู่ใน namespace `ui`

5. **package ส่ง JS + d.ts + CSS Modules ที่ยังไม่ bundle** (`dist/`) — Vite ของแอปประมวลผล
   CSS Modules เอง ส่ง source `.ts` ตรง ๆ ไม่ได้เพราะแอป typecheck ด้วย `rootDir: src`

6. **preview page เป็นหน้า Vite ธรรมดาใน package** (ไม่ใช้ Storybook) แสดงทุก component ทั้ง TH/EN
   และเป็นหน้าที่ Playwright ใช้ตรวจ axe (0 serious/critical) และ keyboard ของทุก component

## ผลที่ตามมา

- (+) accessibility มาจากไลบรารีที่ทดสอบกับ screen reader จริงแล้ว ไม่ใช่ความจำของคนเขียนแต่ละหน้า
- (+) เปลี่ยนหน้าตาทั้งระบบ = แก้ token (`packages/ui`) ที่เดียว และ lint กันค่าหลุดกลับเข้ามา
- (+) โหมดมืด/density ที่สองในอนาคตไม่ต้องแตะ component เพราะทุกค่าเป็น custom property
- (−) ขนาด bundle: ใช้ครบ 9 component เพิ่มราว 100 kB (gzip) ต่อแอป (วัดเมื่อ 2026-09-25:
  176.6 kB เทียบกับ React + i18next อย่างเดียว 75.5 kB) ส่วนใหญ่มาจาก React Aria — ยอมรับได้เพราะ
  Workspace โหลดครั้งเดียวแล้วเปิดค้างทั้งกะ และได้ keyboard/ARIA ที่ถูกต้องแลกมา; import เฉพาะที่ใช้
  เพื่อให้ tree-shaking ตัดส่วนที่เหลือ
- (−) API ที่ยัง `UNSTABLE_` อาจเปลี่ยนเมื่ออัปเกรด React Aria — จำกัดผลกระทบไว้ในไฟล์หุ้ม
- (−) หน้าเดิมที่มี CSS ของตัวเองยังอยู่จนกว่าจะย้าย (D1.14 Journeys, D1.15 Agent Workspace);
  หน้าที่อยู่นอกขอบเขต D1 (Supervisor, Governance, QM) ย้ายภายหลัง

## ทางเลือกที่ไม่เลือก

- **รวม component ไว้ใน `packages/ui`**: ผูก token เข้ากับ React ทำให้ mockups และ dphone ใน iframe
  ที่ไม่ใช้ React ต้องลาก React มาด้วย
- **Radix / Headless UI**: ใช้ได้เหมือนกัน แต่ React Aria มี i18n (รวมปฏิทินพุทธ) และ collection
  component (Table, ListBox) ที่ครบกว่าสำหรับหน้าจอแบบตารางหนาแน่นของ contact center
- **Tailwind ใน component**: preset ของ `packages/ui` ยังใช้ได้ในหน้าจอที่ต้องการ แต่ component ร่วม
  ต้องมี stylesheet ที่ lint ได้และ override ได้ผ่าน token โดยไม่พึ่ง utility class ของผู้ใช้
- **Storybook**: หนักเกินความจำเป็นของ 13 component; หน้า Vite เดียวให้ผลเดียวกันสำหรับ axe/keyboard

## ภาคผนวก: Platform Console (#605)

เลือก **ก. ใช้ token + `ui-react` base components + i18n แต่คง shell ของ platform** เพราะการใช้
token อย่างเดียวแก้สีได้ แต่ยังต้องดูแล keyboard, focus และข้อความอีกชุด ส่วนการแยกทุกอย่างต่อไป
ทำให้แก้ component และแบรนด์ซ้ำ ขอบเขตนี้ขยาย ADR-028 โดยไม่เปลี่ยนการแบ่งแอป tenant ใน ADR-026
และไม่เปิด completion boundary ของ D1/A1 ที่ส่งมอบแล้วขึ้นใหม่

1. **ใช้ฐาน UI เดียวกัน** — `apps/platform-console` โหลด `@d-contact/ui/tokens.css` โดยตรง
   และใช้ base components จาก `@d-contact/ui-react` เมื่อมี component ตรงหน้าที่ เช่น Button,
   TextField, Select, Table, Badge, Dialog และ Tabs; layout/provisioning timeline เฉพาะงานยังอยู่ในแอป
   โดยอ้าง token เดิม ไม่ fork component และไม่สร้าง palette หรือ component library ของ platform
   การปรับ component ร่วมต้องรักษา contract ของ Console/Workspace และผ่าน checks ของ package

2. **คง shell และ navigation ของ platform** — ใช้เส้นทางและเมนู Tenants/สร้าง tenant เดิม
   ไม่เรียก tenant Navigation API ไม่ผูก `ui.shell.v2` และไม่ใช้ tenant AppShell, launcher, pins หรือ
   UserMenu ที่อาศัย tenant identity; shell ต้องแสดงว่าเป็น Internal Platform Operations ชัดเจน
   ปุ่มออกจากระบบยังเรียก platform OIDC flow เดิม

3. **TH และ EN เป็น acceptance ที่ต้องผ่านทั้งคู่** — ใช้ `@d-contact/i18n` กับ react-i18next,
   typed keys และ `uiResources`; catalog ของแอปเป็นเจ้าของข้อความ login/session/error,
   navigation, form/validation, provisioning/recovery, invitation และ Action history รวม accessible
   names และ live regions สลับภาษาโดยไม่ reload/remount, ไม่ล้าง draft, เปลี่ยน route หรือส่งคำสั่งซ้ำ
   API/state/error codes, request IDs, plan/template codes และข้อมูลที่ผู้ใช้กรอกคงค่าเดิม;
   แปล label ที่ครอบข้อมูลเท่านั้น ไม่แปลข้อความอิสระจากผู้ใช้หรือส่ง raw server error มาเป็นข้อความ UI

4. **ใช้ locale adapter ของ platform** — ใช้ `LocaleProvider` และ formatter กลาง โดยเลือกภาษา
   จากค่าที่เลือกในแท็บ → `navigator.languages` → `th`; เก็บเพียง `th`/`en` ใน `sessionStorage`
   ชื่อ `dcontact.platform.locale` เพื่อคงภาษาหลัง refresh/OIDC redirect อ่านหรือเขียน storage ไม่ได้
   ต้องยังสลับภาษาใน memory ได้ ค่านี้ไม่ใช่ identity หรือ authority และไม่เก็บ token/PII เพิ่ม
   timezone ของเวลาปฏิบัติการคง `Asia/Bangkok` ไม่ใช้ timezone ของเครื่องหรือ tenant ที่กำลังเปิดดู;
   TH ใช้ปี พ.ศ., EN ใช้ en-GB และเวลา 24 ชั่วโมงตาม formatter กลาง ช่อง locale/timezone ของ tenant
   ที่กำลังสร้างเป็นข้อมูล provisioning แยกจากภาษาของผู้ปฏิบัติงานเสมอ

5. **ไม่ขยายสิทธิ์เพื่อใช้ระบบภาษา** — ไม่ใช้ `SessionLocaleProvider` ของ tenant เพราะเรียก
   `/api/v1/tenant/locale-defaults` และ Keycloak Account API; platform ยังคง client `platform-console`,
   audience `dcontact-platform-api`, scope `openid`, Password+TOTP, token ใน memory และ platform-only
   identity ตาม #387 ไม่เพิ่ม profile/account scope, tenant context หรือการบันทึกภาษาเข้า Keycloak
   ในงานนี้ การรองรับ preference ข้ามเครื่องต้องตัดสิน contract แยกก่อน

6. **การย้ายและหลักฐาน** — ทำฐาน token/locale adapter ก่อน แล้วจึงย้าย components และข้อความ
   ทุกหน้าพร้อมกันให้ครบ TH/EN ก่อนรับงาน migration ว่าเสร็จ ต้องผ่าน catalog/literal/CSS checks,
   model tests และ Playwright เดิม รวมทั้งสองภาษา, keyboard/axe, operator/auditor/rollout-disabled,
   การคง draft/polling/recovery ระหว่างสลับภาษา และการไม่เรียก Tenant/Account API
   ไม่เปลี่ยน lifecycle, idempotency, expectedRevision, preview/execute หรือ server capabilities
   การ deploy และ browser acceptance บน UAT 3 VM ยังคงต้องผ่าน gate ของ #574 ต่างหาก

ทางเลือก ข. (token อย่างเดียว) ใช้เป็นขั้นย้ายชั่วคราวได้ แต่ไม่ใช่ completion boundary;
ทางเลือก ค. (คงแยกทั้งหมด) ไม่เลือกเพราะไม่มีข้อกำหนดของ platform ที่ต้องมี UI อีกระบบ

เส้นทาง implementation: [#744 — ฐาน token/locale](https://github.com/Kitti-Nualsalee/dcontact/issues/744)
แล้วจึง [#745 — ย้าย components/ข้อความทุกหน้าและตรวจรับ TH/EN](https://github.com/Kitti-Nualsalee/dcontact/issues/745)
ทั้งสอง ticket รอข้อสรุปและ ADR ของ #605 เข้า `main` ก่อน; การรับงาน decision ว่าเสร็จไม่ได้หมายถึง
หน้าจอถูกย้ายหรือผ่าน UAT แล้ว
