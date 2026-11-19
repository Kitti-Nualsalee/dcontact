# เปิด Workspace บน UAT (#684)

Authority: [สเปกส่วนเพิ่ม #684](https://github.com/Kitti-Nualsalee/dcontact/issues/684#issuecomment-6209087715), ADR-026 และ ADR-030

Console อยู่ `https://dcontact-uat.osd.co.th/?tenant=dcontact-uat`; Workspace อยู่
`https://dcontact-workspace-uat.osd.co.th/?tenant=dcontact-uat` และ Supervisor เพิ่ม `&view=supervisor`.
ทั้งสองใช้ realm เดียวกัน ผ่าน Code + PKCE แต่แยก public client/origin.

## เตรียม edge

เพิ่ม hosts mapping ของเครื่องผู้ทดสอบไป VM1 `192.168.102.114` สำหรับ hostname ของ Workspace ตาม ADR-030.
ใช้ wildcard certificate เดิมซึ่งต้องครอบคลุม hostname และไม่หมดอายุภายใน 30 วัน.
Operator บน VM1 ตรวจและใช้สคริปต์จาก release ที่ review แล้ว:

```sh
sudo bash vm1-nginx-workspace-uat.sh --check
sudo bash vm1-nginx-workspace-uat.sh --apply
```

สคริปต์เพิ่มเฉพาะ `/etc/nginx/conf.d/dcontact-workspace-uat.osd.co.th.conf`; หยุดเมื่อไฟล์เดิมต่างจาก
candidate, ตรวจ `nginx -t`, reload และคืนไฟล์เมื่อ apply ล้มเหลว ไม่แก้ permission/cert/vhost อื่น.
ใช้ `--render` เพื่ออ่าน candidate โดยไม่ต้อง root และ `--remove` เพื่อถอนเฉพาะ config ที่ตรงกัน.

## Build และ deploy

ใช้ workflow `uat-operator-package` บน main ระบุ `deployed_base_sha` จาก current deployment record จริง,
`full_workspace=true`, `workspace_host=dcontact-workspace-uat.osd.co.th` และ `uat_host` ของ Console.
Manifest บันทึก `UAT_WORKSPACE_ENABLED=true` และ hostname เป็นค่า public ของ release.
ถ้าไม่เลือก full Workspace ค่าเริ่มต้นของ workflow ยังคง false.

`uat-deploy.sh` ใช้ overlay `docker-compose.uat.workspace.yml` เฉพาะ release ที่ระบุ true และต้องมี
E1 acceptance overlay อยู่แล้ว. API ใช้ entry `workspace-uat-main.js` / profile `uat-workspace`.
เพิ่ม Navigation, tenant locale และ Supervisor controllers บน E1 lease/SIP/WS composition;
ไม่ import default API composition, ไม่สร้าง Kafka/LINE/Journey runtime หรือเปิด provider egress.
Supervisor ใช้ฐานข้อมูลจริงและ team scope เดิม รวม audit/reason/idempotency และ force-safe boundary.
หน้าหัวหน้า refresh snapshot ทุก 5 วินาทีเฉพาะแท็บที่มองเห็น โดยไม่ถือ lease/SIP หรือแย่ง agent socket;
ไม่ซ้อนคำขอและไม่ให้คำตอบก่อน mutation ทับ snapshot หลังยืนยันคำสั่ง.
Navigation registry ส่งเฉพาะ Home, Agent, Supervisor และ dphone embedding ที่ profile นี้ให้บริการจริง.
Console Account/Journey/Governance APIs ยังไม่อยู่ใน profile นี้.

หยุดทันทีหากมี LINE/trial marker ร่วมกับ full Workspace; ยังไม่รองรับ overlay ชุดนั้นร่วมกัน.
คำสั่ง `e1-disable` บน release Workspace ถูกปฏิเสธก่อน mutation ให้ rollback เป็น release เดิมก่อน.

Stage source จาก SHA เดียวกับ image, แล้วรัน prepare → backup → migrate → keycloak → deploy → smoke → record
ตาม runbook เดิม. Reconcile เพิ่ม client `dcontact-uat-workspace` โดยไม่เปลี่ยน credential/role ผู้ใช้.
ตรวจ E1 idle/voice switch ก่อน deploy; ไม่เปิด outbound voice เพื่อทดสอบ UI.

ก่อนรายงานสำเร็จ ตรวจ static Workspace assets ที่ origin ใหม่, OIDC redirect/client/tenant,
Supervisor return URL, protected Navigation/Agent/Supervisor APIs และ runtime profile ที่ยังปิด
Kafka/LINE/egress. Authenticated role smoke ต้องใช้ session ผู้ทดสอบที่ได้รับอนุญาต;
หากไม่มี session ให้ระบุสิ่งที่ยังไม่ตรวจตามจริง ไม่ reset/create credential เพื่อ smoke.

## แผงข้อมูลลูกค้า (Cus360) — ยังไม่เปิดบน UAT (#916)

สถานะ 19 พฤศจิกายน 2569: ยังไม่ได้ตั้งค่าหรือ deploy บน UAT และ PR ของ #916 ไม่ได้แตะ VM
profile `uat-workspace` ประกอบ Agent Workspace จาก E1 composition (`e1-uat-api.ts`) ซึ่งยังไม่มี
Cus360 work auth/controller จึงไม่ประกาศ `workCustomerV1` แม้ตั้ง Keycloak และ env ครบ ต้องเพิ่ม Cus360 work
เข้า profile นี้ก่อน (งานโค้ดแยก ต้องให้ owner ตัดสิน) ขั้นด้านล่างเป็นแผนสำหรับตอนนั้น ทำเมื่อถือ UAT lock
และ owner สั่งเท่านั้น

realm template ของ UAT ไม่มี client นี้โดยตั้งใจ: UAT-S08 ห้าม confidential client และ secret ใน template
ส่วน reconcile ปัจจุบันเพิ่มเฉพาะ public client จึงทำผ่าน admin REST บน network ภายในแบบเดียวกับ
`u1-uat-keycloak-users.mjs` ตามลำดับนี้

1. สร้าง confidential client `dcontact-uat-c360-introspection` ปิด standard/implicit/direct access grant,
   service account, `fullScopeAllowed` และ `standard.token.exchange.enabled` ไม่ให้ role ใด และถอด default/optional
   client scopes ที่ admin REST ใส่ให้อัตโนมัติออก ให้ Keycloak สร้าง secret เอง อ่านครั้งเดียวแล้วเก็บใน
   secret store ห้าม commit, ห้าม echo และห้ามใช้ค่า dev
2. เพิ่ม audience mapper (`oidc-audience-mapper`) ที่ `dcontact-uat-workspace` เท่านั้น ไม่ใส่ที่
   `dcontact-uat-console` ตั้ง `included.client.audience=dcontact-uat-c360-introspection`,
   access token และ introspection เป็น `true`, ID token เป็น `false`
3. ส่ง `KEYCLOAK_C360_CLIENT_ID` และ `KEYCLOAK_C360_CLIENT_SECRET` ให้ API ใน overlay ของ Workspace
   (compose ใช้รูป `${VAR:?}` ตาม UAT-S05; K8s ใช้ `secretKeyRef`) ไม่ใส่ใน compose หลัก
   เพราะ release ที่ไม่เปิด Workspace ไม่ต้องใช้
4. ตรวจหลัง deploy: log API มี `customer_360.work.readiness` เป็น `ENABLED` (แปลว่า config ครบเท่านั้น),
   Workspace แสดงแผงลูกค้าและยืนยัน session ของงานได้จริง, introspect token ของ Console ด้วย client นี้ได้ `active:false` (ไม่ขยายสิทธิ์ client อื่น)

Rollback: ถอด env สองตัวออกจาก overlay แล้ว deploy ก่อน (API จะ log `DISABLED` และ Workspace ซ่อนแผงลูกค้าเอง
ไม่กระทบ lease/SIP) จากนั้นจึงลบ mapper ที่ `dcontact-uat-workspace` และปิด client; ปิด client ก่อนถอด env
จะทำให้ introspection ล้มและงานติด `WORK_REAUTH_REQUIRED`

## Rollback

บันทึก SHA/image digest และ current record ก่อน deploy. เลือก target ด้วย
`uat-deploy.sh rollback-target <previous-sha> > rollback-target.json` แล้วคำนวณ SHA-256
ของไฟล์ผลลัพธ์นั้น จากนั้นใช้ `uat-deploy.sh rollback <previous-sha> <target-record-sha256>`;
หาก record ที่เลือกไม่ตรงกับ archive ล่าสุดหรือ previous ที่ยังมีอยู่ คำสั่งจะหยุดก่อนเปลี่ยน runtime
release เก่าที่ไม่มี `UAT_WORKSPACE_ENABLED=true` ไม่เลือก overlay ใหม่และไม่ต้องลบ
marker กลาง จึงคืน API/Console เดิมได้. ไม่มี down migration. Client ใหม่และ vhost อาจคงอยู่แต่ไม่ควรแจก
ลิงก์ Workspace หลัง rollback; ถอน vhost ด้วย `--remove` ได้หลังตรวจว่าไม่มีผู้ใช้งาน.
