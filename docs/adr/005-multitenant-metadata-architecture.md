# ADR 005: Multi-tenant แบบ Salesforce — shared database + metadata-driven

- **สถานะ:** Accepted
- **วันที่:** 2026-07-15

## บริบท

D-Contact เป็น SaaS ที่ tenant แต่ละรายต้อง "รู้สึกเหมือนมีระบบของตัวเอง" — คิว, ทักษะ, Flow,
เวลาทำการ, ช่องทาง, บทบาทผู้ใช้ ต่างกันหมด — แต่เราต้อง deploy และดูแล runtime **ชุดเดียว**
ต้องเลือกว่าจะ isolate tenant ที่ชั้นไหน: database ต่อ tenant, schema ต่อ tenant,
หรือ shared schema แล้วแยกด้วยข้อมูล

เราใช้สถาปัตยกรรมของ Salesforce Platform เป็นต้นแบบ: **multitenant, metadata-driven** —
ทุก tenant ใช้ database และ runtime (kernel) ร่วมกัน สิ่งที่ทำให้แต่ละ tenant ต่างกันคือ
*metadata* ที่ kernel อ่านตอน runtime ไม่ใช่ schema หรือโค้ดที่แยกกัน

## การตัดสินใจ

1. **Shared physical database + shared schema** — ทุกตารางมี `tenant_id` + RLS
   (`packages/db/prisma/rls.sql`) เป็น "virtual tenant-specific schema": แอปเห็นเสมือน
   มี schema ของ tenant ตัวเอง ทั้งที่จริงคือ shared table ที่ถูกกรองด้วย
   `current_setting('app.tenant_id')` — ยืนยันแนวที่ทำใน Phase 0 เป็นทางการ
2. **พฤติกรรมต่อ tenant มาจาก tenant metadata เท่านั้น** — kernel (api/router/channels)
   เป็นโค้ดชุดเดียว ไม่มี branch/deploy ต่อ tenant; การ "customize" คือ insert/update
   แถว metadata (queues, skills, routing rules, business hours, Flows, channel accounts, roles)
3. **แยกประเภทข้อมูลชัดเจน** — *tenant metadata* (configuration ที่เปลี่ยนพฤติกรรมระบบ) vs
   *tenant data* (ผลจากการใช้งาน: interactions, messages, recordings) — catalog อยู่ใน
   [`docs/multi-tenancy.md`](../multi-tenancy.md)
4. **Runtime materialization = tenant config cache** — kernel โหลด metadata ของ tenant
   เข้า Redis cache ครั้งแรกที่มี traffic และ invalidate ผ่าน Kafka event เมื่อ metadata
   เปลี่ยน — เลี่ยงการอ่าน config จาก Postgres ทุก request/ทุก routing decision
5. **Custom fields (เฟสอนาคต) ทำแบบ Salesforce ไม่ใช่ ALTER TABLE** — ตาราง
   `field_definitions` (metadata) + คอลัมน์ JSONB `custom_fields` บน contacts/interactions;
   schema จริงไม่เปลี่ยนตาม tenant
6. **Tenant onboarding = insert ข้อมูล ไม่ใช่ provision infrastructure** — สร้างแถว tenant +
   Keycloak Organization (ADR-004) + metadata เริ่มต้น จบ

ทางเลือกที่ปัดตก:

- **Database ต่อ tenant** — migration ×N, connection pool ×N, backup/restore ×N,
  cross-tenant analytics ทำยาก; เหมาะกับลูกค้า on-prem ไม่ใช่ SaaS ที่ tenant หลักร้อย
- **Schema ต่อ tenant** — ลดปัญหา pool แต่ migration ยัง ×N และ Prisma ไม่รองรับ
  dynamic schema ต่อ request ได้ดี
- **Fork/branch โค้ดต่อ tenant** — ตายตั้งแต่ tenant ที่สอง

## ผลที่ตามมา

- (+) upgrade/migrate **ครั้งเดียวมีผลทุก tenant** — หัวใจของต้นทุน SaaS ที่ต่ำ
- (+) onboarding เป็นวินาที (insert rows) ไม่ใช่ชั่วโมง (provision infra)
- (+) cross-tenant reporting/billing ทำได้ตรง ๆ (query เดียว group by tenant_id)
- (−) **blast radius สูง**: bug การ scoping = ข้อมูลรั่วข้าม tenant → ต้องมี 4 ชั้นป้องกันเสมอ
  (token claim → guard → service-layer `where tenantId` → RLS) และ integration test
  cross-tenant ใน CI (ดู iam-architecture §11)
- (−) **noisy neighbor**: tenant ใหญ่กิน resource กระทบ tenant เล็ก → rate limit ต่อ tenant
  ที่ API, Kafka partition by key ช่วยกระจายอยู่แล้ว, อนาคต: table partitioning by
  `tenant_id` + read replica
- (−) ต้องมีวินัยเรื่อง cache invalidation ของ tenant config (stale config = routing ผิด)
- Escape hatch: ลูกค้า enterprise ที่เรียกร้อง isolation ระดับ infra ตามสัญญา →
  dedicated instance (deploy stack แยกทั้งชุด) — สถาปัตยกรรมนี้ไม่ปิดทางนั้น
