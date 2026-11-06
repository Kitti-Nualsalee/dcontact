# M3: มาตรฐาน API กลางและ service จำลองสำหรับทดสอบ

ตรวจแหล่งต้นฉบับวันที่ 2 พฤศจิกายน 2569 (Asia/Bangkok). เอกสารนี้เป็นผล research และข้อเสนอสำหรับ decision/Phase Contract; ยังไม่มีการติดตั้ง generator, สร้าง service, ทดสอบ conformance หรืออนุมัติ production integration

## ผลตัดสินหลัง tooling spike

Phase Contract M3 v1 เลือก **OpenAPI 3.1.0** เป็น baseline ที่ทดลองจริง ตาม [tooling compatibility receipt](m3-api-tooling-compatibility.md) และ [สเปก #832](https://github.com/Kitti-Nualsalee/dcontact/issues/832#issuecomment-6576159532). ข้อเสนอเริ่มต้น 3.1.2 ในตารางด้านล่างเป็นประวัติการประเมินก่อน spike; การเปลี่ยนรุ่นภายหลังต้องมี compatibility evidence และ review ตามสเปก

## ข้อเสนอสำหรับ D-Contact

ใช้ **HTTP REST + JSON, OpenAPI ที่ generate จากโค้ด, JSON Schema, OAuth 2.0 client_credentials และ webhook ที่มี event identity/signature** เป็นชุดมาตรฐานการเชื่อมต่อ. กำหนด customer contract ของ D-Contact เองตาม Contact/identity/permissions เดิม โดยให้ service จำลองเป็น reference client/provider ของ contract เดียวกัน. ข้อนี้เป็นข้อเสนอออกแบบ ไม่ใช่คำกล่าวว่ามีมาตรฐาน customer API ตัวเดียวที่ใช้แทนทุก CRM ได้

SCIM มี schema สำหรับจัดการ identity ของผู้ใช้ เช่น User และ Group จึงไม่ควรนำมาใช้แทน Contact โดยอัตโนมัติ: repository แยก User/Agent ออกจากลูกค้าอยู่แล้ว. [SCIM Core Schema RFC 7643](https://www.rfc-editor.org/rfc/rfc7643.html), [ADR-020](../adr/020-customer-360.md)

## มาตรฐานและการเลือกใช้

| ส่วน | ข้อค้นพบจากแหล่งต้นฉบับ | ข้อเสนอและ gate ของ M3 |
| --- | --- | --- |
| สัญญา HTTP API | OpenAPI อธิบาย interface ของ HTTP API โดยไม่ผูกภาษาโปรแกรม; รุ่นล่าสุดที่ตรวจได้คือ **3.2.1** ลงวันที่ 10 ก.ย. 2026 และยังมี **3.1.2** เป็น published specification. [OpenAPI 3.2.1](https://spec.openapis.org/oas/v3.2.1.html), [3.1.2](https://spec.openapis.org/oas/v3.1.2.html) | เริ่ม compatibility spike ด้วย 3.1.2 โดยไม่เรียกว่า latest; ตรึง 3.1.2 หรือ 3.2.1 หลัง generator → validator → mock → generated client → breaking-change CI ผ่านจริง. ADR-015 กำหนด generate จากโค้ด; ไม่เขียนไฟล์ production spec มือเป็น authority อีกชุด |
| รูปร่างข้อมูล | OpenAPI 3.1 Schema Object อิง JSON Schema Draft 2020-12. Draft นี้แยก `format-annotation` กับ `format-assertion`; การระบุ `format` ไม่รับรองว่าทุก validator บังคับตรวจ. [OpenAPI Schema Object](https://spec.openapis.org/oas/v3.1.2.html#schema-object), [JSON Schema 2020-12](https://json-schema.org/draft/2020-12), [Validation](https://json-schema.org/draft/2020-12/json-schema-validation) | ใช้ schema/validators ที่มาจาก authority เดียวกับ server พร้อม strict unknown-field policy; pin dialect และเปิด assertion ที่จำเป็น. ทดสอบ Unicode/phone/email/revisions ด้วย runtime vectors ของ E1/R1 ไม่อ้าง generic schema เพียงอย่างเดียวว่า normalization ตรงแล้ว |
| Machine authentication | `client_credentials` ใช้สำหรับ confidential clients. OAuth Security BCP กำหนดแนวทางป้องกัน token และการตรวจ intended audience. [RFC 6749 §4.4](https://www.rfc-editor.org/rfc/rfc6749.html#section-4.4), [RFC 9700 §2.2 และ §4.10](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.10) | Confidential backend client ต่อ tenant ผ่าน Keycloak/TLS; ตรวจ issuer, audience, token validity, scopes และ tenant/resource grants ที่ server. เลือก client authentication และ rotation ตาม capability ของ deployment; ประเมิน asymmetric client authentication ใน Phase Contract. ไม่ฝัง client secret ลง browser หรือใช้ static API key แทน OAuth ตาม ADR-015 |
| Error response | RFC 9457 กำหนด Problem Details สำหรับ HTTP errors และ media type `application/problem+json`. [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html) | Cus360 มี `{error:{code,messageKey,retryable},requestId}` อยู่แล้ว: document รูปแบบเดิมใน OpenAPI และใช้ต่อรอบแรก. หากต้องรองรับ Problem Details ให้เป็น explicit version/media-type negotiation พร้อม compatibility tests ภายหลัง ไม่เปลี่ยน envelope เดิมเงียบ ๆ |
| Event envelope | CloudEvents 1.0.2 กำหนด required attributes `id`, `source`, `specversion`, `type`; unique event อยู่ที่ `(source,id)` และการส่งซ้ำใช้ identity เดิมได้. Serialized `specversion` ของรุ่นนี้เป็น `1.0`. [CloudEvents 1.0.2](https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md) | เสนอ CloudEvents structured JSON สำหรับ external webhook ใหม่ พร้อม explicit mapping จาก owner event ของ D-Contact. ไม่เปลี่ยน Kafka envelope หรือ webhook contract ที่มีผู้ใช้แล้วโดยไม่มี version/migration. Consumer dedupe ด้วย event identity; delivery attempt เป็นคนละ identity |
| HTTP event binding | CloudEvents structured JSON ใช้ `Content-Type: application/cloudevents+json` และเก็บ metadata กับ data ใน body. [CloudEvents HTTP binding](https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/bindings/http-protocol-binding.md) | สร้าง receiver จำลองจาก binding เดียวกัน และทดสอบ content type/schema. Envelope ไม่ได้ทำ authentication หรือรับประกัน exactly-once ให้เอง |
| Webhook signature | RFC 9421 รองรับ HTTP signatures/MAC รวม `hmac-sha256`; application ต้องกำหนด covered components และ policy ตรวจ signature. Timestamp/expiry/nonce ช่วยจำกัด replay เมื่อ verifier บังคับตาม policy. [RFC 9421](https://www.rfc-editor.org/rfc/rfc9421.html) | ADR-015 กำหนด HMAC ต่อ endpoint: เสนอ profile ที่ลงนาม method/target/body-integrity และ created/expires/keyid/nonce โดย pin exact coverage/clock budget/rotation ใน Phase Contract. หากคง header เดิมต้องประกาศว่าเป็น D-Contact profile ไม่อ้าง RFC conformance โดยไม่มี tests; retry ใช้ event เดิมและ signature attempt ใหม่ตาม policy |

## Boundary ของ repository ที่ต้องรักษา

1. Public API และ UI ใช้ owner operations และ API version path ชุดเดียวกัน; connector/reference client ไม่มี DB หรือ internal bypass. Webhook อยู่ใน worker ที่ consume Kafka พร้อม at-least-once, HMAC และ bounded retry ไม่แทรก network call ใน critical Voice path. Credential อยู่กับ Integration และเข้ารหัสแยก tenant. [ADR-015](../adr/015-integration-platform.md)
2. Contact ที่เขียนใน D-Contact ยังผ่าน normalization, explicit resource authorization, revisions, command identity/digest, receipt/reconcile/tombstone และ audit ของ E1/R1. มาตรฐาน transport ไม่เพิ่มสิทธิ์ merge/verify/consent หรือเปลี่ยนเจ้าของข้อมูล. [E1](https://github.com/Kitti-Nualsalee/dcontact/issues/764#issuecomment-6471698858), [R1](https://github.com/Kitti-Nualsalee/dcontact/issues/763#issuecomment-6449690950)
3. E1 สำหรับ UI ใช้ active domain User/verified actor ส่วน OAuth service client เป็นอีก principal: **ต้องมี decision และ contract สำหรับ service-principal scopes/resource grants/command actor key ก่อนเปิด customer writes ผ่าน machine credentials**. ไม่สร้าง User/ADMIN ปลอม ไม่ใช้ role ใน token แทน persisted resource authorization และไม่เปิดทั้ง tenant โดยปริยาย. นี่เป็นข้อสรุปเชิงออกแบบจากการอ่าน ADR-015 คู่กับ E1/R1 ไม่ใช่การรับรองว่า code ปัจจุบันรองรับแล้ว
4. External profile แบบอ่านเป็นของ source system และ ADR-020 ให้ดึงสดพร้อม short cache ตาม authority; reference provider ไม่ทำให้อนุมัติ full CRM sync หรือสร้าง CRM shadow profile. Source unavailable/permission revoked ต้องแยกจาก empty และไม่ส่งข้อมูลเก่าข้าม actor/tenant. [ADR-020](../adr/020-customer-360.md)
5. Public webhook ใช้ allowlisted projection ที่ current subscriber/resource permission อนุญาต ไม่มี credentials, raw audit, PII snapshot หรือ event ของ resource นอก scope. การเชื่อมข้อมูลยังไม่รวม recording/transcript/DSAR โดยปริยาย. ข้อนี้เป็นข้อเสนอ acceptance ของ M3 จาก authority เดิม ไม่ใช่ semantics ที่ CloudEvents บังคับให้

## Service จำลองและชุดทดสอบที่เสนอ

แยกหน้าที่เป็น **reference client**, **reference external-profile provider** และ **webhook receiver** ใน service จำลองเดียวที่เลือก mode ได้. ใช้ synthetic fixtures อย่างน้อย 2 tenants และ credentials ที่ออกจาก authorization server สำหรับการทดสอบจริง. Service นี้เรียก public HTTP API เท่านั้น ไม่มีสิทธิ์แก้ D-Contact DB; compose/local environment ต้องแยกจาก VM ที่ทีมกำลัง UAT

| กลุ่ม | หลักฐานที่ควรเก็บ |
| --- | --- |
| Contract | Generate OpenAPI จาก actual API, validate examples/actual responses, generated client เรียกได้, CI ตรวจ breaking changes และ mismatch ของ unknown fields/enum/null/revisions; ชี้ชัดว่า mock PASS ไม่เท่ากับ actual API PASS |
| Identity | Actual token endpoint/client_credentials, wrong issuer/audience/tenant/scope, expired/revoked client และ rotation; ยืนยันว่า service principal ไม่ได้รับ customer permissions จากการมี token เพียงอย่างเดียว |
| Commands | Same command/same payload, same command/different payload, timeout หลัง commit, pending/reconcile, tombstone-vs-late request, stale revision และ crash recovery ผ่าน actual owner commands โดยไม่มี duplicate business effect |
| External read | ready/empty/unavailable/timeout/malformed response, mapping version, late response หลัง tenant/scope change, cache isolation/expiry และ source ownership; ไม่ดึง source API ขณะถือ DB lock |
| Webhook | Duplicate/out-of-order event, receiver timeout/429/5xx, bounded backoff, pause/DLQ/replay, signature tamper/expiry/replay/key rotation; same event identity ผ่านหลาย delivery attempts และไม่มี duplicate consumer effect |
| Isolation | 2 tenants, resource scope ที่อนุญาต/ถอนแล้ว, payload allowlist/PII sentinels, no source credential in response/log; webhook destination validation และ network isolation ต้องมี acceptance ตาม deploymentจริง |

## ลำดับส่งมอบที่เสนอ

1. ตรึง use cases และ service-principal authorization; เลือก explicit read/write/event scope เท่าที่จำเป็น โดย read-only reference provider/client เริ่มก่อนหาก writer authority ยังไม่ผ่าน
2. ทำ tooling compatibility spike และสร้าง OpenAPI จาก API ที่ทำงานจริง พร้อม reference service/contract test harness; ยังไม่เลือก generator จากชื่อหรือสมมติว่า tooling รองรับทุกรุ่น
3. ต่อ machine-auth adapter กับ owner commands/read predicates และ implement webhook projection/worker ตาม scope ที่ยืนยัน พร้อม failure/permission/race tests
4. Local/CI trial → review/merge → controlled UAT ตาม Phase Contract พร้อม immutable release/evidence/rollback; reference service ไม่เป็น production connector หรือ credential store ของลูกค้าจริง

## สิ่งที่ยังต้องตัดสินก่อน ready-for-agent

- รอบแรกเปิด read-only external composition, D-Contact customer create/read API หรือ webhook event ใดบ้าง และเป็นทิศทางเดียวหรือหลายทิศทาง; การมี service จำลองไม่ได้ตอบ field ownership แทน business decision
- Service principal ผูก resource scope และ owner ของ Contact ใหม่อย่างไร รวม grant/revoke/recovery/audit; ไม่อนุมานจาก creator User แบบ UI
- รุ่น generator/validator/mock/client และ exact OpenAPI dialect หลัง spike; exact external event/signature profile, replay budget และ compatibility กับ existing header/envelope
- Quotas/timeout/retry/retention ของ test artifact, credentials และ event projection รวม release gates ที่ตรง environmentจริง

Research นี้ไม่รวมเลือก CRM vendor, bidirectional sync, auto-merge, SDK ทุกภาษา, GraphQL, SCIM provisioning, CTI/iframe ใหม่, recording/transcript export หรือการเปลี่ยน ADR เดิม. ไม่มี runtime conformance results จากการอ่านเอกสารนี้
