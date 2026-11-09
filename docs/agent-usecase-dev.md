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
