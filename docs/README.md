# D-Contact — เอกสาร

**D-Contact = CCaaS + ชั้น CX automation** — รับงานทุกช่องทางด้วยคิวเดียว (CCaaS)
และทำให้เรื่องที่คาดเดาได้ไม่ต้องกลายเป็นงานของคน (CXA · [ADR-025](adr/025-journey-orchestration.md))
สิ่งที่**ไม่ใช่**: marketing automation / CDP เต็มรูป — ขอบเขตอยู่ใน ADR-025 ข้อ 8

ดัชนีเอกสารทั้งหมด — อ่านตามลำดับนี้ถ้าเพิ่งเข้าโปรเจค

> **ธรรมเนียมของ schema:** `packages/db/prisma/schema.prisma` เก็บเฉพาะ **ตาราง kernel**
> (tenant · user · queue · interaction · conversation · message · recording) ที่ทุกโมดูลต้องใช้ร่วมกัน
> ส่วน **ตารางของโมดูล** (`wfm_*` `qm_*` `ob_*` `fb_*` `cs_*` `ic_*` `jr_*` `cg_*` …) อยู่ใน
> เอกสารของโมดูลนั้นในรูป Prisma sketch **จนกว่าเฟสของโมดูลจะเริ่มจริง** — เพื่อไม่ให้ schema
> บวมด้วยตารางที่ยังไม่มีโค้ดใช้ และให้ migration เกิดพร้อมโค้ดที่ใช้มันเสมอ

## Architecture Decision Records (docs/adr)

