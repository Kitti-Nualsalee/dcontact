# ADR 027: Contact Governance — ด่านกลางกำกับสิทธิการติดต่อระดับลูกค้า

- **สถานะ:** Accepted
- **วันที่:** 2026-08-30

## บริบท

D-Contact มี DNC/consent อยู่ใน outbound และมี contact policy อยู่ใน journey แล้ว แต่เมื่อ Agent,
Campaign, Journey, Survey และระบบภายนอกติดต่อลูกค้าคนเดียวกันพร้อมกัน การมีกติกาแยกตามโมดูลทำให้
ไม่มีใครตอบได้อย่างแน่นอนว่า **"ตอนนี้ติดต่อ CIF นี้ ผ่านช่องทางนี้ เพื่อเรื่องนี้ได้หรือไม่"**

ภาพแนวคิดเดิมเรียกส่วนนี้ว่า D-Block และประกอบด้วย Caller Allow, Whitelisting, Attempt และ Block list
ซึ่งเป็นองค์ประกอบที่ถูกต้อง แต่ชื่อ D-Block แคบเกินไป: ระบบไม่ได้มีหน้าที่แค่ห้าม แต่ต้องให้สิทธิ์แบบมีเงื่อนไข,
เลื่อนเวลา, จองโควตา, ขออนุมัติ และอธิบายเหตุผลย้อนหลังด้วย

## การตัดสินใจ

1. **ตั้งชื่อโมดูลว่า `Contact Governance` — ภาษาไทย “การกำกับสิทธิการติดต่อ”**

   - ชื่อบนเมนู: **Contact Governance**
   - service: `apps/contact-governance`
   - entitlement: `modules.contactGovernance.*`
   - ตารางของโมดูล: `cg_*`
   - ชื่อ D-Block ใช้ได้เฉพาะชื่อเดิมของ integration/diagram ระหว่างช่วงเปลี่ยนผ่าน

2. **หน่วยตัดสินหลักคือ Contact/CIF ไม่ใช่หมายเลขโทรศัพท์**

   การขอตัดสินต้องระบุ `contactId` (หรือ CIF ภายนอกที่ resolve แล้ว), identity, channel, purpose,
   contact kind, source และ action key การห้ามระดับ CIF ครอบคลุมทุก identity; การห้ามระดับ identity
   มีผลเฉพาะเบอร์/อีเมล/account นั้น

3. **Customer Segment & Team Scope เป็น authorization gate ที่แยกจาก PDPA policy**

   - Customer 360 นิยามและประเมิน customer segment เช่น `LOND`, `CARD` ผ่าน `sg_segment` และ
     `c360_segment_membership`
   - Administration/IAM เป็นเจ้าของ `team_segment_scope` ที่ map Team → segment พร้อมสิทธิ์
     `VIEW`, `WORK`, `CONTACT` และ effective period
   - ตัวอย่าง baseline: Team A และ Team C ใช้ `LOND`; Team D ใช้ `CARD`
   - Caller context ต้องมาจาก token หรือ trusted service context; หากทีมไม่มี `CONTACT` scope ให้ตอบ
     `403 TEAM_SEGMENT_NOT_ALLOWED` และบันทึก audit ก่อนเข้า Policy Engine
   - `TEAM_SEGMENT_NOT_ALLOWED` ไม่ใช่ `BLOCK` ของลูกค้า เพราะเป็นสิทธิ์ของผู้ปฏิบัติงาน ไม่ใช่ข้อจำกัด PDPA

4. **ผลตัดสินมาตรฐานมี 4 แบบ**

   - `ALLOW` — ติดต่อได้และได้ reservation
   - `BLOCK` — ห้ามติดต่อ
   - `DEFER` — ยังติดต่อไม่ได้ พร้อม `nextEligibleAt`
   - `REVIEW` — ต้องผ่าน maker-checker ก่อน

   ทุกผลต้องมี `reasonCode`, `policyVersion`, `decisionId` และ trace ของด่านที่ตรวจ

5. **ลำดับด่านเป็นมาตรฐานเดียวทั้งแพลตฟอร์ม**

   ```text
   resolve caller team scope → resolve CIF/identity
     → hard restriction: DNC / objection / revoked consent
     → purpose + lawful basis / consent
     → channel preference
     → module rule: retry / survey suppression / provider rule
     → quiet hours / holiday / timezone
     → attempt + successful-touch frequency cap
     → approved exception
     → authorize and reserve
   ```

   Hard restriction ห้ามถูกข้ามด้วย Allowlist ส่วน exception ใช้ยกเว้นได้เฉพาะกฎปฏิบัติการที่ policy
   ประกาศว่า override ได้ เช่น callback ที่ลูกค้าร้องขอหรือเพดานความถี่

   `Caller Allow` ในภาพเดิมถูกนิยามใหม่เป็น sender/caller-ID policy สำหรับตรวจ DID, Sender ID หรือ
   channel account ของฝั่งองค์กร แยกจาก Approved exception ของลูกค้าอย่างชัดเจน

