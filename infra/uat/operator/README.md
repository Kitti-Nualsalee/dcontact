# ขั้นตอน operator สำหรับ UAT 3 VM (#537)

สคริปต์ถูกออกแบบให้รัน `--check` ก่อน แล้วจึง `--apply` ด้วย `sudo` บน VM ที่ระบุ ทุกสคริปต์ตรวจ IP/สภาพเดิมและหยุดเมื่อไม่ตรงกับ ADR-030 ห้ามนำ credential bundle ไปใส่ GitHub issue, chat หรือ Git

## VM3 — PostgreSQL 15.4 (`192.168.102.113`)

คัดลอก `vm3-bootstrap-uat.sh` และ `vm3-pg-hba-uat.sh` ไปที่ `/home/osdadmin/` แล้วรันตามลำดับนี้บน VM3:

```bash
sudo bash /home/osdadmin/vm3-bootstrap-uat.sh --check
sudo bash /home/osdadmin/vm3-pg-hba-uat.sh --check
sudo bash /home/osdadmin/vm3-bootstrap-uat.sh --apply
sudo bash /home/osdadmin/vm3-pg-hba-uat.sh --apply
```

bootstrap จะสร้าง role UAT 5 ตัวและ database 2 ตัว โดยไม่แตะ role/database เดิม รหัสผ่านสุ่มใหม่อยู่ใน `/home/osdadmin/dcontact-uat-db-credentials.env` (mode 600) เท่านั้น ต้องส่งต่อไฟล์นี้ไป VM2 ผ่าน SSH เพื่อประกอบ `uat.env` แล้วลบจาก VM3 หลังตรวจว่าค่าบน VM2 ใช้งานได้ ห้ามแสดงเนื้อหาไฟล์ใน log หรือ terminal transcript ที่แชร์ต่อ `dcontact_uat_owner` เป็นบัญชีเฉพาะงาน migrate/backup จึงเป็น `BYPASSRLS` แต่ยังเป็น `NOSUPERUSER`; API ใช้ `dcontact_app` ซึ่งต้องเป็น `NOBYPASSRLS` เสมอ

### ซ่อม VM3 ที่ bootstrap ไปแล้ว

ถ้า `uat-deploy.sh backup` รายงานว่า `pg_dump` ถูก FORCE RLS ปฏิเสธ ให้คัดลอก `vm3-uat-backup-role.sh` ไปที่ `/home/osdadmin/` แล้วรันบน VM3 ก่อน retry backup:

```bash
sudo bash /home/osdadmin/vm3-uat-backup-role.sh --check
sudo bash /home/osdadmin/vm3-uat-backup-role.sh --apply
sudo bash /home/osdadmin/vm3-uat-backup-role.sh --check
```

สคริปต์ยอมแก้เฉพาะ `dcontact_uat_owner` จาก `NOBYPASSRLS` เป็น `BYPASSRLS` หลังยืนยันว่าเป็น owner ของ `dcontact_uat`, ไม่ใช่ superuser และ `dcontact_app` ยังเป็น `NOBYPASSRLS`; ไม่แตะ role/database อื่นหรือ password ใด ๆ

สคริปต์ `pg_hba` สำรองไฟล์ก่อนแก้ แทรก 4 กฎก่อน broad `md5` เดิม ตรวจ `pg_hba_file_rules.error` และ `pg_reload_conf()` โดยไม่ restart PostgreSQL ถ้าตรวจหลังแก้ไม่ผ่าน จะคืนไฟล์สำรองและ reload กลับ

หลังรันให้แจ้งเฉพาะ `CHECK ผ่าน`/`APPLY ผ่าน` หรือ error ที่ไม่มี secret เพื่อให้ตรวจจากระยะไกลซ้ำได้

## VM2 — Docker stack (`192.168.102.112`)

