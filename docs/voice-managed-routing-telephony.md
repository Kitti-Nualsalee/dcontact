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
  tenant ที่เคย ACTIVE ใน process นี้ยัง tick ต่อแม้ถูกพัก เพื่อให้สายที่ค้างถึง deadline และถูกวาง
- **ลำดับ event**: event ของสายเดียวกัน (สายลูกค้าและขา Agent ที่มี `dcontact_call_uuid` ชี้สายลูกค้า) ประมวลตามลำดับ
  สายต่างกันประมวลพร้อมกัน งานช้าของสายหนึ่ง เช่น archive เสียงของสาย legacy ขึ้น S3 หรือ Kafka ช้า จึงไม่ขวางสายอื่น
- **แยก event**: แยกก่อนส่ง legacy router ผ่าน Kafka
  - ขาที่มี `dcontact_offer_id` (ขา Agent และขาลูกค้าหลังตั้ง offer) ไป managed runtime ของ tenant บนช่องสาย ไม่ส่ง Kafka
  - สายฝั่งลูกค้าที่เบอร์ผูกคิว managed v1 (`call.created` ที่ runtime รับ) และ event ต่อจากนั้นของสายนั้น ไป managed runtime
  - คิว legacy, outbound delivery และ event อื่นของสาย legacy ส่ง Kafka ตามเดิม รวม recording lifecycle
  - **บันทึกเสียงของสาย managed (#991)**: หลัง managed runtime รับ event แล้ว `ManagedRecordingTrigger`
    (`managed-voice-recording.ts`) แปลง `CHANNEL_BRIDGE` ที่ผูกสายลูกค้ากับ Agent เป็น `call.answered` และ
    `CHANNEL_HANGUP_COMPLETE` ของขาลูกค้าเป็น `call.hangup` แล้วเรียก `publishTelephonyCallEvent` ที่ publish เป็น no-op
    (ไม่ส่ง Kafka) วงจร recording เดิมจึงทำงานเหมือน legacy: หา interaction จาก `externalId = call uuid ลูกค้า`
    เช็ก `queue.recordingEnabled` แล้วสร้างแถว recording, uuid_record และ archive หลังวางสาย bridge ซ้ำจากสองขาไม่เริ่มซ้ำ
  - ถ้า managed runtime ล้มกับสายใหม่ จะลองซ้ำหนึ่งครั้ง ถ้ายังล้มสายนั้นไป legacy เพื่อไม่ให้คิวเดิมเสียเพราะ managed
  - subscribe `CHANNEL_ANSWER` เพิ่ม (managed ต้องรู้ว่า Agent รับ offer) และไม่ส่ง event นี้ให้ legacy
- **SIP domain ต่อ tenant**: `FreeSwitchManagedVoiceAdapter` หา domain จาก `tenants.sip_domain` ทีละคำสั่ง (แคช 30 วินาที)
  และ originate ไป `user/<extension>@<domain ของ tenant>` ไม่ใช้ `FREESWITCH_SIP_DOMAIN`
  ก่อนผูกช่องสายของลูกค้ากับ tenant (`bindCaller`) ตรวจว่า `domain_name` ของช่องสายตรงกับ domain ของ tenant นั้น
  ไม่ตรงคือไม่ผูกและไม่ originate (คำสั่งค้าง `DIRECT_PORT_UNCONFIRMED` จนสายหมดเวลา)
  originate ใช้ได้เฉพาะ tenant ที่ ACTIVE ส่วนการตรวจช่องสายใช้ domain แม้ tenant ถูกพัก คำสั่งวางสายของสายที่ค้างจึงยังทำงาน
  เมื่อคำสั่งล้ม จะ log สาเหตุจริงครั้งเดียวต่อคำสั่ง (runtime เก็บแค่ `DIRECT_PORT_UNCONFIRMED`)
- **Answer ลูกค้าตอน bridge**: adapter สั่ง `uuid_answer` ขาลูกค้าก่อน `uuid_bridge` เพราะ context `pstn` park สายโดยไม่ answer
  ถ้า bridge ขาที่ยังไม่ answer FreeSWITCH ตัดลูกค้าด้วย `DESTINATION_OUT_OF_ORDER` (ลูกค้าได้ 502) เปลี่ยนนี้มีผลกับ `e1-sandbox-main` ด้วย
  และตรงกับนโยบายที่ลูกค้ารอแบบ pre-answer จนกว่า Agent จะรับ

## ผลตรวจ — 22 พ.ย. 2569

- unit ของ telephony 87 รายการ รวมการแยก event managed/legacy, คิวต่อสาย, directory ของ SIP domain และ adapter ต่อ tenant
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
  - หลังเปลี่ยนเป็นคิวต่อสายตามผลรีวิว ทดลองซ้ำทั้งสาย managed ของ `onboard977` และสาย legacy ของ `demo` ผ่าน

## ข้อจำกัด

- คิว managed บันทึกเสียงได้ (#991): Admin เปิด `recordingEnabled` ในหน้ารายละเอียดคิว (คำสั่ง `PATCH /api/v1/tenant-voice/queues/:id`)
  Supervisor ฟัง (#967) และประเมินโดยคน (#971) ได้ แต่การเปิดคิว/เบอร์ managed ยังต้องปิด auto QM และ transcription
  (`dc_voice_managed_activation_check`) และการแก้ recording ทำไม่ได้ขณะคิวมีสายค้าง (`CONFIG_BUSY`) ผลมีกับสายถัดไป
  ยังไม่ได้ทดลองสายจริงบน FreeSWITCH dev ที่เปิด recording
- Agent ในการทดลองเป็น SIPp ที่ลงทะเบียนด้วย SIP credential/work-session lease ที่สร้างลงฐานแยกโดยตรง และตั้งสถานะ AVAILABLE
  และปิด wrap-up ผ่านฐาน ไม่ได้ผ่าน Workspace/dphone (ส่วนนั้นผ่านแล้วใน #977) ไม่ได้ตรวจเสียงสองทาง
- เมื่อลูกค้าวางหลัง bridge ผลจบของ managed runtime เป็น `AGENT_HANGUP` น่าจะเพราะ event วางสายของขา Agent มาถึงก่อน
  ซึ่งเป็นพฤติกรรมเดิมของ runtime ไม่ได้แก้ในงานนี้
- ถ้าสายใหม่ของเบอร์ managed เจอ runtime ล้มทั้งสองครั้ง สายจะไป legacy ซึ่งปฏิเสธคิว managed (`VOICE_CONFIG_V1_REQUIRED`)
  และ managed จะไม่ได้รับสายนี้อีก ลูกค้าถูก park จนวางเอง ไม่มีเพดาน 60 วินาที
- รายชื่อสาย managed อยู่ในหน่วยความจำ หลัง restart ระหว่างสายรอคิว `DTMF`/`DETECTED_SPEECH` ของสายนั้นอาจถูกส่ง Kafka
  และ legacy router ปฏิเสธ (noise ใน retry/DLQ) ส่วน CREATE/PARK/HANGUP ยังถูกต้องเพราะ runtime หา call จากฐาน
- เมื่อเปิด flag ทุก event ของสาย legacy ต้องผ่าน transaction ของ managed runtime (advisory lock ต่อ tenant) ก่อน และ container
  มี PrismaClient เพิ่ม 2 ตัว ก่อนเปิดบน Solo (`mem_limit: 384m`) ควรดู memory และ latency
- heartbeat เขียนทุกวินาทีต่อทุก tenant ที่ ACTIVE (รวม tenant ที่ไม่มีคิว managed) เหมาะกับจำนวน tenant ของ Solo/dev
- Node 20 ในเครื่อง dev รัน `dist` ของ telephony ไม่ได้ (`ERR_REQUIRE_ESM` จาก `apps/delivery`) ให้ใช้ `pnpm --filter @d-contact/telephony dev`
- ยังไม่ได้ทดสอบบน Solo UAT
