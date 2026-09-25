# Platform Provisioning — rollout และ rollback (A1.8 #413)

เอกสารนี้สำหรับทีม Platform operations ที่นำ Platform Console / Platform API / platform worker ขึ้นใช้งาน
อ้างอิง contract ใน #388 (checkpoint 2) และ acceptance ใน #393

## ตัวควบคุม

| env | ใช้ที่ | ความหมาย |
| --- | --- | --- |
| `PLATFORM_PROVISIONING_ENABLED` | Platform API + worker | `true` เท่านั้นที่เปิด (`platformProvisioning.enabled`); ไม่ตั้ง/ค่าอื่น = ปิด |
| `PLATFORM_OPERATOR_ALLOWLIST` | Platform API | Keycloak subject (UUID) ของ Platform Operator ใน canary คั่นด้วย comma; ค่าที่ไม่ใช่ UUID ทำให้ process ไม่ start |

- ค่าอ่านตอน start: เปลี่ยนค่าแล้วต้อง restart Platform API และ worker **ทั้งคู่** ให้ค่าเดียวกัน
- allowlist ใช้ subject ไม่ใช่ email เพื่อไม่ให้ PII อยู่ใน config/log
- Platform Auditor ไม่ได้รับผลจาก flag — อ่านได้เสมอ เขียนไม่ได้เสมอ

| สถานะ | Platform API | Worker | Console |
| --- | --- | --- | --- |
| ปิด | mutation ทุกตัว (create/edit/preview/recovery/resend) = `503 PROVISIONING_DISABLED` (`retryable: false`); อ่านได้ปกติ | ไม่รับ lease ของ saga และ operator command ใหม่ (log `platform.worker.claims_paused`) | อ่านอย่างเดียว + ประกาศปิดชั่วคราว |
| เปิด, อยู่ใน allowlist | ปกติ | ปกติ | ปกติ |
| เปิด, ไม่อยู่ใน allowlist | mutation = `403 FORBIDDEN` (diagnostic `ROLLOUT_NOT_ALLOWLISTED`) | — | อ่านอย่างเดียว + แจ้งว่ายังไม่อยู่ใน canary |

## Observability

| env | ค่าเริ่มต้น | ความหมาย |
| --- | --- | --- |
| `PLATFORM_WORKER_METRICS_PORT` | `9464` | `/metrics` ของ worker |
| `PLATFORM_API_METRICS_PORT` | `9465` | `/metrics` ของ Platform API |
| `PLATFORM_METRICS_HOST` | `0.0.0.0` | ห้ามเปิด port เหล่านี้ผ่าน ingress/hostname ของ Platform Console |

- metrics ใช้ label ชุดปิด (source/kind/step/code/status/queue/invariant/decision/reason) — ไม่มี tenant,
  request, subject, email หรือ domain; code ที่ไม่ใช่ stable code กลายเป็น `OTHER`
- backlog, อายุคิว และ invariant อ่านจาก control plane DB ตอน scrape (cache 15 วินาที) ด้วย role
  `dcontact_platform`
- alert rules: `infra/observability/prometheus/platform-provisioning.rules.yml` (ทดสอบด้วย `pnpm a1:alerts:test`)
- dashboard: `infra/observability/grafana/platform-provisioning.dashboard.json`
- log เป็น structured JSON มี `correlationId`/`requestId`/`tenantId` แบบ opaque, `stepKey`, code และ outcome

| alert | ระดับ | เงื่อนไข |
| --- | --- | --- |
| `PlatformProvisioningInvariantViolated` | critical | `premature_active`, `readiness_bypass`, `duplicate_ownership`, `cross_tenant_reference` หรือ `audit_gap` > 0 |
| `PlatformMixedTokenAccepted` | critical | tripwire ของ Platform API เจอ tenant context ใน token ที่ผ่าน identity check |
| `PlatformProvisioningPendingStale` / `PlatformInvitationOutboxStale` / `PlatformOperatorCommandStale` | warning | รายการเก่าสุดเกิน 5 นาที |
| `PlatformActionRequiredStale` | warning | `ACTION_REQUIRED` เกิน 30 นาที |
| `PlatformRetryExhausted` / `PlatformLeaseChurn` | warning | retry ครบ / เสีย lease > 3 ครั้งใน 15 นาที |
| `PlatformHealthScrapeFailing` | warning | อ่านสถานะจาก DB ไม่ได้ 5 นาที |

