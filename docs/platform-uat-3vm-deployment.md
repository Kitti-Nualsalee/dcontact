# Platform Admin UAT 3 VM (#574)

ขอบเขตนี้ใช้ `platform-uat.osd.co.th` แยกจาก Tenant Console, แยก Compose project บน VM2 และใช้ PostgreSQL VM3 ผ่าน `db-relay` ของ U1. ข้อมูลทดสอบเป็นข้อมูลสังเคราะห์เท่านั้น; `PLATFORM_PROVISIONING_ENABLED=false` จนกว่า gate และ rollback drill ผ่าน.

## Gate ก่อน deploy

1. Merge PR ของ #574 เข้า `main` แล้วใช้ SHA เต็มของ `main` เป็น `SOURCE_SHA`.
2. Dispatch `a1-release-candidate` บน `main`; ต้องผ่าน fast + real-boundary, ได้ `a1-rc-<SOURCE_SHA>` และ `pnpm a1:uat:gate --expect-sha <SOURCE_SHA>` เป็น `PASS`.
3. Dispatch `platform-uat-images` บน SHA เดียวกัน; ดาวน์โหลด artifact `platform-uat-release-<SOURCE_SHA>` ซึ่งมี image แบบ digest-pinned 3 ตัว. ห้ามใช้ artifact จาก SHA อื่น.
4. บน VM2 `/opt/dcontact-uat/deployments/current.json` ต้องชี้ release U1 ที่รันอยู่และมี `docker-compose.uat.3vm.yml`; schema VM3 ต้องมี migration A1 ครบ. ห้ามรัน Compose ของ U1 ด้วยไฟล์ `docker-compose.uat.yml` เพียงไฟล์เดียว.

## VM3 และ VM1

สคริปต์อยู่ที่ `infra/uat/operator/vm3-platform-db-uat.sh` และ `vm1-platform-nginx-uat.sh`. ส่งไปที่ `/home/osdadmin/` บน VM ที่ตรงชื่อ แล้วให้ `osdadmin` รัน:

```bash
# VM3 — ตรวจและเพิ่ม login member สอง role, HBA เฉพาะ VM2; parent ยัง NOLOGIN
sudo bash /home/osdadmin/vm3-platform-db-uat.sh --check
sudo bash /home/osdadmin/vm3-platform-db-uat.sh --apply

# VM1 — ตรวจ wildcard cert และเพิ่ม vhost ที่ชี้ VM2:8081
sudo bash /home/osdadmin/vm1-platform-nginx-uat.sh --check
sudo bash /home/osdadmin/vm1-platform-nginx-uat.sh --apply
```

VM1 อาจตอบ 502 ชั่วคราวก่อน Platform Console บน VM2 เริ่ม. อย่าโพสต์ credential bundle ของ VM3 ลง GitHub/chat/log.

## VM2 เตรียม env และ release

หลัง VM3 `--apply` ผ่าน รัน `bash infra/uat/operator/vm2-platform-install-env.sh` จากเครื่อง operator ที่ SSH เข้า VM2/VM3 ได้. สคริปต์ส่ง bundle ด้วย `scp -3`, สร้าง `/opt/dcontact-uat/platform/platform.env` mode 600 และตั้ง rollout เป็น `false`. หลังตรวจว่าไฟล์มีและเชื่อม DB ได้ ให้ลบ bundle ต้นทางบน VM3 ด้วย `shred -u /home/osdadmin/dcontact-platform-uat-db-credentials.env`.

วางไฟล์ต่อไปนี้บน VM2 ที่ `/opt/dcontact-uat/platform/releases/<SOURCE_SHA>/` โดย owner `osdadmin`:

- `platform-release.env` จาก artifact ที่ผ่าน gate
- `infra/uat/docker-compose.platform.3vm.yml` เป็น `docker-compose.platform.3vm.yml`
- `infra/uat/docker-compose.platform-keycloak.3vm.yml` เป็น `docker-compose.platform-keycloak.3vm.yml`
- `infra/uat/operator/vm2-platform-deploy.sh` วางที่ `/opt/dcontact-uat/platform/vm2-platform-deploy.sh`, mode 700

