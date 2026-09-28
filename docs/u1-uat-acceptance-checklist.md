# U1 — Checklist สำหรับเดิน UAT (#416) บน URL จริง

> เอกสารนี้ใช้เปิด #416 หลัง acceptance gate ของ U1.7 (#435) ผ่านแล้ว ใช้คู่กับ Phase Contract #374,
> เกณฑ์ pass/fail และ evidence ของ #379 และ first slice ของ #372
>
> **สิ่งที่ gate ของ U1.7 พิสูจน์แล้ว และสิ่งที่ยังไม่ได้พิสูจน์**
>
> - `pnpm cxa:u1:acceptance` (CI job `cxa-u1-acceptance`) เดิน step catalog ด้านล่างครบสองรอบบน backend จริง
>   ใน stack ที่มีรูปแบบเดียวกับ UAT ได้แก่ API entry `uat-main` (profile `uat`), Postgres (app role + RLS),
>   Keycloak (realm จาก template ของ UAT: PKCE + password+TOTP + Organization), MinIO และ Console ที่เรียก
>   `/api/v1` แบบ same-origin ทั้งหมดนี้ไม่มี API mock
> - marker `U1_ACCEPTANCE_GATE_PASSED` แปลว่า **พร้อมเปิด #416** เท่านั้น ไม่ได้แปลว่า UAT ผ่าน
>   (`uatAccepted: false` ใน manifest) #416 ผ่านได้จาก run ที่ทีม UAT เดินบน URL จริงตามเกณฑ์ของ #379 เท่านั้น
> - gate ไม่ได้ตรวจ TLS, DNS, identity-aware gateway/allowlist, secret store หรือ Keycloak production mode
>   ของ VM จริง ส่วนนี้ต้องผ่าน provisioning gate และ readiness/smoke ของ U1.6 (`docs/u1-uat-deployment.md`)

## 0. ก่อนเริ่ม (prerequisite ของ #416)

- [ ] CI job `cxa-u1-acceptance` บน main ผ่านอย่างน้อยสามครั้งติดกันบน SHA ที่จะ deploy และได้ marker
      `U1_ACCEPTANCE_GATE_PASSED` (artifact `cxa-u1-evidence-<sha>` มีแค่ manifest และ screenshot)
- [ ] provisioning gate ของ U1.6 ครบ (host/domain/DNS/TLS/secret store) และ `uat-preview` deploy + smoke ผ่าน
      บน digest ของ SHA เดียวกัน
- [ ] operator provision tenant, owner team, grant ของ maker/reviewer, rollout และ fixture pack ตาม
      `docs/u1-uat-deployment.md` §5 แล้ว บัญชี maker/reviewer เป็นคนละคนตาม §6
- [ ] fixture pack มี `simulationFixture.sendOutcomes` ของ SEND node ใน baseline (ไม่มีแล้ว simulation จะจบ
      พร้อม diagnostic `PREVIEW_FIXTURE_INVALID` และ 0 transition ตามที่ gate พบ)
- [ ] บันทึก run ID, build SHA และ fixture version/digest จากแผง "รอบทดสอบ UAT" (ระบบใส่ให้ ไม่ต้องพิมพ์เอง)

## 1. Step catalog (expected ตรึงใน fixture pack)

step ID และ expected ตรงกับ `U1_STEP_CATALOG` ใน `scripts/u1-acceptance.mjs` ซึ่ง gate ใช้ provision
fixture pack ถ้า pack ของ UAT จริงใช้ catalog อื่น ให้ยึด catalog ที่แสดงบนแผงของ run นั้นเป็นหลัก

