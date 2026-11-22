# Managed routing ใน telephony หลัก (หลาย tenant)

Authority: [#979](https://github.com/Kitti-Nualsalee/dcontact/issues/979) ต่อจาก [#977](https://github.com/Kitti-Nualsalee/dcontact/issues/977)

คิวที่ Admin สร้างใน Console เป็น managed routing v1 (`voiceConfigVersion=1`) เสมอ และ legacy router ปฏิเสธคิวแบบนี้
(`VOICE_CONFIG_V1_REQUIRED`) เดิม `ManagedVoiceRuntime` ต่อกับ FreeSWITCH ได้เฉพาะใน `e1-sandbox-main` ซึ่งรับ tenant เดียว
และ SIP domain เดียวต่อ process งานนี้เพิ่ม managed runtime ให้ `apps/telephony/src/main.ts` ซึ่ง dev และ Solo ใช้ แบบรับหลาย tenant
ใน process เดียว

## เปิดใช้

| env | ค่า | หมายเหตุ |
| --- | --- | --- |
| `TELEPHONY_MANAGED_VOICE_ENABLED` | `true` | ปิดโดยปริยาย ถ้าไม่ตั้งเป็น `true` ตรงตัว `main.ts` ทำงานแบบเดิมทุกอย่าง |
| `TELEPHONY_NODE_ID` | เช่น `fs-local`, `fs-solo` | ต้องตรงกับ `telephonyNodeId` ใน `destination_pool` ของ tenant ที่ operator จองเบอร์ไว้ |
| `APPLICATION_DATABASE_URL` | role `dcontact_app` | managed runtime ใช้ค่านี้ (ไม่มีจึงใช้ `DATABASE_URL`) เพราะ trigger ของ managed runtime ตรวจ role นี้ |

**Solo UAT ยังไม่เปิด** การเปิดบน Solo ต้องรอ owner สั่ง (เพิ่มค่าใน `solo.env` แล้ว restart service `telephony`)

## สิ่งที่ทำเมื่อเปิด

- **Readiness**: ทุก 1 วินาทีตรวจ `api status` ของ FreeSWITCH แล้วส่ง heartbeat ลง `voice_managed_runtime_readiness`
  ให้ทุก tenant ที่ `ACTIVE` บน node นี้ (TTL 15 วินาที) Console จึงไม่แสดง `CAPABILITY_NOT_READY` และเปิดคิว/เบอร์ได้
  จะประกาศ readiness หลัง FreeSWITCH ยืนยันการ subscribe event แล้วเท่านั้น และถอน readiness ทันทีเมื่อได้ SIGTERM หรือ ESL หลุด
  (ESL หลุดแล้ว process ออกด้วย exit 1 ให้ restart policy เริ่มใหม่ ตามแบบ `e1-sandbox-main`)
- **Tick และ dispatch**: ทุก 1 วินาทีเดิน timer ของสาย (offer 20 วินาที, รอรวม 60 วินาที) และส่งคำสั่งที่ค้างให้ FreeSWITCH ต่อ tenant
- **แยก event**: event จาก FreeSWITCH ถูกประมวลตามลำดับ และแยกก่อนส่ง legacy router ผ่าน Kafka
  - ขาที่มี `dcontact_offer_id` (ขา Agent และขาลูกค้าหลังตั้ง offer) ไป managed runtime ของ tenant บนช่องสาย ไม่ส่ง Kafka
  - สายฝั่งลูกค้าที่เบอร์ผูกคิว managed v1 (`call.created` ที่ runtime รับ) และ event ต่อจากนั้นของสายนั้น ไป managed runtime
  - คิว legacy, outbound delivery และ event อื่นของสาย legacy ส่ง Kafka ตามเดิม รวม recording lifecycle
  - ถ้า managed runtime ล้มกับสายที่ยังไม่รู้จัก สายนั้นไป legacy เพื่อไม่ให้คิวเดิมเสียเพราะ managed
  - subscribe `CHANNEL_ANSWER` เพิ่ม (managed ต้องรู้ว่า Agent รับ offer) และไม่ส่ง event นี้ให้ legacy
- **SIP domain ต่อ tenant**: `FreeSwitchManagedVoiceAdapter` หา domain จาก `tenants.sip_domain` ทีละคำสั่ง (แคช 30 วินาที)
  และ originate ไป `user/<extension>@<domain ของ tenant>` ไม่ใช้ `FREESWITCH_SIP_DOMAIN`
  ก่อนผูกช่องสายของลูกค้ากับ tenant (`bindCaller`) ตรวจว่า `domain_name` ของช่องสายตรงกับ domain ของ tenant นั้น
  ไม่ตรงคือไม่ผูกและไม่ originate (คำสั่งค้าง `DIRECT_PORT_UNCONFIRMED` จนสายหมดเวลา)
- **Answer ลูกค้าตอน bridge**: adapter สั่ง `uuid_answer` ขาลูกค้าก่อน `uuid_bridge` เพราะ context `pstn` park สายโดยไม่ answer
  ถ้า bridge ขาที่ยังไม่ answer FreeSWITCH ตัดลูกค้าด้วย `DESTINATION_OUT_OF_ORDER` (ลูกค้าได้ 502) เปลี่ยนนี้มีผลกับ `e1-sandbox-main` ด้วย
  และตรงกับนโยบายที่ลูกค้ารอแบบ pre-answer จนกว่า Agent จะรับ

## ผลตรวจ — 22 พ.ย. 2569

- unit ของ telephony 82 รายการ รวมการแยก event managed/legacy, directory ของ SIP domain และ adapter ต่อ tenant
- integration ของ telephony 5 รายการบนฐานแยก `dcontact_979` รายการใหม่ใช้ ESL จำลองแบบ TCP กับฐานจริง:
  heartbeat แยกต่อ tenant หลังยืนยัน subscription, offer ของสอง tenant ใช้ domain ของตัวเอง, สายที่ domain ไม่ตรง tenant
  ไม่ถูกผูกหรือ originate และ stop ถอน readiness ทันที
- ทดลองบน dev stack (FreeSWITCH dev, Redpanda, API บน `dcontact_979` ซึ่งคัดลอกจาก `dcontact_977`) ด้วย `main.ts` ผ่าน tsx และ SIPp
  - tenant `onboard977` คิว Support Line เบอร์ 2000 ที่ Admin สร้างใน Console ระหว่าง #977: `managedRuntimeReady` ของ API เป็น `true`
    สายจาก SIPp ผ่าน trunk `pstn-sim` พร้อม `X-DContact-Domain` ถึง Agent 1100 ภายใน 1 วินาที Agent รับ ลูกค้าได้ 200 OK
    คุย 15 วินาทีแล้ววาง interaction เป็น `WRAPUP` และไม่มี event ของสายนี้ใน `dc.telephony.events`
  - ไม่มี Agent ว่าง: สายอยู่ในคิวจนครบ 60 วินาทีแล้วถูกวาง (`PREANSWER_DEADLINE_EXCEEDED`); Agent ไม่รับ: offer หมดเวลา 20 วินาที
  - คิว legacy ของ tenant `demo` (seed) เบอร์ 2000 ขณะเปิด flag: Kafka router รับสายและ Agent 1000 รับคุยได้ตามเดิม
  - ปิด flag: ไม่มี heartbeat และคิว legacy ของ `demo` รับสายได้เหมือนเดิม

## ข้อจำกัด

- คิว managed ยังบันทึกเสียงไม่ได้: การเปิดคิว/เบอร์ managed ต้องปิด recording, auto QM และ transcription
  (`dc_voice_managed_activation_check`) งาน Supervisor ฟังเสียง (#967) และ QM (#971) จึงใช้ได้กับคิว legacy เท่านั้น
- Agent ในการทดลองเป็น SIPp ที่ลงทะเบียนด้วย SIP credential/work-session lease ที่สร้างลงฐานแยกโดยตรง และตั้งสถานะ AVAILABLE
  และปิด wrap-up ผ่านฐาน ไม่ได้ผ่าน Workspace/dphone (ส่วนนั้นผ่านแล้วใน #977) ไม่ได้ตรวจเสียงสองทาง
- เมื่อลูกค้าวางหลัง bridge ผลจบของ managed runtime เป็น `AGENT_HANGUP` น่าจะเพราะ event วางสายของขา Agent มาถึงก่อน
  ซึ่งเป็นพฤติกรรมเดิมของ runtime ไม่ได้แก้ในงานนี้
- heartbeat เขียนทุกวินาทีต่อทุก tenant ที่ ACTIVE (รวม tenant ที่ไม่มีคิว managed) เหมาะกับจำนวน tenant ของ Solo/dev
- Node 20 ในเครื่อง dev รัน `dist` ของ telephony ไม่ได้ (`ERR_REQUIRE_ESM` จาก `apps/delivery`) ให้ใช้ `pnpm --filter @d-contact/telephony dev`
- ยังไม่ได้ทดสอบบน Solo UAT
