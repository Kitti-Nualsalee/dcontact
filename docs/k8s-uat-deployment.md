# แผนเตรียม K8s UAT ใหม่ (ยังไม่ deploy)

สถานะ: **manifest และ runbook สำหรับ review/offline render เท่านั้น** (#625/#628). ห้ามนำไฟล์ไป `apply` จนผ่าน gate ด้านล่างและมีคำสั่ง deploy แยกต่างหาก. Cluster `dcontact`, namespace `dcontact-uat` ไม่เกี่ยวกับ UAT 3 VM และไม่มีการย้ายข้อมูลจาก UAT เดิม.

## Topology และ URL

| องค์ประกอบ | ค่า/บทบาท |
| --- | --- |
| Tenant Console + `/api`, `/auth` | `https://dcontact-uat.osd.co.th` |
| Platform Console + `/api` | `https://dcontact-platform-uat.osd.co.th` |
| Keycloak issuer | `https://dcontact-uat.osd.co.th/auth/realms/dcontact` (ใช้ origin Tenant เดียวกัน) |
| Traefik | IngressClass `traefik`, TLS Secret `dcontact-uat-wildcard-tls` ใน namespace |
| DNS | ทั้งสองชื่อชี้ **public IP/VIP หรือ NAT** ที่ส่งต่อไป worker หนึ่งตัวซึ่งทีม cluster เลือก (`10.136.1.21`, `.22` หรือ `.23` เป็น IP ภายใน); ต้องยืนยัน public IP, NAT/LB, Traefik listener และ failover ก่อนเผยแพร่ DNS |
| PostgreSQL | external `10.136.2.11:4567`, ชื่อ Service ภายใน `postgres-external.dcontact-uat.svc.cluster.local:4567`; ฐานใหม่ `dcontact_k8s_uat`, `keycloak_k8s_uat` |
| RustFS | standalone 1 replica, PVC 10Gi บน StorageClass ที่เลือก, `rustfs:9000` แบบ ClusterIP, bucket `uat-evidence` private |
| Mailpit | `mailpit:1025`/`:8025` แบบ ClusterIP สำหรับอีเมลทดสอบ; ข้อมูลใน `emptyDir` หายเมื่อ pod เปลี่ยน |

ไม่ต้องมี public URL เพิ่มสำหรับ RustFS, Mailpit, Keycloak admin หรือ metrics. ถ้าทดสอบ Mailpit ให้ใช้ `kubectl port-forward` ผ่านสิทธิ์ operator; ห้ามเพิ่ม public Ingress. DNS สองชื่อและ wildcard certificate ต้องตรวจว่า certificate ครอบคลุมทั้งสอง FQDN.

`PLATFORM_SIP_BASE_DOMAIN=sip.k8s-uat.osd.co.th` เป็นชื่อสำรองใน config ขณะที่ Platform provisioning ปิดอยู่; ยังไม่ต้องสร้าง DNS นี้. หากจะทดสอบ voice/SIP จริง ต้องตกลง endpoint และแผนเครือข่ายแยกก่อนเปิด feature.

## ไฟล์และค่าเตรียมล่วงหน้า

- ให้เก็บ kubeconfig ที่ `~/.kube/dcontact-uat.yaml` **นอก repository**, owner ปัจจุบันเท่านั้นอ่านได้ (`chmod 600`). คำสั่งในวัน deploy ใช้ `KUBECONFIG=$HOME/.kube/dcontact-uat.yaml` และยืนยัน context `dcontact`/namespace `dcontact-uat` ก่อนทุก mutation; ไม่รวมกับ config ของ UAT VM.
- `infra/k8s/uat/foundation/` มี namespace, Service ไป DB, Keycloak, RustFS/PVC, Mailpit. `applications/` มี API/Console/worker และ Caddy routes. `exposure/` มี public Ingress เพียงสองชื่อ. `jobs/` เป็น one-shot templates ที่ไม่อยู่ใน Kustomize ทั้งสาม phase.
- `REPLACE_WITH_STORAGE_CLASS` ต้องแทนด้วยชื่อ StorageClass จริงหลังตรวจ `ReadWriteOnce`, `WaitForFirstConsumer`/node affinity, `fsGroup=10001` เขียน volume ได้ และการขยาย PVC. ตรวจว่า PVC มี backup/restore ตามความสำคัญของข้อมูล. RustFS standalone เป็น single replica; pod ย้าย node ได้เมื่อ volume รองรับเท่านั้น.
- Image ของแอปมาจาก workflow `k8s-uat-images` ที่ build ทั้ง Tenant และ Platform บน **full `SOURCE_SHA` เดียวกัน** แล้วแนบ `release.env` กับ `platform-release.env`; ตัว render รับเฉพาะ `ghcr.io/...@sha256:<digest>`. Workflow นี้แยกจาก `uat-operator-package` ของ UAT 3 VM และใช้ migration guard แบบฐานว่าง. Trigger จาก `main` หลัง code ผ่าน review/merge. RustFS/Mailpit ตรึง digest ใน manifest อยู่แล้ว; ตรวจ architecture ของ worker และ pull access.
- Workflow ฝัง Vite OIDC issuer เป็น `https://dcontact-uat.osd.co.th/auth/realms/dcontact` สำหรับ Console ทั้งสอง. อย่าใช้ release ของ host อื่นแม้ SHA ตรง.

## Secret contract

ค่า secret จริงอยู่ใน secret manager/ไฟล์ mode 600 นอก Git; manifest อ้าง **ชื่อกับ key** เท่านั้น. ทีม operator ต้องสร้าง Kubernetes Secret ตามรายการนี้ใน `dcontact-uat` ก่อน workload/job ที่เกี่ยวข้อง และจำกัด RBAC/เปิด encryption at rest ของ cluster. ห้าม commit manifest ที่มี `data`/`stringData` จริง, ไม่แปะค่าใน shell history, issue หรือ PR.

| Secret | Keys | ผู้ใช้ |
| --- | --- | --- |
| `dcontact-uat-ghcr` | Docker registry auth (`kubernetes.io/dockerconfigjson`) | imagePullSecret ของแอปและ jobs |
| `dcontact-uat-db` | `DATABASE_URL_OWNER`, `DATABASE_URL_APP`, `PLATFORM_DATABASE_URL`, `PROVISIONER_DATABASE_URL`, `KC_DB_URL`, `KC_DB_USERNAME`, `KC_DB_PASSWORD` | owner เฉพาะ Job migration/provision; runtime แต่ละตัวอ่าน URL ของตน |
| `dcontact-uat-identity` | `KC_BOOTSTRAP_ADMIN_USERNAME`, `KC_BOOTSTRAP_ADMIN_PASSWORD`, `KEYCLOAK_PROVISIONER_SECRET`, `KEYCLOAK_ACCOUNT_SERVICE_SECRET` | Keycloak/Job/worker ตาม key ที่ต้องใช้ |
| `dcontact-uat-s3` | `RUSTFS_ACCESS_KEY`, `RUSTFS_SECRET_KEY`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | RustFS/init ใช้ root; Tenant API ใช้ IAM key แยก |
| `dcontact-uat-tenant` | `UAT_TENANT_ID`, `UAT_TENANT_SLUG`, `UAT_TENANT_NAME`, `UAT_ORGANIZATION_DOMAIN` | setup/provision Jobs |
| `dcontact-uat-provision-input` | `provision.json` | one-shot tenant provision; format จาก `scripts/u1-uat-fixture-render.mjs` |
| `dcontact-uat-accounts` | `accounts.json` | one-shot test users; format จาก U1 fixture renderer |
| `dcontact-uat-platform-operator` | `username`, `email`, `temporary-password` | one-shot Platform operator Job |
| `dcontact-uat-wildcard-tls` | `tls.crt`, `tls.key` (`kubernetes.io/tls`) | สอง Ingress; wildcard ต้องครอบคลุมสองชื่อ |

DB team ยังไม่ส่งมอบ user/password. URL ฐานต้องใช้ principal แยกตาม [DB handoff](k8s-uat-db-handoff.md), host/port `postgres-external:4567` หรือ hostname ที่ตรวจ TLS ได้. ห้ามใช้ `sslmode=disable` เมื่อเปิด public UAT หาก DB ต้องใช้ TLS. หาก URL ใส่ password ที่มีอักขระพิเศษ ให้ URL-encode อย่างถูกต้อง. Secret สำหรับ `dcontact-uat-s3` รวม root และ API keys ใน object เดียวแต่ container เห็นเฉพาะ key ที่อ้าง; จำกัด RBAC การอ่าน Secret object.

## ตรวจแบบ offline ในรอบเตรียมไฟล์

จาก root ของ repository โดย **ไม่ตั้ง kubeconfig และไม่ติดต่อ cluster**:

```sh
node scripts/k8s-uat-render.mjs --template --phase foundation > /tmp/dcontact-uat-foundation.template.yaml
node scripts/k8s-uat-render.mjs --template --phase applications > /tmp/dcontact-uat-applications.template.yaml
node scripts/k8s-uat-render.mjs --template --phase exposure > /tmp/dcontact-uat-exposure.template.yaml
node scripts/k8s-uat-render.mjs --template --phase job:migrate > /tmp/dcontact-uat-migrate.template.yaml
git diff --check
```

Template ยังมี placeholder จงใจ. เมื่อได้ release files ทั้งสองและ StorageClass จริง จึง render/ตรวจด้วย `--tenant-release <ไฟล์นอก repo> --platform-release <ไฟล์นอก repo> --storage-class <ชื่อจริง> --check --phase <phase>`; เอา `--check` ออกเพื่อเขียน YAML ที่แทนค่าแล้ว. สคริปต์ปฏิเสธ SHA ต่างกัน, digest ไม่ถูกต้อง, StorageClass ที่ยังไม่ทราบ และ placeholder ค้าง. `kubectl kustomize` เป็น local render; ห้ามใช้ `kubectl apply --dry-run=server` ในรอบนี้เพราะจะติดต่อ cluster.

## Gate ก่อน deploy จริงในรอบถัดไป

1. ทีม cluster ส่ง kubeconfig/context `dcontact`, public IP/VIP ที่ส่งถึง worker ที่เลือก, IngressClass/Traefik entrypoint, StorageClass, Pod egress IP/CIDR, GHCR pull access และ policy ของ Secret/PVC. เลือก DNS target และตรวจเส้นทางจาก public Internet ถึง Traefik.
2. ทีม DB ส่งมอบสองฐาน, role แยก, TLS/CA/hostname, firewall/`pg_hba.conf` และผลทดสอบตาม [DB handoff](k8s-uat-db-handoff.md). ตรวจว่า DB ยังว่างและไม่ใช่ VM UAT เดิม.
3. จัดเตรียม wildcard TLS Secret, Secret ทั้งหมด, release artifact สองชุด SHA เดียวกัน และ image architecture/pull test. ตรวจว่าค่า OIDC origin/redirect ตรงกับสอง URL.
4. ทดสอบ RustFS image digest นี้ว่ารองรับ S3 contract: bucket private, IAM user ของ API แยก root, `HeadBucket`, `PutBucketLifecycleConfiguration`, `GetBucketPolicy`, `Put/Get/DeleteObject`, presigned GET. API ต้องมีสิทธิ์ตั้ง lifecycle เฉพาะ bucket `uat-evidence` และ object prefix `uat-evidence/`; ห้ามให้สิทธิ์แก้ bucket policy หรืออ่าน bucket อื่น. ตรวจ lifecycle **ลบจริงภายใน 90 วัน** บน RustFS รุ่นที่ใช้ก่อนเปิดผู้ทดสอบ. ถ้าไม่ผ่านให้หยุด rollout ตาม ADR-029.
5. ตรวจ quota/requests, PVC bind/backup, DB connection limits, network policy และ outbound HTTPS ที่งานต้องใช้. เตรียม rollback แบบคืน digest/config เดิมและ backup ฐาน/PVC; migration ฐานต้องมีแผน restore เพราะ rollback image ไม่ย้อน schema.

## ลำดับปฏิบัติเมื่อมีคำสั่ง deploy แยกต่างหาก

1. ยืนยัน `kubectl config current-context` กับ kubeconfig ใหม่, namespace, `kubectl diff` และไฟล์ release ที่ render แล้ว; สร้าง namespace/Secrets ก่อน workload. อย่าสร้าง/ใช้ context ของ UAT VM.
2. ติดตั้ง `foundation` แล้วรอ PVC RustFS, Service DB, RustFS, Mailpit, Keycloak พร้อม. ยังไม่มี public Ingress. ยืนยัน connectivity และ principal แยกโดยไม่พิมพ์ password ลง log.
3. รัน one-shot `job:migrate` เพียงครั้งตามแผน DB และตรวจ RLS/role boundary. ต่อด้วย `job:object-storage-init`; สร้าง RustFS IAM user/policy แยกด้วยวิธีของ RustFS และตรวจ contract/lifecycle ก่อนให้ API เริ่ม.
4. รัน `job:tenant-keycloak-config` → `job:platform-keycloak-config` → `job:platform-catalog-seed`; จากนั้น `job:tenant-provision`, `job:tenant-keycloak-users`, `job:platform-operator` ตามข้อมูลทดสอบที่อนุมัติ. แต่ละ Job ต้อง `Complete` และตรวจ log ที่ไม่เผย secret ก่อนทำตัวถัดไป.
5. ติดตั้ง `applications`, ทดสอบผ่าน ClusterIP/port-forward ก่อน public. Platform provisioning เริ่ม `false` และ operator allowlist ว่าง. ตรวจ tenant API profile `uat`, OIDC login/redirect, migration/RLS, S3, Mailpit, negative access ของ admin/metrics และการทำงาน Platform read-only.
6. เมื่อทุก gate ผ่าน ให้ติดตั้ง `exposure` เป็นขั้นสุดท้าย แล้วเปิด DNS ทั้งสองชื่อ/ตรวจ TLS+public smoke. ตรวจว่า `/auth/admin`, `/auth/realms/master`, `/auth/metrics`, `/mail`, `/metrics` ไม่เปิดสาธารณะ และ RustFS/Mailpit ไม่มี Ingress/NodePort/LoadBalancer.

ถ้า preflight, Job, IAM, lifecycle, TLS, DNS หรือ smoke ไม่ผ่าน ให้หยุดก่อนขั้น exposure. Rollback Ingress/app digest ได้เฉพาะเมื่อ schema ยังรองรับ; หาก schema เปลี่ยนต้องใช้แผน restore ของทีม DB. บันทึก SHA, image digests, StorageClass, TLS fingerprint, Job results และหลักฐาน smoke เป็น deployment record หลังทำจริงเท่านั้น.
