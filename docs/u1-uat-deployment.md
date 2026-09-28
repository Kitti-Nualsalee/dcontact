# U1.6 — UAT deployment (VM + Docker Compose), Keycloak UAT realm และ workflow `uat-preview`

Authority: Phase Contract #374, การตัดสินใจเรื่อง environment #373, ticket U1.6 #434

เอกสารนี้เป็น runbook ของ operator สำหรับ UAT first slice: stack UAT แยกถาวรบน VM เดียว
(Docker Compose แบบ production-shaped), Console/API แบบ tenant-scoped บน HTTPS origin เดียว
(`/api/v1`) และ Keycloak ของ UAT, บัญชี maker/checker ที่ระบุตัวตนพร้อม TOTP, gateway/allowlist
ภายใน และการ promote/rollback ด้วย image digest ที่เปลี่ยนไม่ได้

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
│   ├─ /auth/*       → keycloak:8080 (production mode `start`, KC_HTTP_RELATIVE_PATH=/auth)           │
│   └─ /auth/admin*, /auth/realms/master* → 404 (admin เข้าได้จากใน VM เท่านั้น)                      │
│                                                                                                   │
│ network `internal` (internal: true — ไม่มีทางออก internet)                                          │
│   api ── postgres (dcontact: role dcontact_app, NOBYPASSRLS)                                        │
│   keycloak ── postgres (database keycloak, role keycloak)                                          │
│   api ── minio:9000 (user uat-evidence-api เฉพาะ bucket `uat-evidence` แบบ private, U1.5)          │
│                                                                                                   │
│ one-shot (profile ops, image OPS_IMAGE): db-roles, migrate, keycloak-config                         │
│ one-shot ทุก deploy ก่อน api: minio-init (bucket + user/policy ของ API)                            │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘
```

สิ่งที่ **ไม่มี** ใน UAT (#374): `apps/journey` worker/Journey runtime, FreeSWITCH, Kafka/Redpanda,
Redis — API profile `uat` (U1.2 #430) ปิด Kafka/LINE/provider egress เชิงโครงสร้าง และบูตไม่ผ่านถ้ามี
env `LINE_*`, `KAFKA_BROKERS` หรือ `SIP_*`

| ไฟล์                                     | หน้าที่                                                                           |
| ---------------------------------------- | --------------------------------------------------------------------------------- |
| `apps/api/Dockerfile`                    | target `runtime` (API UAT) และ `ops` (Prisma migrate, Keycloak config, readiness) |
| `apps/console/Dockerfile`                | Console build (`VITE_*` ตอน build) + Caddy (`infra/uat/Caddyfile`)                |
| `infra/uat/docker-compose.uat.yml`       | stack ของ UAT — image อ้างด้วย digest, secret เป็น `${VAR:?}` ทั้งหมด             |
| `infra/uat/bin/uat-deploy.sh`            | ขั้นตอนบน VM: prepare/backup/migrate/keycloak/deploy/smoke/record/rollback        |
| `infra/uat/bin/db-roles.sh`              | role ของ Postgres (Keycloak, `dcontact_app`) จาก secret                           |
| `infra/uat/bin/ci-ssh-setup.sh`          | SSH ของ runner จาก secrets ของ environment `uat-preview`                          |
| `infra/uat/uat.env.example`              | รายชื่อค่าใน `uat.env` (ไม่มีค่า)                                                 |
| `infra/keycloak/realm-dcontact.uat.json` | realm UAT (template `${env.*}`) — ไม่มี user/secret, บังคับ password+TOTP         |
| `scripts/u1-uat-keycloak-users.mjs`      | render/reconcile realm และสร้างบัญชี maker/reviewer จาก secret input              |
| `scripts/u1-uat-readiness.mjs`           | readiness: `--static`, `--live`, `--migration-guard`, deployment record           |
| `.github/workflows/uat-preview.yml`      | deploy/rollback ด้วยมือ ผ่าน environment `uat-preview`                            |

## 2. Provisioning gate (กรอกก่อนเปิด UAT)

ทุกแถวต้องมีค่า ผู้ verify และวันที่ ก่อน deploy ครั้งแรก — ค่าที่เป็น secret บันทึกเฉพาะ "อยู่ที่ไหน"
ใน secret store ไม่ใช่ตัวค่า

| รายการ                                                                   | ใช้ที่                                                       | ค่า / ตำแหน่ง | verified by | วันที่ |
| ------------------------------------------------------------------------ | ------------------------------------------------------------ | ------------- | ----------- | ------ |
| Host/VM (ขนาด, OS, Docker Engine + compose plugin)                       | ที่รัน stack                                                 |               |             |        |
| Domain ของ UAT (`UAT_HOST`)                                              | Caddy, `KC_HOSTNAME`, redirect URI, `VITE_KC_ISSUER`         |               |             |        |
| DNS ของ `UAT_HOST` → gateway/VM                                          | การเข้าถึงของผู้ทดสอบ                                        |               |             |        |
| แหล่ง TLS cert (CA, วันหมดอายุ, วิธีต่ออายุ)                             | `UAT_TLS_CERT_FILE`/`UAT_TLS_KEY_FILE` บน VM                 |               |             |        |
| Secret store (ที่เก็บค่าใน `uat.env` และไฟล์บัญชี)                       | operator วางไฟล์บน VM                                        |               |             |        |
| Identity-aware gateway / allowlist (`UAT_ALLOWED_CIDRS`)                 | Caddy `remote_ip` — ต้องมี `127.0.0.1/32` สำหรับ smoke บน VM |               |             |        |
| GHCR access (VM pull แบบ read-only)                                      | `docker login ghcr.io` บน VM ด้วย token `read:packages`      |               |             |        |
| SSH key ของ deploy (public key บน VM, host key ใน `UAT_SSH_KNOWN_HOSTS`) | workflow `uat-preview`                                       |               |             |        |
| Tenant UAT (`UAT_TENANT_ID`/`UAT_TENANT_SLUG`) และ fixture pack version  | realm Organization, `VITE_UAT_PACK_VERSION`                  |               |             |        |

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

workflow ใช้ `github.token` push image ไป GHCR (`ghcr.io/<owner>/dcontact-uat-{api,ops,console}`)
secret runtime ของ UAT (รหัสผ่าน DB/Keycloak/MinIO) **ไม่ผ่าน GitHub** — อยู่ใน `uat.env` บน VM เท่านั้น
รายชื่อ secret ใน `uat.env` (ดู `infra/uat/uat.env.example`):

| ชื่อ                                                          | ใช้ที่                                                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `UAT_POSTGRES_USER` / `UAT_POSTGRES_PASSWORD`                 | owner ของ Postgres (migrate, backup)                                     |
| `UAT_APP_DB_PASSWORD`                                         | role `dcontact_app` ของ API                                              |
| `UAT_KEYCLOAK_DB_PASSWORD`                                    | role/database `keycloak`                                                 |
| `UAT_KEYCLOAK_ADMIN_USERNAME` / `UAT_KEYCLOAK_ADMIN_PASSWORD` | bootstrap admin ของ Keycloak (ใช้ภายใน VM เท่านั้น)                      |
| `UAT_MINIO_ROOT_USER` / `UAT_MINIO_ROOT_PASSWORD`             | root ของ MinIO — ใช้เฉพาะ `minio-init`                                   |
| `UAT_MINIO_API_ACCESS_KEY` / `UAT_MINIO_API_SECRET_KEY`       | user เฉพาะของ API (`MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY`) — ต่างจาก root |

### Evidence storage (U1.5 #433)

- API profile `uat` **บูตไม่ผ่าน** ถ้าไม่มี `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`
  หรือ bucket ไม่พร้อม — compose ตั้ง `MINIO_ENDPOINT=http://minio:9000` (network `internal`),
  `UAT_EVIDENCE_BUCKET=uat-evidence` และให้ api รอ `minio-init` จบสำเร็จก่อน
- `minio-init` (`infra/uat/bin/minio-init.sh`, idempotent ทุก deploy) ใช้ root ของ MinIO เพื่อ:
  สร้าง bucket `uat-evidence`, ยืนยันว่าไม่มี anonymous access (ไม่ตั้ง policy ใด ๆ ให้ bucket),
  สร้าง/อัปเดต policy `uat-evidence-api` และ user ของ API แล้ว attach — ปฏิเสธถ้า access key ของ API = root
- policy `uat-evidence-api`: `s3:CreateBucket`, `s3:PutLifecycleConfiguration`, `s3:GetLifecycleConfiguration`,
  `s3:GetBucketPolicy`, `s3:GetBucketLocation`, `s3:ListBucket` บน `arn:aws:s3:::uat-evidence` และ
  `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` บน `arn:aws:s3:::uat-evidence/uat-evidence/*` เท่านั้น
- ตอนบูต API ตั้ง lifecycle ให้ object ใต้ `uat-evidence/` หมดอายุใน **90 วัน** และปฏิเสธการบูตถ้า bucket
  มี bucket policy (อาจถูกเปิด public นอกระบบ) — ห้ามใช้ `mc anonymous set` กับ bucket นี้
- MinIO ไม่เปิดพอร์ตสู่ host; ภาพหน้าจอเข้า/ออกผ่าน API ที่ตรวจสิทธิ์เท่านั้น (ไม่มี presigned/public URL)
- rotate secret ของ API: แก้ `uat.env` แล้ว deploy ซ้ำ (`minio-init` อัปเดต secret ก่อน api restart)

## 4. เตรียม VM ครั้งแรก

1. ติดตั้ง Docker Engine + compose plugin; ตั้ง `"userland-proxy": false` ใน `/etc/docker/daemon.json`
   เพื่อให้ Caddy เห็น source IP จริง (allowlist ใช้ `remote_ip`)
2. firewall ของ host/cloud: เปิดเฉพาะ 22 (จากที่ที่ runner/operator ใช้) และ 443/80 (จาก gateway)
3. สร้างโครง `/opt/dcontact-uat/{releases,deployments,backups,tls}` owner = deploy user, mode 700
4. วาง cert/key ของ `UAT_HOST` ใน `/opt/dcontact-uat/tls/` (mode 600) — ใช้ path นี้ใน `UAT_TLS_CERT_FILE`/`UAT_TLS_KEY_FILE`
5. สร้าง `/opt/dcontact-uat/uat.env` ตามรายชื่อใน `infra/uat/uat.env.example`, `chmod 600`
   (`uat-deploy.sh` ปฏิเสธถ้า mode ไม่ใช่ 600) — ทุกค่าสร้างใหม่สำหรับ UAT; รหัสผ่านที่อยู่ใน URL ใช้ `[A-Za-z0-9]` เท่านั้น
6. `docker login ghcr.io` ด้วย token แบบ `read:packages` ของบัญชี service (ไม่ใช่ token ส่วนตัว)
7. กด workflow `uat-preview` ด้วย `action=deploy`, `initial_deploy=true` (ครั้งแรกเท่านั้น)

## 5. Tenant และ fixture pack ของ UAT (ต้องใช้ operator input)

API profile `uat` ไม่ provision tenant เอง ก่อนเปิดให้ผู้ทดสอบ operator ต้องเตรียมข้อมูลต่อไปนี้ใน
ฐานข้อมูล UAT (หลัง deploy ครั้งแรก เพราะต้องมี schema ก่อน) ผ่าน `docker compose exec postgres psql`
ด้วย role owner — ไม่มีขั้นอัตโนมัติใน workflow เพราะทุกค่าเป็น input ของ operator:

1. แถว `tenants` ของ tenant UAT (`id` = `UAT_TENANT_ID`, `slug` = `UAT_TENANT_SLUG`, `lifecycle_status` = `ACTIVE`)
2. team เจ้าของ Journey (`ownerTeamId` ของ fixture pack) และแถว `users` ของ maker/reviewer
   (`id` = `dcUserId` ในไฟล์บัญชี — เป็น `subjectId` ของ J5)
3. `iam_authoring_subjects` + capability grants แบบ TEAM ของ owner team:
   maker = `journey.read`, `journey.edit`, `journey.publish`; reviewer = `journey.read`, `journey.review`
4. rollout ของ Journey authoring สำหรับ tenant: ไม่ `DISABLED`, ไม่ `mutationFrozen`, เปิด canvas write และ publish UI
5. fixture pack (`UatFixturePackV1`) ผ่าน `UatFixtureProvisioner` (U1.1 #429, `apps/journey/src/uat-run.ts`)
   ด้วย connection ของ operator (app role เขียน pack ไม่ได้) — preflight ตรวจข้อ 1–4 และ idempotent ต่อ
   environment + tenant + pack version; digest ต่าง = fail closed

> ช่องว่างที่ทราบ: ยังไม่มี CLI ของ `UatFixtureProvisioner` ใน repo — ต้องรันผ่าน `node` ใน ops image
> หรือเพิ่ม CLI ใน ticket ถัดไป; ห้ามใช้ `pnpm db:seed` ของ dev (สร้างบัญชี/รหัสผ่านของ dev)

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
docker compose --project-name dcontact-uat --project-directory . \
  --env-file /opt/dcontact-uat/uat.env --env-file release.env -f docker-compose.uat.yml \
  --profile ops run --rm -v /opt/dcontact-uat/accounts.json:/run/accounts.json:ro \
  keycloak-config node scripts/u1-uat-keycloak-users.mjs --users /run/accounts.json
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

กด Actions → `uat-preview` → Run workflow (branch `main`, `action=deploy`) แล้วรอ reviewer อนุมัติ
ลำดับใน job `deploy` (หยุดทันทีเมื่อขั้นใดล้ม):

1. ตรวจ provisioning gate variables และ static readiness (`node --test ...` + `u1-uat-readiness.mjs --static`)
2. SSH ไป VM (host key ต้องตรง) อ่าน deployment record ปัจจุบันเป็นฐานของ migration guard
3. migration guard: migration ที่เพิ่มหลัง SHA ที่ deploy อยู่ต้องไม่มี `DROP` และห้ามแก้/ลบ migration เดิม
4. build + push image `api`/`ops`/`console` ไป GHCR และเก็บ digest
5. อัปโหลด release (`docker-compose.uat.yml`, `bin/`, `release.env` ที่มีแต่ digest) → `prepare` (compose config + pull)
6. `backup`: `pg_dump --format=custom` ของ `dcontact` และ `keycloak` ไป `/opt/dcontact-uat/backups/`
7. `migrate`: `db-roles` → `prisma migrate deploy` + `rls.sql` → `db-roles` อีกรอบ
8. `keycloak`: Keycloak production mode + realm config
9. `deploy`: MinIO → `minio-init` (bucket private + user/policy ของ API) แล้ว `api` และ `proxy` ด้วย digest ใหม่
10. `smoke`: `u1-uat-readiness.mjs --live` จาก ops image บน VM (ต่อ `127.0.0.1:443` ด้วย SNI ของ `UAT_HOST`) — ไม่ผ่าน = job ล้ม
11. deployment record: job summary + artifact `uat-preview-<sha>-<attempt>` + `/opt/dcontact-uat/deployments/`

smoke ล้มหลัง deploy: stack ค้างที่ release ใหม่ — ตัดสินใจ rollback (ข้อ 10) หรือแก้แล้ว deploy ใหม่
ไม่มี auto-rollback เพราะต้องมีคนดูว่า migration ของ release นั้นเข้ากับ API เดิมได้

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
    "ops": "...@sha256:..."
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
- `node scripts/u1-uat-readiness.mjs --static` — UAT-S00..S15: compose ไม่มี worker/FreeSWITCH/Kafka/Redis,
  มีแค่ proxy ที่เปิดพอร์ต, ไม่มี `start-dev`, ไม่มี default credential, image/`FROM` pin digest,
  realm ไม่มี user/secret และบังคับ OTP, env ของ api ผ่าน profile, proxy ปิด admin + allowlist,
  workflow ผูก environment/concurrency/readiness, negative secret scan, evidence storage (api ใช้ MinIO
  user เฉพาะแบบ `:?` ไม่ใช่ root, รอ `minio-init`, ไม่มี `mc anonymous set`)
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
