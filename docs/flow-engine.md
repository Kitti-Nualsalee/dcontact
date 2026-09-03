# D-Contact — Flow Engine & Flow Designer

> เอกสารออกแบบประกอบ [ADR-007](adr/007-flow-engine.md) · สถานะ: **แผน (ยังไม่ implement)**
> mockup ใช้งานได้แล้วที่ `mockups/flow-editor.html` · อัปเดต 2026-07-26

## 1. Flow คืออะไร

**Flow = ชุดการตัดสินใจก่อนงานเข้าคิว** ทำงานที่ router ขั้นที่ 3
([interaction-data-flow §4](interaction-data-flow.md)) — ก่อนการจับคู่ agent

```
Facebook ─┐
LINE ─────┤
Web Chat ─┼─▶ Flow Engine ─▶ Queue/ACD ─▶ Agent
Voice ────┤   (ต้อนรับ · เก็บข้อมูล · เงื่อนไข · API · เลือกปลายทาง)
Email ────┘
```

เดิมเรียก "IVR flows" ซึ่งครอบแค่ voice — เปลี่ยนเป็น **Flow** เพราะ layer นี้ใช้ร่วมกันทุกช่องทาง
(รายละเอียดการตัดสินใจและการเปลี่ยนชื่อดู ADR-007)

**เส้นแบ่งความรับผิดชอบ (กติกาเหล็ก):**

| Flow เป็นเจ้าของ | Router/ACD เป็นเจ้าของ |
|---|---|
| ต้อนรับ, เก็บ input, เงื่อนไข, เรียก API, เลือก **ปลายทาง** (queue/agent/terminal) | จับคู่ agent, reserve, ring timer, requeue (§4 ขั้น 4–6) |

node `routeToQueue` / `routeToAgent` คือ **จุดส่งมอบ** — flow ห้ามแตะ agent state

## 2. Node taxonomy (18 ชนิด, 8 หมวดสี)

สีในตารางตรงกับสีใน Flow Designer · **★ = เพิ่มหลังจาก ADR-007** (ที่มาอยู่ในคอลัมน์สุดท้าย)

| # | Node | หมวด (สี) | หน้าที่ | ปลายทาง? | ที่มา |
|---|---|---|---|---|---|
| 1 | `trigger` | Entry (เขียว) | จุดเข้าตามช่องทาง + entry variables (DID, channel account, contact) — มีตัวเดียวต่อ flow | — | |
| 2 | `play` (Play / Send) | I/O (น้ำเงิน) | พูด/ส่งข้อความ: TTS/audio สำหรับ voice, ข้อความ/rich สำหรับ digital | — | |
| 3 | `collect` (Collect input) | I/O (น้ำเงิน) | รับคำตอบ: DTMF/speech (voice), quick-reply/free text (chat); แตกเส้นตามตัวเลือก + timeout/no-match | — | |
| 4 | `condition` | Logic (เหลืองอำพัน) | แตกกิ่งตามเวลาทำการ, ภาษา, ตัวแปร, attribute ลูกค้า | — | |
| 5 | `setvar` (Set variable) | Logic | กำหนด/แปลงค่าตัวแปรใน flow | — | |
| 6 | ★ `expression` | Logic | คำนวณค่าจากนิพจน์ใน sandbox (ไม่มี I/O, มีเพดานเวลา) — ทางออกสำหรับ logic ที่ `setvar` ทำไม่ไหว | — | [ADR-021](adr/021-flow-expression-node.md) |
| 7 | ★ `subflow` (Call flow) | Logic | เรียกผังย่อยที่ใช้ซ้ำได้ ส่งตัวแปรเข้า/ออกแบบระบุชัด | — | §10 |
| 8 | `api` (API call) | Integration (ม่วง) | เรียก HTTP ผ่าน `int_connections`, map ผลลัพธ์เข้าตัวแปร, มีเส้น success/error | — | [integration §10](integration-platform.md) |
| 9 | `bot` (Bot / NLU) | Integration | เรียกบอตแล้วรับผล **ANSWERED / HANDOFF / FAILED** พร้อม `sources[]` และ `confidence` | — | [ADR-013](adr/013-virtual-agent-knowledge.md) |
| 10 | ★ `case` (Create / attach case) | Work item (คราม) | เปิดเคสใหม่หรือผูกกับเคสที่เปิดอยู่ของลูกค้ารายนี้ | — | [ADR-016](adr/016-case-management.md) |
| 11 | ★ `survey` | Work item | ถามความพึงพอใจ: IVR ก่อนวางสาย (voice) หรือการ์ดในห้องแชท (digital) | ✔ | [ADR-012](adr/012-feedback-survey.md) |
| 12 | `queue` (Route to queue) | Routing (teal) | **ส่งมอบให้ ACD** — กำหนด queueId + priority + required skills + context | ✔ ACD | |
| 13 | `agent` (Route to agent) | Routing | ส่งตรงถึง agent/last-agent/skill ที่ระบุ (ยังผ่าน ACD) | ✔ ACD | |
| 14 | ★ `caseOwner` (Route to case owner) | Routing | ถ้าลูกค้ามีเคสเปิดอยู่ ส่งหาเจ้าของเคสก่อน มีเส้นสำรองเมื่อเจ้าของไม่ว่าง | ✔ ACD | [ADR-016](adr/016-case-management.md) |
| 15 | `voicemail` | Deflect (ชมพูแดง) | อัดข้อความ (voice เท่านั้น) แล้วส่งเข้าคิวเป็นงาน | ✔ | |
| 16 | `callback` | Deflect | เสนอ/จอง callback (voice) หรือ "จะติดต่อกลับ" (digital) | ✔ | |
| 17 | `transfer` | Terminal (เทา) | โอนออกเบอร์ภายนอก (voice) / forward (email) | ✔ | |
| 18 | `end` | Terminal | วางสาย (voice) / ปิดบทสนทนา (digital) | ✔ | |

