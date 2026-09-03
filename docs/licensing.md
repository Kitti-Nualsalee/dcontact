# D-Contact — Plans, Entitlements & Licensing

> เอกสารออกแบบประกอบ [ADR-009](adr/009-plan-entitlement-licensing.md) · สถานะ: **แผน (ยังไม่ implement)**
> mockup: `mockups/platform.html` (ฝั่ง operator) · `mockups/admin.html` → Usage & plan (ฝั่งลูกค้า)
> อัปเดต 2026-08-07

## 1. สองแนวคิดที่ต้องไม่ปนกัน

| | **Entitlement** | **Quota** |
|---|---|---|
| ตอบคำถาม | *ใช้อะไรได้บ้าง* | *ใช้ไปเท่าไรแล้ว* |
| ตัวอย่าง | `wfm.enabled`, `wfm.seats: 60`, `onPrem` | นาทีโทร, WA conversations, storage |
| เปลี่ยนเมื่อ | ซื้อ / อัปเกรด / ต่อสัญญา | ทุกวินาทีตามการใช้งาน |
| ตรวจตอนไหน | **ก่อน**ทำงาน (synchronous, บล็อกได้) | **หลัง**ทำงาน (จาก `dc.interaction.events`) |
| ทำอะไรเมื่อเกิน | 403 `ENTITLEMENT_REQUIRED` | soft → เตือน · hard → บล็อกการสร้างใหม่ |

เอกสารนี้เน้น entitlement ส่วน quota metering ต่อยอดจาก [multi-tenancy §5](multi-tenancy.md)

## 2. โครงสร้าง entitlement (JSON)

เก็บเป็น JSONB ทั้งใน `plans.entitlements` และ `tenant_entitlement_overrides.patch`