หลัง `vm3-bootstrap-uat.sh --apply` สำเร็จ ให้รัน `vm2-install-uat-env.sh` จากเครื่อง operator ที่ SSH เข้า VM2/VM3 ได้ สคริปต์ใช้ `scp -3` ส่ง credential bundle ผ่านหน่วยความจำของเครื่อง operator โดยไม่ต้องมี SSH key ระหว่าง VM และไม่พิมพ์เนื้อหาไฟล์:

```bash
chmod 700 infra/uat/operator/vm2-install-uat-env.sh
bash infra/uat/operator/vm2-install-uat-env.sh
```

คำสั่ง Python สร้าง secret เฉพาะ Keycloak และ object storage เพิ่มเอง, สร้าง tenant UUID, ตรวจ bundle แล้วลบ bundle บน VM2 อัตโนมัติ ผลที่คาดคือ `600 osdadmin:osdadmin /opt/dcontact-uat/uat.env` โดยห้ามใช้ `cat`, `less` หรือส่งเนื้อหาไฟล์ออกจาก VM หลังยืนยันว่า VM2 ใช้งานได้ จึงลบ bundle ที่ VM3:

```bash
# รันจาก VM3 หลัง VM2 ยืนยันว่า uat.env สร้างสำเร็จ
shred -u /home/osdadmin/dcontact-uat-db-credentials.env
```

## VM1 — nginx edge (`192.168.102.114`)

คัดลอก `vm1-nginx-uat.sh` ไปที่ `/home/osdadmin/dcontact-vm1-nginx-uat.sh` แล้วรันบน VM1:

```bash
sudo bash /home/osdadmin/dcontact-vm1-nginx-uat.sh --check
sudo bash /home/osdadmin/dcontact-vm1-nginx-uat.sh --apply
```

สคริปต์ตรวจ wildcard cert/key ที่มีอยู่, เพิ่มเฉพาะ `dcontact-uat.osd.co.th.conf`, ตรวจ `nginx -t` ก่อน reload และไม่เขียนไฟล์ของ vhost อื่น รวมถึงเปลี่ยน permission ของ `/etc/nginx`, `conf.d`, `sites-enabled`, `ssl` จาก `777` เป็น `755` และ key เป็น `600` เพราะ directory/file ที่เปิดให้ทุก user เขียนได้ทำให้ key และ nginx config ถูกเปลี่ยนโดยผู้ใช้ทั่วไปบน VM1 ได้

เมื่อ E1.16 เปิด SIP WebSocket ให้ใช้ `vm1-nginx-websocket-uat.sh` เพื่อให้ nginx ส่ง `/sip-ws` ผ่าน Caddy ใน release ด้วย WebSocket tunnel ที่ปิด request/response buffering และลบ override ชั่วคราวที่ชี้ไป FreeSWITCH โดยตรง สคริปต์ยอมแก้เฉพาะ config UAT ที่ตรงกับ state เก่าที่รู้จัก, สำรองไฟล์ก่อนแก้, `nginx -t` ก่อน reload และคืน config เมื่อ test ไม่ผ่าน:

E1 overlay ส่งต่อจาก Caddy ไป `https://freeswitch:7443` เพื่อให้ transport ตรงกับ `Via: SIP/2.0/WSS` ที่ SIP.js ส่งมา การส่งต่อเป็น WS ไปพอร์ต 5066 อาจผ่าน HTTP upgrade แต่ไม่มี SIP response สำหรับ WSS Via จึงต้องตรวจ SIP `401` challenge และ `200` หลัง authentication เพิ่มจาก handshake `101` เสมอ FreeSWITCH สร้าง self-signed certificate ใน tmpfs `/etc/freeswitch/tls`; Caddy ยกเว้น certificate verification เฉพาะ upstream นี้ใน network internal ของ UAT ที่ไม่เปิดพอร์ต WSS บน host การตั้งค่านี้ใช้เฉพาะ acceptance sandbox; production ต้องใช้ upstream certificate ที่ตรวจสอบได้

