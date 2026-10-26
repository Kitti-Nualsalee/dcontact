# B7: เตรียม release และ controlled trial ของ V1-B

Authority: #704 และ #714; B1–B6 เป็น implementation prerequisites ไม่ใช่หลักฐาน VM trial
ใช้ Workspace UAT composition เดิม ไม่ import default/Platform API และไม่เปิด Kafka/LINE
เก็บผล A notes/history เดิมตลอด rollout และ rollback

## 1. ตรวจ source artifacts ก่อน package

### Local rehearsal แยกจาก VM

สำหรับ #714 ใช้ Compose project `dcontact-v1b-local` และเรียง overlay:
`docker-compose.uat.yml` → `docker-compose.uat.e1.yml` →
`docker-compose.uat.workspace.yml` → `docker-compose.uat.workspace-local.yml`
จาก `infra/uat/` ไม่ใส่ overlay `3vm` และไม่ใช้ project `dcontact-uat` ที่อาจมีข้อมูลเดิม
ตัวรัน `uat-local.sh` เดิมยังเป็น U1 ไม่ใช่ตัวรัน B7 ครบชุด

Local overlay ส่ง DB ไป PostgreSQL ใน project เดียวกัน ใช้ proxy/media แบบ loopback
และ Mailpit ใน internal network (SMTP `mailpit:1025`, mailbox UI `http://127.0.0.1:18025`
ผ่าน service `mailpit-ui` ที่ reverse proxy เฉพาะ HTTP ไป Mailpit; ตัว Mailpit ไม่ต่อ edge network)
ไม่ตั้ง relay/forward ออกภายนอก ใช้ผู้รับสังเคราะห์ `@example.test` เท่านั้น
ต้องสร้าง env ส่วนตัว, build images จาก candidate SHA, certificate ที่ browser เชื่อถือสำหรับ
`console.dcontact.test`/`workspace.dcontact.test` และ bootstrap identity/worker ก่อน `up`
ชื่อทั้งสองต้อง resolve เป็น `127.0.0.1` บนเครื่องผู้ทดสอบ (เช่นผ่าน `/etc/hosts`)
ไม่ใช้ `*.localhost` เพราะ realm bootstrap ปฏิเสธตาม identity guard เดิม
อย่าใช้ image placeholder ของ composition tests หรือ credential ของ VM

Ports 80/443 และ UDP 16384–16420 bind เฉพาะ `127.0.0.1`; ถ้าชน service เดิมให้หยุดตรวจ
ไม่หยุดหรือลบ container อื่นเอง ตัวแปร media ที่โฆษณาเป็น loopback ใช้เฉพาะ browser บนเครื่องเดียวกัน
การ render Compose ผ่านยังไม่ยืนยัน media บน Docker Desktop ต้องพิสูจน์เสียงจริงแยก
Local entrypoint กำหนด `local_ip_v4` จาก IPv4 ของ container ก่อนเรียก entrypoint เดิม
เพราะ FreeSWITCH อาจตรวจได้ loopback เมื่ออยู่บน internal network; advertised media ยังคง loopback
ไม่แก้ entrypoint หรือค่า bind ของ VM และไม่เปิด SIP/ESL port บน host
ไม่ใช้ local rehearsal ปิด VM/human acceptance ของ #714 และไม่รัน `down -v` เพื่อทำให้ smoke ผ่าน

```bash
pnpm test:voice-v1b:readiness
pnpm voice:v1b:readiness -- --static
```

ผล `scope=SOURCE_ARTIFACTS_ONLY` ตรวจ wiring/profile/default-off และ pinned artifact เท่านั้น
ไม่ยืนยัน worker binding บน server, image ที่ deploy จริง, SMTP, backups, เสียง หรือ human sign-off
ไม่ใช้ static PASS หรือการอ่าน capability สำเร็จแทนผล business trial
`sourceSha` เป็น HEAD ของ checkout; หาก `worktreeDirty=true` ผลเป็นเพียงการตรวจ working tree
ไม่ใช่หลักฐาน candidate SHA นั้น ต้อง commit/review/CI บน SHA ที่สะอาดก่อน package

## 2. เงื่อนไขก่อน deploy/เปิด writes

- Candidate ต้องอยู่บน main ตาม ADR-032 พร้อม review/CI/affected HTTP/RLS, Keycloak/SMTP,
  browser และ real managed SIP proofs ที่ผูก SHA เดียวกัน
- ตรวจ VM1/VM2/VM3 สด: capacity, clock, current deployment/image digests/OCI source SHA,
  authenticated idle, ไม่มีสายหรืองานค้าง และไม่มี operation/SMTP outcome ที่ยังไม่ยืนยัน
- สำรอง application DB และ Keycloak DB แยกกัน ตรวจ restore/schema rehearsal บนฐานแยก
  ไม่ restore ทับฐานร่วม ไม่ down-migrate และไม่ลบ users/results/outbox/receipts
- Worker ใช้ login แยก `NOINHERIT NOSUPERUSER NOBYPASSRLS` ที่ได้รับเพียง
  `dcontact_tenant_people_worker` และ approved tenant binding; ไม่ fallback เป็น application/owner
- ตรวจ Keycloak image/extension/JPA schema, tenant service client/role allowlist/Organization,
  positive identity classifications และ bootstrap Admin ที่พร้อมใช้จริง
- ระบุผู้รับทดสอบและผู้ทดสอบที่ owner อนุญาตก่อนตั้ง SMTP relay/recipient allowlist
  ไม่อนุมาน recipient จากชื่อบัญชี login และไม่ส่งเมลจาก readiness command
