# ส่งต่องาน PostgreSQL สำหรับ K8s UAT ใหม่

ขอบเขตนี้เป็น cluster `dcontact` / namespace `dcontact-uat` (#625/#628) และเป็นฐานเปล่า **แยกจาก UAT 3 VM**. DB server คือ `uat-osd-DB01` (`10.136.2.11:4567`) อยู่นอก Kubernetes. เอกสารนี้เป็นข้อกำหนดให้ทีม DB ดำเนินการภายหลัง; ยังไม่มีการเชื่อมต่อหรือสร้างบัญชีใด ๆ จาก repository นี้.

## สิ่งที่ขอให้ทีม DB เตรียม

| Database | Owner/login | ใช้โดย |
| --- | --- | --- |
| `dcontact_k8s_uat` | `dcontact_k8s_uat_owner` | migration/RLS และ one-shot tenant provision เท่านั้น |
| `keycloak_k8s_uat` | `dcontact_k8s_keycloak` | Keycloak เท่านั้น |

ใน `dcontact_k8s_uat` ต้องมี role ต่อไปนี้ **ก่อน** รัน migration ครั้งแรก เพราะ `prisma/rls.sql` อ้างชื่อ role ที่ตายตัว:

- `dcontact_app`: `LOGIN`, `NOBYPASSRLS`, ไม่มีสิทธิ์ owner/superuser; Tenant API เท่านั้น
- `dcontact_platform` และ `dcontact_provisioner`: `NOLOGIN`, `NOBYPASSRLS`, ไม่มี password; `rls.sql` ให้สิทธิ์กับ role สองชื่อนี้
- `dcontact_k8s_platform_login`: `LOGIN INHERIT NOBYPASSRLS`, เป็นสมาชิก `dcontact_platform`; Platform API/worker ใช้ principal นี้
- `dcontact_k8s_provisioner_login`: `LOGIN INHERIT NOBYPASSRLS`, เป็นสมาชิก `dcontact_provisioner`; Platform worker ใช้ principal นี้สำหรับขั้น provision เท่านั้น

ทุก login ต้องแยก password ใหม่จาก UAT 3 VM, ใช้ SCRAM-SHA-256, `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`. ให้ owner ของฐานมีสิทธิ์สร้าง/แก้ schema `public` และรัน Prisma migrations + `rls.sql`; app/platform/provisioner ไม่มีสิทธิ์ DDL. ปิด `PUBLIC` database grants แล้วให้ `CONNECT` เฉพาะ principal ที่ระบุ, ตรวจ schema/table grants หลัง migration. ห้ามใช้ owner URL ใน Deployment ของ API หรือ worker. ชื่อ role ที่ทีม DB จะใช้จริงต้องตรงกับ URL ที่ส่งมอบ; ถ้าเปลี่ยนชื่อ `dcontact_app` หรือ parent role ต้องแก้และตรวจ `rls.sql` ก่อน.

## เครือข่ายและ TLS

- อนุญาต TCP 4567 จาก **แหล่ง IP จริงของ pod egress** ไป `10.136.2.11` เท่านั้น. ทีม cluster ต้องแจ้งว่าออกเป็น Pod CIDR หรือ SNAT เป็น node IP ใด แล้วทีม DB ตั้ง firewall/`pg_hba.conf` ให้ตรง; ห้ามคัดลอก CIDR ของ UAT 3 VM.
- ให้ทีม DB ยืนยัน PostgreSQL version ที่รองรับ schema/Keycloak, `listen_addresses`, TLS mode, CA certificate และชื่อ DNS ที่ certificate ครอบคลุม. ถ้าใช้ `verify-full` ต้องเปลี่ยน URL จาก IP เป็น hostname ที่ตรวจ certificate ได้ โดยปลายทางยังเป็น `10.136.2.11:4567`.
- แยก `pg_hba.conf` ตาม database + login role + source CIDR, ใช้ `hostssl` และ `scram-sha-256` เมื่อ TLS พร้อม; ปิด access จาก `0.0.0.0/0` นอก allowlist.
- ยืนยัน backup/restore สำหรับสองฐานใหม่, capacity/connection limit และผู้รับผิดชอบก่อนเปิดให้ผู้ทดสอบ.

## หลักฐานที่ต้องส่งคืนก่อน deploy

1. ชื่อ database/role ที่สร้างจริงและผลตรวจ `rolcanlogin`, `rolbypassrls`, membership, owner และ grants (ไม่มี password ในผลลัพธ์).
2. endpoint/port, TLS mode/CA/hostname และ source CIDR ที่อนุญาตจริงจาก cluster.
3. URL ห้าค่า ส่งผ่านช่องทาง secret manager ที่ทีมตกลงกัน: `DATABASE_URL_OWNER`, `DATABASE_URL_APP`, `PLATFORM_DATABASE_URL`, `PROVISIONER_DATABASE_URL`, `KC_DB_URL` พร้อม `KC_DB_USERNAME`/`KC_DB_PASSWORD`. `DATABASE_URL_*` และ Platform URLs ต้องชี้ฐาน `dcontact_k8s_uat`; `KC_DB_URL` ชี้ `keycloak_k8s_uat`.
4. ผลทดสอบ connection แยกแต่ละ principal และผลปฏิเสธสิทธิ์ที่ไม่ควรมี; ไม่ส่ง password ใน issue, PR, chat หรือ log.

อ้างอิง boundary เดิม: `infra/uat/operator/vm3-bootstrap-uat.sh`, `infra/uat/operator/vm3-platform-db-uat.sh` และ `packages/db/prisma/rls.sql`; สคริปต์ VM เหล่านี้ผูกกับ IP/ชื่อฐานเดิม จึง **ห้ามรันกับ DB server ใหม่นี้**.
