# UAT แบบ D-Contact Solo

UAT สำหรับให้ dev ทดสอบตามแบบ D-Contact Solo ([voice-network-deployment.md](voice-network-deployment.md), [ADR-038](adr/038-single-voice-stack-tenant-trunks.md)) ติดตามที่ #923 ไม่ใช้ทำ load test และไม่ใช่หลักฐานว่ารับ 100 Agent ได้

## เครื่อง

| IP | hostname | บทบาท | สเปก |
| --- | --- | --- | --- |
| 192.168.31.206 | `nginx-dcontact` | voice: nginx (TLS), Kamailio, FreeSWITCH | 2 vCPU · 7.4 GB · root 28 GB |
| 192.168.31.207 | `docker-dcontact` | app: API, Router, Telephony, Console, Workspace, Keycloak, Redpanda, Redis, object storage, Mailpit | 2 vCPU · 7.4 GB · root 97 GB |
| 192.168.31.208 | `postgresql-dcontact` | data: PostgreSQL 16 (ฐาน `dcontact`, `keycloak`, `dcontact_voice_edge`) | 2 vCPU · 3.4 GB · root 28 GB |

ทุกเครื่องเป็น Ubuntu 26.04 บัญชี `osdadmin` เข้าด้วย SSH key และ sudo ไม่ใช้รหัสผ่าน

## โดเมน

| โดเมน | ใช้ทำอะไร |
| --- | --- |
| `dcontact-solo-uat.osd.co.th` | Console, `/api`, `/auth` (Keycloak) |
| `dcontact-solo-workspace-uat.osd.co.th` | Workspace และ `/sip-ws` ของ D-Phone |

ทั้งสองชื่อชี้ที่ 192.168.31.206 cert จริงคือ `star.osd.co.th` วางที่ `/opt/dcontact-solo/voice/tls/server.crt` และ `server.key` ถ้ายังไม่มี `solo-uat.sh voice` สร้าง cert self-signed ชั่วคราวให้ ซึ่ง browser จะเตือนก่อนเข้า

## เส้นทาง

- ผู้ใช้ → nginx บน VM voice (443) → web (Caddy) บน VM app :8080 → API, Keycloak หรือไฟล์ของ Console/Workspace
- D-Phone → nginx `/sip-ws` → FreeSWITCH WSS `127.0.0.1:7443` แล้วเสียงวิ่งตรงระหว่าง browser กับ VM voice (UDP 16384–16683)
- สายจำลอง → Kamailio (5060) → FreeSWITCH profile `pstn-sim` (5080) → park ให้ Router ตาม [voice-edge.md](voice-edge.md)
- Telephony บน VM app → ESL ของ FreeSWITCH (8021) ส่วน FreeSWITCH เรียก directory ของ API ที่ web :8080 `/internal/*`
- Kamailio อ่านตาราง trunk/เบอร์จาก `dcontact_voice_edge` ด้วย `kamailio_ro`

## ขึ้นระบบ

รันจากเครื่อง operator ที่ root ของ repository:

```bash
SOLO_SIM_TRUNK_IP=<IP ของเครื่องที่ใช้เป็นสายจำลอง> bash infra/solo/bin/solo-uat.sh init-env
bash infra/solo/bin/solo-uat.sh build
bash infra/solo/bin/solo-uat.sh data
bash infra/solo/bin/solo-uat.sh app
bash infra/solo/bin/solo-uat.sh voice
```

- `init-env` สร้าง `~/.config/dcontact-solo/solo.env` (mode 600) ที่เก็บ secret ทั้งหมด ไม่เขียนทับไฟล์เดิม
- `build` ส่ง working tree ไป build image บน VM app และ VM voice โดยไม่ใช้ registry แล้วตั้ง `SOLO_IMAGE_TAG`
- `data --reset` ลบฐานของ Solo ทั้งหมดแล้วสร้างใหม่ owner อนุมัติให้ล้างข้อมูล UAT นี้ได้
- `app` migrate, rls, `db:seed`, เชื่อมผู้ใช้กับ Keycloak แล้ว seed แบบ Demo ด้วย `scripts/solo-uat-seed.mjs`

## ข้อมูลทดสอบ

owner อนุมัติเมื่อ 19 พฤศจิกายน 2569 ให้ seed แบบ Demo ทีมขาย: tenant `demo`, ทีม Customer Care, identity binding, สิทธิ์ WORK/VIEW บน `system:all-customers` และ CONTACT_CREATE ของ Admin ลงฐานโดยตรง ไม่ผ่าน Platform provisioning จึงไม่ใช่หลักฐานของ flow สร้าง tenant หรือ identity

| ผู้ใช้ | รหัสผ่าน |
| --- | --- |
| `admin@demo.local` | `SOLO_ADMIN_PASSWORD` ใน `solo.env` |
| `agent1000@demo.local`, `agent1001@demo.local` | `SOLO_AGENT_PASSWORD` ใน `solo.env` |

เปิดด้วย `?tenant=demo` ทุกครั้ง: Console และ Workspace เดา tenant จาก subdomain แรกของ hostname ถ้าไม่ระบุ ซึ่งบน Solo จะได้ `dcontact-solo-uat` / `dcontact-solo-workspace-uat` และ Keycloak ตอบ `invalid_scope`

| แอป | URL |
| --- | --- |
| Console | `https://dcontact-solo-uat.osd.co.th/?tenant=demo` |
| Workspace | `https://dcontact-solo-workspace-uat.osd.co.th/?tenant=demo` |

trunk จำลอง `lan-sim` รับสายจาก `SOLO_SIM_TRUNK_IP` เท่านั้น เบอร์ `021000001` เข้าคิวตรง (2000) และ `021000002` เข้า IVR (2001) โทรเข้าด้วย SIPp หรือ softphone จากเครื่องนั้นไปที่ `sip:021000001@192.168.31.206:5060`

## ข้อจำกัด

- VM เล็กกว่าสเปก Solo ราวครึ่ง ใช้ทดสอบหลายสายพร้อมกันได้ ไม่ได้ load test
- ไม่มีการบันทึกเสียงที่ใช้งานได้ (#845–#848 ยังพัก) seed ของ Solo จึงปิด `recording_enabled` ทุกคิว ถ้าเปิดคิวไหนเองใน Console สายที่รับจะไม่ขึ้นเป็น ACTIVE และ Agent จะเป็น BREAK ระหว่างคุย และไม่มีการสำรองข้อมูลนอกเครื่อง
- realm ใช้ client ของ dev (`agent-desktop`, `dcontact-dev-readiness`) ที่รองรับ password grant ใช้ใน LAN เท่านั้น
- ยังไม่เปิด ufw บนเครื่อง การจำกัดอยู่ที่ ACL ของ FreeSWITCH, `pg_hba` และ Caddy
- เครื่องที่ทดสอบต้องส่ง UDP ถึง 192.168.31.206 ได้ ถ้าอยู่คนละ subnet ต้องให้ router เปิด 5060 และ 16384–16683