```jsonc
{
  "modules": {
    "wfm": {
      "enabled": true,
      "seats": 60,                  // จำนวน agent ที่เปิด WFM ได้ (null = เท่ากับ agentSeats)
      "schedule":     true,         // จัดกะมือ + publish + agent self-service   (W1)
      "timeOff":      true,         // การลา + coverage impact                    (W2)
      "adherence":    true,         // adherence + RTA board                      (W2)
      "forecast":     true,         // พยากรณ์ + staffing requirement             (W3)
      "autoSchedule": true,         // CP-SAT ใน apps/wfm-engine — ของแพงจริง     (W4)
      "intraday":     true          // intraday management                        (W4)
    },
    "qm": {
      "enabled": true,
      "seats": null,                // null = เท่ากับ agentSeats
      "evaluation":      true,      // ฟอร์ม + quality plan + ให้คะแนนมือ + appeal  (Q2)
      "transcription":   true,      // ASR + ค้นหาในบทสนทนา                        (Q3)
      "analytics":       true,      // category + trend + targeted sampling        (Q4)
      "autoQm":          false,     // AI ร่างคะแนน — ของแพงจริง                    (Q5)
      "screenRecording": false      // ต้องมี client ฝั่ง agent                     (Q6+)
    },
    "outbound": {
      "enabled": true,
      "seats": null,
      "preview":            true,   // O1
      "progressive":        true,   // O2
      "predictive":         false,  // O3 — ต้องมีสถิติจริงก่อน
      "proactiveMessaging": false   // O5 — ต้นทุนต่อข้อความจ่ายออกจริง
    },
    "feedback":    { "enabled": true,  "csat": true, "nps": false, "closedLoop": false },
    "bot":         { "enabled": false, "faqDeflection": false, "ragAnswer": false, "voiceBot": false },
    "knowledge":   { "enabled": true,  "publicPortal": false },
    "assist":      { "enabled": false, "autoSummary": false, "knowledgeSuggest": false,
                     "guidedScript": false,     // A6 — ไม่ใช้โมเดล ไม่มีต้นทุนต่อครั้ง
                     "realtimeGuidance": false },
    "cases":       { "enabled": true,  "slaPolicies": true, "customFields": true, "publicPortal": false },
    "analytics":   { "enabled": false, "categories": true, "topicDiscovery": false, "sentiment": false, "correlation": false },
    "performance": { "enabled": true,  "scorecards": true, "gamification": false, "goals": true },
    "reporting":   { "enabled": true,  "builder": true, "scheduled": true, "dataFeed": false, "retentionMonths": 24 },
    "api":         { "enabled": true,  "publicApi": true, "webhooks": true, "cti": false, "rateLimitRps": 20 },
    "connectors":  { "salesforce": false, "dynamics": false, "zendesk": false, "servicenow": false, "custom": true },
    "customer360": { "enabled": true,  "identityResolution": true, "externalProfile": false, "dsar": false },
    "journey": {
      "enabled": false,
      "eventTriggers":  false,  // รับเหตุการณ์จากระบบธุรกิจ → เริ่ม journey        (J1)
      "segments":       false,  // กลุ่มเป้าหมายจาก attribute/พฤติกรรม              (J3)
      "contactPolicy":  true,   // เพดานการติดต่อระดับลูกค้า — เปิดให้ทุกแพ็กเกจ    (J1)
      "holdout":        false   // กลุ่มควบคุมสำหรับวัดผลจริง                        (J4)
    },
    "collab": {
      "enabled": true,
      "channels":     true,   // DM + ห้องทีม + presence                       (CL1)
      "attachments":  true,   // รูป/เอกสาร ตามกติกา internal-collaboration §6  (CL1)
      "consult":      false,  // ถามผู้เชี่ยวชาญผูกกับ interaction              (CL2)
      "expertRouting":false,  // จับคู่ตามสกิล + SLA ตอบครั้งแรก                (CL2)
      "compliance":   false,  // ค้นข้ามห้อง + legal hold + export             (CL4)
      "bridge":       false   // สะพานไป Teams/Slack/LINE                      (CL5)
    },
    "flows":     { "enabled": true, "maxPublished": 50 },
    "recording": { "enabled": true, "retentionMonths": 12 },
    "sso":       { "enabled": true },
    "onPrem":    { "enabled": false }
  },
  "quotas": {
    "agentSeats": 50,
    "voiceMinutesPerMonth": 80000,
    "whatsappConversationsPerMonth": 2000,
    "storageGb": 500,
    "concurrentChannels": 30,
    "qmTranscriptionMinutesPerMonth": 20000,
    "qmAutoScoredPerMonth": 2000,
    "outboundAttemptsPerMonth": 40000,
    "messageSegmentsPerMonth": 20000,
    "surveyInvitesPerMonth": 10000,
    "botSessionsPerMonth": 15000,
    "assistSummariesPerMonth": 30000,
    "analyzedMinutesPerMonth": 20000,
    "collabStorageGb": 50,
    "journeyActionsPerMonth": 50000
  }
}
```

**`contactGovernance.basic` เปิดให้ทุกแพ็กเกจโดยตั้งใจ** — restriction/consent และเพดานการติดต่อเป็น *การป้องกันลูกค้าปลายทาง*
ไม่ใช่ฟีเจอร์ที่ควรขาย ถ้าเก็บเงินเพื่อไม่ให้ระบบสแปม เราก็เป็นคนสร้างปัญหานั้นเอง
([ADR-025](adr/025-journey-orchestration.md) ข้อ 3)

**โมดูลใหม่ 5 ตัวมีต้นทุนผันแปรจ่ายออกจริง** (`outbound` = นาที/ข้อความ, `feedback` = SMS,
`bot` + `assist` = token, `analytics` = นาที ASR) — ทั้งหมดจึง **ต้องมาคู่กับ quota เสมอ**
เหมือน `qm.transcription` ไม่ใช่ entitlement เปล่า ๆ
([ADR-011](adr/011-outbound-campaign.md) · [ADR-013](adr/013-virtual-agent-knowledge.md) ·
[ADR-017](adr/017-interaction-analytics.md))