| ADR | เรื่อง | สาระสำคัญ |
|---|---|---|
| [001](adr/001-unified-interaction-model.md) | Unified Interaction Model | 1 งานทุกช่องทาง = 1 interaction — router เดียวกระจายได้หมด |
| [002](adr/002-esl-vs-mod_callcenter.md) | ESL แทน mod_callcenter | FreeSWITCH เป็น media layer เท่านั้น — logic อยู่ที่ router |
| [003](adr/003-kafka-event-backbone.md) | Kafka เป็น event backbone | event ห้ามหาย/replay ได้เพื่อ billing; Redis เหลือ state store |
| [004](adr/004-keycloak-iam.md) | Keycloak เป็น IAM | single realm + Organizations (org ต่อ tenant) |
| [005](adr/005-multitenant-metadata-architecture.md) | Multi-tenant แบบ Salesforce | shared DB + metadata-driven — customize ด้วยข้อมูล ไม่ใช่ schema/โค้ด |
| [006](adr/006-multi-vendor-telephony-gateway.md) | Multi-vendor telephony | 1 vendor/deployment (SaaS=FreeSWITCH, on-prem=Asterisk); kernel เดียวกัน สลับแค่ gateway — router ไม่รู้ vendor |
| [007](adr/007-flow-engine.md) | Omnichannel Flow engine | เปลี่ยนชื่อ IVR→Flow; interpreter ใน router ทำงานก่อน matching; designer ด้วย React Flow |
| [008](adr/008-workforce-management.md) | Workforce Management | `apps/wfm` (TS) + `apps/wfm-engine` (Python/CP-SAT) คุยกันผ่าน Kafka job; ตารางกะเป็น soft constraint — router ไม่รู้จัก WFM |
| [009](adr/009-plan-entitlement-licensing.md) | Plan & entitlement | แยก entitlement ออกจาก quota; guard จุดเดียว + ด่านที่ 2 ที่ขอบ job; หมดอายุ = อ่านอย่างเดียว **ห้ามกระทบการรับสาย**; on-prem ใช้ license เซ็น Ed25519 |
| [010](adr/010-quality-management.md) | Quality Management | การอัดเป็นของ telephony การประเมินเป็นของ `apps/qm` (TS ล้วน ไม่มีภาษาที่สาม); ตรวจทุกช่องทาง; คะแนน AI **ต้องมีหลักฐานและเป็น DRAFT จนคนกด publish**; PCI pause/resume + calibration + appeal อยู่ใน v1 |
| [011](adr/011-outbound-campaign.md) | Outbound & Campaign | `apps/dialer` ผลิต **งาน** ไม่ใช่ **สาย** — วิ่งเข้า router เป็น interaction ปกติ; blended = reserve capacity ที่ router; DNC/consent เป็นด่านบังคับ 2 ชั้น; เพดาน abandon เป็น hard constraint |
| [012](adr/012-feedback-survey.md) | Feedback & Survey | เสียงลูกค้าเป็น entity ของตัวเอง (`fb_*`) ไม่ใช่คอลัมน์ใน interaction; sampling + suppression บังคับ; คะแนนต่ำเป็น **event** ที่เปิดเคส ไม่ใช่แค่แถวในรายงาน |
| [013](adr/013-virtual-agent-knowledge.md) | Virtual Agent & Knowledge | บอตทำงาน **ใน** flow ไม่ใช่แทน flow; ตอบได้เฉพาะจากคลังความรู้และต้องอ้างที่มา; KB เป็นแหล่งความจริงเดียวของบอต/คน/ลูกค้า; บทความต้องมีเจ้าของ + วันหมดอายุ |
| [014](adr/014-agent-assist.md) | Agent Assist | เริ่มที่ **สรุปหลังจบสาย** ไม่ใช่แนะนำระหว่างสาย; ทุกคำแนะนำกดปฏิเสธได้และ **acceptance rate คือ KPI**; ห้ามส่งข้อความหาลูกค้าเอง |
| [015](adr/015-integration-platform.md) | Integration Platform | public API = API ตัวเดียวกับที่ UI เราใช้; webhook เป็น **consumer ของ Kafka** ไม่อยู่ในเส้นทางรับสาย; connector ของเราใช้ primitive เดียวกับพาร์ตเนอร์ |
| [016](adr/016-case-management.md) | Case Management | เพิ่มชั้น `case 1:N interaction` โดยไม่แก้ความหมายของ interaction; SLA ของเคสคนละหน่วยกับ SLA รับสาย; ใช้ router ตัวเดิม ไม่สร้างเครื่องกระจายงานที่สอง |
| [017](adr/017-interaction-analytics.md) | Interaction Analytics | วิเคราะห์ **100%** ของบทสนทนา แยกจากการสุ่มมาให้คะแนน; topic ที่ค้นพบต้องเลื่อนขั้นเป็นกฎได้; ทุกตัวเลขคลิกลงไปเห็นสายจริง |
| [018](adr/018-performance-gamification.md) | Performance & Gamification | scorecard เป็น **ชั้นรวม** ห้ามคัดลอกข้อมูลดิบ; AHT ต้องมีตัวถ่วงเสมอ; gamification ค่าเริ่มต้นปิด |
| [019](adr/019-reporting-data-platform.md) | Reporting & Data Platform | semantic layer ชั้นเดียวใช้ทุกที่; builder ไม่มี SQL อิสระ; ข้อมูลก้อนใหญ่ออกทาง feed; ทุก schedule มีเจ้าของ + วันหมดอายุ |
| [020](adr/020-customer-360.md) | Customer 360 | แยก `contacts` (คน) จาก `contact_identities` (ช่องทาง); รวมอัตโนมัติเฉพาะระดับ **แน่นอน**; merge ต้องย้อนกลับได้ |
| [021](adr/021-flow-expression-node.md) | Expression node ใน Flow | มีทางออกสำหรับ logic ที่ `setvar` ทำไม่ไหว แต่เป็น **นิพจน์ใน sandbox** (ไม่มี I/O · ไม่มีลูปอิสระ · 50 ms) ไม่ใช่ภาษาสคริปต์แบบ NICE Snippet; เปิดหลังมีเคสจริง 3 เคส |
| [022](adr/022-internal-collaboration.md) | Internal Collaboration | แชทภายใน **ไม่ใช่ interaction** (ไม่กิน capacity/ไม่นับ SLA); presence มีแหล่งเดียวคือสถานะเอเจนต์; หัวใจคือ **consult ผูกกับ interaction** → ป้อน `kb_gap`; ไฟล์แนบอยู่ใน v1 พร้อมกติกาครบ; แจ้งเตือนยอมแพ้ให้งานตรงหน้า |
| [023](adr/023-conversation-vs-interaction.md) | Conversation ≠ Interaction ≠ Case | thread ถาวร (`Conversation`) แยกจากงานที่ assign (`Interaction`) และเรื่อง (`Case`); **reopen window 30 นาที** กลับหา agent เดิม; สถานะห้อง OPEN/IDLE/RESOLVED/BLOCKED; agent "Resolve งาน" ไม่ใช่ "ปิดห้อง"; topic เปลี่ยนเป็น `dc.telephony.events` / `dc.channel.events` |
| [024](adr/024-message-delivery-media.md) | Message delivery & media | แถวใน `messages` คือ **outbox**; idempotency สองทาง (`providerMessageId` / `clientToken`); retry มีเพดานและข้อความที่ล้มเหลวต้องเห็นบนหน้าจอ; **ไฟล์จาก provider ต้องดึงทันทีเพราะ URL หมดอายุ** + สแกนก่อนเปิด |
| [025](adr/025-journey-orchestration.md) | Journey Orchestration (CXA) | journey ผูกกับ **ลูกค้า** ไม่ใช่ interaction; **ห้ามสร้าง interaction เอง** สั่งผ่าน channels/dialer/cases; **contact policy ย้ายขึ้นระดับลูกค้า** ครอบทุกช่องทางขาออก; ทุก journey ต้องมี goal + exit + เพดานอายุ; ไม่ทำ marketing automation |
| [026](adr/026-frontend-app-split.md) | แบ่งแอปหน้าจอ | แบ่งตาม **"มีงานอยู่ในมือหรือไม่"** ไม่ใช่ตามบทบาท → `apps/workspace` (รวมหน้าสดของหัวหน้า) + `apps/console`; **แท็บทำงานได้แท็บเดียว** (leader election) และเป็นแท็บเดียวที่ประกาศว่ารับงานได้; ห้าม redirect login / บังคับรีโหลด ระหว่างถืองาน; เบราว์เซอร์ก่อน desktop shell ทีหลังโดยไม่ fork UI |
| [027](adr/027-contact-governance.md) | Contact Governance | ด่านกลางระดับ CIF สำหรับ restriction/consent/preference/attempt/exception; ทุก outbound ต้อง `authorizeAndReserve`; hard restriction ห้ามถูก Allowlist ข้าม; แยก inbound safety ออกจาก outbound DNC |
| [028](adr/028-frontend-component-layer.md) | Frontend component layer | `packages/ui-react` แยกจาก token (`packages/ui`); **React Aria** รับผิดชอบ keyboard/focus/ARIA; **CSS Modules + `var(--dc-*)` เท่านั้น** บังคับด้วย stylelint; ข้อความของ component อยู่ใน namespace `ui` ของ react-i18next; preview page Vite (ไม่ใช้ Storybook) เป็นหน้าตรวจ axe/keyboard |