`play`/`collect` เป็น **node ชนิดเดียวที่ render ต่างกันตามช่องทาง** ไม่แยกชนิดต่อช่องทาง
เพื่อคุมขนาด palette

**หลักในการเพิ่ม node ใหม่** (กันไม่ให้ palette บวมเป็นหลักร้อยแบบเจ้าอื่น — §11):
node ใหม่ต้องเป็นสิ่งที่ **flow ทำเองไม่ได้ด้วย node ที่มีอยู่** ไม่ใช่แค่ทางลัดของสิ่งที่ทำได้แล้ว
(`caseOwner` ผ่านเกณฑ์เพราะต้องอ่านสถานะเคส + ตกลงกับ ACD; ส่วน "ส่งอีเมลแจ้งหัวหน้า"
ไม่ผ่านเพราะทำได้ด้วย `api` อยู่แล้ว)

## 3. Capability matrix (node × channel)

● ใช้ได้เต็ม · ◐ ใช้ได้แบบมีเงื่อนไข · ✕ ใช้ไม่ได้

| Node | VOICE | WEBCHAT | LINE | FACEBOOK | WHATSAPP | EMAIL |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| trigger | ● | ● | ● | ● | ● | ● |
| play / send | ● audio/TTS | ● text/rich | ● text/flex | ● text | ● text/template | ● subject+body |
| collect | ● DTMF/speech | ● quick-reply | ● quick-reply | ● quick-reply | ● list/buttons | ✕ ไม่มี sync prompt |
| condition | ● | ● | ● | ● | ● | ● |
| setvar | ● | ● | ● | ● | ● | ● |
| expression | ● | ● | ● | ● | ● | ● |
| subflow | ● | ● | ● | ● | ● | ● |
| api | ● | ● | ● | ● | ● | ● |
| bot / NLU | ◐ ต้องมี ASR | ● | ● | ● | ● | ◐ classify เท่านั้น |
| case | ● | ● | ● | ● | ● | ● |
| survey | ● IVR ก่อนวางสาย | ● การ์ดในห้องแชท | ● | ● | ● template | ◐ ส่งลิงก์ |
| route to queue | ● | ● | ● | ● | ● | ● |
| route to agent | ● | ● | ● | ● | ● | ● |
| route to case owner | ● | ● | ● | ● | ● | ● |
| voicemail | ● | ✕ | ✕ | ✕ | ✕ | ✕ |
| callback | ● | ◐ "จะติดต่อกลับ" | ◐ | ◐ | ◐ | ● auto-ack |
| transfer | ● เบอร์นอก | ✕ | ✕ | ✕ | ✕ | ◐ forward |
| end | ● hangup | ● ปิดแชท | ● | ● | ● | ● |

**ข้อบังคับที่ต้อง validate ตอน publish:** DTMF เฉพาะ VOICE · voicemail/transfer-DID เฉพาะ VOICE ·
EMAIL ไม่มี `collect` แบบ synchronous (เป็น store-and-forward → flow email คือ classify/auto-ack/route) ·
`subflow` ที่เรียกต้องมี `channelBinding` เดียวกันหรือเป็น `ANY` · ทุก flow ต้องมี `fallbackNodeId` (§5.5)

### 3.1 ช่องทางที่ 7: `VOICE_OUTBOUND`

สายขาออกที่ปลายทาง**รับสายแล้ว** ก็เป็น interaction ที่ต้องมี flow เหมือนกัน
([ADR-011](adr/011-outbound-campaign.md) — `ob_campaign.flowId`) ต่างจาก `VOICE` สามข้อ:

| | VOICE | VOICE_OUTBOUND |
|---|---|---|
| ใครเริ่ม | ลูกค้า | เรา (dialer) |
| entry variables | DID, ANI, contact | + `campaignId`, `recordId`, `amdResult`, ทุกคีย์ใน `ob_record.attrs` |
| node ที่ห้ามใช้ | — | `callback` (ไร้ความหมาย — เราเป็นคนโทร), `voicemail` แบบรับฝาก |

ใช้จริงเพื่อ: แจ้งข้อมูลด้วย TTS ก่อนต่อเอเจนต์ · ให้กด 1 เพื่อคุยกับคน/กด 9 เพื่อขอไม่ให้ติดต่ออีก
(กด 9 → node `api` เพิ่ม hard restriction ผ่าน Contact Governance) · ฝากข้อความอัตโนมัติเมื่อ `amdResult = MACHINE`

## 4. Flow JSON schema

React Flow serialize ออกมาเป็นรูปนี้ตรง ๆ (ฟิลด์ `position`/`sourceHandle` เป็น shape ของ React Flow
— engine อ่านข้าม `position`)

