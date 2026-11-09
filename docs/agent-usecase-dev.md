# ทดลอง Use case Agent รอบแรกบน dev

Owner ยืนยัน 9 พฤศจิกายน 2569: งานหลัก [#796](https://github.com/Kitti-Nualsalee/dcontact/issues/796) และงานที่พัก [#888](https://github.com/Kitti-Nualsalee/dcontact/issues/888). เป้าหมายคือรับสาย → เลือกลูกค้าหรือ unlinked → แก้ชื่อ/บริษัทตามสิทธิ์ → WRAPUP → บันทึกผล/โน้ต → เปิดดูผลของตน

## เตรียม checkout

```sh
pnpm install --frozen-lockfile
pnpm agent:usecase:prepare
```

เตรียม build ของ dependencies เมื่อ checkout ใหม่หรือ shared package เปลี่ยน คำสั่งนี้ไม่เริ่ม infrastructure หรือแก้ฐานข้อมูล และไม่ต้อง build ทั้งแอปทุกครั้งที่แก้ Unit test

## ตรวจระหว่างพัฒนา

```sh
pnpm test:agent-usecase:unit
```

ชุดนี้ตรวจ business rules ของ profile/work, Workspace state, session, API client และ ended-call snapshot โดยไม่ใช้ service จริง เลือกรันไฟล์ย่อยตาม diff ได้ ไม่มีเป้าหมายจำนวน test หรือ coverage ที่บังคับเพิ่ม test ซ้ำ

## ตรวจ DB seam เมื่อบันทึก/สิทธิ์เปลี่ยน

```sh
pnpm test:agent-usecase:integration
```

ใช้ Docker แยก PostgreSQL ฐาน `dcontact_796_test` บน ephemeral localhost port จาก sandbox เดิม จัด migration/RLS/build ที่ต้องใช้และลบเฉพาะ containers ของ run เมื่อจบ ไม่แตะ `dcontact` บน port 5433

รันเฉพาะ `C5 HTTP/PG/RLS` และ `Use case Agent` ใน integration file: เลือก/แก้ลูกค้าผ่าน HTTP จริง, tenant/role boundary, linked/unlinked แล้ว save/readback/history/replay ผ่าน owner writers บน application role ที่ไม่ bypass RLS. Fixture สร้าง interaction เป็น ACTIVE และเปลี่ยนเป็น WRAPUP เอง; verifier/introspection และ rate limiter ของ work API สังเคราะห์ จึงไม่เริ่ม Redis/Keycloak ที่ชุดนี้ไม่ได้ใช้ และไม่ใช่ real OIDC boundary proof

ผล `AGENT_USECASE_DB_TRIAL_PASS` ยืนยันเฉพาะ DB seam นี้ ส่วน `C360_C5_SIP_AUDIO_TRIAL_NOT_RUN` ระบุว่าไม่มีการโทรจริง ไม่ออก acceptance marker ของ ADR-032 หากแก้ auth/provider boundary ให้เพิ่มชุดจริงที่เกี่ยวข้อง เช่น `pnpm --filter @d-contact/api test:customer-360-c5:components` ซึ่งยังเป็น component trial ไม่ใช่ SIP/audio proof

## ตรวจ UI เมื่อ flow เปลี่ยน

```sh
pnpm --filter @d-contact/workspace exec playwright install chromium
pnpm test:agent-usecase:browser
```

ใช้ Chromium หนึ่งรอบกับ specs ที่มีอยู่ เลือกเฉพาะ happy path การเลือกลูกค้าและบันทึกผล ชุด browser ใช้ API fixtures จึงยืนยัน UI เท่านั้น ไม่แทน HTTP/DB, real OIDC, real Voice หรือประวัติจาก DB

## ทดลองทั้งเส้นกับ Voice จริง

ใช้ dev stack แยกที่พร้อมและ synthetic tenant/Agent กับ SIP ภายในเท่านั้น ตรวจ runtime/config/ports ก่อนเริ่ม ห้ามใช้ root demo command โดยไม่อ่านผลกระทบ เพราะบางคำสั่ง reset งานหรือฆ่า media session เดิมได้

1. Login Agent และรับสายภายใน ยืนยันเสียงสองทางจริง
2. เลือกลูกค้าที่มีสิทธิ์ แก้ชื่อ/บริษัทและอ่านกลับ; ทดลองอีกงานแบบ unlinked
3. จบสาย เขียนโน้ต/เลือก disposition และบันทึก
4. เปิดประวัติงานตนเอง อ่านผล/โน้ตจาก server; retry เดิมไม่สร้างผลซ้ำ
5. บันทึก SHA, environment, คำสั่ง/ขั้นตอน, ผลจริง และข้อจำกัดใน #796 หรือ PR

ยังไม่ปิด #796 ด้วย Unit/DB/UI fixture อย่างเดียว และไม่ต้องรันสอง browser/สองรอบหรือ VM UAT ซ้ำ Formal deployment/rollback ยังติดตาม #868/#879 แยกตามผลกระทบ

## งานที่พัก

CSV import, External API/harness, Recording/playback, LINE pilot, สิทธิ์ประวัติทีม และ outbound dispatch อยู่ #888. ไม่ทำงานเหล่านี้เพื่อให้ dev trial ผ่าน ไม่คืน error/race matrix เก่าทั้งชุดเป็น gate แต่คง authorization, tenant isolation, data integrity และ idempotency ในเส้นทางที่เปิดใช้

## CI ตามผลกระทบ

CI ยังรัน build และ Unit checks ส่วน Integration สี่ชุด (managed routing SIP, core writer races, tenant people และ voice gateway) เลือกจากไฟล์ที่เปลี่ยน งานเอกสาร/UI/test tooling ของ Cus360 ไม่เรียกบริการเหล่านี้เอง เมื่อแก้ DB/RLS/IAM/contracts, infra, workflow, lockfile หรือ path ที่จำแนกไม่ได้ ให้รันแบบ conservative; ถ้าตรวจฐาน diff ไม่ได้ก็รันทั้งสี่ชุด

เรียก Integration ทั้งสี่ด้วยมือได้:

```sh
gh workflow run CI --ref main -f acceptance=integration
```

ชุดนี้ไม่รวม focused DB trial หรือ browser fixtures ของ #796 ต้องเรียกคำสั่งด้านบนเมื่อต้องตรวจ seams เหล่านั้น Acceptance chain เดิมยังเลือกด้วย `acceptance=chain` และใช้ marker ตาม ADR-032

## External softphone control — owner เลือก 10 พฤศจิกายน 2569

ใช้ UI control ใน Workspace จริงและเริ่มจากตัวจำลองก่อน ก่อนเลือก D-Phone เป็น Chrome extension ตัวแรก. เริ่ม Workspace พร้อม build-time opt-in ด้วย:

```sh
pnpm workspace:external-control
```

คำสั่งเปิด Vite ของ Workspace บน localhost (default port 5173) ต้องมี API/OIDC config ใน environment แบบเดียวกับ Workspace ปกติ คำสั่งนี้ไม่เริ่ม API/Keycloak หรือ Voice stack. หาก build เพื่อทดสอบบน environment ที่เตรียมแล้ว ให้ตั้ง `VITE_SOFTPHONE_CONTROL=external-simulator` ตอน build; ต้อง rebuild เมื่อต้องเปลี่ยนโหมด ค่าอื่น/ไม่ตั้งยังเป็น browser phone เดิม Embedded dphone ไม่รับโหมดนี้

แผงตัวจำลองอยู่คอลัมน์ความพร้อม: เริ่มตัวจำลอง → จำลองสายเข้า → รับสายจำลอง → จบสายจำลอง → ทดลองใหม่. ใช้ได้เมื่อ session/lease ของ Workspace พร้อมและไม่มีงานจริงอยู่ สถานะไม่มีเสียงและไม่สร้าง work item หรือประวัติ จึงไม่เรียก SIP credentials, microphone, AVAILABLE หรือ WRAPUP ของ server

Unit ของ control simulator อยู่ใน `test:agent-usecase:unit` และตรวจ browser แบบ focused ได้ด้วย:

```sh
pnpm --filter @d-contact/workspace exec playwright test e2e/external-phone-control.spec.ts
```

Browser spec ใช้ query เลือกโหมดเฉพาะ E2E harness ส่วน production เลือกผ่าน build config

## D-Phone สำหรับ Chrome

1. รัน `pnpm dphone:extension:build` ค่าปริยายจับคู่กับ Workspace ที่ `http://localhost:5173` สำหรับ dev origin อื่นกำหนด `D_PHONE_WORKSPACE_ORIGIN` ตอน build
2. เปิด `chrome://extensions` เปิด Developer mode แล้วเลือก **Load unpacked** ที่ `apps/workspace/dist-dphone-extension` คัดลอก extension ID ที่แสดง
3. เริ่ม Workspace ด้วย `VITE_SOFTPHONE_CONTROL=chrome-extension` และ `VITE_D_PHONE_EXTENSION_ID` ที่คัดลอกมา พร้อม API/OIDC config ของ dev stack
4. เปิด D-Phone จาก toolbar และกด **เปิดไมโครโฟน** ในแท็บ D-Phone เปิดแท็บนี้ไว้ระหว่างรับสาย แล้วกลับ Workspace กด **เชื่อมต่อ D-Phone** และ **เปิดรับสาย**
5. ใช้ **รับสาย** และ **วางสาย** ใน Workspace จากนั้นส่ง disposition และโน้ต แล้วเปิดผลจากประวัติงานตามปกติ

D-Phone แสดงสถานะโทรศัพท์และไมค์ในแท็บของตัวเอง Workspace ยังอ่าน Interaction, WRAPUP และประวัติจาก server การปิดแท็บ D-Phone หรือออกจากหน้า Workspace จะสิ้นสุดช่องควบคุมและปิด SIP session ดู ADR-037
