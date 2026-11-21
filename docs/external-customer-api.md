# External customer API: ระบบภายนอกสร้าง อ่าน และค้นลูกค้า

งานติดตามที่ [#954](https://github.com/Kitti-Nualsalee/dcontact/issues/954) ต่อจาก service principal ของ
[#841](https://github.com/Kitti-Nualsalee/dcontact/issues/841) (`docs/m3-service-principal-handoff.md`)
ตามขอบเขต Phase Contract M3 v1 ข้อ 1–2 ใน #832

ระบบภายนอกของลูกค้า เช่น CRM ใช้ OAuth2 `client_credentials` เรียก API ชุดเดียวกับ Console
เพื่อสร้างลูกค้าใหม่ อ่านกลับ และค้นหา โดยไม่มีบัญชีผู้ใช้และไม่ได้สิทธิ์ Admin

## Endpoint

Prefix `/api/v1/customer-360` ใช้ path เดียวกับ Console

| Method และ path               | Scope ใน token                | ผล                                                          |
| ----------------------------- | ----------------------------- | ----------------------------------------------------------- |
| `POST /contacts`              | `customer360.contacts.create` | สร้างลูกค้า ตอบ receipt ที่ไม่มีข้อมูลลูกค้า                |
| `GET /contacts/:id`           | `customer360.contacts.read`   | ข้อมูลหลัก ช่องทางติดต่อ และ revision ของลูกค้าหนึ่งราย     |
| `POST /contacts/search`       | `customer360.contacts.read`   | ค้นด้วยชื่อขึ้นต้น เบอร์เต็ม หรืออีเมลเต็ม หรือไล่รายการ    |
| `GET /commands/:id`           | `customer360.contacts.create` | ผลของคำสั่งสร้างที่ส่งไปแล้ว                                |
| `POST /commands/:id/reconcile`| `customer360.contacts.create` | ปิดคำสั่งที่ไม่รู้ผล (body `{}`)                            |

Route อื่นของลูกค้า เช่น แก้ไขโปรไฟล์ ช่องทางติดต่อ แท็ก timeline และ operator ไม่เปิดให้ service
และตอบ 401

Body ของ create รับ `commandId` (UUID ที่ client สร้าง), `displayName`, `company`, `vip` และ `points`
(`{ kind: 'PHONE' | 'EMAIL', value, explicitCountry? }`) ด้วยกฎตรวจและ normalize ชุดเดียวกับ Console
ฟิลด์อื่นรวมถึง id, tenant, custodian หรือ grant ถูกปฏิเสธด้วย 400

## สิทธิ์

Token ต้องมี role `service`, scope ตามตาราง และ audience ของ API แต่ token อย่างเดียวไม่ให้สิทธิ์ใด
สิทธิ์จริงมาจากข้อมูลที่ operator ตั้งผ่าน `POST /api/v1/customer-360/operator/commands`
และ API ตรวจใหม่ทุก request

- **Binding**: `SERVICE_BIND_CREATE` ผูก `(tenant, issuer, subject, clientId)` กับ Admin ผู้ดูแล (custodian)
  ไม่มี binding หรือถูกปิด = 403 ทุก route
- **สร้าง**: ต้องมี `SERVICE_CAPABILITY_GRANT` (`CONTACT_CREATE`) และ custodian ยังเป็น Admin ที่ active
  ลูกค้าใหม่ได้ custodian เป็นผู้ดูแลแบบ MANAGE (ที่มา `INTEGRATION`) และ service ได้สิทธิ์อ่านรายนั้น
  ทั้งหมดอยู่ใน transaction เดียวกับ audit และ receipt
- **อ่านและค้น**: เฉพาะลูกค้าที่ service สร้างเอง หรือที่ operator ให้ `SERVICE_CONTACT_GRANT` เป็นราย ๆ
  ไม่มีสิทธิ์อ่านทั้ง tenant รายที่ไม่มีสิทธิ์ตอบ 404 เหมือนไม่พบ และไม่ถูกนับในผลค้น
- Operator ถอน grant หรือปิด binding แล้วมีผลกับ request ถัดไปทันที

Create ตรวจ token กับ Keycloak แบบ online introspection ก่อนทำงานทุกครั้ง client ที่ถูกปิดหรือถอนที่
Keycloak จึงสร้างไม่ได้ทันทีแม้ JWT ยังไม่หมดอายุ ส่วนอ่านและค้นตรวจ JWT กับ binding ใน DB
ดังนั้นการถอนที่ Keycloak อย่างเดียวมีผลกับการอ่านเมื่อ token หมดอายุ ถ้าต้องหยุดอ่านทันทีให้ operator
ปิด binding

## การส่งซ้ำ

ส่ง `commandId` เดิมซ้ำได้เมื่อไม่รู้ผล (เครือข่ายขาด, 429, 503) server คืน receipt เดิมและไม่สร้างลูกค้าซ้ำ
`commandId` เดิมกับ payload ที่ต่างกันตอบ 409 `COMMAND_PAYLOAD_MISMATCH`
Receipt ไม่มีข้อมูลลูกค้า ให้อ่านค่าปัจจุบันด้วย `GET /contacts/:id`

| สถานะ | ความหมาย                                                                                   |
| ----- | ------------------------------------------------------------------------------------------ |
| 400   | body ไม่ผ่านการตรวจ (`fieldErrors` บอกฟิลด์และรหัส ไม่สะท้อนค่าที่ส่ง)                     |
| 401   | token ใช้ไม่ได้ หรือ introspection ตอบว่าไม่ active                                        |
| 403   | ไม่มี scope, binding, capability หรือ feature ปิด                                          |
| 404   | ไม่พบ หรือไม่มีสิทธิ์อ่านรายนั้น                                                           |
| 409   | `commandId` เดิมกับ payload ต่าง                                                           |
| 429   | เกินโควตา ดู `Retry-After` (ค้น 60, สร้าง 30, อ่าน/receipt 120 ครั้งต่อนาทีต่อ client)      |
| 503   | ระบบที่ต้องพึ่งไม่พร้อม เช่น IdP, limiter หรือ lock ชน ส่ง `commandId` เดิมซ้ำได้          |

## เปิดใช้

ปิดเป็นค่าเริ่มต้น ตั้ง `C360_SERVICE_API=on` ที่ API เพื่อเปิด ตอนเริ่ม API จะ log
`customer_360.service_api.readiness` หนึ่งบรรทัด

Create ใช้ confidential client `KEYCLOAK_C360_CLIENT_ID/SECRET` ชุดเดียวกับแผงลูกค้าของ Workspace
ในการ introspect ถ้าไม่ได้ตั้ง readiness จะบอก `DISABLED_NO_INTROSPECTION_CLIENT` และ create ตอบ 503
ส่วนอ่านและค้นยังใช้ได้

Service client ใน Keycloak ต้องมี

- service account ที่มี realm role `service`
- client scope `customer360.contacts.read` และ `customer360.contacts.create` ตามที่ต้องใช้
- claim `tenant_id`, `tenant_slug` และ `organization` ของ tenant เดียว
- audience ของ API (`KEYCLOAK_AUDIENCE`) และ audience ของ introspection client
  เพราะ Keycloak ตอบ `active: false` เมื่อ client ที่ถามไม่อยู่ใน `aud` ของ token

ตัวอย่างการตั้ง realm ครบชุดอยู่ใน `apps/api/src/customer-360-service-oidc.integration.ts`

## ทดลองและตรวจ

```sh
pnpm --filter @d-contact/api exec tsx --test src/customer-360-service-config.test.ts
pnpm --filter @d-contact/api test:m3-principal:boundary
```

`test:m3-principal:boundary` สร้าง PostgreSQL และ Keycloak ชั่วคราวของตัวเอง ไม่แตะฐาน `dcontact`
realm dev หรือ UAT แล้วรัน

- `customer-360-service-contacts.integration.ts`: HTTP → PostgreSQL ด้วย application role ที่ไม่ bypass RLS
  ครอบคลุม create/read/search, grant รายลูกค้า, tenant อื่น, ถอนสิทธิ์, custodian ถูกปิด และ feature ปิด
- `customer-360-service-oidc.integration.ts`: token จริงจาก `client_credentials`, introspection จริง
  และรัน `examples/external-customer-api/client.mjs` กับ API จริง

ตัวอย่าง client ใช้ HTTP API เท่านั้น

```sh
API_BASE_URL=http://localhost:3000 \
TOKEN_URL=http://localhost:8081/realms/dcontact/protocol/openid-connect/token \
CLIENT_ID=<service client> CLIENT_SECRET=<secret> \
node examples/external-customer-api/client.mjs
```

## ข้อจำกัดของรอบนี้

- OpenAPI ยังไม่ได้ generate จาก schema และยังไม่มีเกต breaking change ใน CI เอกสารนี้เป็นสัญญาที่เขียนมือ
- ไม่มี reference service แบบ fault proxy หรือ conformance harness มีเฉพาะตัวอย่าง client
- ยังไม่ผูก entitlement `modules.api` และโควตาใช้ค่าเดียวกับ Console ต่อ client
- Realm dev ยังไม่มี service client สำเร็จรูป และยังไม่ได้ทดลองบน dev stack จริงหรือ UAT
- ยังไม่ได้ทดสอบ limiter ร่วมกับ Redis จริงสำหรับ bucket ของ service และยังไม่ได้ทดสอบหลาย instance

งานที่เหลือของ #842–#844 อยู่ใน backlog #888
