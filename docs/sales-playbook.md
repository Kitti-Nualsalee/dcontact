# D-Contact Sales Playbook

เอกสารนี้เป็นแหล่งกลางสำหรับข้อความขาย แนวทาง discovery และหลักฐานที่ทีมขายใช้กับลูกค้า โดยให้ผู้ขายปรับคำพูดตามบริบทได้ แต่ต้องไม่กล่าวอ้างเกินความสามารถที่มีใน product roadmap หรือแผนบริการ

## 1. เป้าหมายของ playbook

- ทำให้ทีมขายอธิบาย D-Contact ในทิศทางเดียวกัน
- เชื่อม pain point ของลูกค้ากับ workflow และผลลัพธ์ทางธุรกิจ
- ลดการ demo แบบไล่เมนู และเพิ่มการค้นพบปัญหาก่อนนำเสนอ
- เก็บข้อมูลจากการสนทนาเพื่อปรับ script, product และรายงาน conversion

## 2. Positioning หลัก

**D-Contact คือ contact center platform ที่รวมการรับ-ส่ง interaction, การทำงานของ agent, automation, quality, workforce และ reporting ไว้บนข้อมูลชุดเดียวกัน**

ข้อความผลลัพธ์ที่ควรใช้:

- ผู้ดูแลเห็นภาพจาก interaction ถึงผลลัพธ์ ไม่ต้องรวมข้อมูลจากหลายระบบเอง
- Supervisor จัดการคุณภาพและ performance ได้จาก workflow เดียวกัน
- ทีมปฏิบัติการเปลี่ยน flow, campaign และการติดตามลูกค้าได้โดยไม่ต้องทำงาน manual ทุกจุด
- องค์กรเริ่มจาก use case ที่สำคัญก่อน แล้วค่อยขยายตามแผนและ entitlement

หลีกเลี่ยงการพูดว่า “รองรับทุกอย่างทันที”, “ลดต้นทุนได้แน่นอน” หรือการรับรอง integration ที่ยังไม่ได้ยืนยันกับ technical team

## 3. กลุ่มผู้ซื้อและสิ่งที่ต้องค้นหา

| Persona | สิ่งที่สนใจ | คำถาม discovery |
|---|---|---|
| Contact center leader | ผลลัพธ์รวม, visibility, scalability | วันนี้วัดผล contact center จากรายงานใด และมีจุดไหนที่ต้องรวมข้อมูลด้วยมือ |
| Operations / Supervisor | queue, SLA, adherence, agent productivity | ปัญหาที่เกิดซ้ำในแต่ละวันคือ routing, staffing, quality หรือ follow-up |
| QA / Compliance | scorecard, transcript, audit trail, consent | การตรวจคุณภาพใช้เวลานานตรงไหน และต้องเก็บหลักฐานอะไรเพื่อ audit |
| IT / Integration | API, webhook, CTI, identity, data control | ระบบใดต้องเชื่อมต่อ และต้องการ real-time event หรือ batch data |
| Finance / Procurement | total cost, plan, adoption risk | เกณฑ์ตัดสินใจและผลลัพธ์ที่ต้องพิสูจน์ก่อนขยาย rollout คืออะไร |

## 4. Sales motion

### Stage 1: Qualify

ยืนยันช่องทาง, ปริมาณ interaction, ทีมและระบบที่เกี่ยวข้อง, pain point, ผู้มีอำนาจตัดสินใจ, timeline และเกณฑ์ความสำเร็จ

### Stage 2: Discover

ให้ลูกค้าเล่า workflow ปัจจุบันตั้งแต่รับ interaction, ทำงาน, ส่งต่อ, ปิดเคส ไปจนถึงรายงาน อย่าเริ่มจากการเปิด feature list

### Stage 3: Map

จับคู่ pain point กับ capability ที่เกี่ยวข้อง เช่น routing/queue, case/SLA, QM, WFM, journey, outbound, customer 360 และ reporting

### Stage 4: Prove

เลือก demo 2-3 flow ที่ตอบ pain point โดยใช้ตัวชี้วัดก่อน-หลัง เช่น SLA attainment, first response, QA coverage, adherence, conversion หรือเวลาทำรายงาน

### Stage 5: Commit

สรุป use case แรก, owner, integration dependency, data/access requirement, success metric, timeline และขั้นตอนถัดไปให้เป็นลายลักษณ์อักษร

