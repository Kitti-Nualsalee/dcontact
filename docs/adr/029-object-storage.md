# ADR 029: Object storage — S3 API เป็น contract, dev ใช้ RustFS, on-prem และ cloud ใช้ SeaweedFS

- **สถานะ:** Accepted
- **วันที่:** 2026-09-29
- **ที่มา:** ผู้ใช้ตัดสิน 2026-09-29 (ต่อจาก [#467](https://github.com/Kitti-Nualsalee/dcontact/issues/467)
  ที่แก้ชั่วคราวด้วย `pgsty/minio` fork)

## บริบท

ระบบเก็บไฟล์ใน object storage หลายที่: ไฟล์เสียง (`recordings`, telephony archive และ playback ของ API),
media ของ QM, compliance export ของ Contact Governance (`governance-exports`,
[ADR-027](027-contact-governance.md)) และหลักฐาน UAT (`uat-evidence`) ทั้งหมดเรียกผ่าน
`@aws-sdk/client-s3` ใช้ `PutObject`, `GetObject`, `DeleteObject`, presigned GET, path-style และในส่วน UAT
ใช้ `CreateBucket`, `PutBucketLifecycleConfiguration` และ `GetBucketPolicy` เพิ่ม

ปัญหาคือ MinIO community edition ไม่ได้รับการดูแลแล้ว (ตัด console, หยุดออก binary และ image,
repo เข้า maintenance mode) image ทางการ pull ไม่ได้ตั้งแต่ 2026-09-24 (#467) ตอนนี้เราพึ่ง fork ที่มี
maintainer ภายนอกรายเดียว และ license ของ MinIO เป็น AGPL

ในโค้ดยังผูกกับชื่อ MinIO แม้ไม่ได้ใช้ API เฉพาะของ MinIO:

- ชื่อ env ปนกัน: `S3_*` (`.env.example`, telephony) กับ `MINIO_*` (api, contact-governance, qm, UAT)
  และ default credential ไม่ตรงกัน (`minioadmin` ใน api/governance กับ `dcontact` ใน dev compose)
- ชื่อ bucket env ปนกัน: `S3_BUCKET_RECORDINGS` กับ `RECORDINGS_BUCKET`
- ชื่อ adapter `Minio*`, healthcheck `/minio/health/live` และการสร้าง bucket/user ด้วย `mc`

## การตัดสินใจ

1. **S3 API คือ contract เดียวระหว่างแอปกับ storage** แอปต้องเรียกผ่าน `@aws-sdk/client-s3` เท่านั้น
   ห้ามพึ่ง admin API หรือ endpoint เฉพาะของผู้ผลิต ชุด S3 API ที่อนุญาตคือชุดที่ใช้อยู่ในส่วนบริบท
   การเพิ่ม API ใหม่ (เช่น Object Lock) ต้องพิสูจน์ว่าทำงานได้ทั้งบน RustFS และ SeaweedFS ก่อน

2. **config เป็นกลางต่อผู้ผลิต** ใช้ชื่อ env ชุดเดียวทุกแอป:

   | env | ความหมาย |
   |---|---|
   | `S3_ENDPOINT` | URL ของ S3 endpoint |
   | `S3_REGION` | region (default `us-east-1`) |
   | `S3_ACCESS_KEY` / `S3_SECRET_KEY` | credential ของแอป ไม่ใช่ root |
   | `S3_FORCE_PATH_STYLE` | default `true` |
   | `S3_BUCKET_<ชื่อ>` | ชื่อ bucket เช่น `S3_BUCKET_RECORDINGS`, `S3_BUCKET_GOVERNANCE_EXPORTS`, `S3_BUCKET_UAT_EVIDENCE` |

   ระหว่างเปลี่ยนผ่านยังอ่าน `MINIO_*` และชื่อ bucket env เดิมเป็น fallback ได้ และต้อง log เตือนว่า
   deprecated ส่วน adapter เปลี่ยนชื่อเป็น `S3*` (เช่น `S3RecordingStorage`)

3. **แต่ละ environment ใช้ storage ต่างกัน**

   | environment | storage | เหตุผล |
   |---|---|---|
   | dev และ acceptance ที่สั่งด้วยมือ | **RustFS** (Apache 2.0) | เบา, บูตเร็ว, มี console ช่วย debug และรองรับ lifecycle/IAM ครบตามที่ UAT stack ต้องใช้ |
   | UAT, on-prem และ cloud (self-host) | **SeaweedFS** (Apache 2.0) | โปรเจกต์อยู่มานานและรับไฟล์เล็กจำนวนมากอย่างไฟล์เสียงได้ดี รองรับ presigned URL, lifecycle expiration, bucket policy, IAM API, Object Lock และ SSE |

   **ข้อยกเว้นสำหรับ K8s UAT ใหม่ (#625/#628, 2026-10-06):** environment `dcontact-uat` บน cluster
   `dcontact` แยกจาก UAT 3 VM โดยเริ่มฐานข้อมูลและ object storage ใหม่ ใช้ RustFS แบบ standalone
   บน PVC เพื่อทดสอบข้อมูลสังเคราะห์ปริมาณน้อยตามคำตัดสินของ owner. UAT 3 VM เดิมยังใช้ SeaweedFS.
   ก่อนเปิดให้ผู้ทดสอบ ต้องพิสูจน์ S3 contract, IAM ที่แยก API จาก root, bucket private และการลบตาม
   lifecycle 90 วันบน image digest ที่ deploy จริง; หากข้อใดไม่ผ่านให้หยุด rollout และทบทวน storage choice.

   ตรึง image ด้วย release tag และ digest ห้ามใช้ `latest`

4. **bootstrap ต้องไม่ผูกกับ CLI ของผู้ผลิต** การสร้าง bucket, private policy และ lifecycle ใน dev/acceptance
   ใช้ client ที่เป็น S3 มาตรฐาน (AWS CLI หรือสคริปต์ที่ใช้ `@aws-sdk/client-s3`) ส่วนการสร้างผู้ใช้และ
   policy ของแอป (least privilege) เป็นงานของ environment นั้น ๆ ทำผ่าน IAM API ของ storage
   ที่ environment นั้นใช้

5. **แอปไม่รู้ว่าข้างหลังเป็นผู้ผลิตใด** readiness และ healthcheck ของแอปตรวจด้วย S3 API
   (`HeadBucket`) ส่วน healthcheck ของ container ใช้ endpoint ของผู้ผลิตแต่ละรายได้

## ผลที่ตามมา

- การเปลี่ยน storage ในอนาคตเป็นงานของ infra และ config เท่านั้น ไม่ต้องแก้โค้ดแอป
- dev กับ production ใช้คนละตัว ความต่างของพฤติกรรม S3 จึงต้องจับด้วย contract test ชุดเดียวกันที่รันได้ทั้ง
  RustFS และ SeaweedFS (put/get/delete, presigned GET, lifecycle, bucket ต้องเป็น private)
- ต้องย้ายข้อมูลใน UAT และ deployment ที่มีอยู่จาก MinIO ไป SeaweedFS (ทำในงานแยก)
- เอกสารที่เขียนว่า "MinIO/S3" ให้เปลี่ยนเป็น "object storage (S3)" เมื่อแก้ส่วนนั้น

## ทางเลือกที่ไม่เลือก

- **ใช้ `pgsty/minio` fork ต่อ**: พึ่ง maintainer รายเดียวและยังเป็น AGPL
- **RustFS ทุก environment**: โปรเจกต์ยังใหม่ ยังไม่มีหลักฐานว่ารันกับข้อมูลที่ต้องเก็บตาม compliance
  ได้นานและในสเกลใหญ่ ทบทวนได้เมื่อมีหลักฐานนั้นแล้ว
- **SeaweedFS ใน dev ด้วย**: ใช้ได้ แต่ตั้งค่าหนักกว่าสำหรับเครื่องนักพัฒนา และ contract test ข้อ "ผลที่ตามมา"
  ครอบคลุมความต่างอยู่แล้ว
- **Garage**: AGPL และฟีเจอร์ S3 บางตัวที่เราใช้ยังไม่ครบ
- **Ceph RGW**: หนักเกินขนาดทีมและระบบตอนนี้
- **Managed cloud storage**: ผู้ใช้เลือก self-host
