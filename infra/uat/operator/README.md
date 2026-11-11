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

`--inspect`/`--check` ไม่มี mutation; check ที่ยังไม่มี snapshot จะ FAIL ให้ใช้ apply หลังตรวจ scope แล้ว มีเพียง DNAT/FORWARD ของเครือข่ายทดสอบ `192.168.0.0/16` ↔ IP ปัจจุบันของ FreeSWITCH UAT, UDP `16384–16420` เดิม และ reply ไป ephemeral ports ที่ `ESTABLISHED` แล้วเท่านั้น ไม่อนุญาต NEW provider egress ช่วงนี้รองรับ VPN ที่เปลี่ยน IP ระหว่างทดสอบ ต้องตรวจคำยืนยัน scope ใน #657 ก่อน deploy/apply และห้ามขยายนอกช่วงนี้เอง สำหรับ HTTPS ให้เพิ่ม `192.168.0.0/16` ใน `UAT_ALLOWED_CIDRS` โดยคงรายการเดิม หากมี snapshot ของ scope เก่า ให้หยุดเพื่อตรวจด้วยมือ: restore ด้วย operator รุ่นเก่ายังเหลือ snapshot ที่ปิดอยู่และ operator รุ่นใหม่จะปฏิเสธ ต้องตรวจว่า owned rules ถูกถอดครบ แล้วเก็บ snapshot เดิมแยกพร้อมรักษา audit ก่อนใช้ scope ใหม่ ห้ามลบหรือย้าย snapshot ขณะที่ยังมี owned rules

Operator ใช้ chain/jump ที่มี ownership marker เฉพาะงานนี้, lock และ audit/state ที่ root-owned ใน `/var/lib/dcontact-uat-e1-media/`; state เป็น non-secret อ่านได้แต่แก้ได้เฉพาะ root Apply ซ้ำไม่เพิ่ม rule และไม่ reset counter/ledger หากมี chain/rule/reference รวม `goto` ไม่ตรง ownership จะหยุดโดยไม่แตะ firewall; failure คืน owned state ที่ยังปลอดภัยหรือปิด snapshot แบบ fail-closed หากแจ้ง rollback failed ต้องตรวจด้วย root ก่อน ห้ามนับว่า apply/restore ผ่าน หาก reboot ล้าง owned rules ทั้งหมด แต่ snapshot เดิมยังอยู่ จะ apply/restore ได้โดยไม่แตะ unrelated rules; owned rules ที่เหลือบางส่วนแบบไม่ตรงแผนยังต้องตรวจด้วยมือ

เขียน audit `snapshot.publish.intent` ให้สำเร็จก่อนเผยแพร่ enabled snapshot แบบ atomic หาก audit/filesystem ล้มจะไม่เปิด snapshot ใหม่จากผลล้มเหลว Event นี้เป็น intent ไม่ใช่หลักฐานว่า apply สำเร็จ; ต้องใช้ผลคำสั่งและ root check ของ firewall ที่รันจริงร่วมกัน

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

### #868: เก็บ journal หลัง record commit ครบแล้ว

`b868-record-journal-retire.py` รับ `--expected-desired-sha256` และ `--expected-intent-sha256`
จาก journal ที่ operator ตรวจแล้ว ใช้ exclusive lock เดียวกับ deploy และยอมทำงานเมื่อ archive,
current, previous และ committed marker ครบตรงตาม intent เท่านั้น ไม่ซ่อม transaction ที่ยังไม่ commit
และไม่เปลี่ยน deployment pointer, runtime หรือ DB

ก่อนย้าย journal จะสร้าง `uat-record-retirement.pending` และ sync ไฟล์/metadata ของ record,
marker และ snapshots ทั้งหมด แล้วเก็บ journal ทั้ง directory เป็น `operator/uat-record-completed-*`
พร้อมตรวจ readback หาก mandatory sync/readback ล้ม gate จะคงอยู่ให้ deploy/reconciliation หยุด
ต้องตรวจ intent, snapshots และ directory ที่เก็บไว้ก่อนกู้ต่อ ห้ามลบ gate เพื่อข้ามการตรวจ

