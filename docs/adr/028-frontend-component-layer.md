# ADR 028: Frontend component layer — `packages/ui-react`, React Aria, CSS Modules และ react-i18next

- **สถานะ:** Accepted
- **วันที่:** 2026-09-25
- **ที่มา:** [D1.3 #423](https://github.com/Kitti-Nualsalee/dcontact/issues/423) (ผู้ใช้ตัดสิน 2026-09-24),
  [D1.5 #425](https://github.com/Kitti-Nualsalee/dcontact/issues/425),
  Phase Contract [D1.8 #428](https://github.com/Kitti-Nualsalee/dcontact/issues/428),
  implementation [D1.10 #449](https://github.com/Kitti-Nualsalee/dcontact/issues/449)

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