```bash
sudo bash /home/osdadmin/vm1-nginx-websocket-uat.sh --check
sudo bash /home/osdadmin/vm1-nginx-websocket-uat.sh --apply
sudo bash /home/osdadmin/vm1-nginx-websocket-uat.sh --check
```

หาก VM2 ยังไม่เปิด Caddy ที่ `192.168.102.112:8080` ชื่อ UAT จะตอบ `502` ชั่วคราว แต่ vhost อื่นไม่ควรเปลี่ยน หลังเปิด stack ให้ตรวจ HTTPS ผ่าน hosts mapping `dcontact-uat.osd.co.th → 192.168.102.114` บนเครื่องผู้ทดสอบ

### Voice Delivery Gate ภายใน E1 sandbox

เมื่อ staging release ด้วย `umask 077` ให้รัน `uat-deploy.sh prepare "$SHA"` ก่อนขั้นอื่นเสมอ `prepare` คืน permission เฉพาะ template Caddy/HAProxy และไฟล์ config/โฟลเดอร์ของ FreeSWITCH ที่อยู่ใน source เพื่อให้ container non-root อ่านได้ ไม่ทำ recursive chmod ทั้ง release และไม่เปลี่ยน `uat.env`/`release.env` จาก 600 หาก config FreeSWITCH ถูกแทน placeholder ด้วย secret ใน source หรือ template เป็น symlink จะหยุด ให้ใช้ source จาก release ที่ตรวจสอบแล้วและ render secret ลง tmpfs ตาม entrypoint เท่านั้น ห้ามแก้ด้วยการเปิด permission ของ secret

ก่อน deploy release ที่มี command gateway ให้คัดลอก `vm2-e1-voice-secret.py` ไป VM2 แล้วรันด้วยเจ้าของ `/opt/dcontact-uat/uat.env`:

```bash
python3 /home/osdadmin/vm2-e1-voice-secret.py --apply
python3 /home/osdadmin/vm2-e1-voice-secret.py --check
```

สคริปต์สร้าง secret แยกจาก ESL/directory password และ backup permission 600 โดยไม่พิมพ์ secret ไม่เปิด flag และไม่เปลี่ยน rollout API ส่งเฉพาะ `call.originate`/`call.cancel` ไป `http://e1-sandbox:3001/commands` และ `sip.registration.flush` ไป `/registrations/flush` ใน internal network ไม่มี host port และไม่ส่งผ่าน Caddy/nginx API ไม่ได้รับ ESL password

`UAT_E1_OUTBOUND_VOICE_ENABLED` ปิดเป็นค่าเริ่มต้น ต้องเปิดเฉพาะ acceptance ของ tenant `UAT_TENANT_ID` หลังตั้ง scope ของ `e1-uat-sandbox` ผ่าน Voice rollout control plane เป็น `SANDBOX`, technical switch, caps และ allowlist ของ agent/target สังเคราะห์แล้ว ห้ามใช้ `CAPPED_PILOT` กับ gateway นี้ ห้ามเปลี่ยน provider egress และห้ามแตะ tenant #77

หลัง deploy release ใหม่ ใช้คำสั่งจาก release เดียวกับ container ที่รันอยู่เท่านั้น (แทนค่า SHA และ UUID ด้วย fixture ของ tenant ทดสอบ):

```bash
RUNNER="/opt/dcontact-uat/releases/$SHA/bin/uat-deploy.sh"
bash "$RUNNER" e1-voice-control "$SHA" status
bash "$RUNNER" e1-voice-control "$SHA" prepare operator:patiphan-phakam "$AGENT_USER_ID" "$TARGET_IDENTITY_ID"
bash "$RUNNER" e1-voice-on "$SHA" operator:patiphan-phakam
bash "$RUNNER" e1-voice-control "$SHA" status
```