หลังข้อมูลครบและ durable แล้วจึงถอน gate หาก sync การถอน gate ล้ม ผลจะระบุ
`cleanupDurable=false` และ `RETIRE_GATE_REMOVAL_DURABILITY_UNKNOWN`; gate อาจกลับมาหลัง reboot
จึงต้องตรวจอีกครั้ง ผล `COMMITTED_JOURNAL_RETAINED` ไม่รับรอง provenance ของ release หรือ rollback:
`runtimeVerified` และ `rollbackCertified` ยังคงเป็น `false` การทดสอบ process exit ไม่ใช่การทดสอบ power loss

### #868: กู้ record transaction ที่ commit ไม่ครบ

`b868-record-forward-recovery.py --apply` ใช้เฉพาะ `deploy` record V1 ที่ runtime ทั้งสี่ component
ตรงกับ desired ใน journal และมี current/previous อยู่แล้ว กรณี rollback, mixed source หรือไม่มี pointer
ที่หลักฐานต้องใช้จะถูกปฏิเสธ ไม่ผ่อน validator เพื่อให้ผ่าน

ผู้เรียกต้องส่ง `--evidence` เป็นไฟล์ส่วนตัวใต้ `/opt/dcontact-uat/operator`,
`--approved-evidence-sha256` ของ canonical JSON และ `--approved-intent-sha256` ของ intent bytes
ที่ owner อนุมัติจากการ review อิสระ พร้อม `--actor operator:<ชื่อ>` ตัว hash ตรวจเพียงความตรงของ
ข้อมูล และ actor เป็น audit label; CLI ไม่ได้พิสูจน์ตัวตนหรือสร้าง approval ให้เอง หลักฐานมีอายุไม่เกิน 300 วินาที

คำสั่งถือ exclusive lock ตลอด ตรวจ runtime/ops และอ่าน protected runtime กับ migration ledger สดก่อน–หลัง
การเขียน โดยใช้ helper และ collector จาก bytes ที่ตรงกับ hash ที่ pin ไว้ การอ่าน ledger ใช้ probe container
แบบ read-only ชั่วคราวที่จำกัดทรัพยากรและตรวจ ownership ตอน cleanup ไม่เปลี่ยน application containers หรือข้อมูลแอป

เมื่อข้อมูลตรงจึงเขียน archive → previous จาก snapshot → current → committed marker แบบ atomic พร้อม
fsync/readback โดยคง journal ไว้ หาก postcheck หรือหลักฐานหมดอายุหลังเขียน จะคง `forward-postcheck.pending`
ให้ retirement หยุด ต้องตรวจและอนุมัติ observation ปัจจุบันใหม่ก่อน retry ไม่ใช้ไฟล์เก่าหรือข้าม gate
staging ของ archive ผูกกับ journal เพื่อเก็บ hard link ที่ค้างจากการขัดจังหวะได้อย่างระบุเจ้าของ
หากยังพบ alias ของ archive ที่ไม่อยู่ในขอบเขตนี้ จะหยุดให้ตรวจ ไม่ลบไฟล์อื่นเพื่อให้ผ่าน

หลัง postcheck ผ่านจะเก็บ `forward-postcheck.json` ที่ผูก intent/request/evidence แล้วจึงถอนเกต postcheck
ผล `RECORD_TRANSACTION_COMMITTED_PENDING_RETIREMENT` ต้องเรียก retirement แยกต่อ ซึ่งตรวจหลักฐานนี้ด้วย
หาก `postcheckGateCleanupDurable=false` เกตอาจกลับมาหลัง reboot ต้องตรวจซ้ำ ผลทั้งหมดนี้ไม่รับรอง compatible
rollback และไม่สร้าง smoke PASS, realm receipt หรือ final C

### #868: เติม observation ราย component โดยรักษา layout เดิม

Manifest `UatCompositeEvidenceManifestV3` เพิ่ม `componentPackages` ครบ API, sandbox, proxy และ Keycloak
โดยผูกแต่ละ component กับ `release.env` ของ source ที่ใช้จริงผ่าน hash, OCI reference และ digest
ผลที่ประกอบยังเป็น proposal ไม่ถือว่า artifact hash พิสูจน์ build attestation หรืออนุมัติให้เขียนเอง

