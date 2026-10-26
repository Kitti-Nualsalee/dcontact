# Managed Voice direct adapter

`@d-contact/telephony` export `FreeSwitchManagedVoiceAdapter`, `ManagedVoiceEslTransport`,
`E1EslCommandClient`, `parseEslEvent` และ `normalizeManagedVoiceEvent` สำหรับ runtime และ acceptance harness

## จุดเชื่อม harness

- สร้าง `E1EslCommandClient({ host, port, password })` จาก ESL ของ FreeSWITCH sandbox จริง
- สร้าง `FreeSwitchManagedVoiceAdapter(esl, nodeId, sipDomain)`; domain ต้องตรง directory ของ Agent
- เรียก `bindCaller(tenantId, callUuid)` หลังยืนยัน tenant/domain ของ caller และก่อน dispatch managed command
- ส่ง normalized `CHANNEL_ANSWER`/`CHANNEL_BRIDGE`/`CHANNEL_HANGUP_COMPLETE` ให้ runtime โดยเก็บ exact
  `dcontact_call_uuid`, `dcontact_offer_id`, `dcontact_agent_id`, `dcontact_bleg_uuid`, tenant และ node
- ส่งทุก `BACKGROUND_JOB` ที่จบให้ `adapter.backgroundJob(jobUuid)` เพื่อบันทึกหลักฐาน originate จบจริง
- ตรวจ `readback(command)` ของ caller และทุก persisted B-leg; แยกหลักฐาน SIP CANCEL/BYE,
  FreeSWITCH timeout และ durable command confirmation ออกจากกัน

`offer.create` ใช้ stable B-leg UUID และ `&park()`; runtime ต้องชนะ answer CAS ก่อน `call.bridge`
`originate_timeout` ใช้เวลาที่เหลือก่อน offer expiry ปัดขึ้นเป็นวินาทีและไม่เกิน 20 วินาที
`offer.cancel` ฆ่าเฉพาะ B-leg ส่วน `call.hangup` ตรวจและฆ่าทั้ง caller/B-leg
runtime เป็นผู้ serialize dispatch ต่อสายและต้องรอ cleanup ของ offer เก่ายืนยันก่อนเสนอคนใหม่

e1 direct port ส่งต่อ `readback(command)` ไปยัง adapter จริงเพื่อ reconcile ACTIVE หลังพลาด hangup event
readback ใช้เฉพาะ `uuid_exists`/`uuid_getvar` ไม่มี bind/setvar/kill และไม่ใช้ offer deadline ตัดสาย ACTIVE
probe error หรือ scope mismatch จะ throw แทนการรายงาน absence; runtime จึงเปลี่ยนเป็น WRAPUP ได้เฉพาะเมื่อมีหลักฐาน absence จริง
production port และ acceptance port ต้องต่อ readback จริง; heartbeat ของ runtime ปฏิเสธ port ที่ไม่มี readback
DB-only `handle`/`tick`, readiness probe/heartbeat และ direct `flushCommands` ใช้ loop แยกกัน
ESL probe/readback/dispatch ที่ช้าไม่ถือ DB timer หรือ managed event chain ค้าง
`BACKGROUND_JOB` ถูกเข้าคิวให้ dispatch pump บันทึก receipt แทนการรอ ESL I/O ใน event chain
state DB และ dispatch advisory lock ใช้ Prisma clients คนละ pool แม้ URL เดียวกัน
e1 เลือก `APPLICATION_DATABASE_URL` ก่อน `DATABASE_URL` และส่ง URL ชัดเจนให้ทั้งสอง clients
จึงไม่ให้ dispatch transaction ที่รอ ESL แย่ง connection ของ DB timer เมื่อ pool มี connection เดียว

## Readiness และข้อจำกัด

`e1-sandbox-main` ส่ง heartbeat หลังยืนยัน event subscription และ probe `api status` สำเร็จเท่านั้น
managed deadline/terminal intent ยังเดินต่อเมื่อ ESL ใช้ไม่ได้ โดย direct dispatch คง pending
readiness ถูก clear เมื่อ probe ล้มเหลวหรือ connection ปิด; ถ้า DB clear ไม่สำเร็จใช้ TTL expiry

FreeSWITCH global marker ป้องกัน blind originate ซ้ำหลัง response lost/restart;
การไม่พบ channel อย่างเดียวไม่พิสูจน์ว่า background originate จบแล้ว
หาก process ตายระหว่างเขียน marker กับ dispatch/บันทึก Job-UUID และพลาด completion event
อาจเหลือ cleanup pending แบบไม่มีกำหนด adapter จะ throw `ManagedVoiceReconciliationRequiredError`
ที่มี `code=MANAGED_VOICE_ORIGINATE_OUTCOME_UNKNOWN` และ `actionRequired=true` ไม่คืน confirmed
กรณี process restart หลัง job จบขณะที่ listener ใช้ไม่ได้และ B-leg หายไปแล้วก็อยู่ในข้อจำกัดนี้
operator ต้องหาหลักฐาน quiescence ของ origination เดิมก่อน reconcile; ยังไม่มี automated provider lookup
หรือ operator mutation endpoint ใน adapter นี้ ห้ามลบ marker/ส่ง originate ซ้ำเพื่อแก้สถานะ
ห้ามถือว่าเวลาเลย deadline หรือ DB terminal state เป็นหลักฐาน teardown แทน switch

## ตรวจสอบ

`pnpm --filter @d-contact/telephony test` ตรวจ regression และ race cases
`pnpm --filter @d-contact/telephony test:integration` รวม authenticated ESL TCP integration
และ DB regressions ซึ่งต้องใช้ isolated migrated owner/application database URLs
ผล TCP fixture ไม่ใช่หลักฐาน real SIP acceptance; ใช้ `pnpm voice:managed-routing:acceptance` สำหรับ gate นั้น
