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

## แผงข้อมูลลูกค้าใน Workspace (Cus360 introspection) — #916

API ประกาศ `workCustomerV1` และยืนยัน session ของงาน (`WORK_REAUTH_REQUIRED`) ผ่าน token introspection ของ confidential client แยก Keycloak 26 ตอบ `active:false` ถ้า client ที่ถามไม่อยู่ใน `aud` ของ access token จึงต้องมีทั้งสองส่วน

- realm dev (`infra/keycloak/realm-dcontact.dev.json`) มี client `dcontact-c360-introspection-dev` แบบ confidential ที่ปิดทุก flow, ไม่มี service account/role และ `fullScopeAllowed=false` และปิด standard token exchange ใช้ authenticate ตอน introspect เท่านั้น ออก token เองหรือแลก token ไม่ได้
- `agent-desktop` มี audience mapper `c360 introspection audience (development only)` เพิ่ม client นี้ใน `aud` ของ access token (ไม่ใส่ใน ID token) client อื่นไม่ได้ mapper นี้ token ของ client อื่นจึงยังได้ `active:false`
- API อ่าน `KEYCLOAK_C360_CLIENT_ID`/`KEYCLOAK_C360_CLIENT_SECRET` ค่าใน `.env.example` ตรงกับ realm dev และเป็นค่าเฉพาะ local dev เท่านั้น UAT ห้ามใช้ (ค่านี้อยู่ใน denylist ของ `u1-uat-readiness` ที่สแกนไฟล์ UAT ใน Git ตามรายการ `UAT_FILES` แต่ไม่ได้สแกน `uat.env` บน VM)

ตอนเริ่ม API จะ log `customer_360.work.readiness` หนึ่งบรรทัด

- `"status":"ENABLED"` พร้อม `clientId` = config ครบและ Workspace จะแสดงแผงลูกค้า ยังไม่ได้ยืนยันว่า secret หรือ mapper ถูก ให้ตรวจจากแผงจริงตามอาการด้านล่าง
- `"status":"DISABLED"` พร้อม `reasons` = แผงลูกค้าปิด `KEYCLOAK_C360_CLIENT_NOT_CONFIGURED` คือไม่ได้ตั้ง env ทั้งคู่ (`missingEnv` บอกชื่อ) ส่วน `C360_WRITE_RUNTIME_NOT_READY` คือ contact-points runtime โหลดไม่ผ่าน (ทุก environment) หรือ release manifest ของ production ไม่ตรง
- ตั้งแค่ตัวใดตัวหนึ่ง API หยุดตั้งแต่เริ่มพร้อมชื่อ env ที่ขาด diagnostic ทุกแบบไม่พิมพ์ secret

dev ใหม่จาก `pnpm infra:ready` ได้ client และ mapper จากการ import realm เลย แต่ dev ที่ import realm ไปแล้ว Keycloak จะข้าม realm ที่มีอยู่ ให้เพิ่มเองใน Admin Console (`http://localhost:8081/admin` realm `dcontact`): Clients → Import client แล้ววาง JSON ของ client จาก realm file และที่ `agent-desktop` → Client scopes → `agent-desktop-dedicated` → Add mapper → By configuration → Audience ตามค่าในไฟล์

อาการเมื่อแผงขึ้นแต่ใช้ไม่ได้

- `WORK_REAUTH_REQUIRED` = introspection ตอบ `active:false` ตรวจว่า `agent-desktop` มี mapper แล้ว logout/login Workspace ใหม่เพื่อรับ token ที่มี `aud` ใหม่
- `WORK_IDENTITY_UNAVAILABLE` (503) = introspection ล้ม เช่น secret ใน Keycloak ไม่ตรงกับ env (Keycloak ตอบ 401) หรือ `KEYCLOAK_ISSUER` ผิด ตรวจ Credentials ของ client กับ env

