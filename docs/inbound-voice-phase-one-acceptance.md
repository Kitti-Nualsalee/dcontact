# หลักฐาน Inbound Voice Phase 1

เอกสารนี้อธิบายหลักฐานอัตโนมัติสำหรับปิด Phase 1 ตาม issue #29 โดยมีคำสั่งหลักเพียงคำสั่งเดียว:

```bash
pnpm voice:acceptance
```

คำสั่งจะพิมพ์ JSON หนึ่งบรรทัดต่อ check และจบด้วย `INBOUND_VOICE_PHASE_1_ACCEPTED`
เมื่อทุก check ผ่าน หาก check ใดล้มเหลว ระบบจะระบุ dependency, boundary และ remediation
แล้วข้าม check ที่พึ่งพา blocker นั้น

## ขอบเขตที่พิสูจน์

| Check               | หลักฐานที่สังเกตได้                                                                                                                                                         |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 0             | PostgreSQL/RLS, Redis, MinIO, Redpanda, FreeSWITCH และ Keycloak พร้อมใช้งาน                                                                                                 |
| Identity สอง tenant | Keycloak 26 Organizations `demo` และ `demo-two` ออก token ที่มี `tenant_id`, `tenant_slug`, `dc_user_id` ตรงกับ PostgreSQL และ tenant ID ไม่ซ้ำกัน                          |
| Event contract      | tenant header/payload ตรงกัน, ordering key ถูกต้อง และ duplicate event ถูก dedupe                                                                                           |
| Router              | direct queue, IVR, skill/routing policy, offer timeout, no-answer, max wait, wrap-up และ idempotent lifecycle                                                               |
| Workspace/API       | supervisor team scope, queue control, human publish และ signed playback authorization                                                                                       |
| Recording           | ประกาศก่อนอัด, shared FreeSWITCH volume, tenant-safe MinIO archive, duration/finalization, durable retry หลัง object storage ล้ม และไม่ archive ซ้ำ                         |
| QM                  | HTTPS/no-training provider contract, `PENDING → PROCESSING → READY/FAILED`, bounded retry, audit และ evidence-backed `DRAFT`                                                |
| Two-tenant E2E      | Router → recording → `interaction.ended` → Thai transcript → auto-QM ทำงานแยก tenant และ RLS ไม่เห็น agent, queue, interaction, recording, transcript หรือ QM ของอีก tenant |
| Softphone E2E       | SIPp/FreeSWITCH direct และ IVR/DTMF มี media สอง leg แล้วจบ `COMPLETED` พร้อม archived recording                                                                            |

## Thai ASR/QM development baseline

acceptance fixture ใช้ corpus ภาษาไทยสองตัวอย่าง ครอบคลุมคำทักทายและคำถามยอดชำระ
แต่ละตัวอย่างมีเสียงจำลอง 10 วินาทีและ transcript 2 segments ระบบวัด `processingLatencyMs`
ด้วย wall clock ระหว่างเรียก provider contract จริงใน test และคำนวณ `realTimeFactor` จาก duration ที่บันทึกไว้
ผลล่าสุดถูกแนบใน structured evidence ชนิด `thai-asr-qm-development-baseline` ทุกครั้งที่รัน

failure path บังคับ provider ล้มเหลวสามครั้งตาม `maxAttempts=3` และต้องได้ audit ตามลำดับ:

1. `TRANSCRIPTION_STARTED`
2. `TRANSCRIPTION_RETRY_SCHEDULED`
3. `TRANSCRIPTION_STARTED`
4. `TRANSCRIPTION_RETRY_SCHEDULED`
5. `TRANSCRIPTION_STARTED`
6. `TRANSCRIPTION_FAILED`

ตัวเลขนี้เป็น development baseline ของ pipeline และ provider contract แบบ deterministic เท่านั้น
ไม่ใช่ SLA production และไม่ใช่ผล WER ของ ASR vendor ก่อนใช้จริงต้องวัด corpus ที่มนุษย์ตรวจแล้ว
ซึ่งสะท้อน noise, codec และศัพท์เฉพาะของแต่ละ tenant เพิ่มเติม

## Tenant isolation

การยืนยัน isolation ใช้หลายชั้นร่วมกัน:

- Keycloak Organization claim เป็น canonical tenant context
- Kafka ปฏิเสธ tenant header/payload ที่ไม่ตรงกัน
- Router และ QM ใช้ tenant-scoped service transaction
- PostgreSQL RLS คืนผลเป็นศูนย์เมื่อ tenant A query ID ของ tenant B
- REST API คืน `404` สำหรับ recording/transcript/QM ข้าม tenant
- signed playback ออกให้เฉพาะ object key ใต้ `recordings/{tenantId}/` และทุกการออก URL มี audit

structured evidence อาจมี UUID และตัวเลข latency ที่เปลี่ยนทุกครั้งตามการรัน ซึ่งเป็นพฤติกรรมที่ตั้งใจไว้
ให้ใช้ output จากการรันล่าสุดเป็นหลักฐานอ้างอิงแทนการคัดลอกค่าคงที่ลงเอกสารนี้
