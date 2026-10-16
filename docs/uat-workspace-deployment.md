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

## Rollback

บันทึก SHA/image digest และ current record ก่อน deploy. ใช้ `uat-deploy.sh rollback <previous-sha>`
ตาม runbookเดิม; release เก่าที่ไม่มี `UAT_WORKSPACE_ENABLED=true` ไม่เลือก overlay ใหม่และไม่ต้องลบ
marker กลาง จึงคืน API/Console เดิมได้. ไม่มี down migration. Client ใหม่และ vhost อาจคงอยู่แต่ไม่ควรแจก
ลิงก์ Workspace หลัง rollback; ถอน vhost ด้วย `--remove` ได้หลังตรวจว่าไม่มีผู้ใช้งาน.
