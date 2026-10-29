# B5: real dev SIP acceptance (#712)

รันจาก repository root ด้วย Node 22 และ pnpm 9 หลังติดตั้ง dependencies และ build
`@d-contact/db`, `@d-contact/shared` ตาม prerequisite ของ Router แล้ว:

```sh
docker pull postgres@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea
docker pull safarov/freeswitch@sha256:f156e01a96d48944078ed7f0e24304be63ea15f6466cf607a0aeb6cb47761da7
docker pull ctaloi/sipp@sha256:c459f2340443ddcc159227efc798217dbdaad0dbe88b76b78b1a876aa271986a
pnpm voice:managed-routing:acceptance
```

คำสั่งตรวจ cached images ก่อนสร้าง stack ไม่ pull หรือ build images เงียบ ๆ ระหว่างทดสอบ
FreeSWITCH image pin digest เดียวกับ cached dev stack และบันทึก image IDs จริงใน evidence
เมื่อ dependency ไม่พร้อมจะ exit nonzero ไม่มี skip หรือ PASS สำรอง

## สภาพแวดล้อม

- สร้าง PostgreSQL ใหม่และ migrate/RLS ถึง HEAD; runtime ใช้ `dcontact_app` NOBYPASSRLS
  ส่วน owner ใช้สร้าง fixture และอ่าน evidence เท่านั้น ไม่แตะฐานข้อมูล dev/UAT เดิม
- สร้าง Docker network และ containers ชื่อสุ่มเฉพาะ run; publish เฉพาะ PostgreSQL/ESL
  บน `127.0.0.1` ด้วย port ที่ Docker จัดให้ SIP ใช้ network ภายใน run
- ไม่มี Kafka, Redis, Keycloak, API, Console, browser, server UAT หรือ headset
- PostgreSQL/FreeSWITCH จำกัด memory ตัวละ 768MiB, SIPp ตัวละ 96MiB
  พร้อม CPU/PID/log limits; PostgreSQL data เป็น tmpfs จำกัด 768MiB
  ต้องมี Docker memory อย่างน้อย 3GiB และ disk ว่างอย่างน้อย 2GiB หลังเตรียม cached images
- เวลาจริง 20s/60s ใช้ PostgreSQL clock ไม่มี fake clock, backdate deadline หรือ mock SIP
  สองช่วงการทดสอบใช้เวลาประมาณ 140s บวก setup; runner มี hard limit 240s
  cleanup ลบเฉพาะ containers/network ของ run เมื่อสำเร็จ ล้มเหลว หรือ SIGINT/SIGTERM

## หลักฐานที่ต้องผ่าน

1. Agent สองคน: คนแรกไม่ตอบครบ 20s แล้ว offer ให้คนถัดไป; ไม่วนคนเดิม
2. ไม่มี eligible Agent: อยู่ QUEUED จน 60s แล้ว caller รับ BYE จริง
3. ไม่ตอบทุกคน: budget รวม 60s และ caller รับ BYE จริง
4. Restart: หยุด direct port หลัง terminal intent commit ก่อนส่งคำสั่ง ตรวจ caller ยังอยู่
   และ intent ยัง PENDING, SIGKILL runtime แล้วเริ่ม process ใหม่ด้วย direct adapter จริง
   deadline เดิมต้องไม่เปลี่ยน และ caller/B-leg UUID ทั้งหมดต้องหายจริงหลัง recovery
   บันทึกว่า B-leg ยังอยู่ก่อน restart หรือจบจาก FreeSWITCH offer safety timeout แล้ว
5. หน่วง answer event ที่รับจาก SIP/ESL จริงของ offer แรก 25s ให้หมดอายุก่อนส่งเข้า runtime
   offer ถัดไปตอบจริงและ bridge จริง; event เก่าห้ามแย่ง owner หรือ bridge ซ้ำ
   caller และ B-leg ของ ACTIVE ต้องยังอยู่หลัง absolute preanswer deadline 3s
6. DB due tick ทุก 1s และ direct dispatch pump แยกกัน โดย runtime ใช้ DB connection เดียว
   เริ่ม call A ก่อน B แล้วค้าง direct command ของ A ไว้หลัง commit; B ต้องถึง terminal
   ขณะ caller A ยังอยู่จริงและ command A ยัง PENDING จากนั้น restart และตรวจ SIP teardown จริง
   แยกหลักฐาน DB deadline ระหว่าง RPC ค้างออกจาก actual teardown หลัง recovery
7. หลัง ACTIVE ผ่าน deadline แล้ว SIGKILL runtime; SIPp caller ส่ง BYE จริงเมื่อครบ 70s
   ตรวจ SIPp รับ 200/exit=0 และ caller หายจริง ขณะที่ DB ยังคง ACTIVE เพราะพลาด event
   บันทึกว่า B-leg ยังอยู่ก่อน recovery หรือไม่; เริ่ม runtime ใหม่ต้อง reconcile ผ่าน actual
   readback เป็น WRAPUP และเก็บ B-leg ที่ค้างจนหายจริง พร้อม ended event ครั้งเดียว

`result.json` จะเขียน PASS หลังตรวจทั้ง DB invariants, SIPp caller exit=0,
SIP BYE/CANCEL traces, positive ESL B-leg readback ของทุก offer และ absence readback
หลัง teardown เท่านั้น การมีแค่ DB ABANDONED ไม่ผ่าน

คำสั่งแสดง evidence directory ใน temp: `environment.json` (SHA/image IDs/resources),
`fixtures.json`, `runtime.jsonl` (events/commands/readback), SIP message traces,
`dispatch-blocked.json`, `result.json` และ container logs เก็บไว้หลัง cleanup
ข้อมูลทั้งหมดเป็น fixture แยก ไม่มี production PII หรือ credentials จาก environment เดิม

runner อยู่ `apps/router/scripts/managed-routing-runner.mts` แยกจาก production tsconfig
แต่เรียก `ManagedVoiceRuntime` และ `FreeSwitchManagedVoiceAdapter` จริงจาก source
การผ่านนี้เป็น dev runtime proof ไม่ใช่ VM/headset/final business acceptance

ตรวจ required case IDs ทั้งเจ็ดแบบระบุชื่อและไม่ซ้ำ ไม่ใช้จำนวน cases อย่างเดียว
`sources.json` บันทึก SHA-256 ของ runtime/adapter/runner/fixtures/schema ก่อนเริ่ม
และตรวจว่าไม่เปลี่ยนตลอด run; evidence รุ่นก่อนเพิ่ม case ใหม่ไม่ทดแทนผลชุดปัจจุบัน