จาก VM2 ใช้คำสั่งตามลำดับ โดยแทน `<SOURCE_SHA>` เป็น SHA เต็มเดียวกันทุกคำสั่ง:

```bash
bash /opt/dcontact-uat/platform/vm2-platform-deploy.sh check <SOURCE_SHA>
bash /opt/dcontact-uat/platform/vm2-platform-deploy.sh pull <SOURCE_SHA>
bash /opt/dcontact-uat/platform/vm2-platform-deploy.sh keycloak <SOURCE_SHA>
bash /opt/dcontact-uat/platform/vm2-platform-deploy.sh configure <SOURCE_SHA>
bash /opt/dcontact-uat/platform/vm2-platform-deploy.sh start <SOURCE_SHA>
bash /opt/dcontact-uat/platform/vm2-platform-deploy.sh status <SOURCE_SHA>
```

**Keycloak 26.7.5 (#592):** env ของ Platform ต้องมี `KEYCLOAK_ACCOUNT_SERVICE_SECRET`
- `vm2-platform-install-env.sh` สร้างให้เมื่อติดตั้งใหม่
- env เดิมที่ติดตั้งก่อน #592 ต้องเพิ่มเองด้วยค่าสุ่ม 48 ตัวอักษร (`[A-Za-z0-9]`) แล้วจึงรัน `configure`
- `configure` เปิด fine-grained admin permissions v2, ตั้ง `dcontact-account-service` และให้ provisioner ได้ `manage-organizations` (ADR-033)
- `operator` รัน account setup ซ้ำ เพื่อให้ operator ใหม่อยู่ในรายชื่อที่ service account แตะไม่ได้
- **AC3 (#596): SMTP** — email บัญชีของ D-Contact และ email เชิญของ Keycloak ใช้ `SMTP_*` ชุดเดียวกันจาก `uat.env`
  - ไม่ตั้ง `SMTP_HOST` = Keycloak ส่งเข้า mailpit ภายใน stack เหมือนเดิม
  - ชื่อผู้ส่งเป็น "D-Contact" เสมอ (ชื่อใน `SMTP_FROM` ถูกแทน); Keycloak ตั้ง HELO เองไม่ได้ — `SMTP_HELO` ใช้กับ API เท่านั้น
  - ใส่ค่าจริงใน `uat.env` เท่านั้น ห้าม commit
  - **gate ก่อน production:** UAT ใช้ Microsoft 365 direct send ซึ่งส่งได้เฉพาะผู้รับในองค์กร (#589 Q1)
    ต้องตั้ง M365 SMTP relay connector + SPF หรือใช้ SMTP ที่ส่งออกนอกองค์กรได้ก่อนเปิดให้ลูกค้าภายนอก
- **AC6 (#599): ซ่อนร่องรอย Keycloak** — `keycloak-config` (`u1-uat-keycloak-users.mjs --config`) รัน `keycloak-branding-setup.mjs` ต่อท้าย (idempotent)
  - ตั้ง `displayName` = "D-Contact", account theme `dcontact`, `baseUrl` ของ client `account`/`account-console` = `https://${UAT_HOST}/` (หรือ `CONSOLE_PUBLIC_URL` ถ้าตั้ง) และซ่อน attribute ภายในจากผู้ใช้
  - **ชื่อ cookie ของ realm `dcontact` เปลี่ยนเป็น `DC_*`** เมื่อ image Keycloak ใหม่ขึ้น: ผู้ใช้ที่ login อยู่ยัง SSO ต่อได้ (ชื่อเดิมถูกอ่านแล้วหมดอายุ) ไม่ต้อง login ใหม่
  - rollback ของ image Keycloak กลับรุ่นก่อน AC6: cookie `DC_*` ที่ค้างอยู่ในเบราว์เซอร์ไม่ถูกอ่าน — ผู้ใช้ต้อง login ใหม่หนึ่งครั้ง
  - ก่อนเปิดให้ลูกค้า: รัน `pnpm test:identity-traces` กับ stack ที่มี Keycloak ตัวเดียวกัน (ต้องผ่านทั้ง th/en)
- **AC2 (#595):** `configure` ยังตั้ง browser flow ของ tenant `dcontact-browser` และผูกเป็น browser flow ของ realm
  (บังคับ 2FA ตาม Organization ผ่าน extension `dc-account` ใน image ของ Keycloak)
  - image ของ Keycloak ต้องมี `dcontact-account.jar` ก่อนรัน `configure` — ถ้าไม่มี setup จะล้มที่การเพิ่ม `dc-org-mfa-required`
  - ถอยกลับ: ตั้ง browser flow ของ realm กลับเป็น `browser` ใน admin console ของ Keycloak
    (`platform-console` ใช้ flow ของตัวเอง จึงไม่กระทบ)

`keycloak` เปลี่ยนเฉพาะ image ของ service U1 ด้วย overlay; release directory และ `release.env` ของ U1 ไม่ถูกแก้. `configure` ตั้ง `platform-console`/provisioner/SMTP และ seed operational baseline UAT (`uat-operational-v1`, plan starter/growth/enterprise) แบบทำซ้ำได้. `start` ต้องตรวจว่า rollout ยังปิด.

## ตรวจ UAT และเปิด canary

1. ตรวจ Keycloak invitation guard ใน server info, OIDC discovery, API `/health/live`, HTTPS `platform-uat.osd.co.th`, Caddy allowlist และปฏิเสธ `/auth/admin`, `/metrics` จาก browser. ตรวจ U1 Journey smoke เดิมหลัง Keycloak เปลี่ยน.
2. สร้าง **platform-only** operator (`kittin.platform`, email ทดสอบ `kittin.platform@uat.invalid`) ผ่าน `vm2-platform-deploy.sh operator <SOURCE_SHA>` โดยส่ง temporary password ใหม่ผ่าน stdin; Keycloak ต้องบังคับเปลี่ยน password และตั้ง TOTP. ห้ามใช้ tenant admin `kittin` เป็น platform operator. เก็บ subject UUID จากผลลัพธ์ที่ไม่มี secret.
3. ตรวจ API ด้วย platform token: operator อ่านได้, tenant token ต้องถูกปฏิเสธ, request นอก CIDR ต้อง 403. ตรวจ DB login role ทั้งสองเป็น `INHERIT NOBYPASSRLS`, parent `NOLOGIN`.
4. ทำ rollback drill โดย rollout ยังปิด: `vm2-platform-deploy.sh rollback <SOURCE_SHA>`, ตรวจ U1 กลับมาปกติ แล้วรัน `keycloak`, `configure`, `start` ใหม่. ไม่ลบ ledger/tenant.
5. หลัง `a1:uat:gate` ของ SHA ที่ deploy ผ่าน และ rollback drill ผ่านแล้ว รัน `vm2-platform-deploy.sh canary <SOURCE_SHA> <platform-subject-uuid>`; สคริปต์ตั้ง allowlist/rollout และ recreate **ทั้ง** `platform-api` และ `platform-worker`.
6. Internal Platform Operator รัน create → review → progress → failure/reconcile → handoff/search/Action history บนข้อมูลสังเคราะห์ พร้อม invitation ผ่าน Mailpit `/mail/`; ทดสอบสอง tenant แยกข้อมูลกัน และบันทึกหลักฐานใน #574.

## Rollback

บน VM2 รัน `bash /opt/dcontact-uat/platform/vm2-platform-deploy.sh rollback <SOURCE_SHA>`. สคริปต์ตั้ง rollout false, หยุด Platform stack และคืน Keycloak image ของ U1. ห้ามลบ A1 ledger, tenant หรือ migration.
ถ้า image ของ U1 ยังเป็น Keycloak 26.0.0 แต่ Platform release ใช้ 26.7.5 แล้ว การคืนแค่ image จะไม่พอ ต้อง restore ฐานข้อมูล `keycloak` ตาม `docs/u1-uat-deployment.md` §9 (Keycloak downgrade ไม่ได้, ADR-033). ถ้า rollback ไม่ผ่าน ให้หยุดเปิด canary และตรวจ U1 ก่อน.