**`qm.transcription` / `qm.autoQm` เป็นคู่แรกที่ entitlement ต้องมาพร้อม quota เสมอ** —
เป็นโมดูลเดียวที่มี **ต้นทุนผันแปรจ่ายออกไปจริงต่อสาย** (นาที ASR + token)
ต่างจาก `wfm.autoSchedule` ที่ compute เป็นของเราเอง เปิดโดยไม่มีเพดานแล้ว margin ติดลบเงียบ ๆ
([ADR-010](adr/010-quality-management.md) ข้อ 15)

**ชื่อ key คือสัญญาถาวร** — `wfm.autoSchedule` ถูกใช้ทั้งใน decorator, ใน error payload,
ในไฟล์ license และในหน้าจอ operator เปลี่ยนชื่อทีหลังแปลว่าต้องแก้ทั้งสี่ที่พร้อมกัน

`wfm.autoSchedule` แยกเป็น key ของตัวเองแม้ตอนนี้จะแถมมากับ Growth เสมอ
([ADR-009](adr/009-plan-entitlement-licensing.md) ข้อ 14) — วันที่ต้องแยกขายจะแก้แค่ค่าใน plan

## 3. แพ็กเกจมาตรฐาน

รหัสแพ็กเกจ (ใช้ในโค้ดและฐานข้อมูล): `starter` · `growth` · `enterprise`

| ความสามารถ | Starter | Growth | Enterprise |
|---|:---:|:---:|:---:|
| 6 ช่องทาง + universal queue | ✓ | ✓ | ✓ |
| Flow Designer | ✓ (10 flow) | ✓ (50 flow) | ไม่จำกัด |
| บันทึกเสียง | 3 เดือน | 12 เดือน | ตามสัญญา |
| SSO องค์กร | — | ✓ | ✓ |
| **`wfm.schedule` · `timeOff`** | — | ✓ | ✓ |
| **`wfm.adherence`** | — | ✓ | ✓ |
| **`wfm.forecast`** | — | ✓ | ✓ |
| **`wfm.autoSchedule` · `intraday`** | — | ✓ | ✓ |
| **`wfm.seats`** | 0 | = agentSeats | = agentSeats |
| **`qm.evaluation`** (ฟอร์ม/ตรวจ/appeal) | — | ✓ | ✓ |
| **`qm.transcription`** | — | ✓ (20,000 นาที/เดือน) | ตามสัญญา |
| **`qm.analytics`** (category/trend) | — | — | ✓ |
| **`qm.autoQm`** | — | — | ✓ (มีเพดานเสมอ) |
| ติดตั้งในองค์กร (`onPrem`) | — | — | ✓ |
| หลายไซต์ / หลายประเทศ | — | ✓ | ✓ |
| **`outbound.preview` · `progressive`** | — | ✓ | ✓ |
| **`outbound.predictive`** | — | — | ✓ (มีเพดาน abandon เสมอ) |
| **`outbound.proactiveMessaging`** | — | ✓ (20,000 ข้อความ/เดือน) | ตามสัญญา |
| **`feedback.csat`** | ✓ (ในห้องแชทเดิม) | ✓ | ✓ |
| **`feedback.nps` · `closedLoop`** | — | — | ✓ |
| **`cases`** (SLA + custom fields) | — | ✓ | ✓ |
| **`knowledge`** (คลังความรู้ภายใน) | ✓ | ✓ | ✓ |
| **`bot.faqDeflection`** (L1) | — | ✓ | ✓ |
| **`bot.ragAnswer`** (L2) | — | — | ✓ (มีเพดาน session) |
| **`assist.guidedScript`** | — | ✓ | ✓ |
| **`assist.autoSummary`** | — | ✓ (มีเพดาน) | ✓ |
| **`assist.realtimeGuidance`** | — | — | ✓ (เมื่อผ่านเกณฑ์ latency) |
| **`analytics.topicDiscovery` · `correlation`** | — | — | ✓ |
| **`performance.scorecards`** | — | ✓ | ✓ |
| **`performance.gamification`** | — | — | ✓ (ค่าเริ่มต้นปิด) |
| **`reporting.builder` · `scheduled`** | — | ✓ | ✓ |
| **`reporting.dataFeed`** | — | — | ✓ |
| **`api.publicApi` · `webhooks`** | — | ✓ (20 req/s) | ✓ (ตามสัญญา) |
| **`api.cti`** + connector แบรนด์ | — | — | ✓ |
| **`customer360.identityResolution`** | ✓ | ✓ | ✓ |
| **`customer360.externalProfile` · `dsar`** | — | — | ✓ |
| **`contactGovernance.basic`** (restriction/consent + เพดานระดับ CIF) | ✓ | ✓ | ✓ |
| **`journey.enabled` · `eventTriggers`** (CX automation) | — | ✓ (50,000 การกระทำ/เดือน) | ตามสัญญา |
| **`journey.segments`** | — | — | ✓ |
| **`journey.holdout`** (วัดผลด้วยกลุ่มควบคุม) | — | — | ✓ |
| **`collab.channels` · `attachments`** (แชทภายใน + ไฟล์แนบ) | ✓ (5 GB) | ✓ (50 GB) | ตามสัญญา |
| **`collab.consult` · `expertRouting`** | — | ✓ | ✓ |
| **`collab.compliance`** (ค้น/legal hold/export) | — | — | ✓ |
| **`collab.bridge`** (Teams/Slack/LINE) | — | — | ✓ |