`prepare` ยอมเฉพาะ tenant `dcontact-uat` ที่ ACTIVE, agent และ target ภายใน `1xxx` คนละ extension; ใช้ control plane เดิมเลื่อน DISABLED → DRY_RUN → SANDBOX, ปิด technical switch, ตั้ง caps 2 ครั้ง/นาทีและ 10 ครั้ง/วันของ tenant, 1 ครั้ง/นาทีและ 10 ครั้ง/วันของ agent แล้ว allowlist 30 นาทีแบบมี audit ไม่มีการ reset cap ledger `e1-voice-on` ปิด switch ก่อนตรวจว่าง แล้วเปิด SANDBOX switch และ recreate เฉพาะ API/sandbox ด้วย runtime flag ไม่ restart FreeSWITCH/proxy; เมื่อมี ASSIGNED/ACTIVE/WRAPUP จะหยุดโดยคง switch ปิด ไม่แตะสายที่คุยอยู่ routine deploy ไม่สืบทอด runtime override นี้และกลับ default-off

ปิดรับ originate ใหม่ผ่าน audited switch ได้ทันทีโดยไม่ restart container; หลังงาน VOICE จบทั้งหมดจึงคืน runtime default-off:

```bash
bash "$RUNNER" e1-voice-control "$SHA" off operator:patiphan-phakam
bash "$RUNNER" e1-voice-off "$SHA" operator:patiphan-phakam
```

gateway ตรวจ binding ภายใต้ tenant RLS: node, outbox `SUBMITTING`, reservation ที่ผ่าน `beginProviderSubmission`, cap ledger, lease, allowlist และ target identity ที่ resolve เป็น internal extension `1xxx` เท่านั้น จากนั้น insert `E1_SANDBOX_COMMAND_CLAIMED` ใน audit แบบ unique ก่อน ESL I/O การส่งซ้ำแม้ restart จะถูกปฏิเสธ; publisher ไม่ retry และผลไม่แน่นอนเข้า reconciliation ตาม gate เดิม ไม่อ้างว่า `socket.write` หรือ HTTP 202 คือการโทรสำเร็จ

ESL events ของ origination UUID ที่มี durable claim เท่านั้นเข้า `VoiceOriginateOutcomeProcessor`/Contact Governance; event ของขาอื่นไม่ settle delivery นี้ `BACKGROUND_JOB` failure ที่ผูกกับคำสั่งได้ใช้ outcome จริง ส่วนผลที่หายระหว่าง restart ยังต้อง reconciliation ไม่ resend และไม่ถือเป็นหลักฐาน DELIVERED การ cancel ที่ request ไว้แล้วทำได้แม้ technical switch ปิด; การปิด embed/auth ต้องไม่สั่งตัดสายที่คุยอยู่

SIP flush ทำงานได้แม้ outbound flag ปิด แต่ต้องผูก credential ที่ revoked และ lease ที่ released แล้วภายใต้ RLS ตรง tenant/node/domain/extension เท่านั้น ใช้ user row lock ร่วมกับ credential issuance; ถ้ามี credential ของ lease ใหม่จะปฏิเสธ ไม่ลบ registration ใหม่ การ issue ยัง lock lease แล้วตรวจ released/expiry อีกครั้ง จึงไม่หมุน credential แข่งกับ close ใช้เฉพาะ `sofia ... flush_inbound_reg` ไม่มี `uuid_kill`, audit หลัง ESL reply จริงและ flush ซ้ำที่สำเร็จแล้วไม่ส่ง ESL ซ้ำ timeout ไม่ retry อัตโนมัติและมี diagnostic แบบ opaque ให้ operator ตรวจต่อ ไม่ถือว่า flush transport นี้แทนหลักฐาน auth continuity หรือ single receiving point บน browser จริง

### LAN RTP ของ E1 UAT

FreeSWITCH ยังคงอยู่บน `internal:true` เพื่อปิด provider egress แต่ Docker ไม่ publish RTP จาก network นี้จริง แม้ Compose ระบุ port ไว้ ต้องให้ operator ใช้ root-only `operator/vm2-e1-media-uat.py` บน VM2 หลัง canonical deploy และขณะ runtime/technical switch ปิด, VOICE idle และไม่มีสาย คำสั่งนี้ไม่เพิ่ม edge network/SIP/ESL port ไม่เปลี่ยน PostgreSQL/Keycloak หรือ rule ของ service อื่น

