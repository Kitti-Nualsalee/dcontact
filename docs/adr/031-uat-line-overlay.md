# ADR 031: เปิด LINE บน UAT ผ่าน overlay `uat-line` ที่เปิดปิดได้

- **สถานะ:** Accepted (ผู้ใช้ยืนยัน 2026-10-01; ยังต้องปิด gate ก่อนเริ่ม implement)
- **วันที่:** 2026-10-01
- **ที่มา:** #548 (S2 follow-up: LINE provider pilot จริง) — ผู้ใช้ต้องการให้ทีมทดสอบ LINE ทั้งรับและส่งร่วมกันบน UAT
  ด้วย LINE OA เดียวกัน; channel และผู้รับทั้งหมดอยู่ในการควบคุมของทีม ไม่มีลูกค้าใช้
- **ปรับ (amend):** U1.2 (#430) ที่ให้ profile `uat` ปิด LINE/Kafka/egress เชิงโครงสร้าง — ADR นี้ **ไม่แก้ profile `uat`**
  แต่เพิ่มทางเปิดแยกที่ต้องเลือกใส่เอง

## บริบท

- profile `uat` ห้ามมี `LINE_*`, `KAFKA_BROKERS`, `SIP_*` (`infra/uat/docker-compose.uat.yml`) และ readiness UAT-S09
  ล้มด้วย `CONFLICTS_WITH_UAT_PROFILE` ถ้ามี; runtime profile รายงาน `lineWebhook: DISABLED`, `providerEgress: BLOCKED`
- api อยู่บน network `internal: true` ไม่มีทางออก internet; ทางออกเดียวของ stack คือ `db-relay` ไป VM3 (ADR-030)
- S2 ถูกปิดแบบ candidate-only (#360 amendment 2026-09-29) — PR01/PR02/RB01 และ marker `OUTBOUND_DELIVERY_LINE_PILOT_READY`
  ย้ายมา #548 ซึ่งต้องมี environment ที่ส่ง LINE ได้จริง
- authority ของ rollout/kill/allowlist/credential คือ #358 (+ amendment 2026-10-01)

## การตัดสินใจ

1. **overlay `uat-line` ที่เปิดปิดได้** (#565): `infra/uat/docker-compose.uat.line.yml` ซ้อนบน
   `docker-compose.uat.yml` + `docker-compose.uat.3vm.yml` พร้อม runtime profile ใหม่ `uat-line`
   - ไม่ใส่ overlay = UAT แบบ fail-closed เดิมทุกประการ; UAT-S09 ยังคุ้มครอง profile `uat`
   - rollback = redeploy โดยไม่ใส่ overlay
   - ทางเลือกที่ไม่เลือก: เปิด LINE ใน profile `uat` หลักถาวร (ขัด #430 และทำให้ปัญหา LINE กระทบ UAT ส่วนอื่น);
     ใช้ protected environment แยก (ทีมไม่ได้ทดสอบร่วมกันบน UAT)

2. **ขาส่งออกผ่าน egress relay เท่านั้น**: api คงอยู่บน `internal: true`; เพิ่ม relay ที่ออกได้เฉพาะ `api.line.me:443`
   แบบเดียวกับ `db-relay` — ไม่มี container อื่นออก internet ได้ และ readiness ของ overlay ต้องตรวจ allowlist ปลายทาง

3. **ขารับเป็นงานแยก (#566) บน overlay เดียวกัน**: webhook เข้าทาง nginx edge (VM1) → Caddy → api เฉพาะ path ของ LINE,
   ตรวจ `x-line-signature` ด้วย channel secret; kill ของขารับคือปิด route ที่ edge แยกจาก kill ของขาส่ง

4. **credential เฉพาะ UAT**: revoke v3 (ที่เคยอยู่ใน Keychain ของเครื่อง dev) พร้อมออก v4 ใน LINE Console
   เก็บเป็น secret แบบ file mount บน VM2 — ห้ามอยู่ใน env ของ profile `uat`, ใน repo หรือใน log;
   RB01 ของ #548 revoke v4 แล้วออก v5 สำหรับช่วงทีมทดสอบ (#567)

5. **ลำดับ**: #565 → REG01 บน final-main SHA → PR01 → PR02 (exact one-shot) → RB01 (revoke v4) → marker (#548)
   → v5 + standing approval 30 วันสำหรับทีม (#567); ขารับ #566 deploy ได้ตั้งแต่ overlay พร้อม

6. **ที่ไม่เปลี่ยน**: `productionReleaseEnabled=false`, ห้ามเปิด production LINE outbound, consent enforcement ของ
   Contact Governance (ADR-027), allowlist/cap/kill ตาม #358, marker ออกได้เมื่อ 19/19 ตาม #360 เท่านั้น

## ผลที่ตามมา

**ข้อดี:** ทีมทดสอบรับ-ส่ง LINE จริงร่วมกันบน UAT; profile `uat` และ readiness เดิมไม่ถูกรื้อ; rollback ระดับ deployment ง่าย

**ข้อเสีย/ความเสี่ยง:**

- UAT มีทางออก internet เพิ่ม 1 ทาง (relay) และทางเข้าจาก internet 1 path (webhook) — ต้องคุมด้วย allowlist และ readiness
- overlay อาจค้างอยู่บน UAT นานกว่าที่ตั้งใจ — runtime profile ต้องรายงานสถานะ LINE ตามจริงเพื่อให้ตรวจเห็น
- VM1 เป็นทรัพยากรร่วม (ADR-030) — การเพิ่ม route webhook ต้องเป็นแบบ "เพิ่มเท่านั้น" และผ่าน `nginx -t`

## เงื่อนไขก่อนเริ่ม implement (gate)

| # | รายการ | สถานะ |
| - | ------ | ----- |
| 1 | VM2 ออก `api.line.me:443` ได้ในระดับเครือข่ายองค์กร (firewall/proxy) | ยังไม่ตรวจ |
| 2 | **LINE เรียก webhook เข้ามาได้**: ADR-030 ช่วง UAT ไม่ขอ DNS และ VM1 เป็น IP ใน LAN (`192.168.102.114`) — ขารับต้องมี hostname สาธารณะ + HTTPS cert ที่ LINE เข้าถึงได้ (เช่น DNS record + NAT/reverse proxy ขาเข้า) | ยังไม่ตัดสิน (blocker ของ #566 เท่านั้น ไม่ขวาง #548) |
| 3 | ผู้ใช้ revoke v3 และออก v4 ใน LINE Console | รอ (ทำเมื่อ #565 พร้อม deploy) |
| 4 | ที่เก็บ secret บน VM2 (path/สิทธิ์ไฟล์) | ตัดสินใน spec ของ #565 |
