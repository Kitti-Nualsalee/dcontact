# Hotfix session ของ Tenant Console บน UAT

Authority: [bug #733](https://github.com/Kitti-Nualsalee/dcontact/issues/733), ADR-004/026 และ `docs/iam-architecture.md` ที่กำหนด memory token + silent re-auth หลัง reload

## ขอบเขต

Console boot กู้ SSO จาก Keycloak ครั้งเดียวด้วย top-level `prompt=none` และ `redirectMethod=replace` ผ่าน redirect URI เดิม พร้อมจำหน้าปลายทาง ไม่ใช้ root callback ใน iframe เพราะ UAT ส่ง `X-Frame-Options: DENY` Callback และ explicit sign-out ไม่เริ่มรอบใหม่ จำกัด discovery/token request 5 วินาที; การโหลดหน้า authorization เป็น document navigation ตาม browser ปกติ หาก IdP ใช้ไม่ได้ผู้ใช้ยังกลับหรือเปิด Console ใหม่ได้ ไม่มีการ retry อัตโนมัติใน callback เมื่อ SSO ใช้ไม่ได้แสดงปุ่ม login การกู้ครั้งแรกจบแล้วไม่ครอบ lifecycle reauth ของหน้าที่เปิดอยู่ จึงคง Core draft ในหน้าเดิม Token อยู่ใน memory ตามเดิม Browser harness ส่ง header DENY เหมือน UAT เพื่อพิสูจน์ navigation/reload/back/forward ภายใต้นโยบายจริง

การเปิด hotfix นี้แยกจาก Core Settings #726 ซึ่งรอ verified proof/migration/limited trial อยู่ โดยอัปเดต image ของ `proxy` ที่เสิร์ฟ Console เท่านั้น ใช้ API/ops/Keycloak digests, database schema, full Workspace/E1 overlays และ configuration ของ deployment ปัจจุบัน ไม่ใช้ขั้น migrate/keycloak/provision หรือ full-stack deploy สำหรับ hotfix นี้

## Gates และขั้น operator

1. Merge หลัง review/CI ผ่าน เก็บ immutable main evidence ของ tested SHA และสร้าง digest-pinned Console image ด้วย build args ของ UAT/Workspace hosts จริง ตรวจ source label, artifact/run และ SHA ก่อนใช้
2. บันทึก current.json และ container IDs/images ของ API/Keycloak/FreeSWITCH/e1-sandbox/proxy รวม source label ของแต่ละ component ตรวจ Compose config files จาก label ของ proxy ที่รันอยู่ ใช้ base release เดิมพร้อม env files เดิม
3. ตรวจ Voice ไม่มี QUEUED/ASSIGNED/ACTIVE/WRAPUP และไม่มี FreeSWITCH channels ก่อนเปลี่ยน proxy ประสานช่วงหยุดทดสอบสายสั้น ๆ เพราะ proxy ให้บริการ SIP/Workspace WebSockets ด้วย
4. เตรียม override ใต้ `/opt/dcontact-uat/console-hotfixes/<tested-console-sha>/` ให้มีเพียง `services.proxy.image` ที่เป็น digest ใหม่ เก็บ previous image/digests และ rollback override ใช้ Compose binary/project/config files ของ deployment เดิม เพิ่ม override เป็นไฟล์สุดท้าย แล้ว `up -d --no-deps proxy` ตรวจ service อื่นด้วย container IDs หลังจบ
5. ตรวจ HTTPS Console/Workspace, OIDC discovery และ runtime-profile เดิม จากนั้นบัญชี kittin tenant=dcontact-uat ทดสอบ Home → Account → Home → เมนูตั้งค่าที่มีสิทธิ์/ประวัติ → reload/back/direct URL โดย session กลับมาเองเมื่อ SSO ยัง valid ไม่ถาม credentials ทุกเมนู Explicit logout/expired SSO มี regression ใน real Keycloak sandbox
6. หลัง smoke ผ่านจึงเขียน hotfix record พร้อม expected/actual, tested Console SHA/digest/run/time, previous/current image และ Voice idle evidence เก็บ snapshot เดิม แล้วอัปเดต `current.json` แบบ atomic โดยแก้เฉพาะ `images.console` และเพิ่ม `consoleHotfix` ที่ชี้ record ของ component นี้ `sourceSha` ของ base API/schema ยังเป็น deployed base เดิม เพื่อให้ migration guard ครั้งถัดไปไม่ข้าม migrations ที่ยังไม่ได้ apply ห้ามอ้างว่าทั้ง stack เป็น Console SHA หรือสร้างหลักฐาน migration/realm change ใหม่จาก hotfix

## Rollback และ full release ถัดไป

หาก proxy/auth smoke ไม่ผ่าน คืน previous Console image ผ่าน override เดิมและ recreate เฉพาะ proxy ตรวจ health แล้วคืน current record จาก snapshot เก็บ hotfix failure/evidence ไว้ ไม่มีการ restore DB หรือแก้ credentials จากอาการนี้

Full release ถัดไปของ Core/People ต้องรวม fix #733 และใช้ package/evidence ของ SHA ที่ทดสอบจริงตาม contract ของตน แทน staged Console รุ่นก่อนหน้า เมื่อผ่าน proof/migration/Voice gates แล้วจึงกลับใช้ canonical full-release runner และ record ตามปกติ
