# D-Contact — Tier 3 Roadmap (แผน ยังไม่ออกแบบละเอียด)

> เอกสารนี้คือ **แผน** ไม่ใช่สเปก — ตั้งใจให้ระดับรายละเอียดต่ำกว่าเอกสารโมดูล Tier 1/2
> เพราะสิ่งเหล่านี้จะถูกออกแบบจริงเมื่อมีลูกค้าที่ต้องการ ไม่ใช่ตอนนี้
>
> สิ่งที่ต้องทำ **ตอนนี้** สำหรับทุกข้อในนี้คือ "อย่าปิดประตู" — ตัดสินใจวันนี้อย่างไร
> ไม่ให้ต้องรื้อของเดิมในวันที่ทำจริง แต่ละหัวข้อจึงมีช่อง **"ต้องเผื่ออะไรไว้ตั้งแต่ตอนนี้"**
> ซึ่งเป็นส่วนเดียวที่ผูกพันกับงานปัจจุบัน

> **อัปเดต 2026-08-10:** ตำแหน่งผลิตภัณฑ์เปลี่ยนเป็น **CCaaS + CX automation**
> → [Journey orchestration](journey-orchestration.md) ([ADR-025](adr/025-journey-orchestration.md))
> ถูกยกขึ้นมาเป็นงานหลักก่อนทุกข้อในหน้านี้ เพราะเป็นสิ่งที่ทำให้คำว่า CXA มีของจริงรองรับ

## สรุปลำดับความสำคัญ

| # | เรื่อง | ทำเมื่อ | ต้นทุนถ้าเลื่อน |
|---|---|---|---|
| T1 | Compliance & Data governance | ลูกค้าองค์กร/ธนาคารรายแรก | **สูงมาก** — ย้อนแก้ข้อมูลที่เก็บไปแล้วไม่ได้ |
| T2 | Sandbox & config promotion | มี tenant ที่มีทีม IT ของตัวเอง | ปานกลาง |
| T3 | Business continuity & DR | ก่อนเซ็น SLA 99.9% ฉบับแรก | สูง |
| T4 | Video / co-browse / screen share | เมื่อแข่งกับ Zoom ตรง ๆ | ต่ำ |
| T5 | Voice biometrics & fraud | ธนาคาร/ประกัน | ต่ำ (ใช้พาร์ตเนอร์) |
| T6 | White-label & reseller | ขายผ่าน SI มากกว่า 3 ราย | ปานกลาง |
| T7 | Screen recording | ลูกค้า BPO | ปานกลาง |
| T8 | Marketplace พาร์ตเนอร์ | หลัง I5 | ต่ำ |

---

## T1 — Compliance & Data Governance

ของที่มีแล้ว: PCI pause/resume, retention 3 ชั้น, legal hold, access log
([quality-management §4, §11](quality-management.md)), RLS 5 ชั้น ([multi-tenancy §7](multi-tenancy.md))

ของที่ยังขาด:

| หัวข้อ | สาระ |
|---|---|
| **PII redaction ใน transcript** | ปกปิดเลขบัตร/บัญชี/เบอร์ในข้อความ ไม่ใช่แค่หยุดอัดเสียง |
| **DSAR แบบครบวงจร** | ขอดู/แก้/ลบ ครอบทุกโมดูล — โครงอยู่ใน [customer-360 §6](customer-360.md) |
| **Data residency** | บังคับให้ข้อมูลของ tenant อยู่ในภูมิภาคที่กำหนด (ไทย/สิงคโปร์/EU) |
| **BYOK / customer-managed key** | ลูกค้าถือคีย์เข้ารหัสของตัวเอง เพิกถอนได้ |
| **Contact Governance ขั้นสูง** | ต่อยอดทะเบียน `cg_consent` กลางด้วย policy simulation, anomaly alert และ compliance export |
| **มาตรฐาน** | ISO 27001 / SOC 2 / PCI DSS SAQ-D — เป็นงานกระบวนการมากกว่างานโค้ด |

**ต้องเผื่ออะไรไว้ตั้งแต่ตอนนี้**
- ทุกตารางที่เก็บข้อมูลส่วนบุคคลต้องมี `contact_id` หรือ `tenant_id` ที่ตามรอยได้ —
  ตารางที่เก็บ PII แบบลอย ๆ จะทำ DSAR ไม่ได้ตลอดกาล
- คอลัมน์ที่เข้ารหัสต้องมี `key_version` ตั้งแต่แถวแรก ([integration-platform §7](integration-platform.md)
  ทำแล้วกับ `int_credential`) — เพิ่มทีหลังแปลว่าต้อง re-encrypt ทั้งฐาน
