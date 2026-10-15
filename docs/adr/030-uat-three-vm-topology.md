# ADR 030: UAT แบบ 3 VM — nginx (edge), Docker (stack), PostgreSQL (ภายนอก stack)

- **สถานะ:** Accepted (ผู้ใช้ในฐาน owner ของ #374 ยืนยัน 2026-09-29; gate ปิดครบและ implement แล้ว 2026-10-01)
- **วันที่:** 2026-09-29
- **ที่มา:** ผู้ใช้เตรียม VM สำหรับ UAT ไว้ 3 เครื่อง ต่างจากสมมติฐาน "VM เดียว" ใน Phase Contract #374 และ
  `docs/u1-uat-deployment.md` §1 (ticket U1.6 #434) — ADR นี้ **ปรับ (amend)** สมมติฐานนั้น ไม่ใช่การยกเลิก
  owner ของ #374 ยืนยันการปรับนี้แล้ว (2026-09-29)

## บริบท

runbook U1.6 ออกแบบให้ทุกอย่างอยู่ใน Docker Compose project `dcontact-uat` บน VM เดียว: Caddy (Console + TLS จากไฟล์),
api (profile `uat`), Keycloak, Postgres, MinIO บน network `internal: true` ที่ไม่มีทางออก internet มีเพียง proxy
ที่เปิดพอร์ต 443/80 สู่ host

โครงสร้างพื้นฐานที่มีจริง (ผลจาก `infra/uat/bin/uat-3vm-precheck.sh` 2026-09-29):

| VM  | IP                | บทบาท                          | ข้อเท็จจริงที่ตรวจพบ                                                                                                  |
| --- | ----------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| VM1 | `192.168.102.114` | nginx 1.18 (edge / หน้าเว็บ)   | **ใช้ร่วมกับเว็บอื่น** (`dphonedemo.osd.co.th`, `id24-dphonedemo`, `m-dphonedemo` ใน `conf.d`)                        |
| VM2 | `192.168.102.112` | Docker 24.0.7 + Compose v2.21  | ตรวจซ้ำ 2026-09-29 16:35: RAM **7.9 GB** (เพิ่มจาก 3.9 GB), disk ว่าง 20 GB, `osdadmin` อยู่ใน `docker` group, `userland-proxy: false`, มี `/opt/dcontact-uat` แล้ว; container เก่า (stack เดิม) หยุดแล้วและผู้ใช้แจ้งว่าไม่ใช้แล้ว แต่ยังไม่ได้ลบ container/volume |
| VM3 | `192.168.102.113` | PostgreSQL **15.4** (server; psql client 16.3) | **ใช้ร่วมกับระบบอื่น** (database `dialer`, `dinventory`, `id24`; role `dialer`, `id24`, `osdadmin`, `postgres`, `sa`), listen `0.0.0.0:5432`; `pg_hba.conf` บรรทัด 98 `host all all 0.0.0.0/0 md5` เปิดให้ทุก IPv4 ต่อทุก database/role ด้วย password (จึงทำให้ VM1 เข้า 5432 ได้) |

ทั้งสามเครื่อง Ubuntu 20.04, sudo ต้องใช้ password, host ที่ใช้คือ `dcontact-uat.osd.co.th` — ช่วงทดสอบ **ไม่ขอ DNS record**
ผู้ทดสอบ map host ในเครื่องตัวเอง (hosts file) ชี้ `192.168.102.114`; cert ทีมของผู้ใช้จะติดตั้งบน VM1 ภายหลัง;
ระบบเดิมบน VM1/VM3 หยุดอยู่ชั่วคราวแต่อาจกลับมาใช้ได้; ผู้ใช้ตัดสินว่าเป็น server ทดสอบชั่วคราว (ไม่ต้องเปลี่ยนรหัสผ่านบัญชี bootstrap)

ผลกระทบต่อ design เดิม:

1. compose เดิมมี service `postgres` + volume และ `db-roles`/`migrate`/`uat-provision`/`backup` ผูกกับมัน
2. network `internal: true` ไม่มีทางออกจาก host จึงต่อ Postgres บน VM3 ไม่ได้
3. Caddy ทำ TLS เองและตรวจ allowlist ด้วย `remote_ip` แต่ตอนนี้ TLS จบที่ nginx (VM1) — Caddy จะเห็น source IP เป็น VM1 เสมอ
4. Postgres และ nginx เป็น **ทรัพยากรร่วม** — การตั้งค่าต้องไม่ทำให้ระบบอื่นบนเครื่องเดียวกันพัง

## การตัดสินใจ

1. **VM2 รัน stack ที่ไม่มี Postgres**: proxy (Caddy + Console), api, keycloak, object storage (MinIO ปัจจุบัน → SeaweedFS ตาม ADR-029/#540) (+ one-shot) ยังใช้ compose project
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
   - **database** ใช้ชื่อเฉพาะ UAT: `dcontact_uat` และ `keycloak_uat` — ต้อง parametrize ชื่อ database ใน `db-roles.sh`,
     `uat-deploy.sh` และ compose (ตอนนี้ hardcode `dcontact`/`keycloak`) และตรวจว่าไม่ชนกับของเดิมก่อนสร้าง
     (ตรวจ 2026-09-29: ว่างทั้งคู่)
   - **role คงชื่อเดิม ไม่ใช้ prefix**: `dcontact_app` (NOBYPASSRLS), `dcontact_platform`, `dcontact_provisioner`, `keycloak`
     เพราะ `rls.sql` และ migration อ้างชื่อ `dcontact_*` ตรง ๆ (`rls.sql` 143 จุด; 209 ไฟล์ในรีโปอ้างถึง) การเปลี่ยนชื่อ
     เป็นงานใหญ่และเสี่ยงกว่าประโยชน์ที่ได้ ชื่อเหล่านี้ว่างอยู่ใน cluster (ตรวจ 2026-09-29) — **ยอมรับว่าชื่อ `dcontact_*`
     และ `keycloak` ถูกจองไว้ใน cluster นี้สำหรับระบบนี้**
   - owner ของ migrate/provision/backup เป็น role เฉพาะ UAT `dcontact_uat_owner` (`BYPASSRLS` แต่ `NOSUPERUSER`) ที่สร้างครั้งเดียว ไม่ใช้บัญชีที่
     ใช้ร่วมกับระบบอื่น (`id24`, `sa`) เป็น owner ถาวร; บัญชี bootstrap (`sa` เป็น superuser + bypassrls) ใช้สร้าง
     role/database ครั้งแรกเท่านั้น และ API ห้ามใช้บัญชีเหล่านี้ — extension ที่ต้องใช้เป็นแบบ trusted (PG 13+)
     owner ที่ไม่ใช่ superuser จึงสร้างเองได้
   - **ลำดับบังคับ: `db-roles` ก่อน `migrate` เสมอ** — migration/`rls.sql` สร้าง `dcontact_platform`/`dcontact_provisioner`
     ด้วย `LOGIN` และรหัสผ่านของ dev ถ้ายังไม่มี ส่วน `db-roles.sh` สร้างไว้เป็น NOLOGIN ก่อน บน cluster ที่เปิด md5 ให้ทั้ง LAN
     ถ้า migrate ก่อนจะมี role ที่ล็อกอินด้วยรหัสผ่านที่เดาได้ readiness ต้องตรวจลำดับนี้และตรวจว่าทั้งสอง role เป็น NOLOGIN
   - **`pg_hba.conf`** (สภาพจริง: บรรทัด 98 `host all all 0.0.0.0/0 md5` ตรงกับทุกการเชื่อมต่อจาก IPv4 และ Postgres ใช้กฎแรกที่ตรง)
     การ **เพิ่มบรรทัดต่อท้ายไฟล์ไม่มีผล** ต้อง **แทรกก่อนบรรทัด 98** โดยไม่แตะ/ลบกฎเดิม (กฎใหม่ตรงเฉพาะ database/role ของ UAT
     จึงไม่กระทบระบบอื่น):

     ```text
     host  dcontact_uat  dcontact_app,dcontact_uat_owner  192.168.102.112/32  scram-sha-256
     host  keycloak_uat  keycloak                          192.168.102.112/32  scram-sha-256
     host  all  dcontact_app,dcontact_platform,dcontact_provisioner,dcontact_uat_owner,keycloak  0.0.0.0/0  reject
     host  dcontact_uat,keycloak_uat  all  0.0.0.0/0  reject
     ```

     ตรวจคอลัมน์ `error` ของ `pg_hba_file_rules` ก่อน แล้วใช้ `pg_reload_conf()` (ไม่ restart) — **ไม่ใช้ ufw จำกัด 5432 ทั้งพอร์ต**
     เพราะกระทบระบบอื่นที่ต่อจาก IP อื่น และต้องให้เจ้าของ cluster รับทราบก่อนแก้
   - **ข้อสังเกตต่อ implement:** กฎ `reject` ข้างบนทำให้บัญชีอื่น (รวม `sa`) ต่อเข้า `dcontact_uat`/`keycloak_uat` จาก VM2 ไม่ได้ และ
     `db-roles.sh` เดิมต้องมีสิทธิ์สร้าง role/database จึงต้องตัดสินตอน implement: ให้ operator ทำ bootstrap (สร้าง role/database)
     ครั้งเดียวผ่าน `sudo -u postgres psql` บน VM3 (การเชื่อมต่อแบบ `local`/peer ไม่ผ่านกฎ `host`) แล้วให้ `db-roles.sh` ในโหมด 3 VM
     ทำเฉพาะตั้งรหัสผ่าน/NOLOGIN โดย owner ไม่ต้องมี CREATEROLE/CREATEDB — ทางเลือกคือให้ owner มีเฉพาะสิทธิ์ที่จำเป็น
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
   - cert ของ `dcontact-uat.osd.co.th` วางบน VM1 โดยทีมของผู้ใช้ภายหลัง (ยังไม่ทราบว่าใช้ wildcard ที่มีอยู่หรือออกใหม่) —
     แหล่ง cert/วันหมดอายุ/วิธีต่ออายุยังเป็น provisioning gate ตาม runbook §2; ก่อนมี cert ทดสอบได้เฉพาะส่วน nginx → stack
   - ไม่มี DNS ในช่วงทดสอบ: Keycloak issuer/redirect URI ยังใช้ชื่อ host เดิม (`https://dcontact-uat.osd.co.th/...`) ผู้ทดสอบต้อง map host ทุกเครื่อง
     และ readiness ที่รันบน VM ต้องใช้ `--resolve` หรือ hosts entry ของ VM นั้น

5. **ทรัพยากรบน VM2 (RAM 7.9 GB, disk ว่าง 20 GB)**: กำหนดเพดานหน่วยความจำต่อ service (เช่น Keycloak `JAVA_OPTS_KC_HEAP`
   และ `mem_limit`) ตามงบ 8 GB, one-shot (`migrate`, `keycloak-config`, `uat-provision`) รันทีละตัว, ไม่รันงานอื่นบน VM2,
   และเฝ้า disk (image + volume ของ object storage ที่ retention 90 วัน — นับ volume `minio-data` เดิมที่ค้างระหว่างย้ายไป
   SeaweedFS (#540) รวมในงบด้วย) เป็นเงื่อนไขของ readiness; ก่อน deploy ต้องตรวจว่า container/volume/network เก่าที่หยุดไว้บน VM2
   ไม่ชนชื่อ project `dcontact-uat` (project, volume, พอร์ต) หรือเก็บกวาดก่อน

6. **backup/restore ต้องไม่พึ่ง `pg_dump` ใน container `postgres`**: `uat-deploy.sh backup` (`exec postgres pg_dump`)
   เปลี่ยนเป็น one-shot จาก client image เวอร์ชัน 15 ให้ตรงกับ server บน VM3 (dump จาก client 16 restore กลับเข้า server 15 ไม่ได้) ต่อผ่าน relay เขียนไฟล์ dump ลง
   `/opt/dcontact-uat/backups` บน VM2 เหมือนเดิม; นโยบาย backup ของ cluster ทั้งก้อนบน VM3 อยู่นอกขอบเขตนี้
   แต่ต้องมีเจ้าของระบุใน provisioning gate

7. **ขอบเขตที่ไม่เปลี่ยน**: ไม่เพิ่ม Journey worker, FreeSWITCH, Kafka/Redpanda, Redis (#374 stop condition),
   object storage ยังอยู่ใน stack บน VM2 บน network `internal` (ADR-029; กำลังย้ายจาก MinIO เป็น SeaweedFS ใน #540 — overlay 3 VM ไม่แตะ service นี้), image อ้างด้วย digest, secret runtime ไม่ผ่าน GitHub

## ผลที่ตามมา

**ต้องแก้ (ตอน implement — ทำเป็น ticket ต่อยอด U1.6):**

- `infra/uat/docker-compose.uat.3vm.yml` (ใหม่), `infra/uat/Caddyfile` (หรือ Caddyfile คู่สำหรับ 3 VM),
  `infra/uat/bin/uat-deploy.sh` (backup, ชื่อ database, เลิกพึ่ง TLS secret), `infra/uat/bin/db-roles.sh`,
  `infra/uat/uat.env.example` (ชื่อ database, `UAT_DB_HOST`, ตัดตัวแปร TLS ของโหมดนี้) — ชื่อ role ไม่เปลี่ยน
- `scripts/u1-uat-readiness.mjs` (+ `.test.mjs`): `--static` ต้องตรวจทั้งโหมดเครื่องเดียวและ 3 VM
  (ยังต้องยืนยัน `internal: true`, allowlist, การปิด admin, **egress ผ่าน relay ไปที่ VM3:5432 เท่านั้น** และลำดับ
  `db-roles` → `migrate` กับ `dcontact_platform`/`dcontact_provisioner` เป็น NOLOGIN)
- test ของ Prisma migration + `rls.sql` บน **PostgreSQL 15** (dev/CI/UAT compose ตอนนี้ใช้ `postgres:16-alpine` ซึ่งไม่ตรงกับ VM3)
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
- `pg_hba.conf` เดิมเปิด md5 ให้ทุก IPv4 ต่อทุก database/role รวม `sa`/`postgres` ที่เป็น superuser — เป็นความเสี่ยงที่มีอยู่ก่อน
  และอยู่นอกขอบเขต ADR นี้ (ไม่แก้ของเดิม) แต่แจ้งเจ้าของ cluster; กฎ `reject` ข้างบนคุ้มครองเฉพาะ role/database ของเรา
- role `dcontact_*`/`keycloak` เป็น global ของ cluster: ถ้ามีระบบอื่นในอนาคตต้องใช้ชื่อเดียวกันจะชน (ยอมรับสำหรับ UAT)
- migration ยังไม่เคยทดสอบกับ PG15 (แค่ค้น syntax เฉพาะ PG16 แล้วไม่พบ ซึ่งไม่ใช่การพิสูจน์)
- RAM 7.9 GB ของ VM2 พอสำหรับ Keycloak + api + object storage แต่ยังต้องกำหนดเพดานต่อ service; ถ้าไม่พอให้เพิ่ม RAM ก่อนพิจารณาย้าย service
- Ubuntu 20.04 พ้น standard support แล้ว (ไม่ขวางการติดตั้ง แต่ควรมีแผนอัปเกรด)

## เงื่อนไขก่อนเริ่ม implement (gate)

ปิดครบแล้ว (2026-10-01) — implementation อยู่ใน #549/#550 และ deploy จริงด้วย release `b5f5efd` (หลักฐานใน #537, #508)

| # | รายการ | สถานะ |
| - | ------ | ----- |
| 1 | owner ของ #374 ยืนยันการปรับจาก VM เดียวเป็น 3 VM | ผ่าน (2026-09-29 — ผู้ใช้ในฐาน owner ยืนยันในบทสนทนา) |
| 2 | VM2 พร้อมใช้ และขั้นตอน sudo บน VM1/VM3 | ผ่าน: VM2 พร้อม (RAM 8 GB); nginx บน VM1 และ `pg_hba`/bootstrap บน VM3 ทำแล้ว (#537) |
| 3 | DNS ของ `dcontact-uat.osd.co.th` | ตัดสินแล้ว: ช่วง UAT ใช้ map host ในเครื่องผู้ทดสอบ ไม่ขอ DNS |
| 4 | cert ของ host บน VM1 | ผ่าน: wildcard certificate อายุถึง 2027-01-13 (#537) |
| 5 | ตรวจ cluster VM3 และแทรกกฎ `pg_hba` | ผ่าน: ชื่อไม่ชน, extension ครบ, แทรก 4 กฎก่อนกฎ md5 เดิมและ reload แล้ว (#537) |
| 6 | รหัสผ่านบัญชี bootstrap และ owner role | ตัดสินแล้ว: server ทดสอบชั่วคราว ไม่ต้องเปลี่ยนรหัสผ่าน; API ห้ามใช้ `sa`/`id24`; ใช้ `dcontact_uat_owner` (`BYPASSRLS` แต่ `NOSUPERUSER`) สำหรับ migrate/backup เท่านั้น |
| 7 | เจ้าของ backup ของ Postgres บน VM3 | ตัดสินแล้ว (2026-10-01): UAT ไม่มีข้อมูลที่ต้อง backup จึงไม่ต้องระบุเจ้าของ — เปิดใหม่ถ้ามีข้อมูลที่ต้องเก็บ; dump ก่อน migrate ของ `uat-deploy.sh` ยังมีไว้สำหรับ rollback ของ deploy |
| 8 | Prisma migration + `rls.sql` ทำงานบน PostgreSQL 15.4 | ผ่าน: migrate + RLS บน PG 15.4 ผ่าน, deploy จริงผ่าน db-relay และ RLS integration test 21/21 ผ่าน (#537) |
| 9 | container/volume เก่าบน VM2 ไม่ชนชื่อ project `dcontact-uat` | ผ่าน: ตรวจสดแล้วไม่ชน (#537) |
| 10 | Compose plugin v2.21 บน VM2 ไม่รองรับ `!reset` | ผ่าน: ใช้ Compose v2.39.4 แบบ scoped ที่ `/opt/dcontact-uat/bin/docker-compose` |

**ตัดออกจากขอบเขต (owner ตัดสิน 2026-10-01):** การ deploy ผ่าน workflow `uat-preview` และ secrets `UAT_SSH_*` — UAT นี้ deploy จากเครื่อง
operator เพราะ runner `ubuntu-latest` เข้า VM ในวง LAN ไม่ได้ ผลคือ workflow deploy/rollback ยังไม่เคยทดสอบจริง; rollback ใช้
`uat-deploy.sh rollback` จากเครื่อง operator (#508)
