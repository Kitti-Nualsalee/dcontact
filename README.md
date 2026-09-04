# D-Contact

**CCaaS + CX Automation** (SaaS, multi-tenant) — Voice / Web Chat / LINE / Facebook / WhatsApp / Email
รับงานทุกช่องทางด้วยคิวเดียว **และ** ทำให้เรื่องที่คาดเดาได้ไม่ต้องกลายเป็นงานของคน
([ADR-025](docs/adr/025-journey-orchestration.md))
เอกสารทั้งหมด (ADRs, สถาปัตยกรรม multi-tenant/IAM/data flow, mockups) เริ่มที่ [docs/README.md](docs/README.md)

## Stack

- **Media/Telephony:** FreeSWITCH (self-hosted) คุมผ่าน ESL — ดู [ADR 002](docs/adr/002-esl-vs-mod_callcenter.md)
- **Event backbone:** Kafka (dev = Redpanda) — ทุก domain event เพื่อรองรับ billing/reporting แบบ SaaS
  ดู [ADR 003](docs/adr/003-kafka-event-backbone.md); Redis เหลือบทบาท state store เท่านั้น
- **Backend:** Node.js + TypeScript (NestJS + worker services), PostgreSQL, Redis, MinIO/S3
- **WFM solver:** Python + OR-Tools CP-SAT (`apps/wfm-engine` เท่านั้น — ภาษาที่สองที่จงใจจำกัดขอบเขต)
  ดู [ADR 008](docs/adr/008-workforce-management.md)
- **Frontend:** React + Vite, softphone ผ่าน SIP.js (WebRTC)
- **Monorepo:** pnpm workspaces + Turborepo

## โครงสร้าง

> **สถานะตอนนี้: ยังไม่มีโค้ดของ service ใด ๆ** — `apps/*` ทั้งตารางเป็น **แผนผังที่ตั้งใจไว้**
> ไม่ใช่โฟลเดอร์ที่มีอยู่จริง โครงร่างที่เคยเขียนไว้ (api/router/telephony/channels/agent-desktop)
> ถูกลบทิ้งเมื่อ 2026-08-14 ระหว่างที่ยังออกแบบระบบอยู่ เพราะ skeleton ที่ไม่ตรงกับแบบล่าสุด
> ทำให้สับสนมากกว่าช่วย — กู้กลับได้ด้วย `git checkout 8165970 -- apps` ถ้าต้องการอ้างอิง
> วินัยเดียวกับตารางของโมดูลใน [docs/README.md](docs/README.md): **โค้ดเกิดพร้อมเฟสที่ใช้มัน**
> ของที่มีอยู่จริงวันนี้คือ `packages/*` · `infra/` · `mockups/` · `docs/`