```jsonc
{
  "id": "flow_voice_mainmenu",
  "tenantId": "…uuid…",
  "name": "Voice — Main menu",
  "kind": "MAIN",                   // MAIN | SUBFLOW  (§10)
  "channelBinding": "VOICE",        // VOICE | VOICE_OUTBOUND | WEBCHAT | LINE | FACEBOOK | WHATSAPP | EMAIL | ANY(เฉพาะ SUBFLOW)
  "version": 3,
  "status": "published",            // draft | published | archived
  "entryNodeId": "n_trigger",
  "fallbackNodeId": "n_fallback",   // บังคับมี — ปลายทางเมื่อ node ใดก็ตามพังโดยไม่มี onError (§5.5)
  "variables": [
    { "key": "lang",  "type": "string",  "default": "th" },
    { "key": "isVip", "type": "boolean", "default": false }
  ],
  "nodes": [
    { "id": "n_trigger", "type": "trigger", "position": { "x": 40, "y": 160 },
      "data": { "channel": "VOICE" } },

    { "id": "n_hours", "type": "condition", "position": { "x": 260, "y": 160 },
      "data": { "kind": "businessHours", "scheduleId": "hours_bkk_office",
                "branches": [ { "id": "open", "label": "Open" },
                              { "id": "closed", "label": "Closed" } ] } },

    { "id": "n_welcome", "type": "play", "position": { "x": 500, "y": 80 },
      "data": { "prompt": { "th": "สวัสดีค่ะ ขอบคุณที่ติดต่อ ACME", "en": "Welcome to ACME" },
                "voice": "th-TH-Standard-A" } },

    { "id": "n_menu", "type": "collect", "position": { "x": 740, "y": 80 },
      "data": { "mode": "dtmf", "maxDigits": 1, "timeoutSec": 5,
                "options": [ { "key": "1", "label": "Support" },
                             { "key": "2", "label": "Sales" },
                             { "key": "0", "label": "Operator" } ],
                "onTimeout": "0", "onNoMatch": "replay" } },

    { "id": "n_q_support", "type": "queue", "position": { "x": 1000, "y": 20 },
      "data": { "queueId": "…uuid…", "priority": 1, "context": { "menu": "support" } } },

    { "id": "n_vm", "type": "voicemail", "position": { "x": 500, "y": 300 },
      "data": { "prompt": { "th": "นอกเวลาทำการ กรุณาฝากข้อความ" }, "maxSec": 120,
                "deliverToQueueId": "…uuid…" } }
  ],
  "edges": [
    { "id": "e0", "source": "n_trigger", "target": "n_hours" },
    { "id": "e1", "source": "n_hours", "sourceHandle": "open",   "target": "n_welcome" },
    { "id": "e2", "source": "n_hours", "sourceHandle": "closed", "target": "n_vm" },
    { "id": "e3", "source": "n_welcome", "target": "n_menu" },
    { "id": "e4", "source": "n_menu", "sourceHandle": "1", "target": "n_q_support" }
  ]
}
```

### 4.1 รูปของ node ที่เพิ่มใหม่

```jsonc
// เรียกผังย่อย — ตัวแปรส่งเข้า/ออกแบบระบุชัดเท่านั้น ไม่มี scope ร่วม
{ "id": "n_verify", "type": "subflow",
  "data": { "subflowId": "flow_shared_verify", "pinnedVersion": 4,
            "inputs":  { "phone": "$.ani", "maxTries": 3 },
            "outputs": { "verified": "isVerified", "customerNo": "crmId" } },
  "outputs": ["done", "error"] }

// คำนวณค่าใน sandbox — ไม่มี I/O, ไม่มี await, มีเพดานเวลา (ADR-021)
{ "id": "n_calc", "type": "expression",
  "data": { "assign": "tier",
            "expr": "vars.spend12m > 1000000 ? 'gold' : vars.spend12m > 200000 ? 'silver' : 'bronze'",
            "timeoutMs": 50 },
  "outputs": ["done", "error"] }

// เปิดเคสใหม่ หรือผูกกับเคสที่เปิดอยู่ของลูกค้ารายนี้
{ "id": "n_case", "type": "case",
  "data": { "mode": "createOrAttach", "typeKey": "technical", "priority": "normal",
            "subjectFrom": "$.vars.topic", "fields": { "deviceModel": "$.vars.model" } },
  "outputs": ["created", "attached", "error"] }

// ส่งหาเจ้าของเคสก่อน ถ้าไม่ว่างค่อยเข้าคิวปกติ
{ "id": "n_owner", "type": "caseOwner",
  "data": { "caseIdFrom": "$.vars.caseId", "waitSec": 20, "fallbackQueueId": "…uuid…" },
  "outputs": ["routed", "unavailable"] }

// ถามความพึงพอใจ — voice = โอนเข้า IVR สำรวจก่อนวางสาย, digital = การ์ดในห้องเดิม
{ "id": "n_survey", "type": "survey",
  "data": { "surveyId": "fb_csat_th", "askBefore": "hangup", "skipIfAskedWithinDays": 30 },
  "outputs": ["sent", "skipped"] }
```

`$.` คือการอ้างค่าจาก state ปัจจุบัน (`$.ani`, `$.vars.x`, `$.contact.id`) — เป็นการ **อ่านอย่างเดียว**
และไม่ใช่ภาษาโปรแกรม การคำนวณจริงต้องผ่าน `expression` ที่มี sandbox

**การเลือก flow ตอน intake:** router ขั้น 1 รู้ tenant + channel + DID/channel-account อยู่แล้ว →
คีย์การเลือกคือ `(tenantId, channelBinding, entrypointRef)` โดย `entrypointRef` = DID (voice)
หรือ channel-account id (digital) — mapping นี้อยู่ใน tenant metadata ร่วมกับ config ของเบอร์/บัญชี
(ช่อง "Route to" ในหน้า Channels จึงกลายเป็น "Route to Flow")

## 5. Execution model

state ต่อ interaction เก็บใน Redis key `flow:{interactionId}` (TTL สูงกว่าอายุ flow เล็กน้อย):

```
{ flowId, flowVersion, currentNodeId, variables{},
  waitingFor: null | {kind, token, deadlineTs},
  stack: [ {flowId, flowVersion, returnNodeId, outputs{}} ],   // subflow call stack (§10)
  traceId, history[] }                                          // history[] → flow_traces (§5.6)
```

`RUNNING` (เดิน node แบบ synchronous) → `WAITING` (ส่งคำสั่งแล้วรอ event ภายนอก) → `RUNNING` →
`HANDED_OFF` (ส่งให้ ACD) | `TERMINATED` (end/voicemail/transfer)

### 5.1 Voice (สายถูก park ไว้ ตาม ADR-002)

