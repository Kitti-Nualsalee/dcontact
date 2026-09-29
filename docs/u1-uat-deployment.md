# U1.6 — UAT deployment (VM + Docker Compose), Keycloak UAT realm และ workflow `uat-preview`

Authority: Phase Contract #374, การตัดสินใจเรื่อง environment #373, ticket U1.6 #434

เอกสารนี้เป็น runbook ของ operator สำหรับ UAT first slice: stack UAT แยกถาวรบน VM เดียว
(Docker Compose แบบ production-shaped), Console/API แบบ tenant-scoped บน HTTPS origin เดียว
(`/api/v1`) และ Keycloak ของ UAT, บัญชี maker/checker ที่ระบุตัวตนพร้อม TOTP, gateway/allowlist
ภายใน และการ promote/rollback ด้วย image digest ที่เปลี่ยนไม่ได้

> ซ้อมขั้นทั้งหมดบนเครื่องตัวเองก่อน (ไม่ต้องมี VM): `bash infra/uat/bin/uat-local.sh up` — ดู `docs/u1-uat-local.md`

> ค่าจริงของ host/domain/DNS/TLS/gateway เป็น **provisioning gate** (input ตอน deploy) — ไม่อยู่ใน Git
> ห้ามเปิด UAT ให้ผู้ทดสอบจนกว่าตาราง provisioning gate ด้านล่างจะกรอกและ verify ครบ

## 1. สถาปัตยกรรม

```text
ผู้ทดสอบ (browser)
   │ HTTPS
   ▼
identity-aware gateway / allowlist (provisioning gate)
   │ 443 (80 = redirect)
   ▼
┌──────────────────────────── VM: docker compose project `dcontact-uat` ────────────────────────────┐
│ proxy  (image CONSOLE_IMAGE = Caddy + Console static, non-root, TLS จากไฟล์)                        │
│   ├─ /             → Console (Vite build; VITE_CONSOLE_DEFAULT_VIEW=journeys)                        │
│   ├─ /api/*        → api:3000   (image API_IMAGE, DCONTACT_API_PROFILE=uat, entry dist/uat-main.js)  │
│   ├─ /auth/*       → keycloak:8080 (image KEYCLOAK_IMAGE, production mode `start`, relative /auth)  │
│   └─ /auth/admin*, /auth/realms/master* → 404 (admin เข้าได้จากใน VM เท่านั้น)                      │
│                                                                                                   │
│ network `internal` (internal: true — ไม่มีทางออก internet)                                          │
│   api ── postgres (dcontact: role dcontact_app, NOBYPASSRLS)                                        │
│   keycloak ── postgres (database keycloak, role keycloak)                                          │
│   api ── object-storage:8333 (SeaweedFS; user uat-evidence-api เฉพาะ `uat-evidence` private)      │
│   object-storage-lifecycle (lifecycle pass ทุก 1 ชม.), object-storage-migrated-expiry (#540/#541)   │
│                                                                                                   │
│ one-shot (profile ops, image OPS_IMAGE): db-roles, migrate, keycloak-config                         │
│ one-shot ทุก deploy ก่อน api: object-storage-init (bucket private ผ่าน S3 API)                     │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘
```

