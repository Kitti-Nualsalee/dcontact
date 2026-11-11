# ADR 038: Voice stack เดียว (Kamailio + FreeSWITCH) ทั้ง CCaaS และ on-prem และ trunk แยกตาม tenant

- สถานะ: Accepted — owner ยืนยัน 10 พฤศจิกายน 2569
- แทนที่บางส่วนของ [ADR-006](006-multi-vendor-telephony-gateway.md): profile on-prem = Asterisk (ข้อ 1), การใช้ ARI (ข้อ 2) และ dual-stack (ข้อ 6)
- คงไว้จาก ADR-006: gateway abstraction, envelope กลางใน `packages/shared`, header `vendor` และ command set ที่ไม่ผูก vendor

## บริบท

D-Contact จะขายสองแบบ คือ CCaaS ที่หลาย tenant ใช้ระบบร่วมกันบน cloud ของเรา และ on-prem ที่ติดตั้งในไซต์ลูกค้ารายใหญ่ซึ่งมี Agent เกิน 500 คน ฝั่ง CCaaS ต้องรองรับ trunk สองแบบ คือ trunk กลางของเราที่มีเบอร์ให้ tenant เช่า และ trunk ที่ tenant นำ provider ของตัวเองมาเชื่อม

ADR-006 เคยกำหนดให้ on-prem ใช้ Asterisk ผ่าน `apps/asterisk-gateway` แต่ gateway นี้ยังไม่ถูกสร้าง การดูแลสอง media server ทำให้ต้องทดสอบและแก้ปัญหาสองชุด ในขณะที่งานยากของ on-prem อยู่ที่การแจกจ่ายและดูแลระบบ ไม่ใช่การเลือก vendor

## การตัดสินใจ

### 1. ใช้ stack เดียวทุก profile

ทั้ง CCaaS และ on-prem ใช้ Kamailio เป็นขอบ SIP และ FreeSWITCH เป็น media server โดยมี `apps/telephony` (ESL) เป็น gateway ตัวเดียว ไม่สร้าง `apps/asterisk-gateway` profile ต่างกันที่การติดตั้งและค่า config เท่านั้น image เป็นชุดเดียวกัน

ลูกค้าที่มี PBX เดิม รวมถึง Asterisk ให้เชื่อมเข้ามาเป็น SIP trunk ที่ Kamailio เหมือน trunk อื่น ไม่มี gateway แยกสำหรับ PBX

### 2. Kamailio เป็นขอบ SIP ที่รู้จัก tenant

- สายเข้า: ระบุ tenant จากเบอร์ปลายทาง (DID) สำหรับ trunk กลาง และจาก IP ต้นทางหรือบัญชีที่ลงทะเบียนสำหรับ trunk ของ tenant แล้วส่งต่อไป FreeSWITCH พร้อม SIP domain ของ tenant ตามกติกา SIP domain เป็นกุญแจ tenant เดิม
- สายออก: เลือก trunk จาก tenant ของสาย tenant ที่มี trunk ของตัวเองออกทาง trunk นั้น ที่เหลือออก trunk กลาง
- Kamailio ทำงานเป็นคู่ active/standby ถือ VIP เดียว เป็น IP ขาออกคงที่ที่ provider ทุกรายใช้ whitelist
- FreeSWITCH ไม่ถือ trunk โดยตรง สาย PSTN ทุกสายผ่าน Kamailio ส่วนเสียง (RTP) วิ่งตรงระหว่าง trunk กับ FreeSWITCH

### 3. Trunk สองแบบ

| เรื่อง | Trunk กลางของแพลตฟอร์ม | Trunk ของ tenant |
| --- | --- | --- |
| เจ้าของเบอร์ | แพลตฟอร์ม จัดสรรเบอร์ให้ tenant | tenant ผูกกับ tenant เดียว |
| ระบุ tenant ของสายเข้า | เบอร์ปลายทาง | IP ต้นทางหรือบัญชีที่ลงทะเบียน |
| ยืนยันตัวกับ provider | whitelist IP | whitelist IP หรือ Kamailio ลงทะเบียนไปหา provider |
| ผู้ตั้งค่า | ผู้ดูแลแพลตฟอร์ม | ผู้ดูแลแพลตฟอร์มในรอบแรก |

ข้อมูล trunk เบอร์ และการจัดสรรเก็บในฐานข้อมูลและจัดการผ่าน Platform Console Kamailio อ่านจากฐานข้อมูลแบบอ่านอย่างเดียว ไม่แก้ไฟล์ config ต่อ tenant ความลับของ trunk เก็บตามแนวทาง secret เดิม ไม่เก็บใน repo

### 4. กติกาแยก tenant ที่ขอบ SIP

- สายออกต้องใช้เบอร์ต้นทางที่จัดสรรให้ tenant นั้น หรือเบอร์ใน trunk ของ tenant นั้น
- สายของ tenant หนึ่งห้ามออก trunk ของ tenant อื่น
- มีเพดานจำนวนสายพร้อมกันและอัตราโทรออกต่อ tenant เมื่อเกินให้ปฏิเสธสายใหม่ของ tenant นั้นโดยไม่กระทบ tenant อื่น
- สายเข้าที่ระบุ tenant ไม่ได้ให้ปฏิเสธที่ Kamailio ไม่ส่งถึง FreeSWITCH

