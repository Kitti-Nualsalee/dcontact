# RTP สำหรับ Workspace UAT บนเครื่อง local

ขอบเขต #786 ภายใต้ #714 ใช้เฉพาะ Compose project `dcontact-v1b-local`
ไม่ใช่ VM UAT หรือหลักฐาน final acceptance

## Topology และข้อจำกัด

- Docker Desktop อาจไม่สร้าง host publication ให้ container ที่อยู่บน internal network เท่านั้น แม้ Compose ระบุ ports แล้ว ต้องตรวจ realized mappings จริง
- `local-rtp-relay` publish เฉพาะ `127.0.0.1:16384–16420/udp` ผ่าน dedicated publication bridge
- relay ต่อเฉพาะ `rtp-publication` และ internal `rtp-media` ไม่เข้า application networks ไม่มี credentials หรือ capabilities เพิ่ม
- FreeSWITCH คง control network เดิม และเพิ่มเฉพาะ internal media network; SIP/WSS/ESL bind เฉพาะ control IP ส่วน RTP bind media IP
- เป็น topology/listener isolation ไม่ใช่ kernel egress firewall และไม่รับประกัน containment หาก relay process ถูกยึด
- loopback ไม่ใช่ authentication; ICE/DTLS/SRTP และ candidate ACL ต้องคงเดิม

## Input ที่ operator ต้องระบุ

ไม่มี subnet/IP defaults ก่อน deploy ต้องเลือก RFC1918 CIDRs ที่ไม่ชน Docker networks หรือ host/VPN routes และบันทึกค่าที่ตรวจแล้ว:

- `LOCAL_RTP_PUBLICATION_SUBNET`, `LOCAL_RTP_PUBLICATION_GATEWAY`, `LOCAL_RTP_PUBLICATION_ADDRESS`
- `LOCAL_RTP_MEDIA_SUBNET`, `LOCAL_RTP_MEDIA_GATEWAY`, `LOCAL_RTP_RELAY_MEDIA_ADDRESS`, `LOCAL_RTP_FREESWITCH_MEDIA_ADDRESS`

แต่ละ subnet ต้องมีอย่างน้อย 8 addresses และ canonical network boundary; gateway เป็น subnet+1, relay เป็น subnet+2 และ FreeSWITCH media เป็น media subnet+3
สอง subnet ต้องไม่ทับกัน ห้ามใช้ค่าทดสอบจาก tests เป็น production/local defaults โดยไม่ตรวจ routes จริง

CLI รับ `LOCAL_RTP_RELAY_PROJECT=dcontact-v1b-local`, `LOCAL_RTP_RELAY_HOST=workspace.dcontact.test` และ `LOCAL_RTP_RELAY_CONFIG_JSON` ที่ Compose render ให้เท่านั้น
ขาด marker, field เกิน, interface ไม่ใช่ของ relay หรือ bind ไม่ครบ ต้อง fail closed

## เกตและ lifecycle

1. ผ่าน focused relay/CLI และ Compose/wrapper tests รวม negative inputs, peer isolation, limits และ shutdown
2. ตรวจ candidate image/source/config digests, project labels, network/IP ownership และ idle ก่อน recreate FreeSWITCH
3. ตรวจ realized loopback mappings ครบ 37 ports ที่ relay; FreeSWITCH ไม่มี host ports และ media interface ต้องไม่รับ SIP/WSS/ESL
4. ทดสอบ synthetic UDP สองทางและ recreate/cleanup แยกจาก browser media
5. จึงทดสอบ actual browser ICE/DTLS/SRTP และให้ผู้ทดสอบยืนยันเสียงจริง; publication/UDP PASS ไม่เท่ากับ headset PASS

relay เก็บ socket แยกต่อ peer tuple ไม่ใช้ last sender และไม่ reuse backend ports `49152–53247` ภายใน process generation แม้ flow หมดอายุ
เมื่อ allocation budget หมดให้ปฏิเสธ flow ใหม่จน operator drain/idle แล้ว restart ไม่ล้าง reservation เงียบ ๆ
ไม่รับประกัน replay protection ข้าม process generation และไม่รับประกัน active-call survival ระหว่าง relay/FreeSWITCH restart

หาก FreeSWITCH recreate แม้ media IP เดิม ต้อง clear/recreate relay ใน idle window และตรวจ gates ใหม่
rollback ให้หยุด relayและคืน local overrides ตาม ledger ห้าม `down -v` หรือลบ identities/results/policies/dev-db
ห้ามลด authentication, candidate ACL หรือ DTLS/SRTP เพื่อทำให้เกตผ่าน

## ทดสอบเฉพาะจุด

```sh
pnpm --filter @d-contact/telephony exec tsx --test src/local-rtp-relay.test.ts src/local-rtp-relay-main.test.ts
node --test scripts/voice-v1b-local-compose.test.mjs
```

ผล tests เหล่านี้ไม่เปิดรับสาย ไม่ส่งอีเมล และไม่ใช่ actual FreeSWITCH listener หรือ headset acceptance