```bash
MEDIA="/opt/dcontact-uat/releases/$SHA/operator/vm2-e1-media-uat.py"
sudo python3 "$MEDIA" --inspect
sudo python3 "$MEDIA" --check
sudo python3 "$MEDIA" --apply --actor operator:patiphan-phakam
sudo python3 "$MEDIA" --check
```

`--inspect`/`--check` ไม่มี mutation; check ที่ยังไม่มี snapshot จะ FAIL ให้ใช้ apply หลังตรวจ scope แล้ว มีเพียง DNAT/FORWARD ของ Mac `192.168.50.12/32` ↔ IP ปัจจุบันของ FreeSWITCH UAT, UDP `16384–16420` เดิม และ reply ไป ephemeral ports ของ Mac ที่ `ESTABLISHED` แล้วเท่านั้น ไม่อนุญาต NEW provider egress หาก IP ของเครื่องทดสอบเปลี่ยนต้องยืนยัน scope ใหม่ก่อน ห้ามขยายเป็น subnet/wildcardเอง

Operator ใช้ chain/jump ที่มี ownership marker เฉพาะงานนี้, lock และ audit/state ที่ root-owned ใน `/var/lib/dcontact-uat-e1-media/`; state เป็น non-secret อ่านได้แต่แก้ได้เฉพาะ root Apply ซ้ำไม่เพิ่ม rule และไม่ reset counter/ledger หากมี chain/rule/reference รวม `goto` ไม่ตรง ownership จะหยุดโดยไม่แตะ firewall; failure คืน owned state ที่ยังปลอดภัยหรือปิด snapshot แบบ fail-closed หากแจ้ง rollback failed ต้องตรวจด้วย root ก่อน ห้ามนับว่า apply/restore ผ่าน หาก reboot ล้าง owned rules ทั้งหมด แต่ snapshot เดิมยังอยู่ จะ apply/restore ได้โดยไม่แตะ unrelated rules; owned rules ที่เหลือบางส่วนแบบไม่ตรงแผนยังต้องตรวจด้วยมือ

ก่อน `e1-voice-on` runner ถือ shared media lock ตลอดการตรวจและเปิด runtime จึงไม่แข่งกับ root apply/restore; ตรวจ snapshot ให้ตรง source SHA/FS container/IP/host boot/iptables backend และ canonical profile `uat-e1`; ไม่เรียก sudo และไม่อ้างว่า metadata check แทน live firewall check เมื่อ deploy/FS recreate/reboot/เปลี่ยน iptables backend ให้รัน root check/apply ใหม่ก่อน acceptance โดยไม่เพิ่ม sudo NOPASSWD หรือ privileged container ตรวจ UDP marker จากเครื่องทดสอบให้ PASS และตรวจ RTP/เสียงจริงก่อนปิด #657; SIP200 หรือ UI กำลังสนทนายังไม่ใช่หลักฐานว่าเสียงผ่าน

Topology ที่ตรวจจริงบน VM2 วันที่ 2026-10-13 (Docker24) มี default route ของ FreeSWITCH ไป internal bridge gateway `172.21.0.1` แม้ network เป็น internal Operator ตรวจ route นี้ทุกครั้ง ไม่สมมติจากคำว่า internal และไม่เพิ่ม SNAT/default route หรือเปิด network ใหม่ หาก route หาย/ผิดให้หยุดด้วย `E1_MEDIA_RETURN_ROUTE_REQUIRED` และตรวจ topology ก่อน ยังต้องมี live UDP roundtrip เพื่อพิสูจน์ DNAT/FORWARD/reply จริง

คืน exception หลังทดสอบ ขณะ default-off/idle/0calls:

```bash
sudo python3 "$MEDIA" --restore --actor operator:patiphan-phakam
```

