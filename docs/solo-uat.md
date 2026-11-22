# UAT แบบ D-Contact Solo

UAT สำหรับให้ dev ทดสอบตามแบบ D-Contact Solo ([voice-network-deployment.md](voice-network-deployment.md), [ADR-038](adr/038-single-voice-stack-tenant-trunks.md)) ติดตามที่ #923 ไม่ใช้ทำ load test และไม่ใช่หลักฐานว่ารับ 100 Agent ได้

## เครื่อง

| IP | hostname | บทบาท | สเปก |
| --- | --- | --- | --- |
| 192.168.31.206 | `nginx-dcontact` | voice: nginx (TLS), Kamailio, FreeSWITCH | 2 vCPU · 7.4 GB · root 28 GB |
| 192.168.31.207 | `docker-dcontact` | app: API, Router, Telephony, QM worker (เปิดด้วย profile), Console, Workspace, Keycloak, Redpanda, Redis, object storage, Mailpit | 2 vCPU · 7.4 GB · root 97 GB |
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
- เสียงบันทึก (เฉพาะคิว legacy 2000/2001): FreeSWITCH เขียน WAV ลง `/srv/dcontact-solo/recordings` บน VM voice ซึ่ง export ด้วย NFSv4 ให้ VM app เท่านั้น VM app mount แบบ systemd automount ที่ `/mnt/dcontact-solo/recordings` และ bind `/mnt/dcontact-solo` เข้า Telephony Telephony ส่งไฟล์เข้า bucket `recordings` ใน object storage หลังวางสาย

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
- `app` ตั้ง NFS export ของเสียงบันทึก สร้าง bucket, migrate, rls, `db:seed`, เชื่อมผู้ใช้กับ Keycloak แล้ว seed แบบ Demo ด้วย `scripts/solo-uat-seed.mjs` (seed เปิด `recording_enabled` ของคิว legacy และปิดของคิว managed ทุกรอบ)
- `voice` ตั้ง NFS export ซ้ำ (รันซ้ำได้) แล้วเริ่ม nginx, Kamailio และ FreeSWITCH
- `app` ตั้ง NFS ทั้งสองฝั่งก่อน: ติดตั้ง `nfs-kernel-server` บน VM voice และ `nfs-common` บน VM app แล้วเพิ่มบรรทัดใน `/etc/fstab` ของ VM app

## ข้อมูลทดสอบ

owner อนุมัติเมื่อ 19 พฤศจิกายน 2569 ให้ seed แบบ Demo ทีมขาย: tenant `demo`, ทีม Customer Care, identity binding, สิทธิ์ WORK/VIEW บน `system:all-customers` และ CONTACT_CREATE ของ Admin ลงฐานโดยตรง ไม่ผ่าน Platform provisioning จึงไม่ใช่หลักฐานของ flow สร้าง tenant หรือ identity

| ผู้ใช้ | รหัสผ่าน |
| --- | --- |
| `admin@demo.local` | `SOLO_ADMIN_PASSWORD` ใน `solo.env` |
| `agent1000@demo.local`, `agent1001@demo.local` | `SOLO_AGENT_PASSWORD` ใน `solo.env` |
| `supervisor@demo.local` (Supervisor ทีม Customer Care) | `SOLO_AGENT_PASSWORD` ใน `solo.env` |

เปิดด้วย `?tenant=demo` ทุกครั้ง: Console และ Workspace เดา tenant จาก subdomain แรกของ hostname ถ้าไม่ระบุ ซึ่งบน Solo จะได้ `dcontact-solo-uat` / `dcontact-solo-workspace-uat` และ Keycloak ตอบ `invalid_scope`

| แอป | URL |
| --- | --- |
| Console | `https://dcontact-solo-uat.osd.co.th/?tenant=demo` |
| Workspace | `https://dcontact-solo-workspace-uat.osd.co.th/?tenant=demo` |

trunk จำลอง `lan-sim` รับสายจาก `SOLO_SIM_TRUNK_IP` เท่านั้น เบอร์ `021000001` เข้าคิวตรง (2000), `021000002` เข้า IVR (2001) และ `021000004` เข้าเบอร์ 2002 ซึ่ง operator จองให้คิว managed ที่ Admin สร้างใน Console ([new-tenant-onboarding.md](new-tenant-onboarding.md), managed routing เปิดด้วย `TELEPHONY_MANAGED_VOICE_ENABLED=true` ใน `solo.env`) โทรเข้าด้วย SIPp หรือ softphone จากเครื่องนั้นไปที่ `sip:021000001@192.168.31.206:5060`