6. **การตรวจและจองเป็นคำสั่งเดียว `authorizeAndReserve()`**

   ผู้ส่งทุกตัว (`apps/dialer`, `apps/channels` และ connector ภายนอก) ต้องได้ reservation ที่ยังมีผลก่อนส่ง
   เพื่อกัน race ระหว่างหลาย Campaign/Journey การจองมีอายุและต้อง confirm/release/refund ตามผลส่งจริง

7. **แยก Attempt ออกจาก Successful Touch**

   Attempt ใช้คุม retry และพฤติกรรมรบกวน เช่น โทรไม่รับ ส่วน Successful Touch ใช้คุมความถี่การสื่อสาร
   ที่ถึงลูกค้าจริง แต่ละ tenant ตั้งได้ว่าผลลัพธ์ใดนับเป็นสอง metric นี้

8. **Inbound ไม่ผ่าน Outbound DNC**

   ลูกค้าที่คัดค้านการตลาดยังต้องติดต่อองค์กรได้ การป้องกัน abusive caller เป็น `INBOUND_SAFETY`
   คนละ restriction type และใช้เพื่อ route/แจ้งเตือน/จำกัดความเสี่ยงตาม policy ไม่ปนกับ PDPA preference

9. **โมดูลนี้เป็นเจ้าของข้อมูลกำกับการติดต่อ**

   `ob_dnc`, `ob_consents` และ `cp_*` ในเอกสารเดิมถือเป็นชื่อ legacy ระหว่างเปลี่ยนผ่าน เป้าหมาย canonical
   คือ `cg_restriction`, `cg_consent`, `cg_preference`, `cg_exception`, `cg_policy`, `cg_reservation`,
   `cg_attempt`, `cg_sender_identity`, `cg_decision_log` และ `cg_audit_log` โดย Outbound/Journey/Survey
   เป็นผู้ใช้ ไม่ใช่เจ้าของกติกา ส่วน Customer 360 และ Administration/IAM ยังคงเป็นเจ้าของ segment membership
   และ team scope ตามลำดับ

## ผลที่ตามมา

- Outbound เลิกเป็นเจ้าของ DNC/consent และเรียก Contact Governance ก่อน originate/send
- Journey เลิกเป็นเจ้าของ `cp_*`; contact policy และ reservation ย้ายมาโมดูลนี้
- Customer 360 แสดงมุมมองสรุป แต่ไม่เป็นเจ้าของ policy engine
- Customer 360 เป็น source ของ segment membership; Administration/IAM เป็น source ของ team scope และทุก
  consumer ต้อง re-filter งานเมื่อ `customer.segment.changed` หรือ `team.segment-scope.changed`
- Integration ภายนอกใช้ API กลางเดียวกับโมดูลภายใน
- การแก้ hard restriction และ approved exception ต้องมี RBAC, maker-checker และ audit
- Promotional contact ใช้ fail-closed เมื่อ policy service ใช้งานไม่ได้

## ทางเลือกที่ไม่เอา

| ทางเลือก | เหตุผลที่ไม่เอา |
|---|---|
| ใช้ชื่อ D-Block เป็นชื่อโมดูล | สื่อเฉพาะการห้าม ไม่ครอบคลุม allow/defer/review, preference และ reservation |
| เก็บ DNC ไว้ใน Outbound | Non-voice, Journey และ connector จะมีกติกาคนละชุด |
| ใช้ Whitelist ข้ามทุก policy | เปิดทางให้ override การคัดค้านหรือ hard restriction โดยไม่มีขอบเขต |
| ตรวจแล้วค่อยส่ง | เกิด race และติดต่อเกินเพดานเมื่อหลายระบบทำงานพร้อมกัน |
| Block inbound ตาม outbound DNC | ลูกค้าที่ไม่รับการตลาดจะติดต่อขอรับบริการไม่ได้ |

## เอกสารเกี่ยวข้อง

[contact-governance.md](../contact-governance.md) · [contact-governance-data-flow.md](../contact-governance-data-flow.md) · [ADR-011](011-outbound-campaign.md) ·
[ADR-020](020-customer-360.md) · [ADR-025](025-journey-orchestration.md)