1. router ขั้น 3: resolve flow → สร้าง state `RUNNING` → เดินจาก `entryNodeId`
2. node แบบ synchronous (`condition`, `setvar`) ทำใน process ไม่ผ่าน Kafka
3. `play`/`collect` → produce `dc.telephony.commands` (`play` / `collect_dtmf`, key = callUuid,
   header `vendor` ตาม [ADR-006](adr/006-multi-vendor-telephony-gateway.md)) → set `WAITING` + `deadlineTs` → คืน consumer loop
4. FreeSWITCH/Asterisk เล่นเสียง/เก็บปุ่ม → gateway ส่งผลลัพธ์ลง `dc.telephony.events`
5. router consume event นั้น → โหลด state ด้วย `interactionId` → เทียบ `waitingFor.token` →
   เดินต่อ (dedupe ด้วย `eventId`)
6. `queue` node → set `interaction.queueId` + append `interaction_events` → `HANDED_OFF` →
   ส่งเข้า matching ขั้น 4 (สายยัง park อยู่; คำสั่ง bridge เกิดตอน matching สำเร็จเหมือนเดิม)
7. **timeout**: timer tick ของ router ยิงเมื่อถึง `deadlineTs` → เดินตามเส้น `onTimeout`

### 5.2 Digital (ข้อความเข้า)

1. channels gateway normalize ข้อความเข้า → `dc.channel.events` → router สร้าง interaction + flow state
2. `play`/`collect` → produce **`dc.channel.commands`** (topic ใหม่, key = interactionId) →
   gateway ส่งออก LINE/FB/WA/webchat/email → `WAITING`
3. ลูกค้าตอบ → gateway ส่งข้อความเข้า `dc.channel.events` → router เดิน flow เดิมต่อด้วย `interactionId`
4. `api` ทำใน process (await ใน interpreter ไม่ผ่าน Kafka) → map ผล → เดินเส้น success/error
5. `queue` → ส่งให้ ACD (digital assign = ขั้น 5 push ผ่าน `dc.agent.events`)
   — flow ของ EMAIL ปกติคือ trigger → api/classify → setvar → queue (ไม่มีรอ)
6. **idle timeout**: ถ้าลูกค้าไม่ตอบจนถึง `deadlineTs` → ปิดบทสนทนาหรือเข้าคิวตาม `onTimeout`

**Idempotency:** ทุกครั้งที่ resume ต้องเทียบ `waitingFor.token` + dedupe `eventId`
(กลไกเดียวกับ router intake) — Kafka at-least-once จึงเดิน flow ซ้ำไม่ได้

### 5.3 Subflow

```
node subflow → push {flowId, flowVersion, returnNodeId, outputs} ลง stack
             → โหลด graph ของผังย่อยที่ pin ไว้ → เดินจาก entryNodeId ของผังย่อย
ผังย่อยเดินจนถึง node `end` (หรือ node `return` โดยปริยาย)
             → pop stack → map ตัวแปรตาม outputs → เดินต่อที่ returnNodeId ของผังแม่
```

| กฎ | ค่า | เหตุผล |
|---|---|---|
| ความลึกสูงสุด | **3 ชั้น** | ผัง 5 ชั้นคือผังที่ไม่มีใครดีบักได้ |
| เรียกวนซ้ำ (recursion) | **ห้าม** — ตรวจจาก `flowId` ที่ซ้ำใน stack, publish ไม่ผ่าน | ผังที่เรียกตัวเองคือลูปที่ไม่มีเบรก |
| ขอบเขตตัวแปร | ส่งเข้า/ออก **เฉพาะที่ระบุใน `inputs`/`outputs`** | scope ร่วมทำให้ผังย่อยเปลี่ยนพฤติกรรมผังแม่โดยไม่ตั้งใจ |
| เวอร์ชัน | ผังแม่ **pin เวอร์ชันของผังย่อย** ตอน intake | publish ผังย่อยกลางสายไม่กระทบสายที่กำลังเดิน (§6) |
| ผังย่อยที่ยังถูกใช้ | ลบไม่ได้ — แสดงว่า "ถูกใช้โดย N ผัง" ก่อนเสมอ | ลบแล้วผังแม่พังเงียบ ๆ คือความเสียหายที่หาสาเหตุยากที่สุด |

### 5.4 Expression (sandbox)

รายละเอียดการตัดสินใจอยู่ที่ [ADR-021](adr/021-flow-expression-node.md) — สรุปสัญญาที่ engine ต้องบังคับ:

| ข้อจำกัด | ค่า |
|---|---|
| I/O ทุกชนิด (network, fs, timer, require) | **ไม่มี** |
| เวลาที่ใช้ได้ | ≤ 50 ms (เกิน = kill → เส้น `error`) |
| หน่วยความจำ | ≤ 4 MB ต่อการเรียก |
| ลูป | เฉพาะ `map`/`filter`/`reduce` บน array ที่มีขนาดจำกัด — ไม่มี `while`/`for` |
| ผลลัพธ์ | ต้องเป็นค่า deterministic ชนิดเดียวกับที่ประกาศไว้ใน `variables[]` |
| สิ่งที่เห็นได้ | `vars`, `contact`, `interaction` (อ่านอย่างเดียว, PII ที่ถูก mask ยังคง mask) |

### 5.5 สัญญาความผิดพลาด (`onError`) — ทุก node ไม่ใช่แค่ `api`

```
node พัง (timeout / provider ล่ม / expression throw / subflow error)
  → มี data.onError.target ไหม → ไปที่นั่น
  → ไม่มี → ไป fallbackNodeId ของ flow
  → ผังย่อยพัง → โยนขึ้นผังแม่ที่เส้น `error` ของ node subflow
```