## 5. Demo path แนะนำ

1. เปิดด้วยปัญหาและ success metric ที่ลูกค้ายืนยัน
2. แสดง interaction และ context ของลูกค้าในมุม agent
3. แสดงการส่งต่อหรือเปิด case พร้อม SLA และ collaboration
4. แสดง supervisor view สำหรับ queue, quality, staffing หรือ performance
5. ปิดด้วย report ที่เชื่อมเหตุการณ์ตั้งแต่ต้นจนผลลัพธ์
6. ทวนสิ่งที่ตอบโจทย์แล้ว, สิ่งที่ต้อง validate และ next step

เลือก path ตามโจทย์ ไม่จำเป็นต้องแสดงทุก module ในทุกครั้ง

## 6. Objection handling

ใช้โครงสร้าง **รับฟัง -> ทวนความกังวล -> ตอบด้วยหลักฐาน -> ขอ commitment ขั้นถัดไป**

| ข้อกังวล | แนวทางตอบ |
|---|---|
| “มีระบบเดิมอยู่แล้ว” | D-Contact ไม่จำเป็นต้องแทนที่ทุกระบบในครั้งเดียว ให้เริ่มจาก workflow ที่มีปัญหา แล้ว validate integration และ data boundary ก่อน |
| “กลัวเปลี่ยนระบบยาก” | วาง rollout เป็น phase, กำหนด use case แรกและ success metric ให้ชัด พร้อมระบุ dependency ก่อนเริ่ม |
| “ต้องการ feature เฉพาะ” | แยกให้ชัดว่าเป็น capability ที่มีแล้ว, configuration, integration หรือ roadmap และนัด technical validation |
| “ขอราคาอย่างเดียว” | ขอข้อมูล volume, users, channels และ use case ก่อน เพื่อให้ราคาเทียบกับ scope และ entitlement ได้จริง |
| “AI จะผิดพลาดหรือไม่” | AI ควรทำงานภายใต้ knowledge, policy, confidence และ human handoff พร้อมตรวจสอบ transcript และ audit trail |

## 7. ข้อมูลที่ต้องบันทึกหลังการคุย

- persona, industry และ business objective
- channels, interaction volume และ peak period
- current workflow, systems และ integration dependency
- pain point ที่จัดลำดับแล้ว
- use case ที่ demo และผลลัพธ์ที่ต้องการ
- objection, competitor หรือระบบเดิม
- decision maker, timeline, next step และ owner
- consent/data residency/compliance constraint ที่ลูกค้าระบุ

## 8. Metrics สำหรับปรับปรุง script

- discovery completion rate
- demo-to-next-step rate
- qualified opportunity conversion
- objection category และ win/loss reason
- time-to-first-value หลังเริ่ม pilot
- conversion แยกตาม persona, use case และ channel

ข้อมูลเหล่านี้ควรเชื่อมกับ reporting layer และ interaction analytics เมื่อระบบรองรับ เพื่อให้ทีมเห็นว่า script ส่วนใดนำไปสู่ผลลัพธ์จริง ไม่วัดแค่จำนวน demo

## 9. Governance และ versioning

- มี owner ด้าน Sales/Marketing 1 คน และ reviewer จาก Product กับ Solution/Technical
- ทุก script ระบุ `version`, `owner`, `status`, `effective date` และ `last reviewed`
- แยกข้อความที่ approved แล้วออกจาก draft และห้ามใช้ claim ที่ยังไม่มีหลักฐาน
- review อย่างน้อยทุกไตรมาส หรือเมื่อ product capability, pricing, plan หรือ compliance เปลี่ยน
- เก็บ win/loss feedback ทุกเดือน แล้วปรับเฉพาะส่วนที่มีหลักฐานรองรับ

สถานะที่แนะนำ: `draft` -> `pilot` -> `approved` -> `deprecated`

## 10. MVP ที่ควรทำก่อน

เริ่มด้วย script 3 ชุด:

1. Inbound demo สำหรับลูกค้าที่สนใจ platform
2. Outbound qualification สำหรับนัด discovery
3. Enterprise objection สำหรับ IT, security, integration และ procurement

แต่ละชุดควรทดลองกับทีมขาย 3-5 คนเป็นเวลา 2 สัปดาห์ แล้ว review จาก call note, conversion และคำถามที่ลูกค้าถามจริงก่อนนำไปทำเป็นฟีเจอร์ในระบบ