- object storage แยก bucket ต่อ tenant (ไม่ใช่ prefix) เพื่อให้ทำ residency/BYOK ได้ทีหลัง

---

## T2 — Sandbox & Config Promotion

ปัญหา: ลูกค้าองค์กรไม่กล้าแก้ flow/scorecard/queue บนระบบที่รับสายจริงอยู่

| ส่วน | สาระ |
|---|---|
| **Sandbox tenant** | tenant คู่แฝดที่ใช้ metadata ชุดเดียวกันแต่ข้อมูลจริงแยก |
| **Config bundle** | รวม flow + queue + form + scorecard + category เป็นก้อนที่มีเวอร์ชัน |
| **Promote** | dev → uat → prod พร้อม diff ให้ดูก่อนกด และ rollback ได้ |
| **Config as code** | ส่งออก/นำเข้าเป็น JSON เพื่อเก็บใน Git ของลูกค้า |

**เราได้เปรียบตรงนี้** เพราะ [ADR-005](adr/005-multitenant-metadata-architecture.md) ทำให้
config เป็น *ข้อมูล* อยู่แล้ว — คู่แข่งที่ config เป็น schema ทำเรื่องนี้ได้ยากกว่ามาก

**ต้องเผื่อไว้ตั้งแต่ตอนนี้**
- ทุก entity ที่เป็น metadata ต้องมี **id ที่ไม่ผูกกับ tenant** (เช่น `key` ที่ผู้ใช้ตั้ง)
  ไม่งั้น promote ข้าม tenant แล้ว reference ภายในจะพัง
- ห้ามฝัง id ของ tenant หนึ่งลงใน config ของอีก entity แบบตายตัว — อ้างด้วย key เสมอ

---

## T3 — Business Continuity & DR

| หัวข้อ | เป้า (ตั้งต้น) |
|---|---|
| RPO / RTO | RPO ≤ 5 นาที · RTO ≤ 60 นาที |
| Multi-AZ | Postgres + Kafka + MinIO ข้าม AZ |
| Degraded mode | **การรับสายต้องทำงานต่อได้แม้ QM/WFM/analytics ล่ม** — หลักการเดียวกับที่ [ADR-009](adr/009-plan-entitlement-licensing.md) บอกว่าใบอนุญาตหมดอายุห้ามกระทบการรับสาย |
| Status page | หน้าสถานะสาธารณะ + ประวัติเหตุขัดข้อง |
| Runbook | ซ้อมกู้คืนอย่างน้อยปีละ 2 ครั้ง และบันทึกผล |

**ต้องเผื่อไว้ตั้งแต่ตอนนี้**
- ทุก service ใหม่ต้องประกาศว่าตัวเองเป็น **critical path หรือไม่** และ service ที่ไม่ใช่
  ต้องล้มได้โดยไม่ทำให้ kernel ล้ม (ตอนนี้ QM/WFM/webhook/dialer worker ทำถูกแล้ว)

---

## T4 — Video / Co-browse / Screen share

จุดขายหลักของ Zoom — และเรามี WebRTC อยู่แล้วจาก SIP.js จึงไม่ไกลเกินเอื้อม

| ส่วน | สาระ |
|---|---|
| Video escalation | ยกระดับจากแชท/เสียง → วิดีโอในหน้าเดิม เป็น interaction เดียวกัน |
| Co-browse | ดูหน้าจอเว็บลูกค้าแบบ DOM sync (ไม่ใช่ภาพ) + ปิดบังฟิลด์อ่อนไหวโดยค่าเริ่มต้น |
| Screen share | ลูกค้าแชร์หน้าจอให้ agent |
| การอัด | ต้องเข้า retention/consent ชุดเดียวกับเสียง |

**ต้องเผื่อไว้ตั้งแต่ตอนนี้**: `interactions.channel` ต้องรองรับค่าใหม่ได้โดยไม่ต้องแก้ enum
ในหลายที่ — ตรวจว่าโค้ดที่ switch บน channel มีทางออก default ทุกจุด

---

## T5 — Voice Biometrics & Fraud

ใช้พาร์ตเนอร์ (Nuance/Phonexia/ผู้ให้บริการในภูมิภาค) **ไม่ทำเอง**

- ยืนยันตัวตนด้วยเสียงระหว่างคุย → ยกระดับ identity เป็น CONFIRMED
  ([customer-360 §3](customer-360.md))