### 5. FreeSWITCH เป็น pool ใช้ร่วมกัน

CCaaS ใช้ FreeSWITCH หลายตัวร่วมกันทุก tenant แบบ N+1 Kamailio ตรวจสถานะแล้วกระจายสาย tenant รายใหญ่แยก pool ของตัวเองได้ด้วยการตั้งค่า ไม่เปลี่ยนโครง เมื่อ FreeSWITCH ตัวใดล่ม สายที่คุยอยู่บนตัวนั้นหลุด สายใหม่ไปตัวที่เหลือ

### 6. เสียงของ Agent

Agent ต่อ SIP over WSS และเสียง WebRTC กับ FreeSWITCH ตัวที่ D-Contact กำหนดให้ ผ่านชื่อของโหนดนั้น ตามรูปแบบ `telephonyNodeId` คู่กับ `wssUrl` ที่มีอยู่ CCaaS ต้องมี TURN เพราะ Agent อยู่บนอินเทอร์เน็ต ส่วน on-prem ไม่ต้องมี การวาง rtpengine คั่นหน้า FreeSWITCH เพื่อไม่เปิด FreeSWITCH ออกอินเทอร์เน็ตยังไม่ตัดสิน

### 7. Profile on-prem

ติดตั้ง stack เดียวกันในไซต์ลูกค้าเป็น tenant เดียว ใช้ trunk หรือ PBX ของลูกค้า ไม่ต้องต่ออินเทอร์เน็ต ใช้ license แบบตรวจออฟไลน์ตาม [ADR-009](009-plan-entitlement-licensing.md) และ object storage ตาม [ADR-029](029-object-storage.md) ขนาดเครื่องกำหนดจากผล load test ของจำนวนสายพร้อมกันจริง ไซต์ขนาดเล็กติดตั้งบนเครื่องเดียวด้วย Docker Compose ได้ โดยใช้ Kamailio และ FreeSWITCH อย่างละตัวและไม่มีเครื่องสำรอง ซึ่งเป็นข้อยกเว้นของคู่ active/standby ในข้อ 2 และ N+1 ในข้อ 5 รายละเอียดเครือข่ายอยู่ใน [voice-network-deployment.md](../voice-network-deployment.md)

## ทางเลือกที่ปัดตก

- คง Asterisk สำหรับ on-prem ตาม ADR-006: ต้องดูแลสอง gateway และสองชุดทดสอบ และ feature ของ CCaaS กับ on-prem เสี่ยงไม่เท่ากัน
- ให้ FreeSWITCH ถือ trunk ต่อ tenant เอง: ต้องตั้งค่าทุกโหนดให้ตรงกัน และ provider ต้อง whitelist IP หลายชุดที่เปลี่ยนเมื่อเพิ่มโหนด
- แยก FreeSWITCH ต่อ tenant ตั้งแต่ต้น: แยกขาดกว่าแต่ต้นทุนต่อ tenant สูง เก็บไว้เป็นทางเลือกสำหรับรายใหญ่

## ผลที่ตามมา

- ดูแลและทดสอบ voice stack ชุดเดียว feature ของ CCaaS กับ on-prem เท่ากัน
- Kamailio เป็นส่วนประกอบใหม่ที่ต้องมี config ชุดทดสอบ และการเฝ้าระวังของตัวเอง
- ต้องเพิ่มโมเดลข้อมูล trunk เบอร์ และการจัดสรรต่อ tenant พร้อมหน้าจัดการใน Platform Console
- ลูกค้า on-prem ที่ต้องการให้ D-Contact ควบคุม Asterisk เดิมโดยตรงจะทำไม่ได้ ต้องเชื่อมผ่าน SIP trunk
- ค่า `asterisk` ใน `TelephonyVendor` และจุดตรวจ vendor ในโค้ดยังอยู่และไม่มีผลต่อการทำงาน การลบเป็นงานแยก
- ข้อความใน [ADR-011](011-outbound-campaign.md) ที่ให้ dialer รันบน Asterisk ได้ ไม่เป็นเงื่อนไขอีกต่อไป แต่หลักไม่ผูก vendor ที่ router ยังคงอยู่

## สถานะการลงมือ

ยังไม่ได้ implement: config ของ Kamailio, โมเดลข้อมูล trunk และเบอร์, หน้าจัดการใน Platform Console, ชุดติดตั้ง on-prem และ load test

owner ยืนยันเมื่อ 11 พฤศจิกายน 2569 ให้เก็บ ADR นี้และเอกสารประกอบเป็นแบบอ้างอิงก่อน ยังไม่เริ่มแผนขึ้นระบบจริงและไม่เปิด issue ติดตาม จนกว่า owner แจ้งว่าพร้อมทดสอบ