สิ่งที่ **ไม่มี** ใน UAT (#374): `apps/journey` worker/Journey runtime, FreeSWITCH, Kafka/Redpanda,
Redis — API profile `uat` (U1.2 #430) ปิด Kafka/LINE/provider egress เชิงโครงสร้าง และบูตไม่ผ่านถ้ามี
env `LINE_*`, `KAFKA_BROKERS` หรือ `SIP_*`

| ไฟล์                                     | หน้าที่                                                                                            |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `apps/api/Dockerfile`                    | target `runtime` (API UAT) และ `ops` (Prisma migrate, Keycloak config, readiness, `uat-provision`) |
| `apps/console/Dockerfile`                | Console build (`VITE_*` ตอน build) + Caddy (`infra/uat/Caddyfile`)                                 |
| `infra/keycloak/Dockerfile`              | Keycloak 26.0.0 + login/email theme `dcontact` (#515/#522) — token/โลโก้สร้างตอน build             |
| `infra/uat/docker-compose.uat.yml`       | stack ของ UAT — image อ้างด้วย digest, secret เป็น `${VAR:?}` ทั้งหมด                              |
| `infra/uat/bin/uat-deploy.sh`            | ขั้นตอนบน VM: prepare/backup/migrate/keycloak/provision/deploy/smoke/record/rollback               |
| `infra/uat/bin/db-roles.sh`              | role ของ Postgres (Keycloak, `dcontact_app`) จาก secret                                            |
| `infra/uat/bin/object-storage-entrypoint.sh` | SeaweedFS `weed server -s3`: สร้าง `s3.json` (identity root/API + policy) ใน tmpfs จาก secret |
| `infra/uat/docker-compose.uat.migration.yml` | overlay ย้ายหลักฐานจาก MinIO เดิมครั้งเดียว (#540) — ถอดใน #541                              |
| `scripts/uat-object-storage.mjs`         | ops: `init` (bucket private), `migrate`, `expire-migrated`                                         |
| `infra/uat/bin/ci-ssh-setup.sh`          | SSH ของ runner จาก secrets ของ environment `uat-preview`                                           |
| `infra/uat/uat.env.example`              | รายชื่อค่าใน `uat.env` (ไม่มีค่า)                                                                  |
| `infra/keycloak/realm-dcontact.uat.json` | realm UAT (template `${env.*}`) — ไม่มี user/secret, บังคับ password+TOTP                          |
| `scripts/u1-uat-keycloak-users.mjs`      | render/reconcile realm และสร้างบัญชี maker/reviewer จาก secret input                               |
| `scripts/u1-uat-readiness.mjs`           | readiness: `--static`, `--live`, `--migration-guard`, deployment record                            |
| `.github/workflows/uat-preview.yml`      | deploy/rollback ด้วยมือ ผ่าน environment `uat-preview`                                             |

## 2. Provisioning gate (กรอกก่อนเปิด UAT)

ทุกแถวต้องมีค่า ผู้ verify และวันที่ ก่อน deploy ครั้งแรก — ค่าที่เป็น secret บันทึกเฉพาะ "อยู่ที่ไหน"
ใน secret store ไม่ใช่ตัวค่า

| รายการ                                                                   | ใช้ที่                                                           | ค่า / ตำแหน่ง | verified by | วันที่ |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------- | ------------- | ----------- | ------ |
| Host/VM (ขนาด, OS, Docker Engine + compose plugin)                       | ที่รัน stack                                                     |               |             |        |
| Domain ของ UAT (`UAT_HOST`)                                              | Caddy, `KC_HOSTNAME`, redirect URI, `VITE_KC_ISSUER`             |               |             |        |
| DNS ของ `UAT_HOST` → gateway/VM                                          | การเข้าถึงของผู้ทดสอบ                                            |               |             |        |
| แหล่ง TLS cert (CA, วันหมดอายุ, วิธีต่ออายุ)                             | `UAT_TLS_CERT_FILE`/`UAT_TLS_KEY_FILE` บน VM                     |               |             |        |
| Secret store (ที่เก็บค่าใน `uat.env` และไฟล์บัญชี)                       | operator วางไฟล์บน VM                                            |               |             |        |
| Identity-aware gateway / allowlist (`UAT_ALLOWED_CIDRS`)                 | Caddy `remote_ip` — ต้องมี pool ของ Docker bridge ด้วย (ข้อ 4.7) |               |             |        |
| GHCR access (VM pull แบบ read-only)                                      | `docker login ghcr.io` บน VM ด้วย token `read:packages` (ข้อ 4.6) |               |             |        |
| SSH key ของ deploy (public key บน VM, host key ใน `UAT_SSH_KNOWN_HOSTS`) | workflow `uat-preview`                                           |               |             |        |
| Tenant UAT (`UAT_TENANT_ID`/`UAT_TENANT_SLUG`/`UAT_TENANT_NAME`) และ fixture pack version | realm Organization, `VITE_UAT_PACK_VERSION`      |               |             |        |
| Domain ของ Keycloak Organization (`UAT_ORGANIZATION_DOMAIN`)             | realm ตั้งเป็น domain แบบ `verified` ของ Organization ของ tenant   |               |             |        |

## 3. ตั้งค่า GitHub environment `uat-preview`

Settings → Environments → `uat-preview`:

- **Required reviewers**: อย่างน้อยหนึ่งคนที่ไม่ใช่ผู้กด dispatch; เปิด "Prevent self-review"
- **Deployment branches**: `main` เท่านั้น (workflow ตรวจ `refs/heads/main` ซ้ำอีกชั้น)
- **Secrets** (ชื่อเท่านั้น — ค่าอยู่ใน secret store):
  - `UAT_SSH_PRIVATE_KEY` — private key ของ deploy user (ใช้กับ UAT เท่านั้น)
  - `UAT_SSH_KNOWN_HOSTS` — host key ของ VM ที่ verify แล้ว (`StrictHostKeyChecking yes`)
  - `UAT_SSH_HOST` — host/IP ของ VM สำหรับ SSH
  - `UAT_SSH_USER` — deploy user บน VM (อยู่ในกลุ่ม `docker`)
- **Variables** (ไม่ใช่ secret):
  - `UAT_HOST` — domain ของ UAT (ใช้ build Console: `VITE_KC_ISSUER=https://<UAT_HOST>/auth/realms/dcontact`)
  - `UAT_FIXTURE_PACK_VERSION` — pack version ที่ provision ไว้ (ฝังใน Console และบันทึกใน record)
  - `UAT_ENVIRONMENT` — ชื่อ environment ของ fixture pack (ว่าง = `uat`)

workflow ใช้ `github.token` push image ไป GHCR (`ghcr.io/<owner>/dcontact-uat-{api,ops,console,keycloak}`)
secret runtime ของ UAT (รหัสผ่าน DB/Keycloak/object storage) **ไม่ผ่าน GitHub** — อยู่ใน `uat.env` บน VM เท่านั้น
รายชื่อ secret ใน `uat.env` (ดู `infra/uat/uat.env.example`):

| ชื่อ                                                          | ใช้ที่                                                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `UAT_POSTGRES_USER` / `UAT_POSTGRES_PASSWORD`                 | owner ของ Postgres (migrate, backup)                                     |
| `UAT_APP_DB_PASSWORD`                                         | role `dcontact_app` ของ API                                              |
| `UAT_KEYCLOAK_DB_PASSWORD`                                    | role/database `keycloak`                                                 |
| `UAT_KEYCLOAK_ADMIN_USERNAME` / `UAT_KEYCLOAK_ADMIN_PASSWORD` | bootstrap admin ของ Keycloak (ใช้ภายใน VM เท่านั้น)                      |
| `UAT_S3_ROOT_ACCESS_KEY` / `UAT_S3_ROOT_SECRET_KEY`           | root ของ object storage — init, lifecycle, ย้ายข้อมูล, expiry เท่านั้น   |
| `UAT_S3_API_ACCESS_KEY` / `UAT_S3_API_SECRET_KEY`             | user เฉพาะของ API (`S3_ACCESS_KEY`/`S3_SECRET_KEY`) — ต่างจาก root       |
| `UAT_MINIO_ROOT_USER` / `UAT_MINIO_ROOT_PASSWORD` (ชั่วคราว)  | root ของ MinIO **เดิม** — ใช้เฉพาะตอนย้ายข้อมูล (ข้อ 7.1) ลบหลัง #541    |

credential ของ object storage (`UAT_S3_*`) ต้องเป็น `[A-Za-z0-9_-]` ยาว ≥ 8 (entrypoint เขียนลง `s3.json` โดยตรง
และไม่ยอมบูตถ้าผิดรูป)

### Evidence storage (U1.5 #433, SeaweedFS ตั้งแต่ #540)

- API profile `uat` **บูตไม่ผ่าน** ถ้าไม่มี `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` หรือ bucket ไม่พร้อม —
  compose ตั้ง `S3_ENDPOINT=http://object-storage:8333` (network `internal`), `S3_BUCKET_UAT_EVIDENCE=uat-evidence`
  และให้ api รอ `object-storage-init` จบสำเร็จก่อน (ADR-029: env ของแอปเป็น `S3_*`)
- `object-storage` = SeaweedFS `weed server -s3` (**ไม่ใช้ `weed mini`** ที่เปิด admin/worker gRPC แบบไม่มี mTLS)
  รันเป็น uid 1000, `cap_drop: ALL`, rootfs read-only; entrypoint สร้าง `/tmp/s3.json` (tmpfs, mode 0400) ที่มี
  identity แค่ `root` กับ `uat-evidence-api` — ไม่มี `anonymous` และปฏิเสธถ้า access key ของ API = root
- สิทธิ์ของ API = policy `uat-evidence-api` แบบ AWS ผูกด้วย `policyNames` (ห้ามใช้ `actions` แบบหยาบ — spike #539):
  `s3:CreateBucket`, `s3:PutLifecycleConfiguration`, `s3:GetLifecycleConfiguration`, `s3:GetBucketPolicy`,
  `s3:GetBucketLocation`, `s3:ListBucket` บน `arn:aws:s3:::uat-evidence` และ `s3:PutObject`, `s3:GetObject`,
  `s3:DeleteObject` บน `arn:aws:s3:::uat-evidence/uat-evidence/*` เท่านั้น (ทดสอบด้วย
  `pnpm test:object-storage:least-privilege` ใน CI)
- `object-storage-init` (ops image, idempotent ทุก deploy) ใช้ root สร้าง `uat-evidence` (HeadBucket ก่อน) และยืนยันว่า
  ไม่มี bucket policy; API `ensureBucket()` ตรวจ HeadBucket ก่อนเช่นกัน (SeaweedFS ตอบ `BucketAlreadyExists`
  เมื่อ bucket เป็นของ root)
- ตอนบูต API ตั้ง lifecycle ให้ object ใต้ `uat-evidence/` หมดอายุใน **90 วัน** และปฏิเสธการบูตถ้า bucket มี bucket policy;
  SeaweedFS 4.48 ไม่รัน lifecycle เอง — `object-storage-lifecycle` สั่ง `s3.lifecycle.run-shard -refresh 1h`
- object storage ไม่เปิดพอร์ตสู่ host; ภาพหน้าจอเข้า/ออกผ่าน API ที่ตรวจสิทธิ์เท่านั้น (ไม่มี presigned/public URL)
- rotate secret: แก้ `uat.env` แล้ว deploy ซ้ำ (`object-storage` สร้าง `s3.json` ใหม่ตอน container ถูกสร้างใหม่)
- disk: `-volume.max=64` × 64 MB = สูงสุด 4 GB สำหรับ bucket เดียว; ระหว่างย้ายข้อมูล volume `minio-data` เดิมยังอยู่

## 4. เตรียม VM ครั้งแรก

1. ติดตั้ง Docker Engine + compose plugin; ตั้ง `"userland-proxy": false` ใน `/etc/docker/daemon.json`
   เพื่อให้ Caddy เห็น source IP จริง (allowlist ใช้ `remote_ip`)
2. firewall ของ host/cloud: เปิดเฉพาะ 22 (จากที่ที่ runner/operator ใช้) และ 443/80 (จาก gateway)
3. สร้างโครง `/opt/dcontact-uat/{releases,deployments,backups,tls}` owner = deploy user, mode 700
4. วาง cert/key ของ `UAT_HOST` ใน `/opt/dcontact-uat/tls/` — ใช้ path นี้ใน `UAT_TLS_CERT_FILE`/`UAT_TLS_KEY_FILE`
   - compose secret แบบ file เป็น bind mount (uid/gid/mode ใน compose ไม่มีผล) และ Caddy ใน image รันเป็น uid 10001
     จึงต้อง `sudo chown 10001:10001 <key> && sudo chmod 400 <key>` (cert อ่านได้ทุกคน `chmod 444`) — ถ้าเป็นของ
     deploy user mode 600 proxy จะอ่าน key ไม่ได้และไม่ขึ้น (ยืนยันแล้วใน `uat-image-smoke` #507)
5. สร้าง `/opt/dcontact-uat/uat.env` ตามรายชื่อใน `infra/uat/uat.env.example`, `chmod 600`
   (`uat-deploy.sh` ปฏิเสธถ้า mode ไม่ใช่ 600) — ทุกค่าสร้างใหม่สำหรับ UAT; รหัสผ่านที่อยู่ใน URL ใช้ `[A-Za-z0-9]` เท่านั้น
   - `UAT_ORGANIZATION_DOMAIN` = domain ที่องค์กรเป็นเจ้าของจริง (realm ตั้งเป็น `verified: true`) — ห้ามใช้ domain
     ของอีเมลสาธารณะอย่าง `gmail.com`; อีเมลของผู้ทดสอบไม่จำเป็นต้องอยู่ใน domain นี้
6. `docker login ghcr.io` ด้วย token แบบ `read:packages` ของบัญชี service (ไม่ใช่ token ส่วนตัว)
   - image ถูก push ครั้งแรกตอน deploy ครั้งแรก (ยังไม่มี package ให้ทดสอบ pull ล่วงหน้า) และ package ที่ push ด้วย
     `github.token` เป็น private ที่สืบสิทธิ์จาก repository — บัญชี service ต้องอ่าน repository นี้ได้ ไม่อย่างนั้น
     ขั้น `prepare` ของ deploy ครั้งแรกจะล้มตอน pull (`denied`) หลัง push เสร็จ
   - ถ้าล้มแบบนี้: ให้สิทธิ์อ่านกับบัญชี service ใน Package settings ของทั้ง 4 package
     (`dcontact-uat-{api,ops,console,keycloak}`) แล้ว re-run workflow — ยังไม่มี backup/migrate/deploy เกิดขึ้น เพราะ `prepare` อยู่ก่อน
     `backup`/`migrate`
7. `UAT_ALLOWED_CIDRS` = CIDR ของ gateway/allowlist จริง **และ** pool ของ Docker bridge บน VM
   - smoke (`uat-deploy.sh smoke`) รันบน VM แล้วเข้า proxy ผ่าน `127.0.0.1:443` แต่ docker-proxy/hairpin NAT
     (รวมกรณี `userland-proxy: false`) ทำให้ Caddy เห็น source เป็น gateway ของ bridge network ไม่ใช่ `127.0.0.1`
     — allowlist ที่มีแค่ `127.0.0.1/32` จะได้ 403 ทั้ง smoke
   - pool ค่าเริ่มต้นของ Docker คือ `172.16.0.0/12` และ `192.168.0.0/16` (แบบที่ `uat-image-smoke` ใช้); ถ้า VPC/LAN ของ VM
     ทับช่วงนี้ ให้ตั้ง `"default-address-pools"` ใน `/etc/docker/daemon.json` เป็นช่วงเฉพาะที่ไม่ทับ แล้ว allowlist ช่วงนั้นแทน
     (ไม่อย่างนั้นเครื่องอื่นใน subnet เดียวกันจะผ่าน allowlist ได้)
8. กด workflow `uat-preview` ด้วย `action=deploy`, `initial_deploy=true` (ครั้งแรกเท่านั้น)

## 5. Tenant และ fixture pack ของ UAT (ต้องใช้ operator input)

API profile `uat` ไม่ provision tenant เอง ก่อนเปิดให้ผู้ทดสอบ operator รัน CLI `uat-provision`
(U1.8 #502, `apps/api/src/uat-provision.ts` → `/app/dist/uat-provision-main.js` ใน ops image) หลัง deploy ครั้งแรก
(ต้องมี schema ก่อน) — **ไม่ต้องใช้ `psql`** และไม่มีขั้นอัตโนมัติใน workflow เพราะทุกค่าเป็น input ของ operator

CLI ทำข้อ 1–4 ใน transaction เดียวแบบ idempotent แล้วจึงเรียก `UatFixtureProvisioner.provision()` เดิมของ U1.1 (ข้อ 5):

1. แถว `tenants` (`id` = `UAT_TENANT_ID`, `slug` = `UAT_TENANT_SLUG`, `lifecycle_status` = `ACTIVE`;
   ต้องตรงกับ `uat.env` ไม่เช่นนั้น `TENANT_ENV_MISMATCH`)
2. owner team (`ownerTeamId` ของ fixture pack) และแถว `users` ของ maker/reviewer (`id` = `dcUserId` ในไฟล์บัญชี
   ข้อ 6 — เป็น `subjectId` ของ J5; `password_hash` = `!keycloak-managed` เพราะ login ผ่าน Keycloak เท่านั้น)
3. `iam_authoring_subjects` (`STANDARD`, ไม่มี direct review authority) + capability grants แบบ TEAM ของ owner team:
   maker = `journey.read`, `journey.edit`, `journey.publish`; reviewer = `journey.read`, `journey.review`
4. rollout ของ Journey authoring: ไม่ `DISABLED`, ไม่ `mutationFrozen`, เปิด canvas write และ publish UI
5. fixture pack (`UatFixturePackV1`) ด้วย connection ของ owner (app role เขียน pack ไม่ได้) — preflight ของ U1.1
   ตรวจข้อ 1–4 และ idempotent ต่อ environment + tenant + pack version; digest ต่าง = `FIXTURE_PACK_DIGEST_MISMATCH`

### 5.1 ไฟล์ใน repo (U1.9 #506)

| ไฟล์                                                  | คืออะไร                                                                                                                                                                 |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `infra/uat/fixtures/uat-first-slice.v1.template.json` | fixture pack `UatFixturePackV1` ของ UAT first slice (สังเคราะห์ล้วน): baseline `EVENT_TRIGGER → SEND → EXIT` (maker แทรก WAIT เอง), simulation fixture และ step catalog |
| `infra/uat/uat-provision.example.json`                | input `UatProvisionV1` ตัวอย่างที่มีแต่ placeholder `__UAT_*__` — operator คัดลอกแล้วกรอกจาก secret store                                                               |
| `scripts/u1-uat-fixture-render.mjs`                   | renderer (Node ล้วน ไม่มี dependency): input ที่กรอกแล้ว + `--build-sha` → input `UatProvisionV1` ที่มี manifest เต็ม                                                   |

ทำไมต้อง render: digest ของ pack ครอบทุก field รวม `tenantId`/`ownerTeamId`/`makerSubjectId`/`reviewerSubjectId`/
`environment`/`packVersion`/`buildSha` ซึ่งเป็นค่าของ deployment — ไฟล์ใน Git จึงเก็บได้แค่ template ที่มี placeholder
renderer แทน placeholder ทั้ง string เท่านั้น: id ของ tenant/team/บัญชีเอามาจาก input เดียวกัน (กรอกครั้งเดียว),
`environment`/`packVersion` จาก stub `fixturePack` และ `buildSha` จาก `--build-sha` (SHA เต็ม 40/64 ตัวของ release
ที่ deploy — ตัวย่อไม่รับ) ส่วนอื่นของ input ไม่ถูกแตะ

กันการ provision placeholder โดยไม่ตั้งใจ:

- renderer ปฏิเสธ input ที่ยังมี `__UAT_*__` ที่ใดก็ตาม (`PLACEHOLDER_UNFILLED` พร้อมชื่อ field) และไม่พิมพ์ค่าจาก input
- CLI `uat-provision` ปฏิเสธ `__UAT_*__` ที่ใดก็ตาม (`INPUT_PLACEHOLDER` — รวม field อิสระอย่างชื่อ tenant) และ stub
  `fixturePack.template` ที่ยังไม่ render (`FIXTURE_PACK_NOT_RENDERED`) ก่อน scan และก่อนแตะฐานข้อมูล
- readiness `UAT-S17` ตรวจว่าไฟล์ที่ commit ยังเป็น placeholder ไม่มี UUID/อีเมลจริง

`buildSha` กับ pack version: pack idempotent ต่อ environment + tenant + `packVersion` และ digest รวม `buildSha` —
render pack version เดิมด้วย SHA อื่น = `FIXTURE_PACK_DIGEST_MISMATCH` (fail closed) ดังนั้น release ใหม่ที่ใช้ pack เดิม
**ไม่ต้อง** provision ใหม่; ถ้าต้องการ pack ที่ผูกกับ release ใหม่ให้ตั้ง `UAT_FIXTURE_PACK_VERSION` ใหม่ (ค่าเดียวกับที่ฝังใน
Console) แล้ว render ด้วย SHA ของ release นั้น ส่วนการรันซ้ำของ pack เดิมต้องใช้ SHA เดิม (ดูได้จาก Build SHA ในหน้า UAT run)
เนื้อหา template ที่เปลี่ยนต้องออกเป็น template ใหม่ (`….v2`) พร้อม pack version ใหม่เสมอ

`buildSha` ใดก็ได้ผ่าน negative scan — pattern `PHONE` ไม่จับเลขที่ต่อด้วยตัวอักษร ASCII แล้ว (U1.11 #512)

### 5.2 กรอก, render และ provision

input ที่กรอกแล้วมีอีเมลจริงของผู้ทดสอบ: เก็บใน secret store เท่านั้นและลบทันทีหลังใช้ — **ห้าม commit**
key ที่ไม่รู้จัก/ขาด = ปฏิเสธ (`INPUT_INVALID`)

1. คัดลอก `infra/uat/uat-provision.example.json` ไปที่ secret store แล้วแทน `__UAT_*__` ทุกตัว:

   | placeholder                                                          | ค่า                                                                    |
   | -------------------------------------------------------------------- | ---------------------------------------------------------------------- |
   | `__UAT_TENANT_ID__` / `__UAT_TENANT_SLUG__` / `__UAT_TENANT_NAME__`  | `UAT_TENANT_ID` / `UAT_TENANT_SLUG` / `UAT_TENANT_NAME` ของ `uat.env`  |
   | `__UAT_OWNER_TEAM_ID__` / `__UAT_OWNER_TEAM_NAME__`                  | UUID ตัวพิมพ์เล็กใหม่ของ owner team / ชื่อ team                        |
   | `__UAT_MAKER_DC_USER_ID__` / `__UAT_REVIEWER_DC_USER_ID__`           | UUID ตัวพิมพ์เล็กคนละค่า — ตรงกับ `dcUserId` ในไฟล์บัญชีข้อ 6          |
   | `__UAT_MAKER_EMAIL__` / `__UAT_REVIEWER_EMAIL__`, `…_DISPLAY_NAME__` | อีเมลจริงและชื่อที่แสดงของผู้ทดสอบ (คนละคน)                            |
   | `__UAT_ROLLOUT_EVIDENCE_REF__`                                       | ref ของ issue/หลักฐานที่อนุมัติ rollout                                |
   | `__UAT_FIXTURE_PACK_VERSION__`                                       | `UAT_FIXTURE_PACK_VERSION` ของ GitHub environment (ค่าที่ Console ใช้) |

   `rollout.stage` เริ่มที่ `INTERNAL_SYNTHETIC`; `fixturePack.environment` = `UAT_ENVIRONMENT` (ว่าง = `uat`);
   `fixturePack.template` คงเป็น `uat-first-slice.v1`

2. render บนเครื่อง operator ใน checkout ที่ตรงกับ release (`<sha>` = SHA เต็มของ release ปัจจุบันบน VM)
   แล้วส่งผลทาง stdin ไปเป็นไฟล์ mode 600 บน VM — ผลไม่ถูกเขียนลงดิสก์ของเครื่อง operator:

   ```bash
   set -o pipefail   # renderer ล้ม = ไม่ถือว่าสำเร็จ (ไฟล์ว่างบน VM จะถูก CLI ปฏิเสธด้วย INPUT_UNREADABLE)
   git -C dcontact fetch origin && git -C dcontact checkout --detach <sha>
   # <filled.json> = input ที่กรอกแล้วจาก secret store; สถานะ (ไม่มีค่าจาก input) ออกทาง stderr
   node dcontact/scripts/u1-uat-fixture-render.mjs --input - --build-sha "$(git -C dcontact rev-parse HEAD)" <filled.json \
     | ssh <uat-vm> 'install -m 600 /dev/stdin /opt/dcontact-uat/uat-provision.json'
   ```

   (`--output <file>` แทน stdout ได้: สร้างไฟล์ใหม่ mode 600 และไม่เขียนทับไฟล์เดิม)

3. บน VM: `--check` → apply → ลบไฟล์

   ```bash
   # บน VM — <sha> = release ปัจจุบัน
   bash /opt/dcontact-uat/releases/<sha>/bin/uat-deploy.sh provision <sha> /opt/dcontact-uat/uat-provision.json --check
   bash /opt/dcontact-uat/releases/<sha>/bin/uat-deploy.sh provision <sha> /opt/dcontact-uat/uat-provision.json
   shred -u /opt/dcontact-uat/uat-provision.json
   ```

   `--check` ต้องได้ `WOULD_CREATE`/`UNCHANGED` ทุก part และ `digest` ของ pack; apply ต้องได้ digest เดียวกัน
   (บันทึก digest ลง issue ของ deploy)

CLI รับ `fixturePack` เป็น manifest ตรง ๆ (ผ่าน `uat-deploy.sh` ต้องเป็นแบบนี้เพราะไฟล์ส่งทาง stdin) หรือ `fixturePackPath`
แทนเมื่อรัน CLI ตรงกับไฟล์ที่ container อ่านได้ — renderer ผลิตแบบแรกเสมอ

### 5.3 สิ่งที่อยู่ใน fixture pack `uat-first-slice.v1`

- baseline (รูปเดียวกับ acceptance gate U1.7 #435): `EVENT_TRIGGER` (`synthetic.uat.signup`) → `SEND` (`send-1`, LINE,
  `content-uat-welcome`) → `EXIT` (`done`, `COMPLETED`); sender `sender-uat-synthetic`, purpose `SERVICE`,
  maxDurationDays 7 — maker แทรก `WAIT` 600 วินาทีเองใน Console (step `MAKER_EDIT`) จนได้
  `EVENT_TRIGGER → SEND → WAIT → EXIT`; ref ทั้งหมดเป็น opaque id สังเคราะห์ (J5 ไม่ resolve ref ตอน
  validate/compile/simulate และ UAT ไม่มี provider egress)
- simulation fixture ที่ server ตรึงไว้: `uat-first-slice-fx-1`, startAt `2026-09-01T02:00:00.000Z`, seed
  `uat-first-slice-seed-1`, `sendOutcomes.send-1 = SENT` (ไม่มีแล้ว simulation จบพร้อม `PREVIEW_FIXTURE_INVALID`)
  → จบที่ `EXIT` เสมอ (`SIMULATION_ONLY`); หลังแทรก WAIT 600 วินาที `done` อยู่ที่เวลาเสมือน `2026-09-01T02:10:00.000Z`
- step catalog 32 step: 9 step ของ `U1_STEP_CATALOG` ใน `scripts/u1-acceptance.mjs` (U1.7) ใช้ id/title/expected
  เดียวกันและลำดับเดียวกัน (`docs/u1-uat-acceptance-checklist.md` §1) บวก step ที่ checklist ให้คนเดิน (login + TOTP,
  preview, simulation ถึง EXIT/ซ้ำได้/ไม่ใช่การส่งจริง, ห้ามอนุมัติตัวเอง, `เริ่มรอบใหม่` ระหว่างรอตรวจ,
  failure/recovery, session หมดอายุ, refresh/deep link/Back/Forward, accessibility, ไม่มีขั้น CLI/DB และหลักฐาน/bundle)
  — ขั้นจำลองติด `SIMULATION_ONLY` ขั้นอื่นติด `REAL_STATE`; ทุก step ผ่านได้ในรอบเดียว และต้องเดินครบทั้งรอบแรก
  และ rerun ตาม checklist §2
- ทดสอบใน CI: `apps/api/src/uat-fixture-pack.test.ts` (render, parser/negative scan, digest คงที่, J5 validate/compile/
  simulate, catalog ครบ, example ที่ยังไม่กรอกถูกปฏิเสธ) และ `apps/api/src/uat-fixture-pack.integration.ts`
  (render → CLI CREATED → `เริ่มรอบใหม่` → แทรก WAIT → validate/compile/simulate ถึง EXIT → ส่งตรวจ/อนุมัติ/publish บน Postgres)

`uat-deploy.sh provision` ต้องการไฟล์ mode 600 (`PROVISION_INPUT_PERMISSIONS`) และส่งไฟล์ทาง stdin ให้ one-shot
`uat-provision` (compose profile `ops`, `OPS_IMAGE`, `DATABASE_URL` ของ `UAT_POSTGRES_USER` เหมือน `migrate`) —
ไฟล์ไม่ถูก mount เข้า container และไม่ผ่าน command line

CLI จะ:

- ปฏิเสธก่อนเขียนใด ๆ ถ้า connection เป็น role ของ application (`current_user` = `dcontact_app` ฯลฯ →
  `APPLICATION_ROLE_REFUSED`), maker = reviewer (`MAKER_REVIEWER_SAME`), บัญชี `.local` หรือ slug/ชื่อ tenant
  ของ dev seed (`demo`, `demo-two` → `DEV_SEED_REFUSED`) — ห้ามใช้ `pnpm db:seed` ของ dev
- รัน negative scan ของ U1.5 (`scanUatText`) ทั้ง input + manifest **ยกเว้น `maker.email`/`reviewer.email`**
  ซึ่งเป็นอีเมลจริงโดยชอบ — อีเมล/token/JWT/secret ใน field อื่น (เช่นชื่อ team, displayName, manifest) =
  `INPUT_SENSITIVE_CONTENT` พร้อมชนิดที่พบเท่านั้น
- plan แบบ READ ONLY ก่อนเสมอ: แถวที่มีอยู่แล้วแต่ต่างจาก input (slug/ชื่อ tenant, team, users, subject,
  ชุด grant, flag ของ rollout) = fail closed ด้วย `TENANT_CONFLICT`, `OWNER_TEAM_CONFLICT`, `USER_CONFLICT`,
  `SUBJECT_CONFLICT`, `GRANTS_CONFLICT`, `ROLLOUT_CONFLICT` — ไม่เขียนทับและไม่เขียนส่วนอื่น; แก้ข้อมูลเดิมด้วยการตัดสินใจ
  ของ operator ใน issue ไม่ใช่รันซ้ำด้วย input ใหม่ (`updatedByRef`/`evidenceRef` ของ rollout เป็น audit จึงไม่เทียบ)
- `--check`: validate + preflight เดียวกันใน transaction แบบ READ ONLY — ไม่เขียนอะไรเลย
  (`WOULD_CREATE`/`UNCHANGED`; preflight ของ pack = `SKIPPED` ถ้าข้อ 1–4 ยังไม่ถูกสร้าง)
- พิมพ์ JSON lines ที่มีแค่ part, สถานะ (`CREATED`/`UNCHANGED`), id และ digest ของ pack — ไม่พิมพ์อีเมล ชื่อ
  หรือ `DATABASE_URL`; รันซ้ำด้วย input เดิม = `UNCHANGED` ทุก part

## 6. สร้างบัญชี maker/reviewer

บัญชีสร้างด้วย `scripts/u1-uat-keycloak-users.mjs --users <file>` บน VM เท่านั้น (admin REST ไม่เปิดผ่าน proxy)
ไฟล์บัญชีมาจาก secret store และลบทันทีหลังใช้ — **ห้าม commit**:

```json
{
  "accounts": [
    {
      "role": "maker",
      "username": "<อีเมลจริงของผู้ทดสอบ>",
      "email": "<อีเมลจริงของผู้ทดสอบ>",
      "firstName": "<ชื่อ>",
      "lastName": "<นามสกุล>",
      "dcUserId": "<users.id ของ UAT>",
      "temporaryPassword": "<จาก secret store อย่างน้อย 12 ตัว>"
    },
    { "role": "reviewer", "...": "บัญชีคนละคนกับ maker" }
  ]
}
```

```bash
# บน VM ในโฟลเดอร์ release ปัจจุบัน
install -m 600 /dev/stdin /opt/dcontact-uat/accounts.json   # วางเนื้อหาจาก secret store
# ส่งทาง stdin — ห้าม mount: container รันเป็น uid 10001 อ่านไฟล์ mode 600 ของ deploy user ไม่ได้
docker compose --project-name dcontact-uat --project-directory . \
  --env-file /opt/dcontact-uat/uat.env --env-file release.env -f docker-compose.uat.yml \
  --profile ops run --rm -T keycloak-config \
  node scripts/u1-uat-keycloak-users.mjs --users /dev/stdin < /opt/dcontact-uat/accounts.json
shred -u /opt/dcontact-uat/accounts.json
```

script จะ:

- ปฏิเสธถ้าไม่มีทั้ง maker และ reviewer, ใช้ username/อีเมล/`dcUserId` ซ้ำกัน (maker-checker ต้องคนละบัญชี),
  ใช้บัญชี `.local` ของ dev หรือรหัสผ่านที่รู้กันใน dev (`SHARED_CREDENTIAL_WITH_DEV`)
- สร้างบัญชีใหม่พร้อม attribute `tenant_id`/`tenant_slug`/`dc_user_id`, สมาชิก Organization ของ tenant,
  รหัสผ่านแบบ temporary และ required action `UPDATE_PASSWORD` + `CONFIGURE_TOTP`
- บัญชีเดิม: อัปเดต attribute เท่านั้น ไม่รีเซ็ตรหัสผ่าน; ถ้า `dc_user_id` เดิมไม่ตรง = หยุด (`ACCOUNT_SUBJECT_MISMATCH`)
- พิมพ์เฉพาะ role, Keycloak id และสถานะ — ไม่พิมพ์รหัสผ่าน

login ครั้งแรก ผู้ทดสอบต้องเปลี่ยนรหัสผ่านและผูก authenticator app (TOTP) — browser flow
`uat browser password otp` ตั้ง OTP เป็น REQUIRED จึงไม่มีทาง login ด้วยรหัสผ่านอย่างเดียว
Console client (`dcontact-uat-console`) เป็น public client + PKCE S256 และรับ redirect URI เดียว
`https://<UAT_HOST>/?tenant=<UAT_TENANT_SLUG>`

realm ไม่ถูก import ตอนบูต Keycloak: ขั้น `keycloak` ของ workflow รัน
`u1-uat-keycloak-users.mjs --config` ซึ่ง render `${env.*}` ของ template (ขาดค่า = หยุด) แล้วสร้าง realm
หรือ reconcile client/OTP/Organization/user profile ทุกครั้ง และคืน `realmConfigDigest`

## 7. Deploy

ก่อน deploy: acceptance gate ต้องผ่านบน **SHA เดียวกับที่จะ deploy**
(`docs/u1-uat-acceptance-checklist.md` — CI job `cxa-u1-acceptance` สามครั้งติดกัน):

1. จด SHA ของ `main` ตอนนี้ แล้วสั่ง `gh workflow run CI --ref main -f acceptance=u1` ทีละรอบจนผ่านสามรอบ
   (แต่ละรอบราว 5 นาที) — ทุกรอบต้องรันบน SHA ที่จด
2. workflow `uat-preview` build/deploy `main` HEAD ตอนกด dispatch (`$GITHUB_SHA`) ไม่ใช่ SHA ที่เลือกเอง — ถ้า `main`
   ขยับระหว่างทาง (มี merge ใหม่) gate ของ SHA เดิมใช้กับ release นี้ไม่ได้ ต้องเริ่มสามรอบใหม่บน HEAD ใหม่
   ให้ตกลงช่วงงด merge เข้า `main` ตั้งแต่รอบแรกของ gate จนกด dispatch
3. หลัง deploy เทียบ `sourceSha` ใน deployment record (ข้อ 11) กับ SHA ที่จดไว้

กด Actions → `uat-preview` → Run workflow (branch `main`, `action=deploy`) แล้วรอ reviewer อนุมัติ
ลำดับใน job `deploy` (หยุดทันทีเมื่อขั้นใดล้ม):

1. ตรวจ provisioning gate variables และ static readiness (`node --test ...` + `u1-uat-readiness.mjs --static`)
2. SSH ไป VM (host key ต้องตรง) อ่าน deployment record ปัจจุบันเป็นฐานของ migration guard
3. migration guard: migration ที่เพิ่มหลัง SHA ที่ deploy อยู่ต้องไม่มี `DROP` และห้ามแก้/ลบ migration เดิม
4. build + push image `api`/`ops`/`console`/`keycloak` ไป GHCR และเก็บ digest
5. อัปโหลด release (`docker-compose.uat.yml`, `bin/`, `release.env` ที่มีแต่ digest) → `prepare` (compose config + pull)
6. `backup`: `pg_dump --format=custom` ของ `dcontact` และ `keycloak` ไป `/opt/dcontact-uat/backups/`
7. `migrate`: `db-roles` → `prisma migrate deploy` + `rls.sql` → `db-roles` อีกรอบ
8. `keycloak`: Keycloak production mode + realm config
9. `deploy`: `object-storage` → `object-storage-init` (bucket private) แล้ว `object-storage-lifecycle`,
   `object-storage-migrated-expiry`, `api` และ `proxy` ด้วย digest ใหม่
10. `smoke`: `u1-uat-readiness.mjs --live` จาก ops image บน VM (ต่อ `127.0.0.1:443` ด้วย SNI ของ `UAT_HOST`) — ไม่ผ่าน = job ล้ม
11. deployment record: job summary + artifact `uat-preview-<sha>-<attempt>` + `/opt/dcontact-uat/deployments/`

smoke ล้มหลัง deploy: stack ค้างที่ release ใหม่ — ตัดสินใจ rollback (ข้อ 10) หรือแก้แล้ว deploy ใหม่
ไม่มี auto-rollback เพราะต้องมีคนดูว่า migration ของ release นั้นเข้ากับ API เดิมได้

### 7.1 Cutover object storage: MinIO → SeaweedFS (ครั้งเดียว, #540)

ทำครั้งแรกที่ deploy release ที่มี `object-storage` บน VM ที่เคยมี MinIO — ห้ามข้าม: ถ้า deploy ก่อนย้าย API จะบูตบน
bucket ว่าง และหลักฐานเดิมใน `minio-data` จะไม่ถูกลบตามวันหมดอายุ

1. เพิ่มใน `uat.env`: `UAT_S3_ROOT_*`, `UAT_S3_API_*` (ค่าใหม่ สุ่ม) และคง `UAT_MINIO_ROOT_USER`/`UAT_MINIO_ROOT_PASSWORD`
   เดิมไว้ (ต้องเป็นค่าที่ MinIO ใช้อยู่) — ลบ `UAT_MINIO_API_*` ได้
2. รัน workflow `uat-preview` ตามปกติ — ขั้น `deploy` จะ **ล้มด้วย `OBJECT_STORAGE_MIGRATION_PENDING`** ก่อน api บูต
   (VM มี volume `minio-data` แต่ยังไม่มี `/opt/dcontact-uat/object-storage-migrated`) ซึ่งเป็นสิ่งที่ตั้งใจ: release ถูก
   `prepare`, backup และ migrate DB แล้ว
3. บน VM: `bin/uat-deploy.sh migrate-object-storage <sha>` — หยุด api, เปิด MinIO เดิมจาก overlay
   `docker-compose.uat.migration.yml`, `object-storage-init`, แล้ว `object-storage-migrate`:
   - คัดลอกทุก object ใต้ `uat-evidence/` โดยคง key, ตรวจ sha256 กับ `uat_run_evidence.sha256`
   - object ที่ถึงวันหมดอายุแล้วถูกข้าม; object ไม่มีแถว (`ORPHAN_OBJECT`) หรือแถวที่ยังไม่หมดอายุแต่ไม่มี object
     (`MISSING_OBJECT`) = หยุดทั้งหมด ไม่เขียนอะไร
   - เขียน manifest `migration/uat-evidence-<วันที่>.json` (key, `sourceLastModified`, `expiresAt`, sha256) ด้วย root
   - รันซ้ำได้ (object ที่ sha256 ตรงถูกข้าม) — แนบบรรทัด JSON `"step":"migrate","status":"PASS"` ใน issue #540
   เมื่อสำเร็จจะเขียน `/opt/dcontact-uat/object-storage-migrated`
4. รัน workflow `uat-preview` ด้วย SHA เดิมอีกครั้ง (หรือ `bin/uat-deploy.sh deploy <sha>` แล้ว `smoke`) — `--remove-orphans` ลบ container MinIO
   แต่ **ไม่** ลบ volume `minio-data`
5. `object-storage-migrated-expiry` ลบหลักฐานที่ย้ายมาตาม `expiresAt` เดิม (วันที่สร้างใน MinIO + 90 วัน ปัดเที่ยงคืน UTC)
   ตรวจด้วย `docker logs dcontact-uat-object-storage-migrated-expiry-1` — ครบแล้วจะเห็น `"status":"DONE"`

**Rollback หลัง cutover** ไป release ที่ยังใช้ MinIO (ข้อ 10 ใช้ `up --no-deps api proxy` ซึ่ง**ไม่**เปิด MinIO ให้):

```bash
cd /opt/dcontact-uat/releases/<sha ก่อน cutover>
alias uatc='docker compose --project-name dcontact-uat --project-directory . --env-file /opt/dcontact-uat/uat.env --env-file release.env -f docker-compose.uat.yml'
uatc up -d --wait minio && uatc run --rm -T minio-init   # ต้องมี UAT_MINIO_* เดิมใน uat.env
rm /opt/dcontact-uat/object-storage-migrated             # deploy รอบหน้าต้องย้ายหลักฐานใหม่อีกครั้ง
```

แล้วกด rollback ใน workflow — volume `minio-data` ยังอยู่จึงกลับไปใช้หลักฐานเดิมได้ แต่ **หลักฐานที่เขียนหลัง cutover
อยู่ใน SeaweedFS เท่านั้นและไม่ตามกลับไป** (บันทึกใน issue); เมื่อ deploy release ใหม่อีกครั้ง `migrate-object-storage`
จะคัดลอกหลักฐานที่เพิ่มใน MinIO ระหว่างนั้น (object ที่มีแล้วถูกข้าม)

**ลบ `minio-data`:** เฉพาะหลัง cutover + 90 วัน และ expiry เป็น `DONE` — ทำใน #541

## 8. กฎ "ไม่มี down migration"

- ใช้ `prisma migrate deploy` เท่านั้น — ห้าม `migrate dev`, `migrate reset`, `db push`, `--accept-data-loss`
  (static readiness UAT-S11 ตรวจ workflow)
- migration ใหม่ต้อง additive: workflow ปฏิเสธไฟล์ที่มี `DROP` (หลังตัด comment) และการแก้/ลบ migration ที่มีอยู่
- rollback ไม่ย้อน schema: API เวอร์ชันก่อนต้องทำงานกับ schema ใหม่ได้ (expand ก่อน, contract ภายหลังเมื่อเลิกใช้จริง)
- ต้องการคืนข้อมูลจริง = restore จาก backup (ข้อ 9) ซึ่งเป็นการตัดสินใจของ owner ไม่ใช่ขั้นอัตโนมัติ

## 9. Backup และ restore

- backup อัตโนมัติก่อน migrate ทุกครั้ง: `backups/pg-dcontact-<UTC>.dump` และ `backups/pg-keycloak-<UTC>.dump`
  (sha256 ของ dump ของ `dcontact` อยู่ใน deployment record)
- restore (เฉพาะเมื่อ owner อนุมัติ; ทำให้ข้อมูลหลัง backup หาย):

```bash
cd /opt/dcontact-uat/releases/<sha ที่จะใช้>
alias uatc='docker compose --project-name dcontact-uat --project-directory . --env-file /opt/dcontact-uat/uat.env --env-file release.env -f docker-compose.uat.yml'
uatc stop proxy api
uatc exec -T postgres sh -ec 'pg_restore -U "$POSTGRES_USER" -d dcontact --clean --if-exists --no-owner' \
  < /opt/dcontact-uat/backups/pg-dcontact-<UTC>.dump
uatc --profile ops run --rm db-roles
uatc up -d --wait api proxy
```

แล้วรัน `bin/uat-deploy.sh smoke <sha>` และบันทึกการ restore ใน issue ของ UAT

## 10. Rollback

กด `uat-preview` ด้วย `action=rollback` (ว่าง `rollback_sha` = record ก่อนหน้า หรือใส่ SHA ที่เคย deploy สำเร็จ)

- อ่าน digest จาก deployment record บน VM แล้ว `up -d --no-deps api proxy` ด้วย release นั้น
- **ไม่** backup/migrate/restore และไม่แตะ Keycloak realm
- รัน smoke แล้วเขียน record `action: rollback` (record เดิมกลายเป็น previous — rollback ซ้ำ = สลับกลับ)

## 11. อ่าน deployment record

```json
{
  "schema": "UatDeploymentRecordV1",
  "action": "deploy",
  "environment": "uat",
  "sourceSha": "<commit ที่ build>",
  "images": {
    "api": "ghcr.io/...@sha256:...",
    "console": "...@sha256:...",
    "ops": "...@sha256:...",
    "keycloak": "...@sha256:..."
  },
  "realmConfigDigest": "sha256:<digest ของ realm ที่ render แล้ว (ไม่มี secret)>",
  "fixturePackVersion": "<UAT_FIXTURE_PACK_VERSION>",
  "migration": { "applied": true, "guard": "PASS", "base": "<SHA ก่อนหน้า>", "added": ["..."] },
  "backup": { "status": "PASS", "file": "backups/pg-dcontact-<UTC>.dump", "sha256": "..." },
  "smoke": { "status": "PASS", "checks": [{ "id": "UAT-L01 Console index", "status": "PASS" }] },
  "runUrl": "<ลิงก์ workflow run>",
  "deployedAt": "<UTC>"
}
```

- `sourceSha` + `images` = สิ่งที่รันอยู่จริง (image มี label `org.opencontainers.image.revision` = SHA เดียวกัน)
- `realmConfigDigest` เปลี่ยน = config ของ realm (host/tenant/client/OTP) เปลี่ยน
- `smoke.checks` ที่เป็น `SKIPPED` (เช่น UAT-L06 เมื่อไม่มี token ทดสอบ) ไม่ใช่ PASS — ต้องปิดด้วย smoke แบบ manual

## 12. Readiness

- CI (`pnpm test:u1-uat-readiness` ใน job build): ทดสอบ validator และ static checks ของ artifact จริง
- `node scripts/u1-uat-readiness.mjs --static` — UAT-S00..S18: compose ไม่มี worker/FreeSWITCH/Kafka/Redis,
  มีแค่ proxy ที่เปิดพอร์ต, ไม่มี `start-dev`, ไม่มี default credential, image/`FROM` pin digest,
  realm ไม่มี user/secret และบังคับ OTP, env ของ api ผ่าน profile, proxy ปิด admin + allowlist,
  workflow ผูก environment/concurrency/readiness, negative secret scan, evidence storage (api ใช้ user
  เฉพาะของ object storage แบบ `:?` ไม่ใช่ root, รอ `object-storage-init`, ไม่ใช้ `weed mini`, มี lifecycle runner,
  `s3.json` ไม่มี anonymous และ policy จำกัด bucket/prefix),
  UAT-S16 provision เป็น one-shot ของ ops และ UAT-S17 fixture template/provision example มีแต่ placeholder
  (ไม่มี UUID/อีเมลจริงของ deployment)
- `--live` (UAT-L01..L07): Console index, `/api/v1/runtime-profile` = `uat` (Kafka/LINE/egress ปิด),
  route นอก allowlist = 404 `ROUTE_NOT_AVAILABLE_IN_PROFILE`, OIDC discovery ตรง issuer, admin ของ Keycloak
  ไม่เปิด, journey flow ด้วยบัญชีทดสอบ (SKIPPED ถ้าไม่มี token), พอร์ตภายในปิดบน host
- smoke แบบมี token (UAT-L06: validate/compile/simulate ของ Journey ใน run ปัจจุบัน — ไม่สร้าง Journey ใหม่)
  ทำบน VM: คัด access token ของบัญชี maker จาก session ของ Console แล้วส่งทาง stdin
  `bash bin/uat-deploy.sh smoke <sha> --token-stdin` (token ไม่ผ่าน command line และไม่ถูกพิมพ์)

## 13. Stop conditions

หยุดและรายงานใน issue แทนการดำเนินการต่อ ถ้าต้อง:

- ใช้ credential ร่วมกับ dev หรือ production (รวมรหัสผ่านจาก `rls.sql`/seed ของ dev — `db-roles.sh` ตั้งทับทุกครั้ง)
- deploy `apps/journey` worker/Journey runtime, FreeSWITCH, Kafka หรือ Redis ใน UAT
- เปิด UAT ให้ผู้ทดสอบก่อน provisioning gate (ข้อ 2) ครบและ verify แล้ว

## 14. หลักฐานที่มีและสิ่งที่ยังไม่ได้ verify

ตรวจแล้วนอก VM (ตอนทำ U1.6): `docker compose config` ของ compose ด้วย env จำลอง, Caddyfile ด้วย Caddy 2.8.4
(ลำดับ allowlist/การปิด admin ภายใน `route`), `--live` smoke ผ่าน proxy จริงกับ API profile `uat`,
และ realm config + บัญชี + login (รหัสผ่าน → ตั้ง TOTP → เปลี่ยนรหัสผ่าน → token ที่มี `tenant_id`,
`dc_user_id`, `organization` และ `aud: dcontact-api`; login ครั้งถัดไปต้องกรอก OTP) บน Keycloak 26.0.0
production mode (`start`, dev-file DB)

ยังไม่ได้ verify: การ build image ด้วย Docker, push ไป GHCR, deploy/rollback/backup/restore จริงบน VM,
TLS กับ cert จริง, gateway/allowlist จริง, Keycloak บน Postgres ใน compose และ Journey flow (UAT-L06)
กับฐานข้อมูลที่ provision tenant/fixture pack แล้ว — ต้องเก็บหลักฐานใน deploy ครั้งแรก

U1.8 (#502): CLI `uat-provision` ตรวจแล้วบน Postgres จริง (`apps/api/src/uat-provision.integration.ts`: CREATED →
`เริ่มรอบใหม่` ของ maker ผ่าน app role + J5 จริง → UNCHANGED, conflict ไม่เปลี่ยนแถว, app role/maker = reviewer/
token ใน free text ถูกปฏิเสธ, `--check` ไม่เขียน) และ `docker compose --profile ops config` ด้วย env จำลอง —
ยังไม่ได้ verify: build ops image ที่มี `/app/dist/uat-provision-main.js` จริง และการรัน `uat-deploy.sh provision` บน VM

U1.9 (#506): fixture pack `uat-first-slice.v1` + renderer + input ตัวอย่าง ตรวจแล้วบน Postgres จริง
(`apps/api/src/uat-fixture-pack.integration.ts`: example ที่ยังไม่กรอก/ยังไม่ render ถูกปฏิเสธโดยไม่แตะฐานข้อมูล,
render → `--check` WOULD_CREATE → apply CREATED → รันซ้ำ UNCHANGED → `เริ่มรอบใหม่` ผ่าน HTTP + app role + J5 จริง →
แทรก WAIT → validate/compile/preview ไม่มี diagnostic → simulate ด้วย fixture ของ run ถึง EXIT แบบ `SIMULATION_ONLY` → ส่งตรวจ,
maker อนุมัติเองไม่ได้ (403 `CAPABILITY_REQUIRED`), reviewer อนุมัติ, maker publish) — ยังไม่ได้ verify: การ render + provision
บน VM จริง และการเดิน step catalog ครบใน Console จริงโดยผู้ทดสอบ (เป็นงานของ UAT run)

U1.10 (#507): workflow `uat-image-smoke` (`.github/workflows/uat-image-smoke.yml`) สั่งด้วยมือเมื่อจะตรวจ artifact
ของ UAT — build image `api`/`ops`/`console` จาก commit นั้น, push เข้า registry ชั่วคราวบน runner
(`localhost:5000`, ไม่ใช่ GHCR) เพื่ออ้างด้วย digest, รัน `uat-deploy.sh` ตัวจริงแบบ local (`UAT_ROOT` = โฟลเดอร์ชั่วคราว)
ครบ `prepare` → `backup` → `migrate` → `keycloak` → `deploy` → `smoke` แล้ว `provision` (`--check`, apply, apply ซ้ำ =
UNCHANGED) ด้วย input สังเคราะห์จาก `scripts/u1-uat-ci-fixture.mjs`, สร้างบัญชี maker/reviewer ด้วย `--users`,
ตรวจ hardening (api/proxy non-root + rootfs read-only, object storage/Postgres/Keycloak/api ไม่ publish พอร์ต, admin ของ
Keycloak ตอบ 404, `runtime-profile` = `uat`) และ `backup` หลัง deploy (pg_dump จริง) — secret/cert สุ่มต่อรอบ ไม่ใช้
repository secret และไม่ผูก environment `uat-preview` (static readiness UAT-S18 ตรวจ) จึงไม่ใช่หลักฐานของ VM จริง:
TLS/gateway/allowlist จริง, GHCR และ UAT-L06 ยังต้องเก็บใน deploy ครั้งแรกตามเดิม

## Login/email theme ของ Keycloak (#515/#522)

- realm UAT ตั้ง `loginTheme`/`emailTheme` = `dcontact` (`realm-dcontact.uat.json`) ขั้น `keycloak` ของ workflow apply ให้
  realm ที่มีอยู่แล้วด้วย (`u1-uat-keycloak-users.mjs --config`)
- theme อยู่ใน image `KEYCLOAK_IMAGE` (`infra/keycloak/Dockerfile`) ไม่ bind mount บน VM — deploy ด้วย digest เหมือน image อื่น
  และบันทึกใน deployment record (`images.keycloak`)
- static readiness UAT-S19: compose ใช้ `${KEYCLOAK_IMAGE:?}`, realm ตั้ง theme และ Dockerfile คัดลอก theme จริง —
  realm ที่ตั้ง theme แต่ Keycloak ไม่มี theme = หน้า login ของ realm ล้มทั้งหมด
- live readiness UAT-L08: หน้าของ realm (client ที่ไม่มีอยู่ → หน้า error) render ด้วย theme `dcontact`
  และ `dcontact.css` / `tokens.css` โหลดได้ผ่าน proxy
- rollback (Console/api) ไม่แตะ Keycloak — theme ของ release ล่าสุดยังอยู่