## เอกสารสถาปัตยกรรม

| เอกสาร | เนื้อหา |
|---|---|
| [multi-tenancy.md](multi-tenancy.md) | โมเดล multi-tenant ฉบับเต็ม: kernel/metadata/virtual schema, config cache, custom fields, tenant lifecycle, isolation 5 ชั้น |
| [iam-architecture.md](iam-architecture.md) | Keycloak: OIDC flows, token claims, provisioning saga, RLS wiring, phased rollout A–D |
| [interaction-data-flow.md](interaction-data-flow.md) | **สามชั้น conversation/interaction/case (§1.1)**, lifecycle + reopen, end-to-end call flow, Router (ACD) 6 ขั้น, **§4.1 สัญญาการรับงาน digital (ack/requeue) · §4.2 idle auto-wrap คืน slot · §4.3 ลูกค้าพิมพ์กลับหลังปิดงาน** |
| [flow-engine.md](flow-engine.md) | Flow Engine: node taxonomy **18 ชนิด** + capability matrix (รวม `VOICE_OUTBOUND`), flow JSON schema, execution state machine, **subflow · expression sandbox · flow trace · สัญญา `onError`**, versioning/publish, ตัวอย่าง 12 flow, **§11 เทียบกับ Zoom/NICE CXone และสิ่งที่ตั้งใจไม่ทำ** |
| [workforce-management.md](workforce-management.md) | WFM: interval stats, forecasting, Erlang C/chat concurrency/shrinkage, CP-SAT scheduling 3 ขั้น, adherence & RTA, intraday, multi-country (DST/กฎแรงงาน), แผนเฟส W1–W5 |
| [quality-management.md](quality-management.md) | QM: recording lifecycle + PCI pause/resume + retention 3 ชั้น, transcript pipeline (ASR provider + ข้อจำกัดภาษาไทย), category DSL, quality plan/sampling, สคีมาฟอร์ม + สูตรคะแนน, สัญญาหลักฐานของ auto-QM, calibration & appeal, coaching→WFM, แผนเฟส Q1–Q5 |
| [licensing.md](licensing.md) | Entitlement vs quota, JSON schema, ตารางสิทธิ์ต่อแพ็กเกจ (starter/growth/enterprise), การรวมค่า 3 ชั้น, จุดบังคับใช้ 5 จุด, on-prem license (Ed25519), state machine หมดอายุ, แผนเฟส L1–L4 |
| [outbound-campaign.md](outbound-campaign.md) | Outbound: โหมด preview/progressive/predictive + สูตร pacing, ด่านคัดกรอง 6 ชั้น, data model `ob_*`, callback, proactive messaging, แผนเฟส O1–O5 |
| [feedback-survey.md](feedback-survey.md) | CSAT/NPS/CES: การถามในแต่ละช่องทาง, sampling/suppression, closed loop → เคส + คิว QM, รายงานที่ต้องมี, แผนเฟส F1–F5 |
| [virtual-agent-knowledge.md](virtual-agent-knowledge.md) | บอต 3 ระดับ (menu/RAG/task), สัญญาของ node `Bot`, คลังความรู้ + วงจร kb_gap, voice bot, แผนเฟส B1–B5 |
| [agent-assist.md](agent-assist.md) | สรุปหลังจบสาย, แนะนำบทความ, nudge จาก category DSL, real-time guidance กับเงื่อนไข latency, **สคริปต์นำบทสนทนา (A6) — node 5 ชนิด · ขั้นบังคับ · pin เวอร์ชันต่อสาย · ไม่ผ่าน LLM**, แผนเฟส A1–A7 |
| [integration-platform.md](integration-platform.md) | Public REST API + OAuth2, webhook (ลายเซ็น/retry/DLQ), connector CRM, CTI embedded agent, data model `int_*`/`wh_*`, แผนเฟส I1–I5 |
| [case-management.md](case-management.md) | เคส vs interaction, data model `cs_*`, SLA + หยุดนาฬิกา, การมอบหมายผ่าน router, แผนเฟส C1–C5 |
| [interaction-analytics.md](interaction-analytics.md) | category (กฎที่คนเขียน) vs topic (ค้นพบเอง), `ia_topic_intervals`, saved search + alert, ตัวชี้วัดระดับธุรกิจ, แผนเฟส N1–N5 |
| [performance-gamification.md](performance-gamification.md) | metric registry, สูตรคะแนนรวม + `minSample`, `requiresPair`, gamification 3 ระดับการเปิดเผย, แผนเฟส P1–P5 |
| [reporting-data-platform.md](reporting-data-platform.md) | semantic layer, report builder, scheduled delivery, data feed (Parquet + manifest), **report catalog §7 — รายงานทุกใบของทุกโมดูล พร้อม key/dataset/สิทธิ์/ชั้น/เฟส (แหล่งความจริงเดียว)**, แผนเฟส R1–R5 |
| [customer-360.md](customer-360.md) | `contact_identities` + normalize, กติกาการจับคู่ 3 ระดับ, โปรไฟล์ 360, สิทธิ PDPA, แผนเฟส U1–U5 |
| [journey-orchestration.md](journey-orchestration.md) | ชั้น CX automation: trigger 4 ชนิด, การกระทำที่สั่งได้, เรียก **Contact Governance** ก่อนทุก action, data model `jr_*`/`sg_*`, ตัววัด (goal conversion · **สายที่ไม่เกิด** · suppression) + holdout, แผนเฟส J1–J5 |
| [contact-governance.md](contact-governance.md) | **การกำกับสิทธิการติดต่อระดับ CIF**: DNC/restriction, consent/preference, Attempt/Touch, Approved exception, decision trace, reservation กลางและแผนเฟส CG1–CG5 |
| [contact-governance-data-flow.md](contact-governance-data-flow.md) | **Data flow ของ Contact Governance**: การไหลข้อมูลจาก CRM/Customer 360/Agent/Flow ไปยัง Journey, Dialer, Channels, Provider และ `cg_*` ทุกตาราง รวม Customer Segment & Team Scope (Team A/C → LOND, Team D → CARD), API, Kafka และ lifecycle ของ reservation |
| [internal-collaboration.md](internal-collaboration.md) | แชทภายใน: ห้อง 4 ชนิด, **consult + กลุ่มผู้เชี่ยวชาญ + ตัวชี้วัด**, presence จากสถานะเอเจนต์, **ไฟล์แนบ (รูป/เอกสาร) ครบกติกา**, การแจ้งเตือนที่ไม่รบกวนสาย, สิทธิ์/compliance, แผนเฟส CL1–CL6 |
| [sales-playbook.md](sales-playbook.md) | มาตรฐานข้อความขาย, persona, discovery, demo path, objection handling, governance และ metrics สำหรับปรับปรุง script |
| [sales-script-one-page.md](sales-script-one-page.md) | talk track แบบย่อสำหรับ qualification, discovery, demo และการปิด next step |
| [tier3-roadmap.md](tier3-roadmap.md) | **แผนอย่างเดียว**: compliance/governance, sandbox + config promotion, BC/DR, video/co-browse, voice biometrics, white-label, screen recording, marketplace — พร้อมช่อง "ต้องเผื่ออะไรไว้ตั้งแต่ตอนนี้" |