ตารางนี้ต้องตรงกับหน้าเว็บขาย `mockups/www.html` เสมอ — ถ้าไม่ตรง หน้าเว็บผิด ไม่ใช่ตารางนี้ผิด

## 4. การรวมค่าจาก 3 ชั้น

```
effective = clamp( override ?? plan , ceiling = license )
```

| ชั้น | ใครแก้ | เพิ่มสิทธิ์ได้? | หมายเหตุ |
|---|---|---|---|
| **plan** | platform operator | — | ค่าตั้งต้นตามแพ็กเกจ |
| **tenant override** | platform operator | **ได้** | ต้องมี `reason` + `expiresAt` + audit เสมอ |
| **license** (on-prem เท่านั้น) | ออกจากแพลตฟอร์ม ลูกค้าแก้ไม่ได้ | ไม่ได้ | เป็นเพดานเสมอ ใช้ `min` |

override **ต้องเพิ่มสิทธิ์เกิน plan ได้** ไม่งั้นทีมขายเปิด trial ให้ลูกค้าไม่ได้เลย
แต่บนเครื่องลูกค้า license เป็นเพดานตายตัว

**override คือหนี้ทางเทคนิคที่สะสมได้** — บังคับให้มีวันหมดอายุทุกใบ และมีหน้ารวม
override ทั้งแพลตฟอร์มในที่เดียว ไม่งั้นอีกสองปีจะไม่มีใครรู้ว่าลูกค้ารายไหนได้อะไรไปฟรีบ้าง

## 5. Data model

| ตาราง | ประเภท | สาระ |
|---|---|---|
| `plans` | metadata (platform) | `code` (`starter`\|`growth`\|`enterprise`), `name`, `is_public`, `entitlements` JSONB, `price_per_seat` |
| `tenant_plan` | metadata | tenant → plan + `effective_from`, `status` (`trial`\|`active`\|`past_due`\|`suspended`) |
| `tenant_entitlement_overrides` | metadata | `tenant_id`, `patch` JSONB, `reason`, `expires_at`, `created_by` |
| `licenses` | metadata | on-prem: `deployment_id`, `blob`, `key_id`, `not_before`, `not_after`, `state` |
| `license_state` | data | `last_seen_at` (**ขยับขึ้นอย่างเดียว**), `clock_anomaly_count` |
| `module_seat_assignments` | data | `tenant_id`, `user_id`, `module` (`wfm`), `assigned_at`, `assigned_by` |
| `module_seat_highwater` | data | สูงสุดรายเดือนต่อโมดูล — ใช้ตอนต่อสัญญา/ตรวจสอบ |