| path                    | หน้าที่                                                                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api`              | REST + WebSocket gateway (auth, tenant, CRUD)                                                                                                             |
| `apps/telephony`        | media gateway (ESL/ARI) → dc.telephony.events — ดู [ADR 006](docs/adr/006-multi-vendor-telephony-gateway.md)                                              |
| `apps/asterisk-gateway` | Asterisk gateway (ARI) — parallel ของ telephony, ป้อน topic เดียว (Phase 1+)                                                                              |
| `apps/router`           | ACD/routing engine (ทุก channel, ทุก vendor)                                                                                                              |
| `apps/channels`         | Channel gateways (webchat, LINE, FB, WA, email)                                                                                                           |
| `apps/workspace`        | หน้าทำงานที่ต้องมี session สด: กล่องงาน + softphone + หน้าสดของหัวหน้า (monitor/whisper/queue control) — ดู [ADR 026](docs/adr/026-frontend-app-split.md) |
| `apps/console`          | หน้าตั้งค่า/รายงานทั้งหมด (routing · people · integrations · WFM/QM setup · journeys · reports · admin) — deploy คนละจังหวะกับ workspace                  |
| `apps/wfm`              | Workforce management: กะ/ลา/adherence/RTA — ดู [ADR 008](docs/adr/008-workforce-management.md) (Phase W1+)                                                |
| `apps/wfm-engine`       | **Python** — forecast (Erlang) + จัดกะด้วย OR-Tools CP-SAT, คุยผ่าน `dc.wfm.jobs` (Phase W4)                                                              |
| `apps/qm`               | Quality management: recording lifecycle, transcript, ให้คะแนน, auto-QM — ดู [ADR 010](docs/adr/010-quality-management.md) (Phase Q1+)                     |
| `apps/dialer`           | Outbound: แคมเปญ/รายชื่อ/pacing/DNC — ผลิต **งาน** ให้ router ไม่ใช่โทรเอง — ดู [ADR 011](docs/adr/011-outbound-campaign.md) (Phase O1+)                  |
| `apps/bot`              | Virtual agent + คลังความรู้ (RAG บน pgvector) — ดู [ADR 013](docs/adr/013-virtual-agent-knowledge.md) (Phase B2+)                                         |
| `apps/cases`            | Case management: งานที่ไม่จบในครั้งเดียว + SLA — ดู [ADR 016](docs/adr/016-case-management.md) (Phase C1+)                                                |
| `apps/journey`          | CX automation: journey ที่ผูกกับลูกค้า + contact policy — ไม่สร้าง interaction เอง — ดู [ADR 025](docs/adr/025-journey-orchestration.md) (Phase J1+)      |
| `apps/webhook`          | ส่ง event ออกให้ระบบลูกค้า — consumer ของ Kafka ไม่อยู่ในเส้นทางรับสาย — ดู [ADR 015](docs/adr/015-integration-platform.md) (Phase I2+)                   |
| `packages/shared`       | Types + event contracts                                                                                                                                   |
| `packages/ui`           | design system ร่วมของสองแอปหน้าจอ — ห้าม fork component ([ADR 026](docs/adr/026-frontend-app-split.md) ข้อ 6)                                             |
| `packages/kafka`        | Kafka producer/consumer wrapper (ทุก service ใช้ตัวนี้)                                                                                                   |
| `packages/db`           | Prisma schema, RLS, seed                                                                                                                                  |
| `infra/`                | Docker Compose + FreeSWITCH config (config-as-code)                                                                                                       |

## เริ่มต้น dev

```bash
pnpm install

# 1. เริ่มและยืนยัน Phase 0 readiness ด้วยคำสั่งเดียว
#    FreeSWITCH + Postgres + Redis + MinIO + Redpanda (Kafka) + Keycloak + database baseline
#    รวม RLS tenant isolation, OIDC rejection และ Kafka produce/consume evidence
#    Redpanda Console (ดู topics/messages): http://localhost:8085
#    Keycloak Admin Console: http://localhost:8081 (admin / admin, เฉพาะ dev)
pnpm infra:ready

# 2. build ทั้งหมด
pnpm build

