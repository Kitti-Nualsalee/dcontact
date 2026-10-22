# Hotfix proxy สำหรับ iframe ตรวจ session (#742)

ADR033 ใช้ `/auth/realms/dcontact/dc-account/login-status-iframe.html` ตรวจ session ของ Console และ Workspace ซึ่งมี origin ต่างกันตาม ADR026 จึงให้เฉพาะเอกสารนี้ใช้ framing policy ของ upstream Keycloak แทน global `X-Frame-Options: DENY` ของ Caddy โดยไม่ลบ policy ที่ upstream ส่งมา ส่วน `/init`, หน้า login, realm อื่น และหน้าทั่วไปยังใช้ DENY และคง edge/client allowlist กับ admin 404 เดิม

การแยก header ออกจาก block ที่มี `-Server` แล้วใช้ `>X-Frame-Options` ทำให้ DENY ของหน้าอื่นถูกกำหนดตอนส่ง response และไม่เกิด header ซ้ำกับ upstream ดู [Caddy header documentation](https://caddyserver.com/docs/caddyfile/directives/header)

## หลักฐานก่อน release

- รัน `node --test scripts/uat-session-iframe.boundary.mjs` โดยมี Docker และ OpenSSL ชุดทดสอบใช้ Caddy จริงทั้ง single TLS/3VM/LINE/E1 ภายในเครือข่าย disposable และใช้ upstream fixture เฉพาะขอบเขต proxy ไม่ใช่ OIDC หรือ browser acceptance
- ตรวจ exact path/query, การคง native framing policy, login/nearby paths ที่ยัง DENY, admin 404 และ peer/client allowlist 403 รวม TLS ที่เชื่อถือ cert ของ sandbox โดยไม่ปิด certificate verification
- Standards/Spec review และ CI ต้องผ่านบน SHA ที่นำ config ไปใช้ เก็บ SHA/config checksum/TAP/run URL; ผลจาก fixture ไม่แทนผล Chrome บน UAT

## ขึ้น VM เฉพาะ proxy config

1. อ่าน deployment record และ inspect proxy ปัจจุบัน เก็บ image digest, compose files/environment-file paths, mounts, config checksum และ container ID/StartedAt ของทุก service ห้ามแนบค่าจาก env/token/credentials ลง tracker
2. ตรวจ Voice idle จาก runtime จริง พร้อมสถานะการเปิด Voice และจำนวนสาย; ตรวจ boot journal ว่าไม่มี stall ใหม่ในช่วง release หากตรวจไม่ได้ให้หยุด ตรวจ backup ล่าสุดพร้อม checksum/restore readiness และเก็บสำเนา deployment record/config ก่อนหน้าไว้แบบจำกัดสิทธิ์
3. นำ Caddyfile จาก reviewed SHA ไปไดเรกทอรี hotfix ใหม่โดยไม่เขียนทับ release เดิม ตรวจว่า diff จาก active config มีเฉพาะ framing policy ตามขอบเขตนี้ หาก active config ต่างจาก base ในส่วนอื่นให้ reconcile ก่อน
4. สร้าง compose overlay ที่เปลี่ยนเฉพาะ bind mount `/etc/caddy/Caddyfile` ของ service `proxy` ใช้รายการ compose/env จาก container ปัจจุบันและคง Console image digest เดิม ตรวจ rendered service แบบไม่แสดง secret และ validate Caddyfile ด้วย image เดิมก่อนใช้
5. Caddy ของ UAT ปิด admin API จึง recreate เฉพาะ `proxy` ด้วย `--no-deps --pull never` ผ่าน compose เดิมพร้อม overlay ห้าม pull images, migrate หรือ restart API/Keycloak/FreeSWITCH/Workspace service อื่น
6. ตรวจ HTTP ผ่าน public TLS ว่า iframe 200 และไม่มี proxy DENY, root/login ยังคง DENY, admin/master 404 และ discovery issuer เดิม ตรวจ container IDs/StartedAt ของ service อื่นว่าคงเดิม
7. ใช้ session ของ kittin ทดสอบ Home → เมนูที่ได้รับสิทธิ์ → reload → กลับ Home ด้วย Chrome จริง เก็บ expected/actual พร้อมเวลา/build/config โดยไม่เก็บ token ถ้ายังค้างให้บันทึก FAIL และวิเคราะห์ต่อ ห้ามนับ header test เป็น session PASS
8. อัปเดต component record เฉพาะ proxy config SHA/checksum/overlay/image/หลักฐาน HTTP และ browser โดยคง sourceSha ของ API/schema, Console image, realm hotfix และบัญชีพักเดิมให้ตรงความจริง #726 ยังคงรอ Core trial/proof/Voice gates ของตน

## Rollback

ใช้ compose/env รายการก่อนหน้าโดยไม่ใส่ overlay ใหม่นี้ แล้ว recreate เฉพาะ proxy ด้วย image digest เดิมและ `--no-deps --pull never` ตรวจ config checksum/HTTP/container invariants และคืน deployment component record จาก preimage แบบ atomic เก็บหลักฐาน failed trial แยกไว้ การ rollback นี้ไม่แตะ schema/config data/audit/receipt หรือ realm และไม่ restore DB