`b868-record-reconcile.py` เตรียม record แบบ additive จาก `UatDeploymentReconciliationV1` ที่ถูก quarantine
ไว้เท่านั้น คง `sourceSha`/`images` และ fields เดิมสำหรับ release-layout readers แล้วอธิบาย fields ประวัติเหล่านี้
ใน `legacyAnchor` ข้อมูลปัจจุบันอยู่ใน `components`, `componentPackageBindings` และ `observationProof`
ซึ่งผูก actual observation bytes และ ledger snapshot ไม่เปลี่ยน realm digest ที่ยังเป็น `null` และไม่สร้าง smoke PASS ใหม่

การตรวจ runtime รุ่นนี้รู้จัก `legacyAnchor` และเปรียบเทียบ source/image/config/identity กับข้อมูลราย component
โดยคง `rollbackCertified=false`; reader เก่าที่ไม่รู้จัก fields ใหม่ยังไม่ถือว่าผ่าน release certification

### #868 ตรวจหลักฐานก่อนซ้อม API-only rollback

ใช้ observation สดจาก `release-evidence-observe.py` ก่อนเปลี่ยน API ตรวจว่า current record แบบ reconciliation
ตรงกับ runtime ราย component, protected services และ migration ledger ปัจจุบัน ตัวตรวจใช้ API ที่สังเกตได้จริง
เป็น target ของการซ้อม โดยแยก historical layout ออกจาก API source

ไฟล์ `UatApiRollbackRehearsalV1` ใช้ `scope=ISOLATED_POSTGRES_SYNTHETIC_IDENTITY` และบันทึกผลซ้อม
จาก PostgreSQL แยกและ identity fixture ที่ลงนาม token เอง เก็บข้อมูลเท่าที่ตัวตรวจใช้

- `baselineMigrations` และ `candidateMigrations` เป็นรายการ `{name, checksum}` ของ migrations ที่ finished
  และยังไม่ rolled back จาก Prisma ledger ก่อนและหลังใช้ candidate ops image
- `candidateOpsImage` เป็น OCI reference แบบระบุ digest ที่ใช้ migrate จริง
  `candidateReleaseEnvSha256` และ `candidateMigrationGuardSha256` เป็น SHA-256 ของ bytes จาก package เดียวกัน
- `phases` เรียง `baseline`, `candidate`, `rollback`, `recovery` แต่ละรายการเก็บ `phase`, `sourceSha`, `apiImage`,
  `profile`, `migrationChecksumsSha256`, `agentSnapshot`, `mismatchedTenant` และ `providerEgress` เก็บ hash ของ
  `{migrationName: checksum}` แบบ canonical JSON โดยใช้ schema ใหม่ต่อเนื่องตั้งแต่ candidate จนจบ recovery
- `protectedFixtureAndLedgerPreserved` เป็น `true` เมื่อผลตรวจหลัง recovery ตรงกับข้อมูลทดสอบและ ledger หลัง migrate

Reviewer ตรวจผลรันและให้ SHA-256 ของ canonical JSON สำหรับ observation และ rehearsal แยกจากไฟล์หลักฐาน
ใช้ `json.dumps` ด้วย `sort_keys=True` และ `separators=(',', ':')` แล้ว hash UTF-8 bytes โดยไม่มี newline ท้ายไฟล์
รันจาก checkout ที่ผ่าน review โดยใช้ไฟล์ปกติใน operator directory ส่วนตัว

```sh
python3 -B infra/uat/operator/release-candidate-validate.py \
  --observation /private/operator/observation.json \
  --approved-observation-sha256 "$OBSERVATION_SHA256" \
  --api-rehearsal /private/operator/api-rehearsal.json \
  --approved-rehearsal-sha256 "$REHEARSAL_SHA256" \
  --release-env /private/operator/release.env \
  --migration-guard /private/operator/migration-guard.json
```

`ISOLATED_API_ROLLBACK_REHEARSAL_MATCHES_BASELINE` ยืนยันว่า package, UAT-M01, schema และ API ที่ซ้อม
สอดคล้องกับ observation ก่อน maintenance ผลคง `rollbackEligible=false` และ `rollbackCertified=false`
ก่อนเปลี่ยน runtime ต้องตรวจ identity generation จริง, worker drain, external outcomes และ protected data
ภายใต้ maintenance window และ lock ของ UAT แล้วเก็บหลักฐาน rollback/recovery และ cleanup ตาม #704