## ข้อจำกัด

- VM เล็กกว่าสเปก Solo ราวครึ่ง ใช้ทดสอบหลายสายพร้อมกันได้ ไม่ได้ load test
- เสียงบันทึกพึ่ง NFS จาก VM voice:
  - NFS ตอบ error ทันที (เช่น สิทธิ์ไม่พอ): สายยังรับได้แต่ไม่มีเสียงบันทึก
  - NFS ไม่ตอบ (VM voice ล่ม หรือ nfsd เพิ่ง restart และอยู่ใน grace period 90 วินาที): Telephony รอ mkdir/อ่านไฟล์ (หรือรอ automount ที่ตั้ง timeout 10 วินาที)ได้ถึง ~12 วินาทีก่อนส่ง `call.answered`/`call.hangup` สายที่รับช่วงนั้นอาจเกิน offer timeout และ Agent เป็น BREAK ระหว่างคุย
  - กู้คืน: ตรวจด้วย `sudo ls /mnt/dcontact-solo/recordings` บน VM app แล้วรัน `solo-uat.sh voice` ถ้ายังไม่หาย ปิด `recording_enabled` ของคิวใน Console (seed จะเปิดคืนตอนรัน `app` รอบถัดไป)
- ใครก็ตามที่ส่ง NFS จาก IP ของ VM app ได้ (รวม container อื่นบน VM นั้น) อ่านและแก้ไฟล์ WAV ก่อน archive ได้ ข้อมูลวิ่งบน LAN แบบไม่เข้ารหัส รับได้สำหรับ UAT ที่ใช้ข้อมูล demo ไม่ใช่แบบสำหรับ production
- ไฟล์ WAV บน VM voice ไม่ถูกลบหลังส่งเข้า object storage (ยังไม่มี retention) และไม่มีการสำรองข้อมูลนอกเครื่อง
- realm ใช้ client ของ dev (`agent-desktop`, `dcontact-dev-readiness`) ที่รองรับ password grant ใช้ใน LAN เท่านั้น
- ยังไม่เปิด ufw บนเครื่อง การจำกัดอยู่ที่ ACL ของ FreeSWITCH, `pg_hba` และ Caddy
- เครื่องที่ทดสอบต้องส่ง UDP ถึง 192.168.31.206 ได้ ถ้าอยู่คนละ subnet ต้องให้ router เปิด 5060 และ 16384–16683

## QM worker

service `qm` ใน `infra/solo/app/docker-compose.yml` รัน `apps/qm` (`/app/qm/dist/main.js` ใน image `services`)
รับ `interaction.ended` จาก `dc.interaction.events` สร้าง transcription job, consume `dc.qm.jobs` และรัน `QmRetryDispatcher` ทุก 5 วินาที

- อยู่หลัง compose profile `qm` ขั้น `app` จึงไม่เริ่ม QM จนกว่า `solo.env` มี `COMPOSE_PROFILES=qm`
- ต่อฐานด้วย `APPLICATION_DATABASE_URL` (`dcontact_app`, NOBYPASSRLS) ไม่ใช่ owner แบบ API
- แก้ `solo.env` ที่เครื่อง operator (`~/.config/dcontact-solo/solo.env`) เสมอ เพราะ `solo-uat.sh app` คัดลอกไฟล์นี้ทับไฟล์บน VM ทุกรอบ
- ก่อนเปิด profile ต้องตั้งค่าใน `solo.env` เป็นของจริง ค่าที่ `init-env` ใส่ไว้ (`*.example.internal`) ใช้ไม่ได้
  - `QM_TRANSCRIPTION_PROVIDER_ID`, `QM_TRANSCRIPTION_ENDPOINT` (https) และ `QM_TRANSCRIPTION_API_KEY`
  - `QM_MEDIA_ENDPOINT` (https) ที่ provider ดึงไฟล์จาก bucket `recordings` ได้ด้วย signed URL
    ต้อง proxy ไป `object-storage:9000` โดยคง `Host` เดิม เพราะ signature ผูกกับ host ใน URL
    signed URL ลงนามด้วย `S3_ACCESS_KEY` ซึ่งเป็น root credential ของ RustFS proxy จึงควรรับเฉพาะ `GET`/`HEAD`
    ใต้ `/recordings/` ที่มี `X-Amz-Signature` และจำกัด source IP ของ provider ถ้าทำได้
    ตอนนี้ nginx บน VM voice ยังไม่มี host นี้
  - `QM_SCORING_*`: ถ้ายังไม่มี scorer จริง ให้ตั้ง `QM_SCORING_ENDPOINT=` เป็นค่าว่าง จะถอดเสียงอย่างเดียวไม่สร้าง auto-QM draft
    ถ้าคง placeholder ไว้ คิวที่เปิด `autoQmEnabled` จะถอดเสียงสำเร็จแต่ไม่มี draft เหลือแค่ error log
