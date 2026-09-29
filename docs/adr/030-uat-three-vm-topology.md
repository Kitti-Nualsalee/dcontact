# ADR 030: UAT แบบ 3 VM — nginx (edge), Docker (stack), PostgreSQL (ภายนอก stack)

- **สถานะ:** Proposed (ร่าง — รอผู้ใช้ยืนยันก่อนเริ่ม implement)
- **วันที่:** 2026-09-29
- **ที่มา:** ผู้ใช้เตรียม VM สำหรับ UAT ไว้ 3 เครื่อง ต่างจากสมมติฐาน "VM เดียว" ใน Phase Contract #374 และ
  `docs/u1-uat-deployment.md` §1 (ticket U1.6 #434) — ADR นี้ **ปรับ (amend)** สมมติฐานนั้น ไม่ใช่การยกเลิก
  ต้องให้ owner ของ #374 ยืนยันว่ายอมรับการปรับ

## บริบท

runbook U1.6 ออกแบบให้ทุกอย่างอยู่ใน Docker Compose project `dcontact-uat` บน VM เดียว: Caddy (Console + TLS จากไฟล์),
api (profile `uat`), Keycloak, Postgres, MinIO บน network `internal: true` ที่ไม่มีทางออก internet มีเพียง proxy
ที่เปิดพอร์ต 443/80 สู่ host

โครงสร้างพื้นฐานที่มีจริง (ผลจาก `infra/uat/bin/uat-3vm-precheck.sh` 2026-09-29):

| VM  | IP                | บทบาท                          | ข้อเท็จจริงที่ตรวจพบ                                                                                                  |
| --- | ----------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| VM1 | `192.168.102.114` | nginx 1.18 (edge / หน้าเว็บ)   | **ใช้ร่วมกับเว็บอื่น** (`dphonedemo.osd.co.th`, `id24-dphonedemo`, `m-dphonedemo` ใน `conf.d`)                        |
| VM2 | `192.168.102.112` | Docker 24.0.7 + Compose v2.21  | RAM 3.9 GB, disk ว่าง 19 GB; ผลตรวจครั้งแรกไม่มี container, ไม่อยู่ใน `docker` group, ยังไม่ตั้ง `userland-proxy: false` (ตรวจซ้ำ 2026-09-29 15:09: แก้ครบสามข้อแล้ว และพบ container รันอยู่ 8 ตัว — ต้องระบุที่มา) |
| VM3 | `192.168.102.113` | PostgreSQL **15.4** (server; psql client 16.3) | **ใช้ร่วมกับระบบอื่น** (database `dialer`, `dinventory`, `id24`), listen `0.0.0.0:5432`, VM1 เข้า 5432 ได้ |

ทั้งสามเครื่อง Ubuntu 20.04, sudo ต้องใช้ password, host ที่ใช้คือ `dcontact-uat.osd.co.th` (DNS ยังไม่ resolve)

ผลกระทบต่อ design เดิม:

1. compose เดิมมี service `postgres` + volume และ `db-roles`/`migrate`/`uat-provision`/`backup` ผูกกับมัน
2. network `internal: true` ไม่มีทางออกจาก host จึงต่อ Postgres บน VM3 ไม่ได้
3. Caddy ทำ TLS เองและตรวจ allowlist ด้วย `remote_ip` แต่ตอนนี้ TLS จบที่ nginx (VM1) — Caddy จะเห็น source IP เป็น VM1 เสมอ
4. Postgres และ nginx เป็น **ทรัพยากรร่วม** — การตั้งค่าต้องไม่ทำให้ระบบอื่นบนเครื่องเดียวกันพัง

## การตัดสินใจ

1. **VM2 รัน stack ที่ไม่มี Postgres**: proxy (Caddy + Console), api, keycloak, minio (+ one-shot) ยังใช้ compose project
   `dcontact-uat` เดิม โดยจัดเป็น overlay `infra/uat/docker-compose.uat.3vm.yml` ซ้อนบน `docker-compose.uat.yml`
   **ไม่แก้ไฟล์ฐาน** เพื่อให้การซ้อมเครื่องเดียว (`uat-local.sh`) และ runbook เดิมใช้ได้ต่อ

2. **Postgres อยู่ที่ VM3 และเข้าผ่าน `db-relay` ใน stack**: คง `internal: true` ของ api/keycloak/ops ไว้ (ไม่มีทางออก
   internet เชิงเครือข่ายตาม #374) โดยเพิ่ม service TCP relay (nginx `stream` หรือเทียบเท่า, pin digest) ที่ต่อทั้ง
   `internal` และ network ขาออกใหม่ `dbnet` ส่งต่อ `:5432` ไปยัง `192.168.102.113:5432` เท่านั้น
   overlay คงชื่อ DNS `postgres` ให้ relay เพื่อให้ `DATABASE_URL`, `depends_on` และ healthcheck เดิมใช้ได้โดยไม่ต้องแก้
   ทั้ง 5 จุด — ไม่ให้ container ใดนอกจาก relay ออกนอก VM ได้
   - Compose บน VM2 คือ **v2.21** ซึ่งไม่รองรับ `!reset`/`!override` (มาใน 2.24) จึงลบ property ของ `postgres`
     ในฐาน (`volumes`, `cap_add`) ไม่ได้ ต้องออกแบบ overlay ให้ทนต่อ list ที่ถูก merge (หรืออัปเกรด Compose plugin)
   - ทางเลือกที่ไม่เลือก: ปิด `internal: true` แล้วคุมด้วย iptables `DOCKER-USER` — ทำให้การไม่มี egress
     ขึ้นกับ rule บน host ที่ตรวจใน compose/readiness ไม่ได้

3. **ฐานข้อมูลบน VM3 แยกจากระบบอื่นอย่างชัดเจน** เพราะเป็น cluster ร่วม (role เป็น global ของ cluster):
   - สร้าง database ใหม่สำหรับ UAT โดยเฉพาะ (`dcontact_uat`, `keycloak_uat`) และ role ที่มี prefix
     (`dcontact_uat_app` แบบ NOBYPASSRLS, `keycloak_uat`) — ต้อง **parametrize ชื่อ** ใน `db-roles.sh`,
     `uat-deploy.sh`, compose (ตอนนี้ hardcode `dcontact`/`keycloak`) และตรวจว่าไม่ชนกับของเดิมก่อนสร้าง
   - owner ของ migrate/provision ควรเป็น role เฉพาะ UAT (`dcontact_uat_owner`) ที่สร้างขึ้นครั้งเดียว ไม่ใช้บัญชีที่
     ใช้ร่วมกับระบบอื่น (`id24`, `sa`) เป็น owner ถาวร; บัญชี bootstrap (`sa` เป็น superuser + bypassrls) ใช้สร้าง
     role/database ครั้งแรกเท่านั้น — extension ที่ต้องใช้เป็นแบบ trusted (PG 13+) owner ที่ไม่ใช่ superuser จึงสร้างเองได้
   - `pg_hba.conf`: **เพิ่ม** บรรทัดให้ `192.168.102.112/32` เข้าเฉพาะ database/role ของ UAT ด้วย `scram-sha-256`
     และจำกัด 5432 ด้วย firewall ให้เหลือ VM ที่จำเป็น — ห้ามลบหรือแก้บรรทัดเดิม (ระบบอื่นใช้อยู่)
   - รหัสผ่านอยู่ใน `/opt/dcontact-uat/uat.env` บน VM2 เท่านั้น ไม่เข้า Git/GitHub/รายงานการตรวจ

4. **TLS จบที่ nginx (VM1); Caddy ใน stack รับ HTTP อย่างเดียวจาก VM1**:
   - VM1 เพิ่มไฟล์ใหม่ `conf.d/dcontact-uat.osd.co.th.conf` (ไม่แก้ไฟล์ของเว็บอื่น, `nginx -t` ก่อน reload ทุกครั้ง)
     ทำ 80→443 redirect, HSTS/security header และ `proxy_pass` ไป VM2 พร้อม
     `proxy_set_header X-Forwarded-For $remote_addr` (เขียนทับ ไม่ต่อท้าย เพื่อกัน spoof),
     `X-Forwarded-Proto https`, `Host $host`
   - Caddy: เลิก TLS/`secrets` cert-key, ฟัง `:8080` แบบ HTTP, publish เฉพาะ `192.168.102.112:8080`
     และให้ firewall ของ VM2 เปิด 8080 จาก VM1 เท่านั้น
   - allowlist (`UAT_ALLOWED_CIDRS`) ยังบังคับที่ Caddy: ตั้ง `trusted_proxies static 192.168.102.114/32` +
     `client_ip_headers X-Forwarded-For` แล้วเปลี่ยน matcher `remote_ip` → `client_ip` การปิด `/auth/admin*`,
     `/auth/realms/master*` ยังอยู่ที่ Caddy (VM2 `userland-proxy: false` จึงเห็น source IP จริงของ VM1)
   - cert ของ `dcontact-uat.osd.co.th` วางบน VM1 (ใช้ wildcard ที่มีอยู่ถ้ามี ไม่งั้นออกใหม่) —
     แหล่ง cert/วันหมดอายุ/วิธีต่ออายุยังเป็น provisioning gate ตาม runbook §2

5. **ข้อจำกัดทรัพยากรบน VM2 (RAM 3.9 GB)**: กำหนดเพดานหน่วยความจำต่อ service (เช่น Keycloak `JAVA_OPTS_KC_HEAP`
   และ `mem_limit`), one-shot (`migrate`, `keycloak-config`, `uat-provision`) รันทีละตัว, ไม่รันงานอื่นบน VM2,
   และเฝ้า disk (19 GB — image + `minio-data` ที่ retention 90 วัน) เป็นเงื่อนไขของ readiness

6. **backup/restore ต้องไม่พึ่ง `pg_dump` ใน container `postgres`**: `uat-deploy.sh backup` (`exec postgres pg_dump`)
   เปลี่ยนเป็น one-shot จาก client image เวอร์ชัน 15 ให้ตรงกับ server บน VM3 (dump จาก client 16 restore กลับเข้า server 15 ไม่ได้) ต่อผ่าน relay เขียนไฟล์ dump ลง
   `/opt/dcontact-uat/backups` บน VM2 เหมือนเดิม; นโยบาย backup ของ cluster ทั้งก้อนบน VM3 อยู่นอกขอบเขตนี้
   แต่ต้องมีเจ้าของระบุใน provisioning gate

7. **ขอบเขตที่ไม่เปลี่ยน**: ไม่เพิ่ม Journey worker, FreeSWITCH, Kafka/Redpanda, Redis (#374 stop condition),
   MinIO ยังอยู่ใน stack บน VM2 (ADR-029), image อ้างด้วย digest, secret runtime ไม่ผ่าน GitHub

## ผลที่ตามมา

**ต้องแก้ (ตอน implement — ทำเป็น ticket ต่อยอด U1.6):**

- `infra/uat/docker-compose.uat.3vm.yml` (ใหม่), `infra/uat/Caddyfile` (หรือ Caddyfile คู่สำหรับ 3 VM),
  `infra/uat/bin/uat-deploy.sh` (backup, ชื่อ DB, เลิกพึ่ง TLS secret), `infra/uat/bin/db-roles.sh`,
  `infra/uat/uat.env.example` (ชื่อ DB/role, `UAT_DB_HOST`, ตัดตัวแปร TLS ของโหมดนี้)
- `scripts/u1-uat-readiness.mjs` (+ `.test.mjs`): `--static` ต้องตรวจทั้งโหมดเครื่องเดียวและ 3 VM
  (ยังต้องยืนยัน `internal: true`, allowlist, การปิด admin และ **egress ผ่าน relay ไปที่ VM3:5432 เท่านั้น**)
- `docs/u1-uat-deployment.md` (§1 สถาปัตยกรรม, §2 provisioning gate เพิ่ม VM1/VM3, §4 เตรียม VM) และ
  `docs/u1-uat-local.md` ถ้ากระทบ
- config ของ nginx บน VM1 ควรเก็บไว้ใน repo (เช่น `infra/uat/nginx/dcontact-uat.conf`) เป็น template โดยไม่มี path ของ private key

**ข้อดี:** ใช้โครงสร้างที่มีอยู่จริงโดยไม่ต้องมี Postgres/TLS ซ้ำซ้อน, คงหลักการ no-egress ของ #374 ในระดับ compose,
ฐานพื้นฐาน (`docker-compose.uat.yml`, `uat-local.sh`) ไม่เปลี่ยน

**ข้อเสีย/ความเสี่ยง:**

- เพิ่มจุดล้มเหลว 1 จุด (relay) และ hop เครือข่ายอีก 2 ชั้น (VM1→VM2, VM2→VM3) ยากต่อการ debug กว่า VM เดียว
- DB และ nginx เป็นทรัพยากรร่วม — การแก้ `pg_hba`/firewall/nginx ผิดอาจกระทบเว็บอื่น จึงกำหนด "เพิ่มเท่านั้น" และ `nginx -t`
- ความเป็นส่วนตัวของ traffic ระหว่าง VM (VM2→VM3, VM1→VM2) เป็น plaintext ใน LAN (scram สำหรับ DB, HTTP สำหรับ proxy)
  ยอมรับได้สำหรับ UAT ในวงเดียวกัน; ถ้าต้องการเข้ารหัสให้เปิด `sslmode=require` ที่ Postgres และ TLS ภายในภายหลัง
- RAM 3.9 GB ตึงสำหรับ Keycloak + api + MinIO; ถ้าไม่พอให้เพิ่ม RAM ก่อนพิจารณาย้าย service
- Ubuntu 20.04 พ้น standard support แล้ว (ไม่ขวางการติดตั้ง แต่ควรมีแผนอัปเกรด)

## เงื่อนไขก่อนเริ่ม implement (gate)

| # | รายการ | สถานะ |
| - | ------ | ----- |
| 1 | owner ของ #374 ยืนยันการปรับจาก VM เดียวเป็น 3 VM | รอ |
| 2 | สิทธิ์ sudo บน 3 VM + เพิ่ม `osdadmin`/deploy user เข้า `docker` group บน VM2 | รอ |
| 3 | DNS `dcontact-uat.osd.co.th` → `192.168.102.114` | รอ |
| 4 | cert ของ host บน VM1 (ตรวจว่ามี wildcard เดิมหรือไม่) | รอ |
| 5 | ตรวจ cluster บน VM3: ชื่อ database/role ที่ชน, สิทธิ์ (createdb/createrole), `pg_hba` เดิม | ส่วนใหญ่ผ่าน (2026-09-29): ใช้บัญชี `sa` (superuser) ตรวจแล้ว ชื่อ `dcontact_uat`, `keycloak_uat` และ role ที่มี prefix ไม่ชนกับของเดิม; extension ที่ต้องใช้ (`pgcrypto`, `citext`, `uuid-ossp`, `pg_trgm`, `btree_gin`, `btree_gist`) พร้อม; **ยังค้าง**: อ่าน `pg_hba.conf` (ต้อง sudo), ตรวจ Prisma migration + `rls.sql` กับ PostgreSQL 15 |
| 6 | เปลี่ยนรหัสผ่านของบัญชี bootstrap ที่เคยปรากฏในแชต และสร้าง owner role เฉพาะ UAT (NOSUPERUSER) — `sa` เป็น superuser + bypassrls จึงใช้ bootstrap เท่านั้น | รอ |
| 7 | เจ้าของ backup ของ Postgres บน VM3 | รอ |
