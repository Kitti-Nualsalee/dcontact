# CX Automation contracts

`@d-contact/cxa-contracts` ถือ DTO, identifiers, errors และ ports ข้าม domain โดยไม่มี database, framework หรือ transport dependency

## Contact Governance — E0.4 (#71)

- `ContactAuthorizationPort` เป็น boundary แคบของ Foundation และคง signature `authorizeAndReserve(tenantId, input)` เดิมไว้
- `ContactGovernanceService` implement เฉพาะ authorization port; public DTO/errors ที่ตำแหน่งเดิมเป็น re-export ของ package นี้ จึงรักษา `instanceof` และ API เดิม
- `ContactGovernancePort` เพิ่ม claim, provider acceptance, release ก่อน submit และ settlement โดย command ใหม่ระบุ tenant, correlation และ stable IDs
- `UNKNOWN_RECONCILING` เป็น delivery status; reservation states ยังคง `RESERVED`, `CONFIRMED`, `RELEASED`, `REFUNDED`
- Claim ต้องตรวจ tenant/action/contact/identity/channel/purpose/sender และ lease; binding เดิมคืนผลเดิม ส่วน canonical input ต่างต้อง conflict
- Timeout หลัง submit ต้องเข้าสู่ reconcile ก่อน recovery ห้ามปล่อย reservation ตาม TTL หรือสร้าง provider request key ใหม่เพื่อส่งซ้ำ
- Governance เป็นผู้ตัดสิน Attempt/Touch/refund จาก normalized fact; adapter ไม่ส่ง Boolean การนับเป็น authority

`src/testing/contact-governance-fake.ts` เป็น in-memory fixture สำหรับ conformance เท่านั้นและไม่ export จาก package entry point ใช้ seed ของ authorization decision, sender และ refund policy ที่ test กำหนดเพื่อแยกการพิสูจน์ lifecycle ออกจาก policy engine ไม่มี canonical Attempt/Touch, durable storage หรือ provider I/O

รัน `pnpm --filter @d-contact/cxa-contracts test` เพื่อพิสูจน์ duplicate/conflict, concurrent claim/outcome, tenant/binding swap, expiry, timeout และ out-of-order outcome ส่วน `pnpm --filter @d-contact/contact-governance test:integration` พิสูจน์ authorization/reservation เดิมกับ PostgreSQL/RLS

E0.4 ไม่ได้เปลี่ยน Journey composition; การใช้ ports และถอด concrete imports ใน Journey เป็น #65 ผลทดสอบ E0 ไม่ใช่หลักฐานว่า CG2 complete หรือเปิด provider traffic ได้