- ถ้าเปิดด้วยค่า placeholder job จะล้มครบ `transcriptionMaxAttempts` แล้วเป็น `FAILED` ทั้ง job อัตโนมัติและ job ที่ Supervisor สั่งเอง
  รวมถึง job ที่ API publish ไว้ก่อนมี worker ซึ่ง dispatcher กวาดขึ้นมาหลังค้างเกิน 5 นาที
- เปิด: ใส่ `COMPOSE_PROFILES=qm` ใน `solo.env` ของ operator แล้วรัน `solo-uat.sh app`
  ตรวจว่า compose บน VM เห็น service ด้วย `docker compose --env-file solo.env config --services | grep qm` ใน `/opt/dcontact-solo/app`
  แล้วดู log ด้วย `docker compose --env-file solo.env logs -f qm`
- ปิด: ลบ `COMPOSE_PROFILES=qm` ออกจาก `solo.env` ของ operator และของ VM แล้วรัน `docker compose --env-file solo.env --profile qm rm -sf qm` บน VM
  ถ้าลบค่าแต่ไม่ลบ container `up -d` รอบถัดไปจะไม่ recreate `qm` และ container เดิมรันต่อด้วย image เก่า
- ข้อจำกัดที่ควรรู้ตอนทดสอบ
  - consumer เริ่มอ่านที่ offset ล่าสุดทุกครั้งที่ process เริ่ม `interaction.ended` ที่เกิดระหว่าง QM ดับ (รวมช่วง deploy) จึงไม่ได้ job
  - คิว managed ยังไม่ publish `interaction.ended` ขึ้น Kafka ทางอัตโนมัติจึงใช้ได้เฉพาะคิว legacy 2000/2001 ซึ่งเป็นคิวที่มี recording

## Tenant People และคิว managed (#977, #979)

ทดลองบน Solo วันที่ 22 พ.ย. 2569 (owner อนุมัติ) ด้วย release `bc459bc` และ config ของ voice จาก PR #982

- `solo.env` เปิด `TELEPHONY_MANAGED_VOICE_ENABLED=true` และค่า `TENANT_PEOPLE_*` ที่ได้จาก `scripts/tenant-voice-onboarding.mjs`
  (รันผ่าน SSH tunnel ไป `.208:5432` และ Keycloak `127.0.0.1:8081` บน `.207`, `--node fs-solo`,
  `--issuer https://<console host>/auth/realms/dcontact --backchannel-url http://keycloak:8080/auth/realms/dcontact`)
  ใส่ค่าใน `solo.env` โดยไม่ครอบ quote เพราะ `env_file` ของ docker ไม่ตัด quote ออก
- เบอร์ 2002 ของ tenant `demo` จองไว้ให้คิว managed ขั้น `data` ใส่ `021000004` → 2002 บน trunk `lan-sim` (`SOLO_SIM_TRUNK_IP`)
  บน Solo ตอนนี้แถวนี้ถูกใส่มือบน trunk `lan-sim-app` (โทรจาก VM app แบบเดียวกับ `021000003`) และ `ON CONFLICT DO NOTHING` จะคงแถวเดิมไว้
- realm ที่ import ไปก่อน #977 ไม่มี SMTP ส่วน `render-realm.mjs` ใส่ Mailpit ให้เฉพาะตอน import ครั้งแรก
  realm เดิมต้องให้ operator ตั้ง SMTP (host `mailpit`, port `1025`) ผ่าน Admin API ก่อนเชิญผู้ใช้ผ่าน Console

