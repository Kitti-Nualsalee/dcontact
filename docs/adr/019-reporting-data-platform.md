# ADR 019: Reporting & Data Platform — รายงานสร้างจาก semantic layer เดียว และข้อมูลก้อนใหญ่ออกทาง feed ไม่ใช่ทาง API

- **สถานะ:** Accepted
- **วันที่:** 2026-08-08

## บริบท

`mockups/reports.html` มีรายงานสำเร็จรูป 3 ใบ ซึ่งพอสำหรับสาธิตแต่ไม่พอสำหรับขาย —
ทุก RFP ถามสามข้อเดียวกัน: สร้างรายงานเองได้ไหม, ส่งเข้าอีเมล/SFTP ตามเวลาได้ไหม,
ต่อ Power BI/Tableau ได้ไหม

## การตัดสินใจ

1. **มี semantic layer ชั้นเดียว — รายงานสำเร็จรูป, report builder, และ data feed ใช้ตัวเดียวกัน**
   นิยาม "AHT", "สายที่ตอบใน SLA", "ผู้ติดต่อไม่ซ้ำ" อยู่ที่เดียวเป็น metric definition
   ถ้ารายงานสำเร็จรูปคำนวณเองด้วย SQL มือ วันหนึ่งตัวเลขสองใบจะไม่ตรงกันและเราจะแก้ไม่จบ
   (หลักการเดียวกับ metric registry ของ [ADR-018](018-performance-gamification.md) — ใช้ registry เดียวกันจริง ๆ)

2. **Report builder จำกัดอยู่ที่ dimension × metric × filter — ไม่ใช่ SQL อิสระ**
   ผู้ใช้เลือกจากรายการที่มี ไม่ได้เขียน query เอง
   เหตุผล: SQL อิสระบน DB ที่ใช้รับสายอยู่ = วันหนึ่งจะมีคนรัน query ที่ทำระบบช้าทั้ง tenant
   และ RLS ต่อ tenant ([multi-tenancy §7](../multi-tenancy.md)) ตรวจสอบได้ยากขึ้นมาก

3. **ข้อมูลก้อนใหญ่ออกทาง data feed ไม่ใช่ REST**
   ส่งไฟล์ (Parquet/CSV) ขึ้น S3/SFTP ของลูกค้าตามรอบ + manifest ที่บอกช่วงเวลาและจำนวนแถว
   REST เหมาะกับ "ขอข้อมูลของสายนี้" ไม่ใช่ "ขอ 40 ล้านแถวของเดือนที่แล้ว"

4. **รายงานทั้งหมดอ่านจาก read replica / ตารางสรุป ไม่แตะ primary**
   งานรายงานต้องไม่มีทางทำให้การรับสายช้าลง — เป็นข้อเดียวกับที่ทำให้ webhook
   เป็น consumer แยกใน [ADR-015](015-integration-platform.md)

5. **Scheduled delivery ต้องมีเจ้าของและวันหมดอายุ**
   รายงานอัตโนมัติที่ส่งไปหาคนที่ลาออกไปแล้วสามปีคือรูรั่วข้อมูลที่พบบ่อยที่สุดในองค์กรใหญ่
   ทุก schedule มี owner + `expiresAt` + ต่ออายุได้ (วินัยเดียวกับ entitlement override ใน
   [ADR-009](009-plan-entitlement-licensing.md))

6. **Realtime กับ historical เป็นคนละเส้นทางและห้ามปนกัน**
   realtime (wallboard/supervisor) มาจาก Redis/WS; historical มาจากตารางสรุป
   การพยายามให้เส้นเดียวตอบทั้งสองแบบทำให้ได้ของที่ทั้งช้าและไม่สด

7. **ไม่มี data warehouse ของเราเองใน v1** — ตารางสรุปใน Postgres + feed ออกไปคลังของลูกค้า
   ([ADR-017](017-interaction-analytics.md) ข้อ 5)

## ผลที่ตามมา

- ตารางสรุป `rp_*` (รายชั่วโมง/รายวัน) สร้างโดย worker กลางคืน + rollup แบบ incremental
- entitlement: `modules.reporting.{enabled, builder, scheduled, dataFeed, retentionMonths}`
- `apps/api` ได้ endpoint `/api/v1/reports/{key}/data` ที่ใช้ semantic layer เดียวกัน
- ต้นทุนพื้นที่เก็บ historical เข้า quota `storageGb` ที่มีอยู่แล้ว

## ทางเลือกที่ไม่เอา

| ทางเลือก | เหตุผลที่ไม่เอา |
|---|---|
| เปิด SQL/JDBC ให้ลูกค้าเข้ามาเอง | ระบบช้าทั้ง tenant + isolation ตรวจสอบไม่ได้ |
| ให้แต่ละรายงานเขียน query ของตัวเอง | ตัวเลขไม่ตรงกันระหว่างรายงาน |
| ตั้ง warehouse (ClickHouse/BigQuery) ตั้งแต่ v1 | โครงสร้างพื้นฐานเพิ่มก่อนรู้ความต้องการจริง |
| ส่งข้อมูลก้อนใหญ่ผ่าน REST paging | ทั้งช้าและทำให้ระบบหลักโดนถล่ม |

## เอกสารเกี่ยวข้อง

[reporting-data-platform.md](../reporting-data-platform.md)
