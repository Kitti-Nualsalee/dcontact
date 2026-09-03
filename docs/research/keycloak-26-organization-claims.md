# Keycloak 26: Organization claims สำหรับ Agent Desktop

## คำถาม

Keycloak 26 สามารถออก `tenant_id`, `tenant_slug` และ `dc_user_id` ให้ OIDC token ของ Agent Desktop โดยใช้ Organizations ได้อย่างไร และมี fallback ใดที่รักษา claim shape เดิมได้บ้าง

## ข้อค้นพบ

1. Keycloak 26.0.0 มี built-in optional client scope ชื่อ `organization` และ `Organization Membership` mapper (`oidc-organization-membership-mapper`) สำหรับ map organization context ลง token โดยตรง. Client ต้องร้องขอ scope นี้ระหว่าง authorization request. [เอกสาร Keycloak 26.0.0](https://raw.githubusercontent.com/keycloak/keycloak/26.0.0/docs/documentation/server_admin/topics/organizations/mapping-organization-claims.adoc)
2. Mapper ให้ claim แบบซ้อน โดยใช้ organization alias เป็น key เช่น `organization.{alias}.id` และ attributes ของ Organization เป็น array values. ค่าเริ่มต้นไม่รวม id/attributes; ต้องเปิด `Add organization id` และ `Add organization attributes`. [เอกสาร Keycloak 26.0.0](https://raw.githubusercontent.com/keycloak/keycloak/26.0.0/docs/documentation/server_admin/topics/organizations/mapping-organization-claims.adoc), [source mapper](https://raw.githubusercontent.com/keycloak/keycloak/26.0.0/services/src/main/java/org/keycloak/organization/protocol/mappers/oidc/OrganizationMembershipMapper.java)
3. Scope รับได้ทั้ง `organization`, `organization:<alias>` และ `organization:*`. การใช้ `organization` กับผู้ใช้ที่เป็นสมาชิกหลาย organizations จะให้ผู้ใช้เลือก organization; `organization:<alias>` ผูก token กับ organization ที่ระบุ. หากไม่มี scope, ผู้ใช้ไม่ได้เป็นสมาชิก หรือ organization ถูกปิดใช้งาน จะไม่มี organization claim. [เอกสาร Keycloak 26.0.0](https://raw.githubusercontent.com/keycloak/keycloak/26.0.0/docs/documentation/server_admin/topics/organizations/mapping-organization-claims.adoc), [source mapper](https://raw.githubusercontent.com/keycloak/keycloak/26.0.0/services/src/main/java/org/keycloak/organization/protocol/mappers/oidc/OrganizationMembershipMapper.java)
4. Built-in mapper ไม่มี configuration สำหรับ flatten ค่า Organization ไปเป็น top-level `tenant_id` หรือ `tenant_slug`; Organization alias อยู่ใน key ของ claim. จึงไม่ควรสัญญาว่า mapper นี้เพียงตัวเดียวจะออก claim shape แบนตาม contract ของ D-Contact.
5. Keycloak รองรับ `oidc-usermodel-attribute-mapper` เพื่อ map custom user attribute เป็น OIDC claim และรองรับ custom `ProtocolMapper` ผ่าน SPI. Generic user-attribute mapper เหมาะสำหรับ `dc_user_id` ที่เป็น attribute ของผู้ใช้ แต่ไม่ได้อ่าน attributes ของ Organization. [Protocol Mappers API](https://www.keycloak.org/admin-api/protocol-mappers)

## ทางเลือก

### ทางเลือกที่ 1: ใช้ Organization claim เป็น native context

- สร้าง Organization ต่อ tenant; ตั้ง alias เป็น `tenant_slug` และตั้ง Organization attribute `tenant_id` เป็น UUID ของ tenant ใน D-Contact.
- client scope `organization` เปิด `Add organization id` และ `Add organization attributes` ใน access token; ขอ `organization:<alias>` เมื่อรู้ tenant ที่จะเข้าสู่ระบบ.
- map `dc_user_id` จาก user attribute ด้วย `oidc-usermodel-attribute-mapper` ลง access token.
- ให้ API แปลงและตรวจ organization context เป็น tenant principal ภายใน ไม่เชื่อค่า tenant ที่ client ส่งมาเอง.

ผล: ใช้ feature native ของ Keycloak 26 มากที่สุด แต่ public token contract ต้องยอมรับ `organization` claim แบบซ้อน แทน top-level `tenant_id`/`tenant_slug`.

### ทางเลือกที่ 2: รักษา claim shape แบนด้วย custom ProtocolMapper

- ใช้ Organization Membership mapper ตามทางเลือกที่ 1 เพื่อรักษา organization context ที่ Keycloak ออกให้.
- เพิ่ม custom OIDC `ProtocolMapper` ที่อ่าน selected/resolved Organization จาก authentication context แล้วออก top-level `tenant_id` และ `tenant_slug`; map `dc_user_id` จาก user attribute หรือ mapper เดียวกัน.

ผล: รักษา contract แบน (`tenant_id`, `tenant_slug`, `dc_user_id`) ได้แม้ผู้ใช้เป็นสมาชิกหลาย tenants. ต้นทุนคือรับผิดชอบ extension, tests และ upgrade compatibility ของ Keycloak เอง.

### ทางเลือกที่ 3: fallback ชั่วคราวด้วย User Attribute mapper

- เก็บ `tenant_id`, `tenant_slug` และ `dc_user_id` เป็น single-valued user attributes แล้วใช้ `oidc-usermodel-attribute-mapper` สามตัวออก top-level claims.

ผล: รักษา claim shape โดยไม่เขียน extension แต่ปลอดภัยใช้ได้เฉพาะ Phase 1 ที่ผู้ใช้มี tenant เดียว. ห้ามใช้เป็นโมเดลถาวรสำหรับ agent ที่อยู่หลาย organizations เพราะ user attributes ไม่มี selected-organization semantics.

## ข้อเสนอแนะ

เลือก **ทางเลือกที่ 1 เป็น canonical identity model**: Organizations เป็น authority ของ membership, `organization:<alias>` ผูกการ login กับ tenant เดียว, และ API ต้อง reject token ที่ไม่มี organization context หรือ context ไม่ตรงกับ tenant resource.

หาก D-Contact ต้องรักษา top-level claim contract ตั้งแต่ Phase 1 ให้ใช้ **ทางเลือกที่ 2** ไม่ใช่ fallback user attributes. ทางเลือกที่ 3 ใช้ได้เฉพาะ demo ที่บังคับ one-user/one-tenant และต้องบันทึกเป็น technical debt ที่ต้องยกเลิกก่อนรองรับ multi-tenant จริง.

ไม่ว่าเลือกทางใด `dc_user_id` ควรเป็น immutable identifier ที่ map จาก user attribute (หรือสร้าง/validate กับ D-Contact user directory ตอน provisioning) และ API ต้องยังตรวจ local authorization ต่อ tenant/queue; token claim ไม่ควรเป็นแหล่งอ้างอิงเดียวของสิทธิ์ routing.