- **publish ไม่ผ่านถ้าไม่มี `fallbackNodeId`** — validate ที่เดียวกับ capability matrix (§3)
- **ทางออกสุดท้ายระดับ engine:** ถ้า fallback เองก็พัง → voice = เข้าคิวเริ่มต้นของ tenant,
  digital = ตอบข้อความขอโทษ + เข้าคิว **ห้ามวางสายเงียบ ๆ ในทุกกรณี**
  (ลูกค้าที่โดนตัดสายเพราะ flow error จะโทรกลับมาอีกอยู่ดี แต่โกรธกว่าเดิม)
- `onError` มี `retry` ได้เฉพาะ `api` และ `bot` (สูงสุด 2 ครั้ง, backoff คงที่) — node ที่คุยกับลูกค้า
  ห้าม retry อัตโนมัติเพราะลูกค้าจะได้ยินข้อความซ้ำ

### 5.6 Flow trace — ตอบให้ได้ว่า "สายนั้นเดินทางไหน"

`history[]` ที่มีอยู่ใน state ถูก flush ลง `flow_traces` เมื่อ interaction ถึง `HANDED_OFF`
หรือ `TERMINATED` (เขียนครั้งเดียว ไม่เขียนระหว่างทางเพื่อไม่ให้เพิ่ม latency ต่อ node)

```jsonc
{ "interactionId": "INT-88077", "flowId": "flow_voice_mainmenu", "flowVersion": 3,
  "steps": [
    { "seq": 1, "nodeId": "n_trigger",  "type": "trigger",   "atMs": 0,    "took": 2 },
    { "seq": 2, "nodeId": "n_hours",    "type": "condition", "atMs": 2,    "took": 1,  "branch": "open" },
    { "seq": 3, "nodeId": "n_welcome",  "type": "play",      "atMs": 3,    "took": 4100 },
    { "seq": 4, "nodeId": "n_menu",     "type": "collect",   "atMs": 4103, "took": 3980, "input": "2" },
    { "seq": 5, "nodeId": "n_crm",      "type": "api",       "atMs": 8083, "took": 412,
      "error": "timeout", "tookBranch": "error" },
    { "seq": 6, "nodeId": "n_q_sales",  "type": "queue",     "atMs": 8495, "took": 3, "queueId": "q_sales" }
  ],
  "vars": { "lang": "th", "isVip": false, "crmId": "***" },   // ตัวแปรที่ถูกทำเครื่องหมายว่าอ่อนไหวถูก mask
  "outcome": "HANDED_OFF" }
```

| กฎ | เหตุผล |
|---|---|
| เก็บ **30 วัน** แล้วลบอัตโนมัติ | trace โตเร็วกว่า interaction หลายเท่าและมีค่าเฉพาะตอนสืบสวน |
| ตัวแปรที่ประกาศ `"sensitive": true` ถูก mask ก่อนเขียน | trace เป็นที่ที่เลขบัตรจะรั่วออกได้ง่ายที่สุด |
| เขียนครั้งเดียวตอนจบ | ไม่เพิ่ม latency ให้ทุก node ระหว่างสาย |
| ดูได้จากหน้า interaction | คำถาม "ทำไมสายนี้ไม่เข้าคิวที่ควร" ต้องตอบได้ใน 10 วินาที ไม่ใช่ไล่ log |

**trace มีค่ากว่าปุ่ม Simulate** — simulator ตอบว่าผังนี้*น่าจะ*ทำงานยังไง, trace ตอบว่าเมื่อเช้า
*เกิดอะไรขึ้นจริง* ซึ่งเป็นคำถามที่มีคนถามทุกวัน (แต่ทำทั้งคู่ — ดู §12)

## 6. Versioning & publish

- แก้ไขจะเข้า **draft** เสมอ; publish สร้าง **snapshot immutable** พร้อมเพิ่ม `version`
- **pin version:** ตอน intake บันทึก `flowId@version` ลง `interaction.metadata.flow` →
  ทุกการ resume โหลด **version ที่ pin ไว้** ดังนั้น publish กลางสายไม่กระทบสายที่กำลังทำงาน
- **invalidate cache:** publish → emit `dc.tenant.events` `{type:'flow.published', tenantId, flowId, version}`
  → router ล้าง cache `flow:*` ของ tenant นั้น → interaction ใหม่ใช้ version ใหม่ (ADR-005)
- **rollback:** ชี้ `Flow.activeVersion` กลับไปเวอร์ชันเก่า + invalidate เดิม — snapshot ไม่เคยถูกลบ
- **ผังย่อยก็ถูก pin ด้วย:** ตอน intake ผังแม่ resolve `subflowId → activeVersion` แล้วบันทึกทั้งคู่ลง
  `interaction.metadata.flow.stack` — publish ผังย่อยกลางวันจึงไม่เปลี่ยนพฤติกรรมของสายที่กำลังเดินอยู่
  (ถ้าไม่ pin ชั้นลูก การ publish ผังย่อยตัวเดียวจะเปลี่ยนพฤติกรรมของผังแม่ทุกตัวพร้อมกันโดยไม่มีใครตั้งใจ)

## 7. Prisma models (Phase 1+ — ยังไม่สร้างในเฟสนี้)

```prisma
model Flow {
  id             String      @id @default(uuid()) @db.Uuid
  tenantId       String      @map("tenant_id") @db.Uuid
  name           String
  kind           String      @default("MAIN")         // MAIN | SUBFLOW  (§10)
  channelBinding ChannelType @map("channel_binding")  // + VOICE_OUTBOUND, ANY (เฉพาะ SUBFLOW)
  activeVersion  Int?        @map("active_version")   // null = ยังไม่เคย publish
  status         String      @default("draft")        // draft|published|archived
  createdAt      DateTime    @default(now()) @map("created_at")
  tenant   Tenant        @relation(fields: [tenantId], references: [id])
  versions FlowVersion[]
  @@unique([tenantId, name])
  @@index([tenantId, channelBinding])
  @@map("flows")
}

model FlowVersion {
  id          String    @id @default(uuid()) @db.Uuid
  tenantId    String    @map("tenant_id") @db.Uuid
  flowId      String    @map("flow_id") @db.Uuid
  version     Int
  graph       Json                                  // nodes[]/edges[]/variables[] (§4)
  publishedAt DateTime? @map("published_at")
  createdAt   DateTime  @default(now()) @map("created_at")
  flow Flow @relation(fields: [flowId], references: [id])
  @@unique([flowId, version])
  @@index([tenantId, flowId])
  @@map("flow_versions")
}
```