restore ลบเฉพาะ owned chain/jump ไม่ flush built-in และ snapshot กลับ disabled จึงเปิด voice-on ใหม่ไม่ได้จน operator apply อีกครั้ง หาก rollback ไป release ที่ไม่มี media helper ให้ restore ก่อน redeployขณะว่าง ไม่ปล่อย rule ของ IP เก่าค้าง ใช้ helper ที่เก็บไว้เพื่อ restore ได้เมื่อ current release ยังเป็น E1 UAT ที่รู้จักและ default-off/idle แม้ไม่มี media config รุ่นใหม่; ไม่อนุญาต apply ด้วย source เก่า ส่วน Sofia `local-network-acl=none` ทำให้ WSS ที่ผ่าน proxy ใช้ advertised LAN RTP address ไม่ใช่ Docker IP โดยคง auth/directory/lease/candidate ACL เดิม

### Launcher alias บน runtime ของ E1

HTML shell ของ E1 อ้าง bootstrap JS/CSS ด้วย query `release` จาก `SOURCE_SHA` ใน manifest เพื่อไม่ให้ browser ใช้ entry ของ release เก่าหลัง deploy และ Caddy ตอบ `Cache-Control: no-cache` ให้ชื่อ entry คงที่ทั้งสองไฟล์เพื่อ revalidate ด้วย ETag การมี query ไม่ได้ทำให้ bootstrap เป็น immutable/pinned asset; contract ของ launcher alias และไฟล์ตรึงเวอร์ชันพร้อม SRI ด้านล่างยังเหมือนเดิม ถ้า UI กับ server state ไม่ตรง ให้ตรวจ URL ของ script ใน iframe ว่าตรงกับ release ปัจจุบันก่อน ห้าม patch agent state เพื่อให้ acceptance ผ่าน

หลัง deploy release ที่มี overlay นี้ ขณะ outbound default-off และไม่มีสาย ใช้ `bash "$RUNNER" e1-launcher-enable "$SHA"` เพื่อ import release/SRI จาก image ที่ตรึง digest ไป named volume และ recreate เฉพาะ API ให้ mount แบบ read-only ไฟล์ source ของ helper ต้องผ่านขั้น `prepare` แล้ว ไม่มีการเปิดพอร์ตใหม่หรือส่งข้อมูล tenant ออกนอก stack

`bash "$RUNNER" e1-launcher-status "$SHA"` ตรวจ integrity; `bash "$RUNNER" e1-launcher-alias "$SHA" v1 1.0.0` ชี้ alias กลับ และ `... v1 1.0.1` คืนเวอร์ชันปัจจุบัน โดยไม่ restart API/FreeSWITCH หรือแก้ pinned asset การเปลี่ยน index เป็น atomic และ import ซ้ำเก็บ alias เดิม ไม่ยอมรับข้าม major, asset ที่ถูกแก้ หรือ symlink ก่อนเลื่อน alias ต้องมี contract/e2e บน host อ้างอิงตาม E1.7 ส่วน rollback ให้ใช้เวอร์ชันที่เคยผ่านแล้ว และตรวจ header/เนื้อหาจริงหลัง cache 5 นาที

คำสั่ง launcher ใช้ lock เดียวกันและปฏิเสธเมื่อมี operator อีกคำสั่งกำลังทำงาน จึงไม่ให้ import ทับ alias ที่กำลัง rollback

ไฟล์ `e1-launcher-hosting.enabled` อยู่นอก release; operator ของ release นี้สืบทอด mount เมื่อ E1 เปิดอยู่ ถ้าจะ rollback ไป release รุ่นเก่าที่ไม่มี overlay ต้องถอด E1 profile ก่อนตามขั้น rollback แล้วคืน profile/flag และทดสอบ smoke named volume ไม่ถูกลบ การมี helper หรือ unit tests ผ่านยังไม่ใช่หลักฐานว่าซ้อม alias บน UAT จริงแล้ว
