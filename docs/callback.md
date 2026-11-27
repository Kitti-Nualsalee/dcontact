# นัดโทรกลับรอบแรก (#1061)

Agent นัดโทรกลับลูกค้าจากงานที่ถืออยู่ → ถึงเวลานัด Workspace เตือนและแสดงในรายการ "นัดโทรกลับ" → Agent กดโทร → Contact Governance ตรวจก่อนโทร → D-Phone ของ Agent ดังและ Workspace รับให้เอง → ระบบโทรต่อไปที่เบอร์ลูกค้าแล้วต่อสาย → วางสายแล้วบันทึกผล/โน้ตแบบเดียวกับสายขาเข้า → ดูได้ในประวัติของฉันและของทีม

ขอบเขตที่ owner ตัดสินเมื่อ 28 พฤศจิกายน 2569 (ตอบ "ก ทุกข้อ") อยู่ใน [#1061](https://github.com/Kitti-Nualsalee/dcontact/issues/1061)
ทำตาม [ADR-001](adr/001-unified-interaction-model.md) (สายโทรกลับเป็น Interaction `VOICE`/`OUTBOUND`), [ADR-011](adr/011-outbound-campaign.md) (Dialer เป็นเจ้าของ `ob_callbacks`) และ [ADR-027](adr/027-contact-governance.md) (Contact Governance ตัดสินก่อนติดต่อ)

## กติกา

| เรื่อง | กติกา |
| --- | --- |
| นัดจากงานไหน | งานที่ Agent ถืออยู่ (กำลังคุยหรือบันทึกผล) ทุกช่องทาง ที่ผูกลูกค้า Customer 360 แล้ว |
| เบอร์ที่โทร | เบอร์ PHONE ของลูกค้าที่เป็นเบอร์ภายใน `1xxx` เท่านั้น เบอร์อื่นแสดงแต่เลือกไม่ได้ (ยังไม่มีเส้นทาง PSTN) |
| เวลานัด | อย่างน้อย 1 นาทีจากตอนนี้ ไม่เกิน 30 วัน นัดที่ยังไม่โทรหมดอายุ 24 ชั่วโมงหลังเวลานัด |
| ลูกค้าหนึ่งคน | มีนัดที่ยังไม่โทรได้ครั้งละหนึ่งนัด |
| ใครโทร | Agent ที่นัด ถ้าเลยเวลานัด 15 นาทีแล้ว Agent ยังไม่ออนไลน์ นัดย้ายไปเป็นของทีม Agent ในทีมคนใดก็โทรได้ |
| คิว | คิวเสียงแบบ managed ของงานต้นทาง ถ้างานต้นทางไม่ใช่คิวนั้น (เช่นแชท) ใช้คิวเสียง managed แรกของทีม ไม่มีคิวเสียงของทีม = นัดไม่ได้ |
| Governance ตอนนัด | ตรวจ DNC/consent ด้วย `authorizeAndReserve` (purpose `SERVICE`, channel `VOICE`) แล้วคืน reservation ทันที BLOCK/REVIEW = นัดไม่ได้ ส่วน DEFER (ตอนนี้อยู่นอกเวลาที่โทรได้) ยังนัดได้ เพราะเวลาโทรจริงตรวจอีกครั้ง |
| Governance ก่อนโทร | ตรวจอีกครั้งตอนกดโทร ALLOW = โทรและ CONFIRM reservation; DEFER = เลื่อนนัดไปเวลาที่ Governance บอกให้เอง; BLOCK = ยกเลิกนัด; REVIEW = ยังไม่โทร นัดคงอยู่ |
| ก่อนโทร Agent ต้อง | Ready, ไม่มีงานอื่นค้าง (รวมแชท), มี Work Session ของ Workspace และบัญชี SIP ที่ใช้ได้ |

## สถานะของนัด

`SCHEDULED` → กดโทร → `ORIGINATING` (มีสายแล้ว) → Agent รับสาย D-Phone → `CONSUMED`

- Agent ไม่รับ D-Phone ภายใน 20 วินาที หรือโทรออกไม่สำเร็จ: กลับเป็น `SCHEDULED` ให้กดโทรใหม่ได้
- ยกเลิกโดย Agent, Governance BLOCK หรือหมดอายุ: `CANCELLED` พร้อมเหตุผล
- เลื่อนนัดได้เฉพาะตอน `SCHEDULED` ทุกคำสั่งมี `commandId` และ `expectedVersion`
- ลูกค้าไม่รับสายหลัง Agent รับ D-Phone แล้วถือว่าโทรแล้ว (`CONSUMED`) Agent บันทึกผล เช่น "ติดต่อไม่ได้" แล้วนัดใหม่จากงานนั้นได้

ทุกการเปลี่ยนแปลงลง `ob_callback_events` (ไม่มีเบอร์โทรหรือโน้ตใน event)

## สายโทรกลับ

ใช้กลไกสาย managed เดิม (`voice_managed_calls`/`offers`/`commands`) โดยกลับลำดับขา:

1. กดโทร: API สร้าง Interaction `VOICE`/`OUTBOUND` สถานะ `ASSIGNED` ให้ Agent พร้อม offer และคำสั่ง `callback.originate` ใน transaction เดียวกับการเปลี่ยนนัดเป็น `ORIGINATING`
2. telephony สั่ง `originate {ตัวแปรของ offer}user/<เบอร์ Agent> &bridge({ตัวแปรของสาย}user/<เบอร์ลูกค้า>)` ขาของ Agent คือขา offer (`blegUuid`) ขาลูกค้าคือ `callUuid` ที่สร้างไว้ก่อน
3. Workspace เห็นงานใน snapshot และรับ D-Phone ให้เอง (Agent กดโทรเองแล้ว) → `call.answered` → Interaction `ACTIVE` บันทึก attribution ของทีม และ Agent เป็น BUSY
4. FreeSWITCH โทรเบอร์ลูกค้าและต่อสายเมื่อรับ วางสายฝั่งใดก็ได้ → `WRAPUP` → บันทึกผลแบบ `VOICE_NOTE_V1`

offer ของสายโทรกลับไม่ย้ายไป Agent คนอื่น หมดเวลาแล้วสายจบเป็น `ABANDONED` และนัดกลับเป็น `SCHEDULED`

## เปิดใช้

ตั้ง `AGENT_CALLBACKS=on` ที่ API (ค่าเริ่มต้นปิด) และ apply migration ของ #1061 ปิดอยู่ route และเมนูไม่มี งานเบื้องหลังไม่รัน