```prisma
model FlowTrace {
  id            String   @id @default(uuid()) @db.Uuid
  tenantId      String   @map("tenant_id") @db.Uuid
  interactionId String   @map("interaction_id") @db.Uuid
  flowId        String   @map("flow_id") @db.Uuid
  flowVersion   Int      @map("flow_version")
  steps         Json                                   // §5.6 — เขียนครั้งเดียวตอนจบ
  vars          Json                                   // ตัวแปร sensitive ถูก mask แล้ว
  outcome       String                                 // HANDED_OFF | TERMINATED | ERROR
  expiresAt     DateTime @map("expires_at")            // now() + 30 วัน — job ลบตามนี้
  createdAt     DateTime @default(now()) @map("created_at")
  @@index([tenantId, interactionId])
  @@index([tenantId, flowId, createdAt])
  @@index([expiresAt])
  @@map("flow_traces")
}
```

ต้องเพิ่ม `flowId` ใน config ของเบอร์/บัญชีช่องทาง (entrypoint → flow) ด้วย;
`queue` node ชี้ `Queue.id` เดิมไม่ต้องมีตารางใหม่ · `subflow` ชี้ `Flow.id` ที่ `kind = SUBFLOW`
จึงไม่ต้องมีตารางใหม่เช่นกัน

## 8. ตัวอย่าง 12 flow (sample data ใน mockup)

| # | ชื่อ | ช่องทาง | จุดประสงค์ | ลำดับ node |
|---|---|---|---|---|
| 1 | Voice — Main menu | VOICE | IVR หลักเข้าคิวตามปุ่ม | trigger → condition(hours) → play → collect(DTMF 1/2/0) → queue ×2 / agent |
| 2 | Voice — After-hours voicemail | VOICE | นอกเวลาทำการ | trigger → condition(closed) → play → collect(1/2) → voicemail / callback |
| 3 | Web chat — Pre-chat routing | WEBCHAT | ถามหัวข้อก่อนแชท | trigger → play(ทักทาย) → collect(quick-reply) → setvar(topic) → queue ×3 |
| 4 | LINE — Welcome + menu | LINE | ต้อนรับ LINE OA | trigger → play(flex) → collect(quick-reply) → condition(lang) → queue ×2 |
| 5 | Facebook — FAQ deflection | FACEBOOK | บอตตอบก่อน escalate | trigger → bot(FAQ) → condition(จบ?) → play+end / queue |
| 6 | WhatsApp — Order status lookup | WHATSAPP | เช็คสถานะออเดอร์เอง | trigger → collect(เลขออเดอร์) → api(CRM) → condition(พบ?) → play+end / queue |
| 7 | Email — Auto-ack + classify | EMAIL | ตอบรับ + จัดหมวด | trigger → play(auto-ack) → bot(classify) → setvar(category) → queue ×2 |
| 8 | VIP — CRM priority routing | VOICE | fast-track ลูกค้า VIP | trigger → api(CRM by ANI) → condition(VIP?) → setvar(priority=5) → queue(VIP) / queue |
| 9 | Voice — Language selection | VOICE | เลือกภาษาแล้ว route | trigger → play → collect(1=TH,2=EN) → setvar(lang) → queue by skill |
| 10 | Overflow — Callback offer | VOICE | คิวยาว เสนอ callback | trigger → condition(EWT) → play → collect(1=รอ,2=callback) → callback / queue |
| 11 | **Shared — ยืนยันตัวตน** | ANY (SUBFLOW) | ผังย่อยที่ผังอื่นเรียกใช้ 6 ที่ | trigger → collect(เลขบัตร 4 ตัวท้าย) → api(KYC) → expression(นับครั้ง) → condition(≤3?) → end(verified/failed) |
| 12 | **Outbound — แจ้งยอดก่อนต่อเอเจนต์** | VOICE_OUTBOUND | แคมเปญทวงถาม | trigger(amdResult) → condition(MACHINE?) → play(ฝากข้อความ)+end / play(TTS ยอดค้าง) → collect(1=คุย, 9=ไม่ให้ติดต่อ) → queue / api(Contact Governance restriction)+end |

## 9. Flow Designer (mockup)

- **รายการ flow**: `mockups/routing.html` เมนู **Flows** (view `flows`) — ตาราง 12 flow
  พร้อม channel badge, status, version, ปุ่ม open/edit/duplicate (ผังย่อยมีป้าย SUBFLOW)
- **Flow trace**: `mockups/history.html` เมนู **เส้นทางของ flow** — ไล่ทีละ node ว่าสายจริงเดินทางไหน
  แตกกิ่งไหน ใช้เวลาเท่าไหร่ พังตรงไหน (§5.6)
- **Designer**: `mockups/flow-editor.html?id=<flowId>` — React Flow เต็มหน้าจอ 3 ส่วน
  - top bar: ชื่อ flow (แก้ได้), channel badge, สถานะ, ปุ่ม **Simulate / Save draft / Publish** (mock toast)
  - ซ้าย: **node palette 18 ชนิด** แยกสีตามหมวด — **ลากไปวางบน canvas เพื่อเพิ่ม node**
  - กลาง: canvas pan/zoom, MiniMap, Controls, custom node ตามหมวดสี, ต่อเส้นระหว่าง handle ได้
  - ขวา: **inspector** — คลิก node แล้วแก้ Title/Detail ได้ อัปเดตบน canvas ทันที + ลบ node ได้