### #868 ซ้อมคำสั่งสลับ API และ recovery ใน Docker sandbox

ใช้ API/ops images แบบ OCI digest จาก package ที่ตรวจแล้ว ตั้ง `TARGET_API`, `CANDIDATE_API`, `TARGET_OPS`,
`CANDIDATE_OPS` และ `CANDIDATE_SHA` ให้ตรงกับคู่ release ที่ต้องซ้อม เตรียม images ทั้งสี่ใน Docker แล้วสร้าง
network และ PostgreSQL ของการซ้อมด้วยชื่อ project ใหม่ ฐานนี้ใช้ credential สำหรับข้อมูลสังเคราะห์

```sh
PROJECT="dcontact-868-rehearsal-$(openssl rand -hex 6)"
docker network create --internal --label "com.dcontact.rehearsal=$PROJECT" "$PROJECT"
docker run --rm -d --name "$PROJECT-db" --network "$PROJECT" --network-alias rehearsal-db \
  --label "com.dcontact.rehearsal=$PROJECT" -e POSTGRES_DB=dcontact_868 \
  -e POSTGRES_PASSWORD=rehearsal_owner postgres:15.4
docker exec "$PROJECT-db" pg_isready -h 127.0.0.1 -U postgres -d dcontact_868
```

เมื่อ PostgreSQL พร้อม ให้ apply schema เดิมและ schema candidate ตามลำดับบนฐานแยก

```bash
(
  set -eo pipefail
  for ops in "$TARGET_OPS" "$CANDIDATE_OPS"; do
    docker run --rm --platform linux/amd64 --network "$PROJECT" \
      -e DATABASE_URL=postgresql://postgres:rehearsal_owner@rehearsal-db:5432/dcontact_868 \
      "$ops" prisma migrate deploy --schema prisma/schema.prisma
  done
  git show "$CANDIDATE_SHA:packages/db/prisma/rls.sql" | \
    docker exec -i "$PROJECT-db" psql -U postgres -d dcontact_868 -v ON_ERROR_STOP=1 -q
  docker exec "$PROJECT-db" psql -U postgres -d dcontact_868 -v ON_ERROR_STOP=1 \
    -c "ALTER ROLE dcontact_app WITH LOGIN NOBYPASSRLS PASSWORD 'dcontact_app'"
)
```

รันทีละคำสั่งและตรวจ exit status ทุกครั้ง

```sh
run_api_rehearsal() {
  python3 -B infra/uat/operator/b868-api-rehearsal-switch.py "$1" --project "$PROJECT" \
    --candidate-image "$CANDIDATE_API" --target-image "$TARGET_API"
}
run_api_rehearsal start
run_api_rehearsal rollback
run_api_rehearsal recover
```

คำสั่งใช้ project ชื่อ `dcontact-868-rehearsal-*` กับ internal network ที่ติด label ของ project และสลับเฉพาะ
Compose service `api` จาก image ในเครื่อง `rollback` บันทึก `pending.json` ก่อนหยุด API เดิม หากคำสั่งถูกขัดจังหวะ
ให้ใช้ `recover` กับ project และ image คู่เดิม ตัวรันตรวจ Docker state ของ API และ PostgreSQL ก่อนกลับ candidate
เมื่อ smoke ผ่านจึงบันทึก `recovery.json` แล้วถอน pending ใน `~/.local/state/dcontact-868-rehearsal/$PROJECT/`
`rollbackApiId` ในไฟล์ recovery จะมีค่าเมื่อ target เคยผ่าน smoke และบันทึกผลแล้ว

หลังซ้อมให้หยุดและลบเฉพาะ `$PROJECT-api-1` จากนั้นหยุด PostgreSQL ของ project แล้วลบ network ที่สร้างไว้
ผล smoke ใช้ `uat-workspace` บน sandbox สำหรับตรวจขั้นตอนสลับและ recovery ส่วนการซ้อมบน VM ใช้เกต identity,
worker drain, external outcomes และ protected state ของ #868 ก่อนเปลี่ยน runtime
Platform ยังคงใช้ path จาก source anchor เดิม ส่วน media operator ที่ต้องการ API/sandbox source เดียวกัน
ยังหยุดเมื่อ runtime mixed ไม่ถือว่า observation นี้ซ่อม runtime หรือผ่าน media gate