```prisma
model Plan {
  id           String @id @default(uuid()) @db.Uuid
  code         String @unique          // starter | growth | enterprise
  name         String
  isPublic     Boolean @default(true) @map("is_public")
  entitlements Json                    // ตาม §2
  @@map("plans")
}

// ที่นั่งของโมดูล — admin ติ๊กเปิดรายคน ไม่ใช่ระบบนับเอง (ADR-009 ข้อ 12)
model ModuleSeatAssignment {
  tenantId   String   @map("tenant_id") @db.Uuid
  userId     String   @map("user_id") @db.Uuid
  module     String                     // "wfm"
  assignedAt DateTime @default(now()) @map("assigned_at")
  assignedBy String   @map("assigned_by") @db.Uuid
  @@id([tenantId, userId, module])
  @@map("module_seat_assignments")
}
```

## 6. การบังคับใช้

### 6.1 การไหลของค่า

```
plans / overrides / license (Postgres)
   └─▶ resolver ──▶ Redis  tenant:{id}:entitlements   ──▶ guard ที่ apps/*
                       ▲
            dc.tenant.events (invalidate) — ไม่มี topic ใหม่
```

### 6.2 จุดตรวจ

| # | จุด | ตรวจอะไร | ไม่ผ่านแล้วทำอะไร |
|---|---|---|---|
| 1 | NestJS guard ที่ controller | `@RequiresEntitlement('wfm.forecast')` | `403 ENTITLEMENT_REQUIRED` |
| 2 | ตอน admin ติ๊กเปิด WFM ให้ agent | `wfm.seats` เทียบจำนวนที่ใช้ไป | `409` + บอกจำนวนคงเหลือ |
| 3 | ก่อน publish เข้า `dc.wfm.jobs` | `wfm.autoSchedule` | `403` + ไม่ produce |
| 4 | **`apps/wfm-engine` ก่อนเริ่ม solve** | claim ที่ติดมากับ job | drop job + log + alert (ไม่ควรเกิด) |
| 5 | UI | ทั้งหมด | แสดงเมนู **แบบล็อก** + ปุ่มอัปเกรด ไม่ซ่อนหาย |

**ด่านที่ 4 คือด่านที่คนมักลืม** — engine เป็นตัวกิน CPU จริง ถ้าด่าน 3 พลาดหรือมีใคร
ยิง Kafka ตรง ด่าน 1–3 ไม่ช่วยอะไรเลย

### 6.3 สัญญาของ error

```json
{
  "error": "ENTITLEMENT_REQUIRED",
  "entitlement": "wfm.autoSchedule",
  "currentPlan": "starter",
  "requiredPlan": "growth",
  "message": "การจัดกะอัตโนมัติมีในแพ็กเกจ Growth ขึ้นไป"
}
```

และสำหรับ seat เต็ม:

```json
{ "error": "SEAT_LIMIT_REACHED", "module": "wfm", "used": 60, "limit": 60 }
```

หน้าจอต้องใช้ payload นี้ขึ้นหน้าชวนอัปเกรดที่ตรงเรื่อง — 403 เปล่า ๆ ทำให้ลูกค้าโทรหา support
แทนที่จะกดซื้อ

### 6.4 สิ่งที่ CI ต้องมี

**ทดสอบเส้นทาง "ไม่มีสิทธิ์" ของทุกโมดูล** — สำหรับทุก endpoint ที่ติด decorator
ต้องมีเคสที่ยิงด้วย tenant แพ็กเกจ `starter` แล้วคาดหวัง 403 ถ้าไม่มีการทดสอบชุดนี้
เราจะรู้ตัวว่ารั่วก็ต่อเมื่อลูกค้าใช้ฟีเจอร์ที่ไม่ได้จ่ายเงินไปแล้ว

## 7. On-prem license

### 7.1 รูปแบบ

JWS compact เซ็นด้วย **Ed25519 (EdDSA)** — public key ฝังใน image, `kid` ไว้หมุนกุญแจ

