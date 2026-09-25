# Platform Provisioning — release candidate และ UAT preview (A1.8 #413)

สำหรับ release owner / UAT owner ของ A1 อ้างอิง #393 §6–7

## สร้าง release candidate

1. merge ทุกอย่างเข้า `main` แล้วรัน workflow **a1-release-candidate** (workflow_dispatch บน `main` เท่านั้น)
2. workflow ทำตามลำดับ:
   - รัน `node scripts/a1-acceptance.mjs --profile all` (fast + real-boundary บน Postgres/Keycloak/mailpit ที่ pin version)
   - `a1-rc-bundle.mjs build` รวม manifest เป็น `a1-rc-bundle.json` — **ล้มทันที** เมื่อ non-waivable gate ใดไม่ PASS,
     มี check ขาด/SKIP/flaky, SHA ไม่ตรง `GITHUB_SHA`, tree dirty, config digest ต่างกัน, ไม่มี image digest หรือพบ PII/secret
   - attest digest ของ bundle ด้วย `actions/attest-build-provenance` (Sigstore keyless)
   - เผยแพร่เป็น pre-release `a1-rc-<sha>` (asset ไม่หมดอายุ — repo public เก็บ artifact ได้ไม่เกิน 90 วัน
     จึงใช้ release แทนเพื่อให้ครบ 180 วันตาม #393) และรัน UAT gate ซ้ำใน workflow
3. ถ้าล้ม: log ที่ redact แล้วอยู่ใน artifact `a1-rc-failure-<sha>` (30 วัน) — แก้แล้ว merge ใหม่ ห้าม waive

bundle เก็บ manifest เป็น byte เดิมพร้อม SHA-256 — แก้ไขภายหลังจะทำให้ทั้ง `verify` และ attestation ไม่ผ่าน
ห้ามลบหรือแทนที่ asset ของ release `a1-rc-*`

## เปิด UAT preview

เปิดได้เมื่อครบทุกข้อ (stop condition ของ #413):

1. `pnpm a1:uat:gate --expect-sha <sha>` ต้องได้ `status: PASS` — ดาวน์โหลด bundle จาก `a1-rc-<sha>`,
   ตรวจซ้ำทั้งหมด และ `gh attestation verify` ผูกกับ repo นี้
2. build ที่ deploy เป็น UAT preview มาจาก `<sha>` เดียวกัน
3. `PLATFORM_PROVISIONING_ENABLED=true` และ `PLATFORM_OPERATOR_ALLOWLIST` มีเฉพาะ internal Platform Operator
   ที่ร่วม UAT
4. rollback drill (`A1.8 rollback drill`) อยู่ใน fast gate ของ bundle และผ่าน

## ปิด UAT (sign-off)

Internal Platform Operator เดิน create → review → progress → failure → reconcile → handoff และตรวจ
search/Action history (`pnpm a1:console:uat` ครอบ flow นี้กับระบบจริง) แล้ว product/UAT owner ลง acceptance comment
ใน #413 พร้อม `runId` ของ workflow, `<sha>` และ sha256 ของ bundle (อยู่ใน job summary)