- โหลดผ่าน importmap + esm.sh (`react@18.3.1`, `react/jsx-runtime`, `htm`,
  `@xyflow/react@12.3.5?external=react,react-dom`) — ไม่มี build step
  > **ข้อควรระวังที่เจอจริงตอนทำ:** ต้อง map `react/jsx-runtime` ใน importmap ด้วย
  > ไม่งั้น `@xyflow/react` resolve ไม่ผ่าน; และ prop `style` ใน htm/React ต้องเป็น **object**
  > ไม่ใช่ string (string ทำให้ React error #62 หน้าเปล่า)

## 10. ผังย่อยที่ใช้ซ้ำ (subflow library)

กลไกอยู่ที่ §5.3 — ส่วนนี้คือ**การดูแลไม่ให้มันกลายเป็นขยะ**

`Flow.kind = SUBFLOW` ต่างจากผังปกติสามข้อ: ไม่ผูกกับ entrypoint (ไม่มีใครโทรเข้ามาที่ผังย่อยตรง ๆ) ·
`channelBinding` เป็น `ANY` ได้ถ้าใช้เฉพาะ node ที่ทุกช่องทางรองรับ · ต้องประกาศ **สัญญา** ให้ชัด

```jsonc
// ส่วนหัวของผังย่อย — สัญญาที่ผังแม่มองเห็น
{ "kind": "SUBFLOW", "channelBinding": "ANY",
  "contract": {
    "inputs":  [ { "key": "phone", "type": "string", "required": true },
                 { "key": "maxTries", "type": "number", "default": 3 } ],
    "outputs": [ { "key": "verified", "type": "boolean" },
                 { "key": "customerNo", "type": "string", "sensitive": true } ] } }
```

**สามอย่างที่ต้องมีตั้งแต่วันแรก ไม่งั้นห้องสมุดผังย่อยจะเน่าเหมือนคลังความรู้ที่ไม่มีเจ้าของ:**

| กติกา | ทำไม |
|---|---|
| ทุกผังย่อยมี **เจ้าของ** และหน้าแสดง "ถูกใช้โดย N ผัง" | ผังย่อยที่ไม่มีใครรู้ว่าใครใช้ = ไม่มีใครกล้าแก้ |
| แก้ผังย่อยต้องเห็นรายชื่อผังแม่ที่กระทบ **ก่อน** กด publish | การแก้ผังย่อยตัวเดียวคือการแก้ผังแม่พร้อมกัน 6 ผัง |
| ลบไม่ได้ถ้ายังมีผังแม่อ้างถึง (archive ได้อย่างเดียว) | ผังแม่ที่ชี้ไปยังของที่หายไปคือ 500 ตอนตี 2 |

ตัวชี้วัดว่าเรื่องนี้คุ้ม: **จำนวน node เฉลี่ยต่อผังแม่ลดลง** และ "แก้กติกายืนยันตัวตน" จากงานที่ต้องแก้ 6 ที่
เหลือแก้ที่เดียว

## 11. เทียบกับ Zoom Contact Center และ NICE CXone

| แกน | NICE CXone (Studio) | Zoom Contact Center | D-Contact |
|---|---|---|---|
| ธรรมชาติของเครื่องมือ | สภาพแวดล้อมเขียนโปรแกรมที่มีหน้าตาเป็นผัง | เครื่องมือ config แบบลากวาง | เครื่องมือ config ที่ตั้งใจให้แคบ |
| จำนวน action/node | หลัก**ร้อย** | ราว 20–30 | **18** (มีเกณฑ์คุมการเพิ่ม — §2) |
| เขียนโค้ดในผัง | ได้เต็มรูป (ภาษาเฉพาะของ NICE) | จำกัดมาก | **`expression` ใน sandbox เท่านั้น** ([ADR-021](adr/021-flow-expression-node.md)) |
| ผังต่อช่องทาง | script คนละชนิดต่อสื่อ | ผังต่อช่องทาง | **โมเดลเดียว** + capability matrix ตรวจตอน publish |
| ผังย่อยใช้ซ้ำ | มี | มี | มี (§10) |
| pin เวอร์ชันต่อสายที่กำลังคุย | ไม่ชัด | ไม่ชัด | **มี ทั้งผังแม่และผังย่อย** (§6) |
| รันบนโครงสร้างพื้นฐานของลูกค้าเอง | ไม่ได้ | ไม่ได้ | **ได้** — ผังเดียวกันรันบน FreeSWITCH หรือ Asterisk ([ADR-006](adr/006-multi-vendor-telephony-gateway.md)) |
| ดูย้อนหลังว่าสายเดินทางไหน | มี debugger | มี preview | **flow trace ต่อ interaction** (§5.6) |
| ใครแก้ได้จริง | มักต้องพาร์ตเนอร์/คนที่ผ่านคอร์ส | หัวหน้าทีม | หัวหน้าทีม |

**สิ่งที่ตั้งใจไม่ทำ และเหตุผล**

| ไม่ทำ | เหตุผล |
|---|---|
| action หลักร้อยแบบ NICE | palette ที่ใหญ่เกินคือเหตุผลที่ลูกค้าต้องจ้างพาร์ตเนอร์มาแก้ IVR — เราขายความเป็นเจ้าของให้ลูกค้า |
| ภาษาสคริปต์เต็มรูปในผัง | เปิดแล้วปิดไม่ได้ และผังจะกลายเป็นโค้ดที่ไม่มีใคร review ([ADR-021](adr/021-flow-expression-node.md)) |
| `while` / loop ไม่จำกัด | ผังที่วนไม่จบบนสายที่ลูกค้ารออยู่คือความเสียหายที่มองไม่เห็นในทดสอบ |
| flow แตะ agent state ได้ | เส้นแบ่งเหล็กใน §1 — งานนั้นเป็นของ router |
| ผังเดียวใช้ได้หลายช่องทางพร้อมกัน | จะได้ผังที่เต็มไปด้วย `if channel == …` ซึ่งอ่านไม่ออกทั้งคู่ |

## 12. แผนเฟสของความสามารถใหม่

| เฟส | ได้อะไร | ต้องมีก่อน |
|---|---|---|
| **FL1** | สัญญา `onError` ทุก node + `fallbackNodeId` บังคับตอน publish + ทางออกสุดท้ายระดับ engine | Phase 1 (voice MVP) |
| **FL2** | **flow trace** + หน้าไล่เส้นทางต่อ interaction (ของที่ทีมซัพพอร์ตถามหาทุกวัน) | FL1 |
| **FL3** | `subflow` + ห้องสมุดผังย่อย + pin เวอร์ชันชั้นลูก | FL1 |
| **FL4** | `expression` sandbox ([ADR-021](adr/021-flow-expression-node.md)) | FL1 + มีเคสจริงที่ `setvar` ทำไม่ไหวอย่างน้อย 3 เคส |
| **FL5** | `case` · `caseOwner` (ตาม [ADR-016](adr/016-case-management.md) C3) · `survey` (ตาม [ADR-012](adr/012-feedback-survey.md) F2) · `VOICE_OUTBOUND` (ตาม [ADR-011](adr/011-outbound-campaign.md) O1) | โมดูลนั้น ๆ พร้อม |
| **FL6** | Simulate (เดินผังด้วยข้อมูลสมมติ + ดู trace ที่ได้) | FL2 |

**FL4 มีเงื่อนไข "ต้องมีเคสจริง 3 เคสก่อน" โดยตั้งใจ** — ถ้าเปิด `expression` ตั้งแต่วันแรก
มันจะกลายเป็นทางออกแรกที่ทุกคนเลือกใช้ แทนที่จะเป็นทางออกสุดท้าย

## 13. ความเสี่ยง

| ความเสี่ยง | การรับมือ |
|---|---|
| **router กลายเป็น durable state machine** (ความเสี่ยงงานสร้างอันดับ 1) | module ขอบเขตชัด + Redis namespace แยก + idempotency เดิม; แยกเป็น `flow-runner` ได้ภายหลังโดยไม่แก้ contract |
| ผู้ใช้สร้าง flow ที่ทำงานไม่ได้จริง (DTMF บน email) | 1 flow = 1 channel + validate ตอน publish ตาม §3 |
| เส้นแบ่ง flow/router เบลอ (flow ไปแตะ agent state) | กติกาเหล็ก §1: flow จบที่ `queue`/`agent` node |
| `dc.channel.commands` ยังไม่มี outbound ฝั่ง gateway | ทำ voice flow ก่อน (ใช้ topic เดิม), digital ตามหลัง |
| React Flow ผ่าน CDN (version drift/offline) | pin เวอร์ชันใน importmap; เป็น mockup ไม่กระทบ production |
| **`expression` ค่อย ๆ กลายเป็นภาษาโปรแกรม** (ความเสี่ยงใหม่อันดับ 1) | sandbox ตาม [ADR-021](adr/021-flow-expression-node.md): ไม่มี I/O · ไม่มีลูปอิสระ · 50 ms · เปิดหลังมีเคสจริง 3 เคส · review การใช้งานทุกไตรมาส |
| ผังย่อยซ้อนลึกจนไล่ไม่ออก | เพดาน 3 ชั้น + ห้าม recursion + ตรวจตอน publish (§5.3) |
| แก้ผังย่อยแล้วผังแม่พังพร้อมกันหลายตัว | pin เวอร์ชันชั้นลูก + แสดงรายชื่อผังแม่ที่กระทบก่อน publish (§10) |
| trace เก็บข้อมูลอ่อนไหว / โตเร็ว | mask ตัวแปรที่ประกาศ `sensitive` + เก็บ 30 วัน + เขียนครั้งเดียวตอนจบ (§5.6) |
| flow พังแล้วสายตายเงียบ ๆ | ทางออกสุดท้ายระดับ engine: ห้ามวางสาย ต้องเข้าคิวเริ่มต้นเสมอ (§5.5) |

## รายงานที่โมดูลนี้เป็นเจ้าของ

`flow.funnel` · `flow.node.dropoff` · `flow.node.exit` · `flow.error` · `flow.duration`

รายละเอียดของแต่ละใบ (dataset · grain · มิติบังคับ · entitlement · ชั้น · drill-down · เฟส) อยู่ที่
[reporting-data-platform §7.4](reporting-data-platform.md) ซึ่งเป็น**แหล่งความจริงเดียว** —
ใบใหม่ต้องไปลงทะเบียนที่นั่นก่อน ห้ามตั้งใบรายงานขึ้นเองในโมดูล

ทั้งกลุ่มต้องมี **flow trace (FL2)** เป็นแหล่งข้อมูลก่อน และทุกใบบังคับมิติ `flowVersion` — ไม่งั้นเทียบก่อน/หลังแก้ผังไม่ได้

## เอกสารเกี่ยวข้อง

- [ADR-007 — การตัดสินใจ + การเปลี่ยนชื่อ](adr/007-flow-engine.md)
- [interaction-data-flow.md §4 — flow ทำงานที่ขั้น 3 ก่อน matching](interaction-data-flow.md)
- [multi-tenancy.md §3–4 — Flow เป็น tenant metadata + config cache](multi-tenancy.md)
- [ADR-003 — topic design (ที่มาของ `dc.channel.commands`)](adr/003-kafka-event-backbone.md)