UAT ยังไม่เปิดส่วนนี้ ดูสถานะและขั้นตอนใน [docs/uat-workspace-deployment.md](uat-workspace-deployment.md#แผงข้อมูลลูกค้า-cus360--ยังไม่เปิดบน-uat-916)

## งานที่พัก

CSV import, External API/harness, Recording/playback, LINE pilot, สิทธิ์ประวัติทีม และ outbound dispatch อยู่ #888. ไม่ทำงานเหล่านี้เพื่อให้ dev trial ผ่าน ไม่คืน error/race matrix เก่าทั้งชุดเป็น gate แต่คง authorization, tenant isolation, data integrity และ idempotency ในเส้นทางที่เปิดใช้

## CI ตามผลกระทบ

CI ยังรัน build และ Unit checks ส่วน Integration สี่ชุด (managed routing SIP, core writer races, tenant people และ voice gateway) เลือกจากไฟล์ที่เปลี่ยน งานเอกสาร/UI/test tooling ของ Cus360 ไม่เรียกบริการเหล่านี้เอง เมื่อแก้ DB/RLS/IAM/contracts, infra, workflow, lockfile หรือ path ที่จำแนกไม่ได้ ให้รันแบบ conservative; ถ้าตรวจฐาน diff ไม่ได้ก็รันทั้งสี่ชุด

เรียก Integration ทั้งสี่ด้วยมือได้:

```sh
gh workflow run CI --ref main -f acceptance=integration
```

ชุดนี้ไม่รวม focused DB trial หรือ browser fixtures ของ #796 ต้องเรียกคำสั่งด้านบนเมื่อต้องตรวจ seams เหล่านั้น Acceptance chain เดิมยังเลือกด้วย `acceptance=chain` และใช้ marker ตาม ADR-032

## นำเข้าลูกค้าจาก CSV — owner เลือก 16 พฤศจิกายน 2569

งานติดตามที่ [#909](https://github.com/Kitti-Nualsalee/dcontact/issues/909) เป็น Use case ถัดไปจาก #888 ใน Console เมนู **ลูกค้า → นำเข้า CSV** (`?view=customer-import`) สำหรับ Admin ที่มี `CONTACT_CREATE`

- สร้างลูกค้าใหม่เท่านั้น ไม่เกิน 1,000 แถว/1 MiB/32 คอลัมน์ ประมวลผลใน request เดียว ไม่เก็บไฟล์ ไม่มี job/worker/object storage
- `POST /api/v1/customer-360/imports/preview` ไม่สร้างข้อมูล; `POST .../imports/confirm` ส่งไฟล์เดิมพร้อม `planHash` และ `commandId` แล้วสร้างทีละแถวด้วย create command เดิมของ C4 (child commandId คงที่ต่อ request/plan/แถว) ส่งซ้ำด้วย commandId เดิมไม่สร้างลูกค้าซ้ำ
- `planHash` ผูก source digest, mapping และ rules แต่ไม่ผูก warning ซ้ำ เพื่อให้ replay หลังสร้างแล้วยังผ่าน
- confirm หยุดแถวที่เหลือเมื่อสิทธิ์หายหรือเกิน 45 วินาที (ผล `INCOMPLETE`) แถวที่ commit แล้วคงอยู่และส่งต่อได้

```sh
pnpm --filter @d-contact/customer-360 test
pnpm --filter @d-contact/api exec tsx --test src/customer-360-import-multipart.test.ts src/customer-360-import-api.test.ts
pnpm --filter @d-contact/console test
pnpm --filter @d-contact/api test:customer-import:integration
pnpm --filter @d-contact/console exec playwright test e2e/customer-import.spec.ts --project=chromium
```

`test:customer-import:integration` ใช้ PostgreSQL ชั่วคราวฐาน `dcontact_909_test` และลบ container เมื่อจบ ไม่แตะฐาน `dcontact`; ตรวจ HTTP→PostgreSQL/RLS ด้วย application role ที่ไม่ bypass RLS. Browser spec จำลอง API ด้วย route จึงยืนยัน UI เท่านั้น ไม่แทน HTTP/DB หรือ real OIDC

## Segment ระบบให้ Agent เห็นลูกค้าใหม่ — owner เลือก 18 พฤศจิกายน 2569

งานติดตามที่ [#911](https://github.com/Kitti-Nualsalee/dcontact/issues/911) Agent ค้นลูกค้าในสายได้ผ่าน WORK scope ของ segment เท่านั้น จึงเพิ่ม segment ระบบต่อ tenant คือ `system:all-customers` และ `system:vip` (`contact.vip == true`) Admin ให้ทีมได้ WORK หรือ VIEW ที่ Console เมนู **ลูกค้า → สิทธิ์ทีมเห็นลูกค้า** (`?view=customer-access`, [#915](https://github.com/Kitti-Nualsalee/dcontact/issues/915)) การมี segment ไม่ให้สิทธิ์ใครเอง

- `apps/api` รัน evaluator ทุก 5 วินาที: สร้าง/publish segment ระบบถ้ายังไม่มี แล้วบันทึก fact snapshot (`vip`, `company`) ของ contact ที่ข้อมูลเปลี่ยนหรือยังไม่มีผล และ `commitEvaluation` ตามเส้นทาง owner เดิม รวม backfill ลูกค้าเดิม
- relay ส่ง membership change ไป `dc.customer.events` และ IAM consumer ใน process เดียวกันอัปเดต projection; เชื่อม Kafka แบบ retry/backoff ส่วน evaluator ทำงานได้โดยไม่รอ Kafka
- ปิดทั้งหมดด้วย `C360_SEGMENT_WORKER=off`; consumer group ตั้งด้วย `IAM_SEGMENT_PROJECTION_GROUP_ID`

- `POST /api/v1/tenant/team-segment-scopes` รับ `permission` เป็น `WORK` หรือ `VIEW` (ไม่ส่ง = `VIEW` ตามพฤติกรรมเดิมของหน้า dphone) และ `GET` คืนทั้งสองแบบพร้อม `permission` หรือกรองด้วย `?permission=`
- WORK ให้ Agent ค้น เชื่อม และแก้ลูกค้าในงานที่ยังไม่จบ และเป็นเงื่อนไขให้ Journey ที่ทีมเป็นเจ้าของรับลูกค้าเข้า
- VIEW ใช้กับ screen-pop ของ dphone ที่ฝัง (#519), ให้ Admin/Supervisor ในทีมอ่านโปรไฟล์ลูกค้าใน segment นั้นใน Customer 360 (`c360ReadableContactSql`) และให้ Agent เปิดลูกค้าของงานที่ `COMPLETED` แล้ว (`profile-work.ts`) Agent ที่ต้องรับสายและดูลูกค้าย้อนหลังจึงต้องได้ทั้งสองสิทธิ์
- ให้ VIEW บน `system:all-customers` เท่ากับให้ Admin/Supervisor ของทีมนั้นอ่านลูกค้าทั้ง tenant

```sh
pnpm --filter @d-contact/customer-360 exec tsx --test src/segment-runtime.test.ts
pnpm --filter @d-contact/api exec tsx --test src/customer-360-segment-worker.test.ts
pnpm --filter @d-contact/api test:customer-segment:integration
```

Integration ใช้ PostgreSQL ชั่วคราวฐาน `dcontact_911_test` เดินเส้นสร้างลูกค้าผ่าน HTTP → evaluator → outbox/relay → IAM projection → Agent ค้นผ่าน work API; Kafka ในชุดนี้แทนด้วย producer ที่ส่ง envelope เข้า handler เดียวกับ IAM consumer จึงไม่ใช่หลักฐาน broker จริง

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

## External customer API — #954

งานติดตามที่ [#954](https://github.com/Kitti-Nualsalee/dcontact/issues/954) เป็น Use case ถัดไปจาก #888 ให้ระบบภายนอกสร้าง อ่าน และค้นลูกค้าด้วย service principal บน path เดียวกับ Console ปิดเป็นค่าเริ่มต้นและเปิดด้วย `C360_SERVICE_API=on` รายละเอียด endpoint สิทธิ์ และข้อจำกัดอยู่ใน `docs/external-customer-api.md`

```sh
pnpm --filter @d-contact/api exec tsx --test src/customer-360-service-config.test.ts
pnpm --filter @d-contact/api test:m3-principal:boundary
```

`test:m3-principal:boundary` ใช้ PostgreSQL และ Keycloak ชั่วคราวของ runner เอง ตรวจ HTTP→PostgreSQL/RLS, token จริงจาก `client_credentials`, introspection จริง และตัวอย่าง client ใน `examples/external-customer-api/` ไม่ใช่หลักฐานบน dev stack จริงหรือ UAT

## Voice Recording: Supervisor เปิดฟังเสียงของทีม — #967

งานติดตามที่ [#967](https://github.com/Kitti-Nualsalee/dcontact/issues/967) เป็น Use case ถัดไปจาก #888 ให้ Supervisor เปิดฟังเสียงบันทึกของสายที่ทีมตัวเองรับผ่าน API ที่ตรวจสิทธิ์ทุก chunk ปิดเป็นค่าเริ่มต้นและเปิดด้วย `RECORDING_SUPERVISOR_PLAYBACK=on` รายละเอียดสิทธิ์ endpoint และข้อจำกัดอยู่ใน `docs/voice-recording-supervisor-playback.md`

งานติดตามที่ [#971](https://github.com/Kitti-Nualsalee/dcontact/issues/971) ให้ Admin สร้างฟอร์มประเมิน Supervisor ให้คะแนนสายที่ทีมตัวเองรับ และ Agent เห็นคะแนนของตัวเอง ปิดเป็นค่าเริ่มต้นและเปิดด้วย `QM_HUMAN_EVALUATION=on` integration `apps/api/src/qm-evaluation-api.integration.ts` ต้องใช้ฐานแยกที่ migrate และ `db:rls` แล้ว รายละเอียดอยู่ใน `docs/qm-human-evaluation.md`

```sh
pnpm --filter @d-contact/api exec tsx --test --test-concurrency=1 src/recording-playback-api.integration.ts
pnpm --filter @d-contact/console exec playwright test e2e/team-recordings.spec.ts --project=chromium
```

Integration ใช้ฐานแยกและ storage แบบ in-memory ที่เก็บ WAV จริง ส่วน Playwright ใช้ API จำลอง ทั้งสองไม่ใช่หลักฐานของสายจริง FreeSWITCH หรือ object storage จริง

## Tenant ใหม่ถึง Agent รับสาย — #977

[#977](https://github.com/Kitti-Nualsalee/dcontact/issues/977) เดิน flow ตั้งแต่ Platform provisioning ถึง Agent รับสายและบันทึกผลกับ tenant ที่ไม่ได้ seed ลงฐาน ลำดับงาน งานของ operator และผลทดลองอยู่ใน `docs/new-tenant-onboarding.md`

```sh
node --test scripts/tenant-voice-onboarding.test.mjs
pnpm --filter @d-contact/api exec tsx --test src/tenant-core-errors.test.ts
```

dev stack ที่ใช้ทดลองต้องให้ API ต่อฐานด้วย `dcontact_app` และใช้ telephony `e1-sandbox-main` เพราะคิวที่สร้างใน Console เป็น managed routing
