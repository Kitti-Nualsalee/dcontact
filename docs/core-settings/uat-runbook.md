# Core Settings: Final VM UAT และการรับรอง

Authority: [งาน #729](https://github.com/Kitti-Nualsalee/dcontact/issues/729), [Phase Contract #723 §§7–12](https://github.com/Kitti-Nualsalee/dcontact/issues/723), ADR-030/031/032 และ [operator runbook](../../infra/uat/operator/README.md) ของ candidate ที่ตรวจแล้ว เอกสารนี้เป็นขั้นตอนดำเนินงาน ยังไม่มีผล VM UAT จากการสร้างเครื่องมือ

## ขอบเขตและผู้ดำเนินการ

ทดสอบ Tenant Console แบบ A หน้าองค์กรและ Team เดิม โดย PostgreSQL เป็น authority ใช้ verified identity proof จริง ไม่สร้าง identity/email/name sync, hierarchy, reactivate, auto-move/revoke/cancel หรือเวลาทำการ Operator รับผิดชอบ fixtures/release/backup/rollback ทีมทดสอบทำ business steps ผ่าน UI และ owner หรือผู้แทนทีมรับรองขอบเขตทั้งหมดด้วยชื่อ บทบาท และวันเวลา Agent เก็บและตรวจหลักฐานได้ แต่สร้าง human signoff แทนทีมไม่ได้

ก่อนเริ่ม ตรวจ #729, native blockers #726/#728, map #717, candidate PR/review/CI และ current deployed base ใหม่ทุกครั้ง ข้อความ COMPLETE ของงานก่อนหน้าครอบคลุมเฉพาะ completion boundary ของงานนั้น ไม่ใช่ final first-slice PASS หากพบ authority/current writer ที่ไม่มีใน [inventory](./team-reference-inventory.md) ให้บันทึก gap และหยุดส่วนที่พึ่ง gap

## เตรียม fixtures และอุปกรณ์

Operator เตรียม fixture version เดียวที่ตรวจย้อนหลังได้ มีอย่างน้อยสอง tenants; tenant ทดสอบมี Admin สองคนที่เปิดพร้อมกัน, Supervisor ที่มี own active Team, Agent และ Compliance พร้อม native Organizations/verified proof จริงตาม [identity packet](./organization-limited-trial.md#handoff-ให้-operator-สำหรับบัญชี-admin-uat) ใช้ actor aliases ในหลักฐาน ไม่แนบ credential หรือข้อมูลบัญชีส่วนตัว

จัด legacy missing defaults และ provisioned defaults แยกกัน เตรียม Team ref-free, referenced, history-only, current/future claim และ unresolved negative ตาม §7 รวม missing/revoked/mismatched proof ห้ามแก้ประวัติหรือเติม canonical binding ด้วยการเดาเพื่อให้ deactivate ผ่าน การ cleanup/revoke/settle ใช้กระบวนการของ domain และคืน fixtures ตามที่บันทึกไว้ การ seed เตรียมสภาพเริ่มต้นได้ แต่ create/rename/deactivate/defaults ใน cases ต้องทำผ่าน UI

ใช้ Chrome และ Microsoft Edge ที่ติดตั้งจริง พร้อม headset และ SIP test caller ภายใต้ scope เดิม ปิด fake media, route mocks, synthetic identity, trace และ video; ห้ามเก็บ raw HAR/JWT/password/storageState ถ้าต้อง fault injection ให้ขัด transport เฉพาะ session ทดสอบโดยไม่แทน response/effects ของ Core ด้วย mock และเก็บ API/DB readback ที่ redact แล้วสำหรับ unknown/recovery/guards

## Release และ rollback ก่อนเปิดรอบ

ทำตาม [หน้าองค์กร](./organization-limited-trial.md#package-และ-deploy-ด้วยเครื่องมือเดิม) และ [หน้า Team](./team-limited-trial.md#ก่อนขึ้น-vm) โดยใช้ operator package ของ candidate จริงและ `full_workspace=true` ตรวจ full Workspace/E1 overlay ที่ใช้อยู่จริง คง profile `uat-workspace`; `uat`/`uat-e1` ยังปิด Core routes ไม่เปิด LINE หรือเปลี่ยน switches/Keycloak/provision โดยอัตโนมัติ

1. ตรวจ tested SHA ว่าเป็น ancestor ของ `origin/main` และ image source labels/Console/API/proxy/config ตรง candidate เดียวกัน บันทึก current deployed base จาก VM และ release record จริง ไม่ใช้ PR SHA แทน tested ancestor หรือ rewrite SHA หลัง merge
2. ซ้อม additive migration/RLS ซ้ำ พร้อม fresh/legacy/data conservation และ old API image ของ current deployed base กับ new schema เก็บ image digests และ TAP/ผล query จริง Coverage CI บน baseline รุ่นเก่าไม่แทน rehearsal ของ deployed base ใหม่
3. Backup application และ Keycloak ด้วย PostgreSQL client ที่ pin ตรง VM3 เก็บ checksum, catalog/restore readiness และผล isolated restore ตาม release contract ห้ามนำ dump ที่มีข้อมูลส่วนตัวเข้า public artifact ไม่มี down-migrate/drop history
4. ประสาน Voice idle window ตรวจว่าไม่มี waiting/ringing/active/WRAPUP/live leases ก่อน deploy ใช้ runner ของ release เดียวกันตาม `prepare → backup → migrate → deploy → smoke`; ขั้น `record` ทำเมื่อ release gates ของตนผ่านครบ ใช้ media preflight ตาม operator runbook เมื่อเกี่ยวข้อง และให้ operator ทำ human sudo ผ่านช่องทางปกติ
5. Authenticated Core route smoke เปิด Team mode และ Voice call จริง: SIP caller → offer → รับ → เสียงสองทางที่ human ยืนยัน → WRAPUP → save/readback ระหว่างสายให้ Admin แก้ชื่อ/defaults แล้วตรวจ RTP/PeerConnection/work-session/live UI เดิมไม่เปลี่ยน ข้อมูลใหม่มีผลตอนโหลดครั้งถัดไปตาม personal preference precedence
6. ซ้อม app rollback API/proxy ไป digests ของ deployed base คง schema/data/audit/receipts/tombstones ตรวจ old API/new DB และ navigation fallback พร้อม fingerprints ก่อน/ระหว่าง/หลัง จากนั้นคืน candidate เดิมและตรวจ authenticated smoke อีกครั้ง DB restore เป็น DR แยก มี owner/จุดย้อนข้อมูล ไม่ทำอัตโนมัติเมื่อ readback ล้มเหลว
7. หลัง trial คืนชื่อ/defaults/fixtures และ Voice OFF, calls=0, live leases=0 เก็บ final state และ deployment record/readback ตาม release gate เดิม

Wrap-up ใช้ policy ของคิวจริงตาม [owner resolution](https://github.com/Kitti-Nualsalee/dcontact/issues/723#issuecomment-6489966786): `LEGACY` ต้อง disposition/readback; `VOICE_NOTE_V1` ต้อง disposition+โน้ต/readback เก็บ policy ทุกครั้ง ไม่เปลี่ยน policy เพื่อให้ Core ผ่านและไม่อ้าง notes coverage จาก LEGACY

## รอบทดสอบ Chrome และ Edge

ใช้ read-only browser preflight แยกจาก local harness:

```bash
export CORE_SETTINGS_BASE_URL='https://dcontact-uat.osd.co.th'
pnpm --filter @d-contact/console test:core-settings:uat:preflight
```

Config `apps/console/playwright.core-settings-uat.config.ts` ใช้ branded channels `chrome`/`msedge`, headed mode, TLS verification, ไม่มี webServer/seed/mock login ติดตั้ง browser และ map hosts ตาม ADR-030 ก่อนรัน ผล `browser-preflight.json` เก็บ version/UA/runtime จริงเท่านั้น (`businessCases=NOT_RUN`, `vmUat=NOT_PROVEN`) ไม่รับไฟล์นี้แทน run provenance หรือ business evidence

ทีมทำ Chrome รอบ 1 → Chrome รอบ 2 → Edge รอบ 1 → Edge รอบ 2 บน tested/deployed SHA, image digests, config digest และ fixture version เดียวกัน เก็บ run ID และเวลาเริ่ม/จบพร้อม timezone; ใช้ browser version เดิมภายในคู่ หากรอบล้มเหลว ให้เก็บผลล้มเหลวใน operational log แล้วเริ่มคู่ใหม่จากรอบ 1 ห้ามเลือกเฉพาะสองรอบ PASS ที่มีรอบล้มเหลวคั่น หาก build/config/fixtures เปลี่ยน เริ่มทั้งสี่รอบใหม่และเก็บ bundle เดิมแยก

แต่ละรอบทำครบ 18 cases `ORG-TR01`–`ORG-TR09` และ `TEAM-TR01`–`TEAM-TR09` ตามตารางใน [Org business checks](./organization-limited-trial.md#business-checks-และหลักฐาน-trial) และ [Team business checks](./team-limited-trial.md#business-checks) ใช้ Org/Team เมนูที่ deploy จริง ไม่คงข้อจำกัด org-only trial เดิมเมื่อ Team พร้อมแล้ว ทุก case ต้อง expected/actual/actor/time และหลักฐานจากรอบนั้น ไม่คัดลอก limited-trial หรือ CI เก่า

| กลุ่ม                | หลักฐานที่ต้องเห็นเพิ่มเติมจาก happy path                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Defaults/provenance  | legacy name-only ไม่ fabricate defaults, explicit TH/EN+timezone, provisioned row, personal preference precedence/session ใหม่                                                              |
| Concurrency/recovery | Admin สองคน revision เดียว, conflict เก็บร่าง, lost response/readback, reload command-only, busy/late POST/receipt reconcile ด้วย API/DB จริง ไม่มีคำสั่งซ้ำ                                |
| Identity/permission  | same-identity reauth, sign-out/tenant/identity switch ล้าง draft/reference, Supervisor own-team, Agent/Compliance/foreign/missing/revoked/mismatched proof ไม่ได้ metadata/สิทธิ์เกินขอบเขต |
| Team guards          | ref-free ปิดได้, history-only ปิดได้, referenced/current-future บล็อกตาม kind/count, unresolved บล็อกเฉพาะ deactivate, inactive rename ได้ ไม่มี reactivate/force                           |
| UI/navigation        | deep links/back-forward/reload/dirty warning, keyboard/focus trap/return focus/error summary, TH/EN, narrow≤760 readonly/ขยายกลับ recheck authority+revision                                |
| Regression           | actual Voice/WRAPUP ตาม policy, live defaults ไม่รื้อ Workspace/call/session, old API/new Console fallback และ runtime allowlist                                                            |

CI HTTP/RLS/identity/actual writer races ของ candidate ต้องครบตาม §9 แนบ immutable run evidence ที่ SHA เดียวกัน ไม่มี skip/TODO/fail ไม่แทนผล UI/Voice บน VM ตรวจ no S1/S2 ค้างก่อนขอรับรอง

## รูปแบบ evidence bundle

เก็บ bundle ใน private operational storage ที่ทีมอนุญาต ภายใต้ directory เดียวกัน ตัวอย่างโครงสร้างนี้ไม่มีผล PASS หรือ signoff ที่สร้างไว้ล่วงหน้า:

```text
manifest.json
manifest.json.signoff.json
captures/                 # ผล operator/API/DB/ภาพที่ตรวจ redact แล้ว
release/                  # release observations ครบ 14 checks
chrome-1/                 # provenance + 18 UI observations
chrome-2/
msedge-1/
msedge-2/
```

[JSON Schema](./uat-evidence.schema.json) มี `$defs.manifest`, `uiObservation`, `releaseObservation`, `browserProvenance` และ `signoff` ใช้ช่วย authoring; executable gate เป็นผู้ตรวจ bindings/bytes/coverage/time/Git เพิ่ม ไม่มี schema validator dependency ใน runtime

`manifest.json` ใช้ `schemaVersion=1`, `kind=CORE_SETTINGS_VM_UAT`, `environment=vm-uat`, `runtimeProfile=uat-workspace`, `testedSha`, `deployedSha` (ต้องเท่ากัน), `deployedBaseSha`, `configDigest` (SHA256 จาก `core-settings-uat-snapshot.mjs` ของ VM2 โดยไม่เผย secret), `fixtureVersion`, `timezone`, `images` และ `fixtureCoverage` บันทึก image **digests** ใต้ keys `api`, `console` (image ของ proxy รวม Console/Workspace bundle), `ops`, `keycloak`, `e1` (ใช้ API image ของ candidate), `freeswitch` ตาม package/runtime จริง ไม่ใช้ tag หรือละ service ที่เกี่ยวข้อง

`artifacts` แต่ละรายการมี `id`, `path` แบบ relative ใต้ bundle, `sha256`, `redacted=true`, `kind=capture|observation` Checksum ต้องมาจาก bytes หลัง redact; ไม่ชี้ symlink ออกนอก bundle `kind=capture` เป็นหลักฐานต้นทางที่อนุญาตเผยแพร่ เช่น sanitized query/readback/operator transcript หรือภาพ UI ที่ตรวจแล้ว ไม่ใช่คำรับรอง PASS อีกไฟล์หนึ่ง JSON observations ใช้ `kind=observation` และอ้าง captures ที่สัมพันธ์กับ case จริง

`releaseChecks` มี `{id,evidence}` ครบ `candidate-ci`, `deployed-base`, `workspace-overlay`, `identity-fixtures`, `migration-rls`, `old-api-new-schema`, `backup-restore-readiness`, `idle-window`, `authenticated-smoke`, `voice-smoke`, `live-defaults`, `app-rollback`, `candidate-restored`, `final-state` Evidence เป็น JSON `CORE_SETTINGS_RELEASE_OBSERVATION` มี `checkId`, `result`, `actor`, `expected`, `actual`, `recordedAt`, `artifacts` (capture IDs) และ binding packet เดียวกับ manifest: `testedSha/deployedSha/configDigest/fixtureVersion/images` ระบุ current base ใน deployed-base/old-api-new-schema/app-rollback; Voice ระบุ `voiceWrapupPolicy`, `twoWayAudioConfirmedBy`, `dispositionReadback` และ `notesReadback` ถ้า VOICE_NOTE_V1; final-state ระบุ `voiceEnabled=false`, `calls=0`, `liveLeases=0`, `defaultsRestored=true`

`runs` เรียงเวลาจริง 4 รายการ แต่ละรายการมี `id`, `browser=chrome|msedge`, `round=1|2`, `startedAt`, `endedAt`, `provenance` และ `cases` ครบ 18 `{id,evidence}` Evidence เป็น JSON `CORE_SETTINGS_UI_OBSERVATION` พร้อม binding packet, `runId`, `caseId`, `result=PASS`, `method=real-ui`, `actor`, `expected`, `actual`, `recordedAt` ภายในรอบ และ capture IDs ห้ามให้ gate ยอมรับเพียงชื่อ suite หรือ flags PASS ใน manifest

Run provenance เป็น `CORE_SETTINGS_BROWSER_PROVENANCE` พร้อม binding packet, `runId/channel/version/userAgent/timezone/startedAt/endedAt`, `syntheticIdentity=false`, `fakeMedia=false`, `routeMocks=false` Operator เก็บ UA/version จาก browser ที่ใช้ทำรอบนั้นจริงพร้อม operational log ของทุก attempts ไม่เปลี่ยนชื่อ Chromium เป็น Edge หรือเอา preflight metadata ก่อนหน้าแทนทั้งรอบ การตรวจสตริง UA ไม่ใช่ cryptographic proof ว่าใช้ browser จริง ทีมต้องตรวจต้นทางประกอบการรับรอง

`openDefects` ต้องเป็น array ระบุ id/severity ของงานค้าง อนุญาตเฉพาะ S3/S4 ที่ทีมรับทราบ ถ้าไม่มีใช้ `[]` ไม่ละ field หรือใส่ S1/S2 แล้วเรียกว่าผ่าน

## Signoff และ executable gate

หลังผลครบและ freeze manifest คำนวณ SHA256 ของ **exact bytes** แล้วให้ owner/test-delegate รับรองผ่านช่องทางของทีมจริง เก็บ detached `manifest.json.signoff.json` โดยมี `kind=CORE_SETTINGS_UAT_SIGNOFF`, `manifestSha256`, `role=owner|test-delegate`, `name`, `scope=core-settings-first-slice`, `decision=ACCEPT`, `recordedAt` หลังผลทั้งหมด และ `attestationReference` ที่ตรวจย้อนกลับได้ถึงคำรับรองจากคนจริง การแก้ manifest หลังรับรองต้องขอรับรองใหม่ ไม่สร้างไฟล์นี้แทนทีม

รันบน operator checkout ที่มี `origin/main` ล่าสุด ใช้ expected pins จาก release/VM record ที่ตรวจแยกแล้ว ไม่อ่าน pins ย้อนจาก manifest เพื่อให้ตรงกันเอง:

```bash
# ตั้ง SHA, CONFIG_SHA256 และ FIXTURE_VERSION จาก operator record ที่ตรวจจริง
# รับ CORE_SETTINGS_ACCESS_TOKEN ผ่านช่องทางส่วนตัว/env อายุสั้น ห้ามใส่ command line/history
export CORE_SETTINGS_BASE_URL='https://dcontact-uat.osd.co.th'
# CORE_SETTINGS_CONNECT_HOST ใช้ได้เมื่อ operator ต้อง connect VM1 ตาม hosts mapping
pnpm core-settings:uat:gate --manifest /private/evidence/manifest.json \
  --sha "$SHA" --config "$CONFIG_SHA256" --fixtures "$FIXTURE_VERSION"
unset CORE_SETTINGS_ACCESS_TOKEN
```

Library `validateUatBundle` คืน `BUNDLE_CONSISTENT` เฉพาะความครบ/สอดคล้อง ไม่ให้ VM PASS จาก static inputs CLI ต้องตรวจ authenticated route smoke ใหม่จริง (read-only และ unauthenticated rejection probes ของ script เดิม, Team mode) จึงคืน `EVIDENCE_VALIDATED`, `vmUat=ATTESTED_BY_TEAM`, `acceptanceMarkerIssued=false` Token ต้องเป็น Admin fixture ของ tenant ทดสอบ ไม่มี credential/VM/network ให้คืน nonzero/NOT_PROVEN

ก่อน live smoke CLI อ่าน deployment record และ Docker metadata ผ่าน SSH แบบ BatchMode ไปยัง VM2 ที่กำหนดใน ADR-030 ด้วย `core-settings-uat-snapshot.mjs` ตรวจ source labels ของ API/proxy/E1 ว่าตรง record, image digests ทั้งหก และ config digest จาก Config/HostConfig/Mounts ของ containers ที่กำลังทำงานรวม bytes ของ bind-mounted files และ config directory `/e1-freeswitch` ที่ใช้จริง ไม่อ่าน directory ของ DB/media และไม่พิมพ์ Config.Env หรือ secrets หาก SSH ไม่พร้อมหรือ deployment เปลี่ยนให้ nonzero เก็บ snapshot ด้วย `node scripts/core-settings-uat-snapshot.mjs` ก่อนเริ่มรอบและหลังจบด้วย config digest วิธีเดียวกัน; หาก file/directory-backed configuration ที่เกี่ยวข้องเปลี่ยนนอก snapshot ให้ operator เริ่มรอบใหม่ตาม contract ไม่ใช้ผล hash แทนการตรวจ full overlay หลัง smoke ตรวจ bundle และ runtime snapshot ซ้ำเพื่อปฏิเสธการเปลี่ยนระหว่าง gate Snapshot/route smoke ไม่ replay business steps หรือยืนยัน signoff reference ผ่านช่องทางทีม Gate ตรวจ checksum/โครงสร้าง/ความสอดคล้อง ไม่ยืนยันตัวตนผู้ลงนามหรือความจริงของคำรับรองด้วยตัวเอง ไม่ออก immutable CI acceptance marker หรือปิด issue ให้อัตโนมัติ

Unit tests ของเครื่องมือ:

```bash
pnpm test:core-settings:uat
node --test scripts/core-settings-evidence.test.mjs scripts/core-settings-release.test.mjs
```

CI job `uat-evidence-tools` ตรวจ validator ด้วยข้อมูลจำลองเท่านั้น ไม่เข้าถึง VM และไม่สร้าง team signoff เมื่อ VM/บัญชี/browser/Voice/ทีมไม่พร้อม บันทึก NOT_RUN พร้อม gate ที่ค้างบน #729 คง issue เปิดจน VM สองรอบ Chrome/Edge, release/rollback/Voice evidence, no S1/S2 และทีมรับรองครบจริง
