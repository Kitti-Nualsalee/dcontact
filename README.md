# D-Contact

Omnichannel Contact Center (SaaS, multi-tenant) — Voice / Web Chat / LINE / Facebook / WhatsApp / Email
สถาปัตยกรรมและ roadmap ฉบับเต็มอยู่ในแผนโปรเจค, การตัดสินใจสำคัญอยู่ใน [docs/adr](docs/adr)

## Stack

- **Media/Telephony:** FreeSWITCH (self-hosted) คุมผ่าน ESL — ดู [ADR 002](docs/adr/002-esl-vs-mod_callcenter.md)
- **Event backbone:** Kafka (dev = Redpanda) — ทุก domain event เพื่อรองรับ billing/reporting แบบ SaaS
  ดู [ADR 003](docs/adr/003-kafka-event-backbone.md); Redis เหลือบทบาท state store เท่านั้น
- **Backend:** Node.js + TypeScript (NestJS + worker services), PostgreSQL, Redis, MinIO/S3
- **Frontend:** React + Vite, softphone ผ่าน SIP.js (WebRTC)
- **Monorepo:** pnpm workspaces + Turborepo

## โครงสร้าง

| path                 | หน้าที่                                                 |
| -------------------- | ------------------------------------------------------- |
| `apps/api`           | REST + WebSocket gateway (auth, tenant, CRUD)           |
| `apps/telephony`     | ESL controller — สะพานเชื่อม FreeSWITCH                 |
| `apps/router`        | ACD/routing engine (ทุก channel)                        |
| `apps/channels`      | Channel gateways (webchat, LINE, FB, WA, email)         |
| `apps/agent-desktop` | Agent workspace + softphone                             |
| `packages/shared`    | Types + event contracts                                 |
| `packages/kafka`     | Kafka producer/consumer wrapper (ทุก service ใช้ตัวนี้) |
| `packages/db`        | Prisma schema, RLS, seed                                |
| `infra/`             | Docker Compose + FreeSWITCH config (config-as-code)     |

## เริ่มต้น dev

```bash
pnpm install

# 1. infra: FreeSWITCH + Postgres + Redis + MinIO + Redpanda (Kafka)
#    Redpanda Console (ดู topics/messages): http://localhost:8085
pnpm infra:up

# 2. database
pnpm db:migrate      # สร้าง schema
pnpm db:rls          # ติดตั้ง Row-Level Security policies
pnpm db:seed         # tenant "demo" + agent 1000/1001 + queue

# 3. build ทั้งหมด
pnpm build

# 4. รัน services (แยก terminal หรือใช้ turbo dev)
pnpm --filter @d-contact/api dev            # http://localhost:3000/api
pnpm --filter @d-contact/telephony dev      # ESL bridge
pnpm --filter @d-contact/router dev
pnpm --filter @d-contact/agent-desktop dev  # http://localhost:5173
```

### ทดสอบ softphone spike (Phase 0)

1. เปิด http://localhost:5173 สองแท็บ
2. แท็บแรก register ext `1000`, แท็บสอง ext `1001` (รหัส `DContactDev1`)
3. โทร `1001` จากแท็บแรก หรือโทร `9196` (echo test) เพื่อทดสอบ media path
4. ดู call events วิ่งใน log ของ `telephony` และ `router`

> **Docker Desktop (macOS/Windows):** FreeSWITCH advertise `127.0.0.1` เป็น RTP address
> (ตั้งใน `infra/freeswitch/conf/vars.xml`) เพื่อให้ browser บน host ส่ง media ผ่าน
> published UDP ports ได้ ถ้าเสียงไม่มา ให้ตรวจว่า port `16384-16420/udp` ถูก publish
> และไม่มี firewall ขวาง — บน Linux เปลี่ยน `external_rtp_ip` เป็น IP จริงของเครื่อง

### Login API

```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"tenant":"demo","email":"admin@demo.local","password":"admin1234"}'
```

## Credentials (dev seed)

| user                 | password  | role                 |
| -------------------- | --------- | -------------------- |
| admin@demo.local     | admin1234 | ADMIN                |
| agent1000@demo.local | agent1234 | AGENT (SIP ext 1000) |
| agent1001@demo.local | agent1234 | AGENT (SIP ext 1001) |

## หมายเหตุ production

- ESL (8021) และ default passwords ทั้งหมดเป็น **dev only** — ห้ามใช้ใน production
- WebSocket softphone ต้องเปลี่ยนเป็น `wss:` (7443) + TLS cert จริง
- App ต้องต่อ DB ด้วย role `dcontact_app` (NOBYPASSRLS) เพื่อให้ RLS ทำงานจริง
- FreeSWITCH directory/dialplan จะเปลี่ยนเป็น generate จาก DB ต่อ tenant (mod_xml_curl) ใน Phase 1