| Step ID               | ผู้ทำ    | สิ่งที่ทำ                                                                                     | Expected                                                                                                          | ป้าย              |
| --------------------- | -------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------- |
| `RUN_OPENED`          | maker    | login (password + TOTP) แล้วกด `เริ่มรอบใหม่`                                                 | รอบนี้ ACTIVE พร้อม run ID, build SHA และ fixture digest จาก server; รอบก่อนหน้าปิดเป็น COMPLETED/ABANDONED และหลักฐานเดิมยังอ่านได้ | `REAL_STATE`      |
| `MAKER_EDIT`          | maker    | แทรก WAIT หลัง SEND แล้วบันทึก                                                                | ได้ EVENT_TRIGGER → SEND → WAIT → EXIT และได้ revision ใหม่                                                        | `REAL_STATE`      |
| `DIAGNOSTIC_RECOVERY` | maker    | ตัดเส้น "ถัดไป" ของ WAIT → บันทึก → ตรวจฉบับร่าง → ต่อกลับไป EXIT → บันทึก → ตรวจอีกครั้ง          | graph ที่ไม่สมบูรณ์บันทึกได้ แต่ validate พบ diagnostic ที่ชี้ node; หลังแก้ validate ไม่พบข้อผิดพลาด                   | `REAL_STATE`      |
| `COMPILE`             | maker    | Compile ฉบับร่าง                                                                              | ได้ compile digest จาก server                                                                                     | `REAL_STATE`      |
| `SIMULATE`            | maker    | จำลองการทำงาน                                                                                 | ใช้ fixture ที่ server ตรึง ผลติดป้าย `SIMULATION_ONLY` และแสดงเวลาเสมือน ไม่ใช่การส่งจริง                          | `SIMULATION_ONLY` |
| `SUBMIT_REVIEW`       | maker    | ส่งตรวจ                                                                                       | สถานะ IN_REVIEW และ maker ไม่มีปุ่มตัดสินงานของตัวเอง                                                              | `REAL_STATE`      |
| `REVIEW_APPROVE`      | reviewer | หา candidate เองจากตัวกรอง "รอตรวจ" เปิด แล้วอนุมัติ                                           | เห็น compile digest เดียวกับที่ maker ส่ง และได้ APPROVED                                                          | `REAL_STATE`      |
| `PUBLISH`             | maker    | Compile แล้ว Publish                                                                          | ได้ version และ receipt ที่ server ยืนยัน ("Publish version N สำเร็จ")                                               | `REAL_STATE`      |
| `AUDIT`               | maker    | แสดงประวัติ                                                                                   | เห็น REVIEW_SUBMITTED, REVIEW_APPROVED และ JOURNEY_PUBLISHED ของ Journey รอบนี้                                    | `REAL_STATE`      |

ทุก step ต้องบันทึกผลบนแผง "รอบทดสอบ UAT" (ผล `PASS/FAIL/BLOCKED`, actual และ correlation ID ถ้ามี) และแนบ
screenshot PNG/JPEG ของ step นั้นผ่าน "ภาพหน้าจอหลักฐาน"

## 2. Rerun หลัง `เริ่มรอบใหม่`