- เปิด media/caller เฉพาะ scope ที่อนุญาต ตรวจ pool/release/dialplan digests และ switch ledger
  ไม่ prune/resize/reset password/OTP เพื่อทำให้ smoke ผ่าน

## 3. Workspace runtime ของ B

Overlay `infra/uat/docker-compose.uat.workspace.yml` ส่ง environment แบบ default-off:

- `UAT_TENANT_PEOPLE_BINDINGS_JSON`: server-owned bindings และ approved node/pool refs
- `UAT_TENANT_PEOPLE_WORKER_DATABASE_URL`: connection ของ dedicated worker login เท่านั้น
- `UAT_TENANT_PEOPLE_SECRET_UAT`: secret ฝั่ง server; binding ใช้ `clientSecretEnv=TENANT_PEOPLE_SECRET_UAT`
- `UAT_TENANT_PEOPLE_INVITATIONS_ENABLED` และ `UAT_TENANT_PEOPLE_DISABLE_ENABLED`: ค่าเริ่มต้น `false`

ค่าจริงอยู่ใน private operator env ไม่ใส่ issue, release JSON, command line หรือ frontend
Workspace ส่ง SIP flush ผ่าน direct `E1VoiceCommandPublisher` ไม่ใช่ Kafka
การส่งคำสั่งหรือได้ HTTP202 ไม่ใช่หลักฐานว่า flush สำเร็จ ต้องมี scoped telephony audit ตาม B6
API/worker/schema/identity ต้องพร้อมก่อน Console และก่อนเปิด writes

## 4. Read-only preflight ก่อน controlled trial

Operator เก็บหลักฐานที่ตรวจจริงเป็นไฟล์ private schema `VoiceV1BPreflightV1`:

```json
{
  "schema": "VoiceV1BPreflightV1",
  "sourceSha": "<candidate SHA ที่ตรวจ OCI/deployment record แล้ว>",
  "runId": "<run ID เดียวกับคำสั่ง>",
  "gates": []
}
```

แต่ละ gate มีเฉพาะ `id`, `status`, `observedAt` (ISO UTC), `reference` (opaque ID)
และ `digest` (SHA256 ของหลักฐาน private) ต้องครบ:

- `DEPLOYED_SOURCE_AND_IMAGES`, `WORKER_BINDING`, `IDENTITY_EXTENSION_AND_CLIENT_POLICY`
- `CAPACITY`, `APPLICATION_BACKUP_REHEARSAL`, `IDENTITY_BACKUP_REHEARSAL`
- `AUTHENTICATED_IDLE`, `MEDIA`, `SWITCHES`, `CLOCK`, `EXTENSION_POOL`
- `RECIPIENT_ALLOWLIST`, `DELIVERY_PROBE`

ไม่สร้างแถว `PASS` จากตัวอย่างหรือจากความจำ ต้องมีหลักฐานจริงก่อนกรอก
ไฟล์นี้เป็น operator-owned attestation: script ตรวจ schema/correlation/freshness ไม่ตรวจลายเซ็น
หรือพิสูจน์เนื้อหาหลักฐานแทน operator; OCI/deployment provenance ต้องตรวจจาก VM จริงก่อน
record สดได้ไม่เกินหนึ่งชั่วโมงและไม่ล่วงหน้าเกิน 30 วินาที ไม่ใส่ URL/secret/PII ใน reference

ตั้ง `UAT_BASE_URL` เป็น HTTPS root, `V1B_EXPECTED_SOURCE_SHA`, `V1B_PREFLIGHT_EVIDENCE_FILE`
และส่ง token Admin ผ่าน `V1B_READINESS_ACCESS_TOKEN` ใน environment ส่วนตัวเท่านั้น:

```bash
pnpm voice:v1b:readiness -- --live --run-id <runId>
```

คำสั่งใช้ GET เท่านั้น: runtime isolation, capabilities และ authenticated directory
ไม่ตาม redirect ไม่ส่ง body/SMTP ไม่สร้าง user ไม่เปิด switch และไม่พิมพ์ response/token
ขาด input/record/สิทธิ์หรือบริการไม่พร้อมจะ exit nonzero โดยไม่ข้าม gate
ผลยังเป็น `scope=READ_ONLY_PREFLIGHT_ONLY`, `trial=NOT_EVALUATED` เสมอ

## 5. Controlled trial และคืนค่า

Operator bootstrap เฉพาะ infra/initial Admin/team/policy/pools/servicebinding/SMTP/media/caller
Admin สร้าง queue, skill, Agent ใหม่สองคน, Supervisor และ Admin ผ่าน UI จริง
ผู้ทดสอบรับอีเมลและทำ password/TOTP/activation ด้วยตนเอง ไม่ส่งรหัสหรือ invitation link ในแชต
ตรวจ routing/skills/team permission/idle/resend/disable/recovery พร้อมเสียง headset สองทาง
และ A save/result/history/reload บนบัญชีใหม่ ไม่ใช้ DB preseed แทนขั้น business

Evidence ผูก run/catalog/SHA/image digests/config revision/policy/fixture/actor/browser/correlation
พร้อม expected/actual และ sanitized image manifest แบบ private ไม่มี raw HAR/trace/token/OTP QR
หลังทดสอบหยุด new operations/drain worker/reconcile external outcomes ก่อนคืน switches/binding/skills
ตาม revision ledger; disable เฉพาะ test accounts ที่อนุญาตและไม่ใช่ last usable Admin
เก็บ identity/history/operations/audit/evidence ไม่ลบเพื่อให้ rollback ดูผ่าน
ไม่ปิด #714 จน trial/cleanup/rollback evidence และ human feedback ครบ ไม่อ้าง final C