- ตรวจจับเสียงที่อยู่ในบัญชีดำการฉ้อโกง
- ต้องขอความยินยอมก่อนเก็บ voiceprint เสมอ (เป็นข้อมูลชีวมิติตาม PDPA)

**ต้องเผื่อไว้**: media fork ที่จะทำใน [agent-assist A4](agent-assist.md) ใช้เส้นเดียวกันได้ —
ออกแบบ fork ให้มีผู้บริโภคได้หลายราย ไม่ใช่ผูกกับ ASR ตัวเดียว

---

## T6 — White-label & Reseller

ตลาดไทยขายผ่าน SI เป็นหลัก — เรื่องนี้อาจสำคัญกว่าฟีเจอร์หลายตัวรวมกัน

| ส่วน | สาระ |
|---|---|
| Branding ต่อ tenant | โลโก้ สี โดเมน อีเมลขาออก (บางส่วนมีใน `admin.html` แล้ว) |
| ลำดับชั้น reseller | partner → tenant หลายราย, เห็นและจัดการเฉพาะของตัวเอง |
| Billing แบบ 2 ชั้น | เราเก็บกับ partner, partner เก็บกับลูกค้า, มาร์จิ้นต่อแพ็กเกจ |
| Co-brand เอกสาร | รายงาน/อีเมล/พอร์ทัลใช้แบรนด์ partner |

**ต้องเผื่อไว้ตั้งแต่ตอนนี้**: `platform.html` และโมเดล plan/entitlement ต้องมีที่ว่างสำหรับ
**เจ้าของระดับกลาง** — ตอนนี้เป็น platform → tenant สองชั้น การแทรกชั้นที่สามภายหลัง
กระทบทั้ง IAM และการคิดเงิน จึงควรตัดสินใจเรื่องนี้ก่อนมี tenant จริงจำนวนมาก

---

## T7 — Screen Recording

ถูกเลื่อนไว้แล้วใน [ADR-010](adr/010-quality-management.md) (`qm.screenRecording` เป็น Q6+)

- ต้องมี client ฝั่ง agent (Electron หรือส่วนขยายเบราว์เซอร์) = ช่องทางการติดตั้งที่เราไม่มีวันนี้
- ต้องซิงก์เวลากับเสียงให้ตรง ไม่งั้นดูพร้อมกันไม่ได้
- ปริมาณพื้นที่เก็บสูงกว่าเสียงหลายเท่า → ต้องมี retention แยกและ quota ของตัวเอง
- ประเด็นความเป็นส่วนตัวของพนักงาน: ต้องมีสัญญาณว่ากำลังอัด + ข้อตกลงก่อนเปิด

---

## T8 — Partner Marketplace

หลัง [integration I5](integration-platform.md) — แคตตาล็อกแอปที่พาร์ตเนอร์ส่งเข้ามาได้
ต้องมีกระบวนการตรวจ, sandbox ให้พาร์ตเนอร์ทดสอบ (ผูกกับ T2), และการแบ่งรายได้

**เงื่อนไขที่ทำให้เรื่องนี้เป็นจริงได้** ถูกตัดสินไปแล้วใน
[ADR-015](adr/015-integration-platform.md) ข้อ 5: connector ของเราใช้ primitive เดียวกับของพาร์ตเนอร์
ถ้าวันหนึ่งเราแอบใช้ทางลัดภายใน marketplace จะไม่มีวันเกิด

---

## สิ่งที่ **ไม่** อยู่ในแผน (ตัดสินใจว่าจะไม่ทำ)

| เรื่อง | เหตุผล |
|---|---|
| ฝึก LLM/ASR เอง | ไม่ใช่ความได้เปรียบของเรา และพาภาษา/โครงสร้างพื้นฐานใหม่เข้ามา |
| CRM เต็มรูปแบบ | เราต่อกับ CRM ไม่ใช่แข่งกับ CRM — [customer-360](customer-360.md) มีแค่พอให้บริการ |
| Field service / dispatch | คนละธุรกิจ |
| ระบบ HR/payroll | WFM จบที่ตารางกะและ adherence — ส่งต่อให้ HR ผ่าน API |
| Data warehouse ของเราเอง | [ADR-019](adr/019-reporting-data-platform.md) — ส่ง feed เข้าคลังของลูกค้าแทน |

## เอกสารเกี่ยวข้อง

[README ของเอกสารทั้งหมด](README.md) · [licensing.md](licensing.md) · [multi-tenancy.md](multi-tenancy.md)
