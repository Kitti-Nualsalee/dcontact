# Shared rate limiter สำหรับ Cus360 search

`POST /api/v1/customer-360/contacts/search` ใช้ policy `c360-search-v1` แบบ fixed window 60 วินาที:
60 คำขอต่อ actor และ 600 คำขอต่อ tenant โดยนับร่วมกันทุก API instance ผ่าน Redis เดียวกัน
การตรวจและเพิ่มทั้งสอง counter เป็น atomic; เมื่อเต็มตอบ `429 RATE_LIMITED` พร้อม `Retry-After`
ที่คำนวณจาก window ที่เหลือ คำขอที่ถูกปฏิเสธไม่ใช้ budget อีกฝั่ง

API ใช้ `REDIS_URL` ที่ตั้งไว้อย่างชัดเจน หากไม่มีค่า เชื่อมต่อไม่ได้ หมดเวลา หรือข้อมูล counter
ผิดรูปแบบ จะตอบ `503 RATE_LIMITER_UNAVAILABLE` สำหรับ search โดยไม่ใช้ local fallback และไม่รัน search
Voice และ navigation ไม่พึ่ง limiter นี้ ส่วน profile readback ใช้ budget แยกของ C4 Redis key เก็บ digest ของ tenant/actor
และ policy เท่านั้น ไม่เก็บคำค้น หมายเลขโทรศัพท์ หรืออีเมล

## ก่อน deploy หลาย instance หรือ VM UAT

- ทุก API instance ต้องชี้ Redis logical store เดียวกัน และ network/ACL ต้องอนุญาต `EVAL`, `GET`,
  `PTTL`, `EXISTS`, `SET` และ `INCR` สำหรับ namespace `dc:rate:*`; ใช้ Redis endpoint แบบ
  standalone หรือ proxy ที่รองรับคำสั่งนี้. Key ของ tenant เดียวกันมี hash tag เดียวกัน แต่ client รอบนี้
  ยังไม่ได้รองรับ Redis Cluster แบบ native หรือทดสอบการ redirect ระหว่าง node
- จัด capacity และตั้ง Redis เป็น `noeviction`: ถ้า Redis ลบ key ที่ยังไม่หมดอายุ ระบบจะไม่สามารถ
  แยกการลบดังกล่าวจาก window ใหม่ได้ การตั้งค่าเหล่านี้เป็นหน้าที่ของ environment ไม่ได้ตรวจอัตโนมัติ
- การสูญหายของ Redis state ระหว่าง restart/failover อาจเริ่ม budget ใหม่ก่อนครบ window; ต้องกำหนด
  persistence/failover และตรวจความเสี่ยงนี้ก่อน release ห้ามอ้างว่าการทดสอบ reconnect พิสูจน์ durability
- บันทึก Redis topology/config version, policy `c360-search-v1` และผลทดสอบใน release evidence;
  หากต้องเปลี่ยน quota ให้กำหนด migration/rollout ร่วมกันทุก instance: policy คนละ version ใช้คนละ
  counter และอาจเพิ่ม quota รวมระหว่าง rollout ได้
- Mutation และ receipt/readback budget รวมถึงการกู้ receipt ที่ commit แล้วอยู่ใน C4 #794;
  การทดสอบนี้ไม่ใช่ VM UAT หรือ performance/load acceptance

## ทดสอบ

`pnpm --filter @d-contact/api test:c360-shared-limiter` สร้าง Redis และ PostgreSQL แบบ disposable
บน loopback ใช้ข้อมูลสังเคราะห์ รัน integration หลาย instance, Redis outage/recovery และ C2 regression
จากนั้นลบเฉพาะ container ที่ runner สร้างเอง ต้องมี Docker พร้อมใช้งาน