## UI Mockups (`mockups/`)

Mockup แบบ static HTML (Tailwind + Tabler icons, สลับ EN/TH ได้) — ออกแบบก่อนเขียนโค้ดจริง

- **เปิดดู**: `mockups/index.html` (login → เข้าแอป) หรือ dev server `mockups` ใน `.claude/launch.json`
  ซึ่งรัน `mockups/serve.py` — เป็น `http.server` ที่ส่ง `Cache-Control: no-store` เพื่อไม่ให้เบราว์เซอร์
  แคช `app.css` / `app.js` ค้างจนแก้แล้วไม่เห็นผล
- **โมดูลใหม่ (Tier 1–2)**: **contact governance** (policy ระดับ CIF · restriction/DNC · consent/preference ·
  Attempt/Touch · Approved exception · decision explorer/audit) · **outbound** (แคมเปญ list/new/edit · จอเดินแคมเปญ · รายชื่อ · นัดโทรกลับ ·
  broadcast · DNC · รหัสผลการติดต่อ) · **cases** (เคส list/detail/new/edit · ประเภทเคส · นโยบาย SLA) ·
  **ai** (บอต list/new/edit + ชุดทดสอบ + deflection · คลังความรู้ list/new/edit + kb gap ·
  ผู้ช่วยเอเจนต์: ตั้งค่า/prompt/playbook/**สคริปต์นำบทสนทนา list/new/edit**/คุณภาพ) · **analytics** (หัวข้อ + ค้นบทสนทนา + saved search ·
  CSAT/NPS + แบบสำรวจ + แผนการถาม + คำตอบ · scorecard + gamification) ·
  **integrations** (เดิมชื่อ channels — รวมทุกอย่างที่ต่อกับของนอกระบบไว้ที่เดียว: ภาพรวมสุขภาพ ·
  ช่องทางที่รับงาน DID/webchat/social/email · ระบบภายนอก แอป/ตัวเชื่อม/ซิงก์ลูกค้า/ผู้ให้บริการ AI ·
  สำหรับนักพัฒนา API client/webhook/visual apps/streaming/แคตตาล็อก event) ·
  ส่วนขยายในหน้าเดิม: `people` (โปรไฟล์ 360 + รวมตัวตน) ·
  `reports` (คลังรายงาน + report builder + ส่งอัตโนมัติ + data feed)