```jsonc
{
  "iss": "d-contact-platform",
  "sub": "deployment:acme-onprem-01",
  "iat": 1786000000, "nbf": 1786000000, "exp": 1817536000,
  "ver": 1,
  "customer": "ACME Thailand Co., Ltd.",
  "productMaxVersion": "2.x",
  "entitlements": { /* เพดานตาม §2 */ },
  "grace": { "days": 30 }
}
```

**ตรวจแบบออฟไลน์ ไม่ phone home** — on-prem บางแห่งตัดอินเทอร์เน็ตจริง ระบบที่ต้องต่อเน็ต
เพื่อยืนยันสิทธิ์จะกลายเป็นเหตุผลที่ลูกค้าไม่ซื้อ ตรวจตอน boot และทุก 1 ชั่วโมง

### 7.2 นาฬิกาย้อนหลัง

ลูกค้าตั้งเวลาเครื่องย้อนหลังได้ → เก็บ `license_state.last_seen_at` แบบ **ขยับขึ้นอย่างเดียว**
ถ้าเวลาปัจจุบัน < ค่านั้น ให้นับเป็น anomaly, บันทึก audit และขึ้นแบนเนอร์เตือนผู้ดูแล
— **จับได้ว่าผิดปกติ แต่ห้ามไม่ได้ และไม่ควรพยายามห้าม**

### 7.3 ขอบเขตที่ยอมรับตั้งแต่ต้น

ลูกค้าที่ตั้งใจโกงเข้า Postgres ตัวเองแล้ว `UPDATE` ได้เสมอ ระบบนี้จึงเป็น
**เครื่องมือทางสัญญา ไม่ใช่ DRM** — สิ่งที่มีค่าจริงคือ `module_seat_highwater`
ที่ export ได้ ใช้ตอนต่อสัญญาและตรวจสอบตามข้อสัญญา
**อย่าลงทุนกับการทำ obfuscation** ผลตอบแทนต่ำและทำให้ debug ที่หน้างานลูกค้าเป็นฝันร้าย

## 8. State machine ของการหมดอายุ

```
                    เตือน 30 วันก่อน            หมดอายุ            ครบ grace
   ACTIVE ────────────▶ EXPIRING ────────────▶ GRACE ────────────▶ LOCKED
     │                     │                     │                    │
  ใช้ได้เต็ม           ใช้ได้เต็ม           อ่านอย่างเดียว        อ่านอย่างเดียว
                     + แบนเนอร์เตือน        + แบนเนอร์แดง        + บล็อกการสร้าง
```

| สถานะ | ดูตารางกะเดิม | สร้าง/แก้ตารางใหม่ | adherence/RTA | **รับสาย & routing** |
|---|:---:|:---:|:---:|:---:|
| ACTIVE | ✓ | ✓ | ✓ | ✓ |
| EXPIRING | ✓ | ✓ | ✓ | ✓ |
| GRACE (30 วัน) | ✓ | — | ✓ | ✓ |
| LOCKED | ✓ | — | — | **✓** |

**กติกาเหล็กสองข้อ:**

1. **คอลัมน์สุดท้ายต้องเป็น ✓ ทุกแถวเสมอ** — router/telephony ไม่ผูกกับ license เลย
   ถ้า license หมดอายุแล้วลูกค้ารับสายไม่ได้ นั่นคือการทำให้ธุรกิจเขาหยุด
   เราจะเสียลูกค้ารายนั้นถาวรและอาจถูกฟ้อง (สอดคล้องกับ [ADR-008](adr/008-workforce-management.md)
   ข้อ 3 ที่ router ไม่รู้จัก WFM อยู่แล้ว)
2. **ห้ามลบข้อมูลทุกกรณี** — ดาวน์เกรดหรือหมดอายุแล้วตารางกะล่วงหน้าสองเดือนหายไป
   คือความเสียหายที่กู้ความเชื่อมั่นไม่กลับ ข้อมูลอยู่ต่อ แค่แก้ไม่ได้