# 3. ดู mockup ของหน้าจอทั้งหมด — http://localhost:8090
python3 -m http.server 8090 --directory mockups
```

service แรกของ Phase 1 รันได้แล้ว: `apps/api`, `apps/router` และ `apps/telephony`
ใช้ `pnpm --filter <package> dev` เพื่อรันแยก process ใน local development

### ทดสอบ Inbound Voice Phase 1

หลัง `pnpm infra:ready` ให้รัน:

```bash
pnpm voice:demo
```

คำสั่งนี้ใช้ SIPp image ที่ pin digest จำลอง caller และ agent softphone แล้วรัน FreeSWITCH ESL gateway,
Router และ Kafka จริง โดยตรวจว่าสายเข้า `2000` ถูก bridge ด้วย codec PCMU, Interaction เป็น `ACTIVE`,
มี lifecycle `created → queued → assigned → answered` และ command กลับไป `telephonyNodeId` ต้นทาง
เมื่อผ่านจะแสดง `INBOUND_VOICE_PHASE_1_DEMO_PASS`

> **Docker Desktop (macOS/Windows):** FreeSWITCH advertise `127.0.0.1` เป็น RTP address
> (ตั้งใน `infra/freeswitch/conf/vars.xml`) เพื่อให้ browser บน host ส่ง media ผ่าน
> published UDP ports ได้ ถ้าเสียงไม่มา ให้ตรวจว่า port `16384-16420/udp` ถูก publish
> และไม่มี firewall ขวาง — บน Linux เปลี่ยน `external_rtp_ip` เป็น IP จริงของเครื่อง

### ตรวจและแก้ปัญหา dev infrastructure

`pnpm infra:ready` คือ **entry condition ก่อนเริ่ม ticket ของ Inbound Voice Phase 1** และรันได้จาก
dev environment ใหม่หลัง `pnpm install` โดยคำสั่งเดียวจะเริ่ม Docker, ทำ migration/RLS/seed,
เชื่อม Keycloak identity และตรวจ PostgreSQL, Redis, MinIO (รวม bucket `recordings`), Redpanda,
FreeSWITCH และ Keycloak จาก interface ที่ service ใช้งานจริง

workflow ยังรัน tenant-isolation evidence ผ่าน role `dcontact_app`, ตรวจว่า OIDC token ที่ถูกแก้ไข
ถูกปฏิเสธ, ตรวจ API Gateway 401/403 และส่ง/รับ representative event ผ่าน public API ของ
`@d-contact/kafka` กับ Redpanda จริง ผลแต่ละขั้นเป็น JSON diagnostic ที่มี `checkId`, `dependency`,
`boundaries`, `status` และ remediation เมื่อไม่ผ่าน โดยไม่แสดง token หรือ secret เมื่อสรุปผล

เมื่อพร้อม บรรทัดสุดท้ายจะมี `"entryCondition":"READY_FOR_INBOUND_VOICE_PHASE_1"`; ถ้าไม่พร้อม
ขั้นที่ล้มเหลวจะแสดง `FAIL` และขั้นที่พึ่งพาจะเป็น `SKIP` พร้อม `blockedBy`

ส่วน identity จะ import realm `dcontact`, สร้าง Organization `demo`, เชื่อม dev users กับ
`users.keycloak_id` ใน Postgres แล้วออก access token จริงเพื่อตรวจลายเซ็นผ่าน JWKS รวมถึง claims
`tenant_id`, `tenant_slug`, `dc_user_id`, `realm_access.roles` และ native `organization` claim

- ถ้า Docker service ใดยังไม่พร้อม ให้ดูสถานะของ Docker Compose แล้วรัน `pnpm infra:up` ซ้ำ
- ถ้า PostgreSQL ไม่พร้อมหลังเคยหยุด Docker นาน ให้รอ health check ผ่านก่อนรัน migration
- ถ้า MinIO หรือ bucket ไม่ผ่าน ให้ตรวจว่า port 9000 ไม่ถูกใช้งานโดยโปรแกรมอื่น และ volume ของ dev เขียนได้
- ถ้า Redpanda topic หาย ให้ตรวจ health ของ Redpanda ก่อน ไม่สร้าง topic ชื่อเก่า `dc.fs.events`
- ถ้า FreeSWITCH ไม่ผ่าน ให้ตรวจ Docker log ของ service และ port SIP/ESL ที่ประกาศไว้; ปัญหาเสียงบน Docker Desktop ให้ตรวจ UDP RTP ตามหมายเหตุด้านบน
- ถ้า Keycloak ไม่ผ่าน ให้ตรวจ port 8081 แล้วรัน `pnpm infra:identity:link` ตามด้วย
  `pnpm infra:identity:check`; realm และ credentials ใน `infra/keycloak/` ใช้เฉพาะ local dev

## Credentials (dev only)

| user                 | password  | role                         |
| -------------------- | --------- | ---------------------------- |
| admin@demo.local     | admin1234 | admin / ADMIN                |
| agent1000@demo.local | agent1234 | agent / AGENT (SIP ext 1000) |
| agent1001@demo.local | agent1234 | agent / AGENT (SIP ext 1001) |

## หมายเหตุ production

- ESL (8021) และ default passwords ทั้งหมดเป็น **dev only** — ห้ามใช้ใน production
- Keycloak bootstrap admin, readiness client และรหัสผ่านใน realm import เป็น **dev only**;
  production ต้องปิด Direct Access Grants และรับ credentials จาก secret manager
- WebSocket softphone ต้องเปลี่ยนเป็น `wss:` (7443) + TLS cert จริง
- App ต้องต่อ DB ด้วย role `dcontact_app` (NOBYPASSRLS) เพื่อให้ RLS ทำงานจริง
- FreeSWITCH directory/dialplan จะเปลี่ยนเป็น generate จาก DB ต่อ tenant (mod_xml_curl) ใน Phase 1