- **ฝั่ง tenant** (เดิม): home (dashboard/wallboard) · workspace (omnichannel inbox +
  **แผงบริบทแบบแท็บ 5 แท็บ** — ลูกค้า/สคริปต์/งานค้าง/ขอความช่วย/แอป พร้อม badge และแถบเตือน
  สำหรับของด่วนที่อยู่หลังแท็บที่ปิดอยู่ · แท็บแอปมี Salesforce screen pop + visual app ของลูกค้า ·
  **สามคอลัมน์ลากปรับความกว้างเองได้ จำค่าต่อผู้ใช้ และสูงเต็มจอ** — [§4.4](interaction-data-flow.md)) ·
  routing (queues CRUD/skills/hours/**Flows**) · people (agents/teams/contacts CRUD) ·
  **wfm** (schedule/forecast/adherence/intraday/time-off/sites/my-schedule) ·
  **qm** (คิวงานตรวจ/scorecard พร้อม waveform+transcript+หลักฐาน/calibration/appeals/coaching/
  recordings+transcripts/categories/insights/forms/plans/retention+PCI/my-scores) ·
  integrations (DID/webchat/social/email + ระบบภายนอก + API) · history · reports · admin (users/roles/tenant/usage/audit)
- **หมายเหตุ**: mockup เป็น shell เดียวโดยเจตนา (ใช้เดินเรื่องได้ครบ) แต่โค้ดจริงแยกสองแอปตาม
  [ADR-026](adr/026-frontend-app-split.md): หน้าที่ต้องมี session สด (workspace + หน้าสดของหัวหน้า)
  อยู่คนละแอปกับหน้าตั้งค่า/รายงาน — อ่าน rail แล้วอย่าเข้าใจว่าเป็นแอปเดียว
- **Flow Designer**: `flow-editor.html?id=<flowId>` — canvas React Flow (โหลดผ่าน esm.sh, ไม่มี build step)
  ลากวาง node จาก palette 13 ชนิด, ต่อเส้น, แก้ property ใน inspector; มีตัวอย่าง 10 flow ครบ 6 ช่องทาง
- **ฝั่ง platform operator**: `platform.html` — จัดการ tenants (list/new/edit), plans + entitlement matrix,
  **Entitlements & licenses** (สิทธิ์ที่มีผลจริงต่อ tenant, overrides, on-prem licenses), usage ข้าม tenant
- **หน้าเว็บขายของ (marketing)**: `www.html` — landing page หน้าเดียว (hero + ปัญหา + ความสามารถ 4 บล็อก
  + สถาปัตยกรรม + ราคา 3 แพ็กเกจ + FAQ + ฟอร์มขอ demo), TH เป็นภาษาหลักสลับ EN ได้,
  self-contained ไม่ใช้ `assets/app.*` — **ราคาและข้อมูลติดต่อทั้งหมดเป็นค่าสมมติ ต้องแทนที่ก่อนใช้จริง**

## สถานะโปรเจค

- **Phase 0 (เคยเสร็จ แต่โค้ดถูกลบแล้ว)**: monorepo, docker dev env
  (FreeSWITCH/Postgres/Redis/MinIO/Redpanda), Prisma schema + RLS, API auth (JWT ชั่วคราว),
  softphone spike, Kafka end-to-end call event ผ่านแล้ว —
  **`apps/*` ถูกลบทิ้ง 2026-08-14** เพราะ skeleton ไม่ตรงกับแบบล่าสุดแล้ว
  (กู้อ้างอิงได้ที่ `git checkout 8165970 -- apps`) · ที่ยังอยู่จริง: `packages/*` · `infra/` · `mockups/` · `docs/`
- **ตอนนี้**: เฟส mockup + docs — ทำเอกสารให้ครบก่อนเริ่มโค้ด Phase 1 ใหม่จากศูนย์
  งานแรกของ Phase 1 ฝั่งหน้าจอไม่ใช่หน้าจอ แต่คือ leader election + สัญญา WS เส้นเดียว
  ([ADR-026](adr/026-frontend-app-split.md) ข้อ 2)
- **Phase 1 (Voice MVP)**: router logic (interaction-data-flow §4), Flow interpreter ขั้นที่ 3
  ([flow-engine.md §5](flow-engine.md)), Keycloak Phase A–B, tenant config cache, mod_xml_curl directory
