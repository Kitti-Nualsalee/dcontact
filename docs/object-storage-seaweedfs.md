# Object storage บน SeaweedFS — reference deployment สำหรับ on-prem และ cloud (self-host)

- **สถานะ:** Reference (ยังไม่มี IaC) — ตาม [ADR-029](adr/029-object-storage.md) ข้อ 3 และ [#539](https://github.com/Kitti-Nualsalee/dcontact/issues/539) ส่วน C
- **ใช้กับ:** production on-prem และ cloud แบบ self-host (VM หลายเครื่อง/หลาย AZ)
- **ไม่ใช้กับ:** dev/CI (RustFS, #533) และ UAT (SeaweedFS เครื่องเดียว, #540 — ดู [u1-uat-deployment §3 Evidence storage](u1-uat-deployment.md))

เอกสารนี้กำหนด **ข้อบังคับ** (ต้องมีก่อนเปิด production) กับ **ค่าเริ่มต้นที่แนะนำ** (ปรับได้พร้อมเหตุผล)
สิ่งที่ยังไม่ได้พิสูจน์บน cluster จริงระบุไว้ในหัวข้อ [สิ่งที่ต้องยืนยันตอน deploy ครั้งแรก](#9-สิ่งที่ต้องยืนยันตอน-deploy-ครั้งแรก)

## 1. สิ่งที่แอปต้องการจาก object storage

แอปคุยผ่าน S3 API เท่านั้น (ADR-029 ข้อ 1) ด้วย `@aws-sdk/client-s3` แบบ path-style

| bucket               | key prefix                           | ผู้เขียน                  | ผู้อ่าน/ลบ                                                           | retention                                                    |
| -------------------- | ------------------------------------ | ------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------ |
| `recordings`         | `recordings/<tenant>/…`              | `telephony` (PutObject)   | `api` (presigned GET สำหรับ playback, DeleteObject), `qm` (presigned GET) | แอปเป็นผู้ลบตาม retention ของ tenant (ไม่ใช้ bucket lifecycle) |
| `governance-exports` | `governance-exports/<tenant>/…`      | `contact-governance` (PutObject, DeleteObject) | `api` (presigned GET สำหรับดาวน์โหลด)                                | แอปลบเมื่อ export หมดอายุหรือถูกเพิกถอน (ADR-027)             |
| `collab` (อนาคต)     | `collab/<tenant>/…` (ADR-022)        | ยังไม่ implement          | —                                                                    | กำหนดตอน implement                                           |

**ผลที่ตามมาที่ต้องออกแบบ:**

- **presigned URL ถูกเปิดโดย browser ของผู้ใช้** (playback และดาวน์โหลด export) — `S3_ENDPOINT` ของ `api` ต้องเป็น
  hostname ที่ผู้ใช้เข้าถึงได้ด้วย **HTTPS** เพราะ host อยู่ในลายเซ็น SigV4 จะเปลี่ยน host ภายหลังไม่ได้
- `qm` บังคับ HTTPS (`QM_MEDIA_ENDPOINT` override endpoint เฉพาะ QM ได้) และส่ง URL ให้ผู้ให้บริการถอดเสียง
- ไม่มีแอปใดต้องใช้ `CreateBucket`, bucket policy หรือ ACL ใน production — bucket สร้างครั้งเดียวโดย operator

## 2. Topology ขั้นต่ำ

```text
                     ผู้ใช้ (browser) / ผู้ให้บริการ ASR
                                   │ HTTPS  s3.<domain>
                          ┌────────▼─────────┐
                          │ load balancer/TLS │  (reverse proxy ภายในองค์กรหรือ LB ของ cloud)
                          └───┬──────────┬───┘
                              │          │  HTTP ภายใน (หรือ TLS ถ้านโยบายเครือข่ายกำหนด)
                     ┌────────▼──┐  ┌────▼──────┐
                     │ s3 gw #1  │  │ s3 gw #2  │   weed s3 (stateless) + s3.json identities/policies
                     └─────┬─────┘  └─────┬─────┘
                           └──────┬───────┘
                     ┌────────────▼────────────┐
                     │ filer #1      filer #2  │   filer store ร่วม = PostgreSQL (database แยก)
                     └────────────┬────────────┘
             ┌────────────────────┼────────────────────┐
     ┌───────▼──────┐     ┌───────▼──────┐     ┌───────▼──────┐
     │ master #1    │     │ master #2    │     │ master #3    │   raft (-peers) — จำนวนคี่
     └──────────────┘     └──────────────┘     └──────────────┘
   rack A: volume #1, #2                    rack B: volume #3, #4       replication 010
   lifecycle runner ×1 (weed shell s3.lifecycle.run-shard -refresh 1h)
```

| ส่วน                 | จำนวนขั้นต่ำ                | ข้อบังคับ / ค่าแนะนำ                                                                                                  |
| -------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| master               | 3 (คี่)                      | `weed master -peers=m1:9333,m2:9333,m3:9333 -defaultReplication=010`                                                  |
| volume server        | 2 ต่อ rack × 2 rack          | ตั้ง `-dataCenter` / `-rack` ให้ตรงกับที่ตั้งจริง; disk แยกจาก OS; `-max` ตามขนาด disk ÷ `volumeSizeLimitMB`              |
| filer                | 2                           | filer store ร่วม (PostgreSQL) — leveldb ในเครื่องใช้ได้กับ filer เดียวเท่านั้น                                          |
| s3 gateway           | 2                           | stateless; ใช้ `s3.json` ชุดเดียวกัน; อยู่หลัง LB ที่ terminate TLS ด้วย hostname ที่ใช้ลงชื่อ presigned URL             |
| lifecycle runner     | 1                           | จำเป็นเมื่อมี bucket lifecycle (4.48 ไม่รัน pass เอง — spike #539); รันเกิน 1 ตัวไม่จำเป็น                              |
| admin / worker       | ไม่บังคับ                   | ถ้าเปิด ต้อง bind loopback หรือเปิด mTLS (`grpc.admin`) — **ห้ามใช้ `weed mini`** ใน production                       |

### Replication

รูปแบบ `XYZ`: X = สำเนาใน data center อื่น, Y = สำเนาใน rack อื่นของ DC เดียวกัน, Z = สำเนาใน server อื่นของ rack
เดียวกัน (จำนวนสำเนาทั้งหมด = ผลรวม + 1)

- **on-prem (DC เดียว):** `010` — รอดจาก rack ล่มทั้ง rack; ต้องมี volume server ≥ 2 rack
- **cloud (หลาย AZ):** map AZ เป็น `-rack` แล้วใช้ `010` หรือ map เป็น `-dataCenter` แล้วใช้ `100` ถ้าต้องการรอดจาก region/DC
- **ห้ามใช้ `000` กับ `recordings`** — ไฟล์เสียงเป็นข้อมูลที่ต้องเก็บตาม compliance; replication ไม่ใช่ backup (ดูข้อ 6)

### ขนาด

- หนึ่ง bucket = หนึ่ง collection ที่จองหลาย volume ล่วงหน้า (spike #539: `volume.max` เล็กเกินทำให้ `No writable volumes`)
- ค่าแนะนำ: `-master.volumeSizeLimitMB=30000` สำหรับไฟล์เสียง (ไฟล์ใหญ่, จำนวน volume น้อย) และคำนวณ `-max` ต่อ
  volume server = disk ที่ใช้ได้ ÷ 30 GB โดยเผื่อ 20% สำหรับ vacuum
- เฝ้า `volume.list` / metrics ของ master: writable volumes ต่อ collection ต้องไม่เป็น 0

## 3. ความปลอดภัย

**ข้อบังคับ**

1. **identity และสิทธิ์:** `s3.json` ที่มีเฉพาะ identity ของ operator (root) และหนึ่ง identity ต่อแอป
   - ไม่มี identity `anonymous`
   - สิทธิ์ของแอปใช้ `policies` + `policyNames` แบบ AWS เท่านั้น (ข้อ 4) — **ห้ามใช้ `actions` แบบหยาบกับแอป**
     (`Admin:<bucket>` ให้ตั้ง bucket policy เป็น public และลบ bucket ได้ — spike #539)
   - credential อยู่ใน secret manager และ render `s3.json` ตอน deploy เท่านั้น (แนวเดียวกับ
     `infra/uat/bin/object-storage-entrypoint.sh`: เขียนลง tmpfs, mode 0400) ไม่ commit ลง Git
2. **gRPC และ JWT ภายใน cluster:** สร้าง `security.toml` (`weed scaffold -config=security`) เปิด mTLS ของ gRPC ระหว่าง
   master/volume/filer/s3 และ `jwt.signing` สำหรับการเขียน volume — ไม่อย่างนั้นใครเข้าถึงพอร์ต volume ได้ก็เขียนข้อมูลได้
3. **เครือข่าย:** เปิดสู่ภายนอกเฉพาะ LB ของ s3 gateway; master (9333/19333), volume (8080/18080), filer (8888/18888)
   และ s3 gRPC (18333) อยู่ใน network ภายในเท่านั้น
4. **TLS:** endpoint ที่แอปและ browser ใช้ต้องเป็น HTTPS (presigned URL และ `qm`)

**Encryption at rest (SSE-S3)** — แนะนำให้เปิดกับ `recordings` และ `governance-exports`

- SeaweedFS ใช้ envelope encryption ด้วย KEK จาก `[s3.sse]` ใน `security.toml` (`kek` = 256-bit hex) หรือ env
  `WEED_S3_SSE_KEK`
- ตั้ง bucket default encryption ผ่าน S3 API (`PutBucketEncryption`) เป็น SSE-S3 ตอนสร้าง bucket
- KEK เป็นของ deployment (ตาม [quality-management §encryption](quality-management.md)) — **KEK หาย = ข้อมูลอ่านไม่ได้**
  ต้องเก็บ KEK แยกจาก backup ของข้อมูล และมีเจ้าของ key ที่ระบุชื่อ
- ห้ามใช้ SSE-C (backup/replication ทำไม่ได้เพราะไม่มี key ของลูกค้า)

## 4. สิทธิ์ขั้นต่ำต่อแอป

แต่ละแอปมี identity ของตัวเอง (ไม่แชร์ credential) และได้เฉพาะ action ที่โค้ดใช้จริง (ตรวจจาก adapter ใน `apps/*/src/s3-*.ts`)
presigned GET ใช้สิทธิ์ `s3:GetObject` ของ identity ที่ลงชื่อ

| identity             | bucket / resource                                          | actions                        |
| -------------------- | ---------------------------------------------------------- | ------------------------------ |
| `telephony`          | `arn:aws:s3:::recordings/recordings/*`                     | `s3:PutObject`                 |
| `api`                | `arn:aws:s3:::recordings/recordings/*`                     | `s3:GetObject`, `s3:DeleteObject` |
|                      | `arn:aws:s3:::governance-exports/governance-exports/*`     | `s3:GetObject`                 |
| `qm`                 | `arn:aws:s3:::recordings/recordings/*`                     | `s3:GetObject`                 |
| `contact-governance` | `arn:aws:s3:::governance-exports/governance-exports/*`     | `s3:PutObject`, `s3:DeleteObject` |
| operator (root)      | ทั้งหมด                                                    | ใช้สร้าง bucket, encryption, lifecycle, backup เท่านั้น — ไม่ให้แอปใช้ |

ตัวอย่าง `s3.json` (ค่า credential มาจาก secret manager ตอน render):

```json
{
  "identities": [
    {
      "name": "root",
      "credentials": [{ "accessKey": "<ROOT_ACCESS_KEY>", "secretKey": "<ROOT_SECRET_KEY>" }],
      "actions": ["Admin", "Read", "List", "Tagging", "Write"]
    },
    {
      "name": "telephony",
      "credentials": [{ "accessKey": "<TELEPHONY_ACCESS_KEY>", "secretKey": "<TELEPHONY_SECRET_KEY>" }],
      "policyNames": ["recordings-write"]
    },
    {
      "name": "api",
      "credentials": [{ "accessKey": "<API_ACCESS_KEY>", "secretKey": "<API_SECRET_KEY>" }],
      "policyNames": ["recordings-read-delete", "governance-exports-read"]
    },
    {
      "name": "qm",
      "credentials": [{ "accessKey": "<QM_ACCESS_KEY>", "secretKey": "<QM_SECRET_KEY>" }],
      "policyNames": ["recordings-read"]
    },
    {
      "name": "contact-governance",
      "credentials": [{ "accessKey": "<CG_ACCESS_KEY>", "secretKey": "<CG_SECRET_KEY>" }],
      "policyNames": ["governance-exports-write"]
    }
  ],
  "policies": [
    {
      "name": "recordings-write",
      "content": "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"s3:PutObject\"],\"Resource\":[\"arn:aws:s3:::recordings/recordings/*\"]}]}"
    },
    {
      "name": "recordings-read-delete",
      "content": "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"s3:GetObject\",\"s3:DeleteObject\"],\"Resource\":[\"arn:aws:s3:::recordings/recordings/*\"]}]}"
    },
    {
      "name": "recordings-read",
      "content": "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"s3:GetObject\"],\"Resource\":[\"arn:aws:s3:::recordings/recordings/*\"]}]}"
    },
    {
      "name": "governance-exports-read",
      "content": "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"s3:GetObject\"],\"Resource\":[\"arn:aws:s3:::governance-exports/governance-exports/*\"]}]}"
    },
    {
      "name": "governance-exports-write",
      "content": "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"s3:PutObject\",\"s3:DeleteObject\"],\"Resource\":[\"arn:aws:s3:::governance-exports/governance-exports/*\"]}]}"
    }
  ]
}
```

ตัวอย่างนี้ทดสอบแล้วบน SeaweedFS 4.48 (`weed server -s3`, 2026-09-29): ทั้ง 4 identity ทำได้เฉพาะช่องในตาราง
(Put/Get/Delete ของสอง bucket และ PutBucketPolicy ถูกปฏิเสธนอกตาราง) — identity ที่ผูกหลาย policy (`api`) ได้สิทธิ์รวมกัน

การแยก tenant ทำที่แอป (key prefix ต่อ tenant ถูกตรวจใน adapter ก่อนทุกคำสั่ง) ไม่ใช่ที่ storage — storage จำกัดแค่
bucket/prefix ต่อแอป

## 5. Config ของแอป (`S3_*`)

ทุกแอปอ่านผ่าน `readS3Configuration()` / `readS3Bucket()` ใน `@d-contact/shared` — `NODE_ENV=production` ไม่มี default
ของ endpoint/credential

| env                            | `api` | `telephony` | `qm` | `contact-governance` | ค่า                                                        |
| ------------------------------ | :---: | :---------: | :--: | :------------------: | ---------------------------------------------------------- |
| `S3_ENDPOINT`                  |   ✓   |      ✓      |  ✓   |          ✓           | `https://s3.<domain>` — **ของ `api` ต้องเป็น host ที่ browser เข้าถึงได้** |
| `S3_REGION`                    |   ✓   |      ✓      |  ✓   |          ✓           | `us-east-1` (SeaweedFS ไม่ตรวจ แต่ต้องตรงกันทุกแอป)        |
| `S3_ACCESS_KEY`/`S3_SECRET_KEY`|   ✓   |      ✓      |  ✓   |          ✓           | credential ของ identity ของแอปนั้น (ข้อ 4)                  |
| `S3_FORCE_PATH_STYLE`          |   ✓   |      ✓      |  ✓   |          ✓           | `true` (ไม่ตั้ง `-domainName` ที่ s3 gateway)              |
| `S3_BUCKET_RECORDINGS`         |   ✓   |      ✓      |  ✓   |                      | `recordings`                                               |
| `S3_BUCKET_GOVERNANCE_EXPORTS` |   ✓   |             |      |          ✓           | `governance-exports`                                       |
| `QM_MEDIA_ENDPOINT`            |       |             | ถ้าจำเป็น |                  | override endpoint เฉพาะ QM (ต้อง HTTPS)                     |

## 6. Backup และ restore

replication (ข้อ 2) ป้องกัน disk/rack ล่ม แต่ไม่ป้องกันการลบผิดหรือ ransomware — ต้องมี backup แยก

| ส่วน                     | วิธี                                                                                                   | ความถี่/หมายเหตุ                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| ข้อมูล object            | `weed filer.backup` (subscribe change log ของ filer) ไป sink ที่อยู่คนละ failure domain (S3 อีกระบบหรือ local disk ของเครื่อง backup) ตั้งใน `replication.toml` (`weed scaffold -config=replication`) | ต่อเนื่อง; `is_incremental = true` เก็บเป็นโฟลเดอร์รายวันและไม่ลบตาม source (ป้องกันการลบผิด) — ต้องมีนโยบายลบ backup ตาม retention |
| metadata ของ filer       | backup ของ database PostgreSQL ที่เป็น filer store (pg_dump/PITR ตามนโยบาย DB)                          | ตามนโยบาย DB ขององค์กร                             |
| `s3.json`, `security.toml`, KEK | เก็บใน secret manager (ไม่อยู่ใน backup ของข้อมูล)                                                | ทุกครั้งที่เปลี่ยน                                 |

**Restore drill** (ข้อบังคับก่อน production และทุกไตรมาส): กู้ object ตัวอย่างของ `recordings` จาก backup ไป cluster ทดสอบ,
ตรวจ checksum และเล่นไฟล์ผ่าน presigned URL — บันทึกเวลาและผลใน issue

ข้อควรระวัง: การลบตาม retention ของแอปจะไม่ถูกส่งต่อไปยัง backup แบบ incremental — นโยบาย retention/PDPA ต้องครอบคลุม
backup ด้วย (ลบ backup ที่เก่ากว่า retention สูงสุดของ tenant)

## 7. Lifecycle

- production ตอนนี้ **ไม่ใช้ bucket lifecycle** — retention ของ `recordings` และ `governance-exports` ถูกบังคับที่แอป
  (รู้ tenant/นโยบาย และบันทึก audit) ถ้าในอนาคตเพิ่ม lifecycle ต้องมี lifecycle runner (ข้อ 2) ไม่อย่างนั้น rule ไม่ถูกบังคับ
- เฝ้า log ของ runner (`s3.lifecycle.run-shard`) ว่ารันครบทุกรอบ

## 8. การยืนยันก่อนเปิดใช้

1. `pnpm test:object-storage:contract` กับ endpoint จริง (root credential ใน environment ทดสอบ) — ต้องผ่าน 6/6
2. ทดสอบสิทธิ์ต่อแอปแบบเดียวกับ `scripts/object-storage-least-privilege.test.mjs`: แต่ละ identity ทำได้เฉพาะตารางข้อ 4,
   ตั้ง bucket policy/ACL ไม่ได้, อ่าน bucket อื่นไม่ได้, `ListBuckets` คืนรายการว่าง (ไม่มี `s3:ListBucket`), ไม่มี anonymous access
3. presigned URL ของ `api` เปิดจาก browser ภายนอกได้ และหมดอายุตามเวลา
4. SSE: object ใหม่ใน `recordings` ถูกเข้ารหัส (HeadObject มี `ServerSideEncryption`)
5. restore drill ผ่าน (ข้อ 6)
6. ปิด master/volume/filer/s3 ทีละตัวแล้วแอปยังอ่าน/เขียนได้ (ตาม replication ที่ตั้ง)

## 9. สิ่งที่ต้องยืนยันตอน deploy ครั้งแรก

สิ่งเหล่านี้มาจากเอกสารของ SeaweedFS ยังไม่ได้พิสูจน์ใน repo นี้ (spike #539 ทดสอบเฉพาะ server เดียว):

- config filer store แบบ PostgreSQL (`filer.toml`) และพฤติกรรมเมื่อมี filer 2 ตัว
- `security.toml`: mTLS ของ gRPC และ `jwt.signing` ทำงานร่วมกับ `weed s3` แยก process
- SSE-S3 ด้วย KEK + bucket default encryption บน 4.48 และผลต่อ presigned GET
- `weed filer.backup` แบบ incremental กับ sink ที่เลือก และเวลา restore จริง
- ค่า `volumeSizeLimitMB`/`-max` ที่เหมาะกับขนาดไฟล์เสียงจริง

ผลที่ได้ให้บันทึกกลับมาในเอกสารนี้ และถ้าจะทำ IaC (Helm/Terraform/Ansible) ให้เปิด issue แยก