ก่อน apply ต้อง review manifest hash และ stable record hash จากข้อเสนอ `--approved-stable-record-sha256`
ซึ่งไม่รวม `recordedAt` actor เป็น audit label การอนุมัติต้องมาจาก review อิสระเช่นเดียวกับ recovery
ตัวเขียนใช้ lock/CAS/readback เดิมและ `preserve_previous=True` เพื่อเก็บ previous เดิม byte-for-byte
พร้อม snapshot และตรวจ live หลังเขียน current ก่อนยืนยัน receipt หาก postcheck ล้มหรือไม่แน่ใจ
จะคง reconciliation pending ให้ตรวจ ไม่มีการ restart หรือเขียน DB

### #868 หยุดรับคำขอแก้ไข People ระหว่างสลับ API

Fence อยู่ที่ Caddy จึงมีผลกับ API ทุกรุ่นที่สลับไปมาในช่วงนี้ เมื่อมีไฟล์
`/opt/dcontact-uat/admission-fence/people-mutations` บน VM2 proxy จะตอบ `503`
`{"code":"CAPABILITY_NOT_READY","reason":"ADMISSION_FENCED"}` กับคำขอที่ไม่ใช่ `GET`/`HEAD`/`OPTIONS` ใต้
`/api/v1/tenant-voice/people` ได้แก่ create, disable, reconcile, invitation resend และ skills ก่อนคำขอถึง API.
ส่วน GET รวม `operations/:id` ยังผ่านตามปกติ worker ใน API ไม่ผ่าน proxy จึงทำงานเดิมต่อจนจบ และ Console
ทุกรุ่นอ่าน code นี้เป็นคำขอที่ไม่ถูกรับ

Route และ mount (`/run/dcontact-admission-fence` แบบอ่านอย่างเดียว) ต้องอยู่ใน current layout ก่อน maintenance
window โดย deploy release ที่มี route ตามขั้นตอนปกติ `uat-deploy.sh` จะสร้าง directory ให้แต่ไม่สร้างไฟล์ fence.
การเปิดหรือปิด fence ไม่ต้อง reload หรือ restart proxy

```sh
# VM2: เปิด fence
install -m 0444 /dev/null /opt/dcontact-uat/admission-fence/people-mutations
```

ยืนยันจากเครื่องใน allowlist ผ่าน VM1 คำขอนี้ไม่มี token จึงไม่สร้างงานแม้ fence ยังไม่ทำงาน

```sh
python3 -I infra/uat/operator/b868-people-drain-observe.py probe "https://$UAT_HOST"
```

ต้องได้ `FENCE_ACTIVE` และ exit 0 จากนั้นตรวจ drain บน VM2 ด้วย DB principal และ helper ที่ review แล้ว
ชุดเดียวกับ `release-evidence-observe.py`

```sh
python3 -I /opt/dcontact-uat/operator/<package>/b868-people-drain-observe.py drain
```

คำสั่งค้นทุกตาราง `tenant_people_*` ที่มี `state` หรือ `lease_expires_at` และยืนยันว่า principal มี `BYPASSRLS`
เพราะตารางเหล่านี้ใช้ `FORCE ROW LEVEL SECURITY` จะสลับ API ได้เฉพาะเมื่อผลเป็น `DRAINED` (exit 0) คือทุกแถวอยู่ใน
`SUCCEEDED`/`REJECTED` และไม่มี lease ที่ยังถือ. `NOT_DRAINED` จะแสดงตารางและ state ที่ค้าง ให้รอ worker หรือ
reconcile ผลภายนอกก่อน `ACTION_REQUIRED` และ state ที่ไม่รู้จักถือว่ายังไม่ drain. `FENCE_NOT_ARMED` หมายถึง
ไม่พบไฟล์ fence. ให้เก็บผลทั้งสองคำสั่งพร้อม hash ไว้กับหลักฐานของ window. ผลเหล่านี้ไม่รับรอง rollback และ
`rollbackCertified` เป็น `false` เสมอ

คง fence ไว้ตลอด candidate → target → candidate แล้วเอาออกหลัง readback ของ candidate ผ่าน

```sh
# VM2: ปิด fence
rm -f /opt/dcontact-uat/admission-fence/people-mutations
```