- [ ] หลังรอบแรกผ่านครบ กด `เริ่มรอบใหม่`: รอบใหม่ ACTIVE, รอบเดิมเป็น COMPLETED (publish แล้ว) หรือ ABANDONED
- [ ] ผลบันทึก screenshot และ audit ของรอบเดิมยังอ่านและส่งออก bundle ได้ครบ ไม่มีอะไรถูกลบหรือแก้
- [ ] เดิน step catalog ทั้งชุดอีกหนึ่งรอบ (#379: rerun ต้องผ่าน)

## 3. กรณีที่ต้องตรวจด้วยคนบน URL จริง (gate อัตโนมัติไม่ได้ครอบหรือครอบแค่บางส่วน)

- [ ] failure/recovery: เน็ตหลุดระหว่างบันทึก/publish แล้วกดซ้ำได้ผลเดิม (idempotency key เดิม) และข้อความบอกทางไปต่อ
- [ ] session หมดอายุ: แผงแสดงทางเข้าสู่ระบบใหม่ ไม่ตัน (access token ของ realm UAT มีอายุ 5 นาที)
- [ ] refresh, deep link, Back/Forward ไม่ตันและไม่ทำให้การแก้ที่ยังไม่บันทึกหาย
  (session ของ Console อยู่ในหน่วยความจำ จึง refresh แล้วต้องกดเข้าสู่ระบบอีกครั้ง แต่ SSO พากลับได้โดยไม่ถามรหัส)
- [ ] accessibility: keyboard ล้วน, focus หลัง navigation, live region, contrast และจอต่ำกว่า 960px เป็นอ่านอย่างเดียว
- [ ] ไม่มีขั้นตอนใดต้องใช้ CLI หรือ DB ระหว่างทดสอบ
- [ ] URL และ screenshot ไม่มี `code`/`state` ของ OIDC หรือ token (U1.7 แก้ Console ให้ลบค่าเหล่านี้หลัง login แล้ว)

## 4. Negative ที่ gate พิสูจน์แล้ว (ทีม UAT ไม่ต้องเดินซ้ำ แต่ถ้าพบต้องเป็น S1)

| Negative                          | วิธีที่ gate ตรวจ                                                                                                         | Guard ที่พิสูจน์ว่าถ้าถอดแล้ว test ล้ม            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| self-approval                     | maker ที่ถือ `journey.review` ด้วยอนุมัติ candidate ของตัวเอง → 403 `APPROVAL_SELF_FORBIDDEN`                              | maker-checker ใน `decideJourneyReview`             |
| ข้าม tenant                       | ผู้ใช้ tenant อื่น (มี grant ระดับ TENANT ใน tenant ตัวเอง) อ่าน/อนุมัติ/บันทึกผลของ run และ Journey ของ tenant UAT → 403/404 | tenant scoping (predicate + RLS + team ของ tenant) |
| candidate ของรอบ ABANDONED        | ส่งตรวจ/publish/แก้ฉบับร่างของ Journey รอบที่ปิด → 409 `JOURNEY_LIFECYCLE_CONFLICT` (`UAT_RUN_CLOSED`)                     | `UatJourneyWriteGuard`                             |
| provider egress                   | `/api/v1/runtime-profile` = `providerEgress: BLOCKED`; route นอก allowlist → 404 `ROUTE_NOT_AVAILABLE_IN_PROFILE`           | `RuntimeProfileRouteGuard`                         |

## 5. เกณฑ์ผ่านของ #416 (ตาม #379)

- [ ] ทุก step ใน catalog เป็น `PASS` ทั้งรอบแรกและ rerun — run ที่มี `BLOCKED` ใช้อ้างว่าผ่านไม่ได้
- [ ] ไม่มี defect S1/S2 ที่ยังเปิดอยู่ (S3/S4 ปล่อยผ่านได้เมื่อเปิด issue `uat:defect` + `severity:s3|s4` ไว้)
- [ ] evidence bundle ของ run ที่ใช้อ้าง (ปุ่ม "ส่งออก evidence bundle") มี `verdict: PASS` และ `scan.status: PASSED`
      ถ้า negative scan พบอะไร = S1 และ run นั้น `FAIL`
- [ ] run ที่ผ่านอยู่บน build SHA และ fixture version/digest เดียวกับที่รายงานใน #416
- [ ] แนบ bundle และ screenshot เท่านั้น — **ห้ามแนบ Playwright trace, HAR หรือ network log ดิบ**
- [ ] defect ทุกตัวเป็น issue แยกหนึ่งอาการต่อหนึ่ง issue ตาม template `uat-defect` (run ID, build SHA,
      fixture version/digest, step ID, expected/actual, ขั้นตอนทำซ้ำที่เริ่มจาก `เริ่มรอบใหม่`, correlation ID,
      screenshot ที่ผ่าน scan และป้าย `REAL_STATE`/`SIMULATION_ONLY`) และลิงก์กลับ #416
