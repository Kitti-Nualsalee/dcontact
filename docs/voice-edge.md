# Kamailio voice edge

ขอบ SIP ตาม [ADR-038](adr/038-single-voice-stack-tenant-trunks.md) สำหรับรุ่น Solo บน UAT (#923) Kamailio ตัวเดียว ไม่มี VIP รับสายจาก trunk แล้วส่งต่อ FreeSWITCH และส่งสายออกจาก FreeSWITCH ไปยัง trunk

สถานะ: ทดสอบกับ FreeSWITCH จริงและ SIPp บนเครื่อง dev แล้ว ยังไม่ขึ้น UAT

## ไฟล์

| ไฟล์ | ใช้ทำอะไร |
| --- | --- |
| `infra/voice-edge/kamailio/` | image และ `kamailio.cfg` ใช้แพ็กเกจ Kamailio ของ Debian trixie (6.0) |
| `infra/voice-edge/schema.sql` | ตาราง `tenant_edge`, `trunk`, `number` ในฐาน voice edge ที่แยกจากฐานของแอป |
| `infra/voice-edge/grant-kamailio.sql` | role `kamailio_ro` อ่านอย่างเดียว |
| `infra/voice-edge/test/` | stack ทดสอบ: PostgreSQL, Kamailio, FreeSWITCH และ SIPp เป็น trunk จำลองสองราย |
| `infra/freeswitch/conf/dialplan/pstn.xml` | extension `dcontact-inbound-voice-edge` รับ domain ของ tenant จาก Kamailio |

## เส้นทางสาย

**สายเข้า** trunk → Kamailio → FreeSWITCH (profile `pstn-sim` พอร์ต 5080) → park ให้ Router

1. ลบ header `X-DContact-*` ที่มาจากภายนอก
2. ตรวจว่าเบอร์ปลายทางเป็นตัวเลข 3–20 หลัก ไม่ใช่ตอบ 404
3. หาเบอร์ที่ผูกกับ trunk ของ IP ต้นทาง ไม่เจอตอบ 403 ซึ่งรวม IP ที่ไม่อยู่ในตาราง และเบอร์ของ tenant อื่น
4. นับเพดานสายพร้อมกันของ tenant เกินตอบ 503
5. ใส่ `X-DContact-Domain: <SIP domain ของ tenant>` เปลี่ยนเบอร์ปลายทางเป็น `route_to` (2000 คิวตรง, 2001 IVR หรือ 2002–2009 สำหรับคิว managed ตาม #977) แล้วส่งให้ FreeSWITCH ใน dispatcher set 1

FreeSWITCH ตั้ง `domain_name` จาก header เพื่อให้ telephony หา tenant จาก `Tenant.sipDomain` ตามเดิม แล้วลบ header ก่อน park

**สายออก** FreeSWITCH → Kamailio → trunk

- สายที่มาจาก IP ใน dispatcher set 1 ถือเป็นสายออก
- ต้องมี `X-DContact-Domain` เบอร์ต้นทางต้องเป็นของ tenant นั้น และออกได้เฉพาะ trunk ที่เบอร์ผูกอยู่ ไม่ผ่านตอบ 403
- ลบ `X-DContact-*` ก่อนส่งให้ trunk และนับเพดานเดียวกับสายเข้า

FreeSWITCH สั่งสายออกด้วย dial string แบบนี้:

```text
{sip_h_X-DContact-Domain=<tenant domain>,origination_caller_id_number=<เบอร์ของ tenant>}sofia/pstn-sim/<ปลายทาง>@<Kamailio>:5060
```

แอปยังไม่ได้ใช้ dial string นี้ เพราะ resolver ของสายออกยังรับเฉพาะ extension ภายใน `1xxx` การต่อสายออกจากแอปไปเบอร์ภายนอกเป็นงานแยก

## ข้อมูล trunk และเบอร์

รอบนี้ operator ใส่ข้อมูลด้วย SQL ส่วนหน้าจัดการใน Platform Console เป็นงานภายหลัง `tenant_domain` ต้องตรงกับ `Tenant.sipDomain` ของแอป

```sql
INSERT INTO tenant_edge (tenant_domain, max_channels) VALUES ('<tenant>.sip.example', 35);
INSERT INTO trunk (id, name, tenant_domain, source_ip, host)
  VALUES ('lan-sim', 'สายจำลองใน LAN', '<tenant>.sip.example', '<IP ของเครื่องจำลอง>', '<IP ของเครื่องจำลอง>');
INSERT INTO number (e164, tenant_domain, trunk_id, route_to)
  VALUES ('021000001', '<tenant>.sip.example', 'lan-sim', '2000');
```

- `trunk.tenant_domain` เป็น NULL ได้ หมายถึง trunk กลางที่ใช้ร่วมหลาย tenant
- trigger กันไม่ให้เบอร์บน trunk ของ tenant หนึ่งเป็นของ tenant อื่น
- Kamailio อ่านข้อมูลทุกสาย ไม่ cache จึงเห็นการเปลี่ยนทันที

## ทดสอบบนเครื่อง dev

```bash
bash infra/voice-edge/test/run.sh
```

ต้องมี Docker ใช้ network `172.30.50.0/24` และไม่ publish พอร์ตออก host ใส่ `KEEP=1` เพื่อเก็บ stack ไว้ดู log ผลที่ต้องได้คือ `ผ่าน 14 ไม่ผ่าน 0` ครอบคลุม:

- IP ที่ไม่อยู่ในตาราง, เบอร์ของ tenant อื่น และปลายทางที่ไม่ใช่ตัวเลข ถูกปฏิเสธโดยไม่ถึง FreeSWITCH
- สายเข้าได้ domain ของ tenant ที่ถูกต้องแม้ผู้โทรส่ง header ปลอม
- สายที่สองเกินเพดานถูกปฏิเสธ 503
- รับสายและวางสายผ่าน Record-Route ของ Kamailio
- สายออกถึง trunk โดยไม่มี header ภายในหลุด
- สายออกด้วยเบอร์ของ tenant อื่น หรือไม่ระบุ tenant ถูกปฏิเสธ

กติกาใน config ที่ห้ามหายถูกตรวจแบบ static ใน `pnpm test:freeswitch-config` ซึ่งไม่ต้องใช้ Docker

## ยังไม่ได้ทำ

- ขึ้นบน VM1 ของ UAT, จำกัด ACL ของ profile `pstn-sim` ให้รับเฉพาะ IP ของ Kamailio และ ESL รับเฉพาะ VM2
- อัตราโทรออกต่อ tenant, TLS/SRTP กับ trunk, การลงทะเบียน Kamailio ไปหา provider และคู่ active/standby
- สายออกจากแอปไปเบอร์ภายนอก