พฤติกรรมตอน **ดาวน์เกรดแพ็กเกจ** ใช้กติกาเดียวกัน: seat ที่เกินเพดานใหม่จะถูกทำเครื่องหมาย
`over_limit` ให้ admin เลือกเองว่าจะปลดใคร ระบบไม่ปลดให้อัตโนมัติ

## 9. ลำดับการทำ

| เฟส | ขอบเขต |
|---|---|
| **L1** | `plans` + `tenant_plan` + resolver + Redis cache + guard/decorator + error contract + ทดสอบเส้นทาง 403 ใน CI |
| **L2** | `module_seat_assignments` + เพดาน seat + หน้า Usage & plan ฝั่งลูกค้า + เมนูแบบล็อก |
| **L3** | `tenant_entitlement_overrides` + หน้ารวม override ฝั่ง operator |
| **L4** | on-prem: ออก license, ตรวจลายเซ็น, state machine, `module_seat_highwater` + export |

**L1 ต้องมาก่อน W4 ของ [ADR-008](adr/008-workforce-management.md) และก่อน Q5 ของ
[ADR-010](adr/010-quality-management.md)** — ถ้า `apps/wfm-engine` หรือ auto-QM
ขึ้นก่อนที่จะมี entitlement เราจะปล่อยของแพงที่สุดออกไปโดยไม่มีอะไรกั้น
กรณี Q5 หนักกว่า เพราะเป็นต้นทุนที่จ่ายออกไปนอกบริษัทจริงต่อการเรียกใช้แต่ละครั้ง

## 10. ความเสี่ยง

| ความเสี่ยง | ผลถ้าเกิด | การคุม |
|---|---|---|
| เช็ก entitlement กระจายในโค้ด | เพิ่มโมดูลใหม่แล้วลืมจุดใดจุดหนึ่ง | decorator จุดเดียว + ทดสอบเส้นทาง 403 ครบทุก endpoint ใน CI |
| override สะสมจนไม่มีใครรู้ | รายได้รั่วเงียบ ๆ | บังคับ `reason` + `expiresAt` + หน้ารวม override |
| license หมดอายุกลางดึก | ถ้าออกแบบผิด = ลูกค้ารับสายไม่ได้ | GRACE 30 วัน + router ไม่ผูกกับ license เด็ดขาด |
| ลูกค้า on-prem แก้ฐานข้อมูลเอง | ใช้เกินสิทธิ์ | ยอมรับตั้งแต่ต้น — คุมด้วยสัญญา + seat high-water ที่ export ได้ |
| ตารางสิทธิ์กับหน้าเว็บขายไม่ตรงกัน | ขายของที่ระบบไม่เปิดให้ | ตาราง §3 เป็น source of truth · ตรวจตอนแก้ราคาทุกครั้ง |
| นับ seat อัตโนมัติจนบิลเกิน | ลูกค้ายกเลิกบริการ | ติ๊กเปิดรายคนเท่านั้น + บล็อกตอนติ๊กเมื่อเต็ม |

## รายงานที่โมดูลนี้เป็นเจ้าของ

`lic.usage` · `lic.seat` · `lic.entitlement.denied` · `lic.override.expiring` · `lic.state` · `op.tenant.health` · `op.usage.bytenant` · `op.plan.mix`

รายละเอียดของแต่ละใบ (dataset · grain · มิติบังคับ · entitlement · ชั้น · drill-down · เฟส) อยู่ที่
[reporting-data-platform §7.13](reporting-data-platform.md) ซึ่งเป็น**แหล่งความจริงเดียว** —
ใบใหม่ต้องไปลงทะเบียนที่นั่นก่อน ห้ามตั้งใบรายงานขึ้นเองในโมดูล

สามใบสุดท้าย (`op.*`) เป็นของ**ฝั่ง operator** ใน §7.14 — คนละ audience คนละ realm role และต้องเข้าถึงไม่ได้จาก token ของ tenant; `lic.entitlement.denied` คือสัญญาณขายที่ได้มาฟรีจาก error contract