critical alert ใดๆ = หยุดขยาย canary และพิจารณา rollback ตามหัวข้อด้านล่าง

## ลำดับ rollout

1. migration แบบ additive (`pnpm db:migrate && pnpm db:rls`)
2. Keycloak: `platform-console` client, audience `dcontact-platform-api`, platform roles
   (`pnpm infra:identity:platform`) และ **jar ของ invitation-guard extension**
   (`bash scripts/keycloak-extensions-build.sh` → `infra/keycloak/providers/`) — setup จะตรวจว่า handler
   `execute-actions` ถูก override แล้ว; setup ยังเปิด realm user events (อายุ ≥ 30 วัน, รวมกับค่าเดิม)
   และให้ service account `dcontact-provisioner` มี `view-events` สำหรับ timeline ของ First admin
3. deploy Platform API + worker โดย `PLATFORM_PROVISIONING_ENABLED` ยังไม่ตั้ง แล้ว deploy Platform Console
4. ผ่าน real-boundary acceptance (`pnpm a1:acceptance:boundary`) บน SHA/config ที่จะเปิด
5. เปิด canary: ตั้ง `PLATFORM_PROVISIONING_ENABLED=true` + allowlist เฉพาะ internal operator แล้ว restart
6. ขยาย allowlist ทีละกลุ่ม — หยุดทันทีเมื่อ non-waivable gate ของ #393 ล้ม

## Rollback

1. ตั้ง `PLATFORM_PROVISIONING_ENABLED` เป็นค่าอื่นที่ไม่ใช่ `true` (หรือลบออก) แล้ว restart Platform API และ worker
2. ยืนยัน: worker log มี `platform.worker.claims_paused`, Console แสดงประกาศปิดชั่วคราว, `GET` list/status/action history ยังตอบ 200
3. **ห้าม** drop schema, ลบแถวใน `pf_*` หรือลบ Keycloak Organization/user เพื่อ rollback —
   ledger, receipts, reservations และ audit ต้องอยู่ครบ
4. แก้ไขแล้ว deploy เวอร์ชันใหม่ จากนั้นเปิด flag อีกครั้ง: lease ที่หมดอายุระหว่างปิดถูก adopt ด้วย
   verified adoption และ command ที่รออยู่ถูกทำต่อ — ไม่ต้องสร้างคำขอใหม่

drill อัตโนมัติ: `A1.8 rollback drill` ใน `apps/platform-api/src/provisioning-api.integration.ts`
(ปิดระหว่างมี step ที่ response หายและ preview command ค้าง → ledger ไม่เปลี่ยน → เปิดแล้วจบ `SUCCEEDED`
โดย adopt resource เดิม ไม่สร้างซ้ำ)

## UAT ในเครื่อง

Platform API และ worker สำหรับ `pnpm a1:console:uat` ต้องตั้ง `PLATFORM_PROVISIONING_ENABLED=true` และ
`PLATFORM_OPERATOR_ALLOWLIST=<subject ของ operator ที่ใช้ทดสอบ>`

## Timeline ของ First admin

worker reconcile Keycloak user events ของ first admin ที่ได้คำเชิญแล้ว (ทุก 60 วินาทีต่อคำขอ, ติดตาม 30 วัน)
ลง Action history ด้วย actor `FIRST_ADMIN`: `FIRST_ADMIN_EMAIL_VERIFIED`, `FIRST_ADMIN_PASSWORD_SET`,
`FIRST_ADMIN_TOTP_ENROLLED`, `FIRST_ADMIN_ACTIVATED` — เก็บแค่ชนิดและเวลา (ไม่มี email/IP จาก event details)
ถ้า event หมดอายุก่อน worker อ่าน จะเห็นเฉพาะ `FIRST_ADMIN_ACTIVATED` ที่เวลาตรวจพบ
