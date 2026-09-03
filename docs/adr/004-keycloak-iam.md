# ADR 004: Keycloak เป็น IAM (single realm + Organizations)

- **สถานะ:** Accepted
- **วันที่:** 2026-07-15

## บริบท

Auth ปัจจุบันใน `apps/api` เป็น JWT ทำเอง (login + stateless refresh) และมีช่องโหว่เชิงโครงสร้าง:
`role` อยู่ใน token แต่ไม่ถูกบังคับที่ไหนเลย (AGENT เรียก `POST /users` สร้าง ADMIN ได้),
guard เป็นแบบ opt-in ต่อ controller, refresh token เพิกถอนไม่ได้, RLS ติดตั้งไว้แต่ไม่ engage,
และไม่มี SSO/MFA — ขณะที่ D-Contact เป็น SaaS multi-tenant ที่ลูกค้า enterprise
จะเรียกร้อง SSO (Azure AD/Google Workspace) และ MFA แน่นอน การเขียนสิ่งเหล่านี้เอง
มีความเสี่ยงด้าน security สูงกว่าและแพงกว่าการใช้ IdP สำเร็จรูป

## การตัดสินใจ

1. **ใช้ Keycloak (self-hosted, 26.x) เป็น Identity Provider** — เข้ากับแนว self-hosted
   ของโปรเจค (FreeSWITCH, Redpanda) และได้ OIDC/SSO/MFA/brute-force protection ฟรี
2. **Single realm `dcontact` + Keycloak Organizations (1 org ต่อ tenant)** — ไม่ใช่ realm-per-tenant
   - realm-per-tenant สเกลแย่ (per-realm cache/config drift, admin console ช้าเมื่อหลักร้อย realm)
     และมี ops tax ถาวร: ทุก client/role/mapper ต้อง sync N realms
   - เหตุผลคลาสสิกที่ต้องแยก realm คือ IdP federation ต่อลูกค้า — KC 26 Organizations
     รองรับ org-scoped IdP แล้ว (Azure AD ของลูกค้าผูกกับ org ตัวเอง) ข้อได้เปรียบนั้นจึงหมดไป
   - org alias = tenant `slug`, org attribute `tenant_id` = UUID ใน Postgres
3. **Keycloak เก็บเฉพาะ identity** (credentials, MFA, sessions) — ข้อมูล domain
   (extension, skills, team, concurrency) อยู่ใน Postgres `users` ลิงก์ด้วย `users.keycloak_id`
4. **Authorization บังคับใน NestJS** ไม่ใช้ Keycloak Authorization Services —
   permission matrix เล็ก คงที่ และอยู่บนเส้น latency-sensitive (call control);
   token ใส่แค่ realm roles `agent ⊂ supervisor ⊂ admin` (composite) + `service`
5. **API ตรวจ token ด้วย `jose` + remote JWKS** เป็น global guard (`APP_GUARD`) + `@Public()`
   — ลบ login/refresh ที่ทำเองทิ้งทั้งหมด (clean cut ได้เพราะยังไม่ launch)

รายละเอียดครบทุกมิติ (flows, claims, provisioning saga, RLS wiring, dev compose, phased rollout)
อยู่ใน [`docs/iam-architecture.md`](../iam-architecture.md)

## ผลที่ตามมา

- (+) SSO/MFA/session management/lockout เป็นของสำเร็จรูปที่ผ่านการตรวจสอบมาแล้ว ไม่ต้อง maintain เอง
- (+) tenant onboarding เบา: สร้าง 1 organization — client/role/mapper กำหนดครั้งเดียวระดับ realm (import จาก git)
- (+) เปิดทาง per-tenant enterprise SSO federation โดยไม่ต้องรื้อสถาปัตยกรรม
- (−) เพิ่ม stateful service (JVM + database) ที่ต้อง upgrade/monitor — ชดเชยด้วย realm-config-as-code
  และ pin เวอร์ชัน
- (−) Organizations เป็นฟีเจอร์ใหม่กว่า realm — ต้อง verify org-attribute mapper บนเวอร์ชันที่ pin
  ตั้งแต่ต้น Phase A (fallback: user-attribute `tenant_id` mapper, claim shape เดิม ไม่กระทบ downstream)
- (−) login theming ต่อ tenant อ่อนกว่า realm-per-tenant — ใช้ theme เดียวอ่าน org attributes
- (−) blast radius ระดับ realm ครอบทุก tenant; escape hatch = แยก realm เฉพาะลูกค้าที่เรียกร้อง
  issuer-level isolation เป็นสัญญา
