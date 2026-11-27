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
| `dcontact-solo-media-uat.osd.co.th` | signed URL ของไฟล์เสียงที่ ASR provider ดาวน์โหลด (`SOLO_MEDIA_HOST`) รับเฉพาะ VM app |
| `dcontact-solo-asr-uat.osd.co.th` | ASR provider ตาม [qm-asr-provider-protocol.md](qm-asr-provider-protocol.md) ตอนนี้เป็น simulator (`SOLO_ASR_HOST`) รับเฉพาะ VM app |

สองชื่อแรกชี้ที่ 192.168.31.206 ส่วนชื่อของ QM ไม่ต้องมีใน DNS เพราะ container ของ QM และ simulator ชี้ไป 192.168.31.206 ด้วย `extra_hosts` cert จริงคือ `star.osd.co.th` วางที่ `/opt/dcontact-solo/voice/tls/server.crt` และ `server.key` ถ้ายังไม่มี `solo-uat.sh voice` สร้าง cert self-signed ชั่วคราวให้ ซึ่ง browser จะเตือนก่อนเข้า

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
- `app` ตั้ง NFS export ของเสียงบันทึก สร้าง bucket, migrate, rls, `db:seed`, เชื่อมผู้ใช้กับ Keycloak แล้ว seed แบบ Demo ด้วย `scripts/solo-uat-seed.mjs` (seed เปิด `recording_enabled` ของคิว legacy ทุกรอบ ส่วนคิว managed Admin เปิด/ปิดเองใน Console ตั้งแต่ #991)
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
  - NFS ไม่ตอบ (VM voice ล่ม หรือ nfsd เพิ่ง restart และอยู่ใน grace period 90 วินาที): `call.answered` ไม่รอ storage แล้ว
    จึงไม่เกิน offer timeout ส่วน `call.hangup` รอไม่เกิน 3 วินาที ถ้าเตรียมโฟลเดอร์ไม่ทัน 5 วินาที สายนั้นไม่มีเสียงบันทึก
    ไฟล์ที่ archive ไม่ทันจะถูก retry ต่อ ([voice-recording-supervisor-playback.md](voice-recording-supervisor-playback.md#การ-archive-ของ-telephony))
  - mount หายทั้งก้อน (ทุกไฟล์ได้ `ENOENT`): Telephony ไม่หยุดลองรายการใด จนกว่าจะมีไฟล์อื่นของ node archive สำเร็จ
    แก้ mount แล้วรายการค้างจะขึ้นเองในรอบ retry
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
- QM เรียก ASR ตาม [D-Contact ASR Provider Protocol v1](qm-asr-provider-protocol.md) ระหว่างที่ยังไม่มีโมเดลจริงใช้ service `qm-asr-simulator`
  ซึ่งอยู่หลัง profile `qm` เดียวกัน ดาวน์โหลดไฟล์เสียงจริงแต่คืนข้อความจำลองขึ้นต้น `[จำลอง]` (ห้ามใช้เป็นหลักฐานประเมินจริง)
- เส้นทาง (ทุกขาเป็น HTTPS ด้วย cert `*.osd.co.th` จบที่ nginx บน VM voice แล้วส่งต่อให้ web บน VM app)
  - QM → `https://SOLO_ASR_HOST/v1/transcriptions` → web → `qm-asr-simulator:8090`
  - simulator → `https://SOLO_MEDIA_HOST/recordings/...?X-Amz-Signature=...` → web → `object-storage:9000` โดยคง `Host` เดิม เพราะ signature ผูกกับ host
  - nginx รับสอง host นี้เฉพาะจาก IP ของ VM app และ access log ของสอง host นี้ไม่บันทึก path/query (signed URL มี access key และ signature) ส่วน web รับ media เฉพาะ `GET`/`HEAD` ใต้ `/recordings/` ที่มี `X-Amz-Signature` และ ASR เฉพาะ `/v1/transcriptions`, `/v1/health`
  - signed URL ลงนามด้วย `S3_ACCESS_KEY` ซึ่งเป็น root credential ของ RustFS ถ้าเปลี่ยนไปใช้ provider ภายนอกต้องเพิ่ม IP ของ provider ใน nginx และทบทวนการเปิด host media
- ค่าใน `solo.env` ของ operator ก่อนเปิด (`init-env` ของ `solo.env` ใหม่ใส่ให้แล้ว ยกเว้น `COMPOSE_PROFILES`; `solo.env` เดิมต้องแก้เอง)

  ```bash
  SOLO_MEDIA_HOST=dcontact-solo-media-uat.osd.co.th
  SOLO_ASR_HOST=dcontact-solo-asr-uat.osd.co.th
  QM_MEDIA_ENDPOINT=https://dcontact-solo-media-uat.osd.co.th
  QM_TRANSCRIPTION_PROVIDER_ID=dcontact-asr-simulator
  QM_TRANSCRIPTION_ENDPOINT=https://dcontact-solo-asr-uat.osd.co.th/v1/transcriptions
  QM_TRANSCRIPTION_API_KEY=<ค่าสุ่มใหม่ เช่น openssl rand -hex 24>
  QM_SCORING_ENDPOINT=
  COMPOSE_PROFILES=qm
  ```

  - simulator ใช้ `QM_TRANSCRIPTION_API_KEY` เป็น token ที่รับ จึงไม่ต้องมี secret เพิ่ม ถ้าค่าว่าง simulator ไม่ยอมเริ่ม
  - `QM_SCORING_ENDPOINT=` ค่าว่าง = ถอดเสียงอย่างเดียว ไม่สร้าง auto-QM draft ถ้าคง placeholder ไว้ คิวที่เปิด `autoQmEnabled` จะถอดเสียงสำเร็จแต่ไม่มี draft เหลือแค่ error log
  - เมื่อมีโมเดลจริงเปลี่ยน `QM_TRANSCRIPTION_PROVIDER_ID`, `QM_TRANSCRIPTION_ENDPOINT` และ key ไปที่ gateway ของโมเดลนั้น (ต้องผ่าน contract test ก่อน) แล้วลบ `qm-asr-simulator` ออก
- ถ้าเปิดด้วยค่า placeholder (`*.example.internal`) job จะล้มครบ `transcriptionMaxAttempts` แล้วเป็น `FAILED` ทั้ง job อัตโนมัติและ job ที่ Supervisor สั่งเอง
  รวมถึง job ที่ API publish ไว้ก่อนมี worker ซึ่ง dispatcher กวาดขึ้นมาหลังค้างเกิน 5 นาที
- เปิด: แก้ `solo.env` ของ operator ตามด้านบน รัน `solo-uat.sh build` (image ต้องมี simulator) แล้ว `solo-uat.sh app` และ `solo-uat.sh voice` (ขั้น `voice` สร้าง container nginx ใหม่ทุกครั้งเพื่อให้โหลด `nginx.conf` ใหม่ Console/Workspace จะสะดุดไม่กี่วินาที)
  ตรวจว่า compose บน VM เห็น service ด้วย `docker compose --env-file solo.env config --services | grep qm` ใน `/opt/dcontact-solo/app`
  แล้วดู log ด้วย `docker compose --env-file solo.env logs -f qm qm-asr-simulator`
  simulator log หนึ่งบรรทัดต่อคำขอ (`asr-simulator request` พร้อม status, ความยาวเสียง และจำนวน segment) ไม่ log URL ของไฟล์เสียง
- ปิด: ลบ `COMPOSE_PROFILES=qm` ออกจาก `solo.env` ของ operator และของ VM แล้วรัน `docker compose --env-file solo.env --profile qm rm -sf qm qm-asr-simulator` บน VM
  ถ้าลบค่าแต่ไม่ลบ container `up -d` รอบถัดไปจะไม่ recreate service ของ profile `qm` และ container เดิมรันต่อด้วย image เก่า
- ข้อจำกัดที่ควรรู้ตอนทดสอบ
  - consumer เริ่มอ่านที่ offset ล่าสุดทุกครั้งที่ process เริ่ม `interaction.ended` ที่เกิดระหว่าง QM ดับ (รวมช่วง deploy) จึงไม่ได้ job
  - คิว managed ยังไม่ publish `interaction.ended` ขึ้น Kafka ทางอัตโนมัติจึงใช้ได้เฉพาะคิว legacy 2000/2001 คิว managed ที่เปิดบันทึกเสียงใช้ manual request (`POST qm/interactions/:id/transcription-jobs`) แทน
  - SIPp เล่นเสียงฝั่งลูกค้าอย่างเดียว ถ้า Agent ไม่พูด simulator จะเห็นเสียงแค่ channel ซ้าย (`CONTACT`)

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


## Web Chat (#1044)

เปิดด้วย `WEBCHAT=on` ใน `solo.env` แล้วรัน `build` และ `app` (migration `20261127170000_webchat_round_one` ถูก apply ในขั้น `app`) รายละเอียดการทำงานอยู่ใน [webchat.md](webchat.md)

- Admin ของ tenant ตั้งค่าที่ Console **การเชื่อมต่อ → ช่องทางลูกค้า → Web Chat**: เลือกคิว เพิ่มโดเมน และเปิดใช้งาน แล้วกด "เปิดหน้าทดลอง" เพื่อคุยในฐานะลูกค้าได้โดยไม่ต้องมีเว็บ
- widget, หน้าต่างแชท และหน้าทดลองอยู่ใต้ `https://<console host>/api/v1/webchat/` จึงไม่ต้องแก้ nginx หรือ Caddy
- เว็บจริงที่จะฝังต้องเข้าถึง console host ได้ ผู้ทดสอบที่ map host ในเครื่องตัวเองต้องเปิดเว็บนั้นจากเครื่องเดียวกัน
- ปิดได้ด้วย `WEBCHAT=off` แล้วรัน `app` ให้ Agent ปิดและบันทึกผลแชทที่ค้างก่อน มิฉะนั้น Agent ที่ถือห้องจะติดสถานะของแชทและไม่ได้รับสายจนเปิดกลับ ([webchat.md](webchat.md#ข้อจำกัดของรอบแรก))
