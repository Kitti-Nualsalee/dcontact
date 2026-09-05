# Inbound Voice Phase 2: OIDC session สำหรับ Workspace ที่ถือสายยาว

- วันที่ตรวจ: 2026-09-05
- Tracker: [ยืนยัน OIDC session สำหรับ Workspace ที่ถือสายยาว](https://github.com/Kitti-Nualsalee/dcontact/issues/38)
- ขอบเขต: decision input สำหรับ React/Vite Workspace, REST, WebSocket และ SIP credentials; ไม่เปลี่ยน production IAM deployment

## สรุปคำตอบ

Phase 2 ต้องใช้ **Authorization Code + PKCE S256** และ login ใน organization context ที่เจาะจงด้วย `organization:<tenant-alias>`. Token ต้องอยู่ใน memory เท่านั้นและ refresh ก่อนเรียก REST/ก่อน WebSocket token หมดอายุ. Silent SSO เป็น optimization ไม่ใช่ recovery guarantee เพราะ browser ที่ block third-party cookies อาจบังคับ fallback เป็น redirect

เมื่อ refresh ล้มเหลวขณะมี Interaction ห้าม redirect หรือทำลาย browser media ทันที: Workspace ต้องเข้า auth-degraded mode, หยุดรับ offer ใหม่, เตือนผู้ใช้ และคงเฉพาะ safe controls/reconciliation ตาม contract ที่จะตัดสินต่อ. SIP credentials ต้องแยกจาก OIDC token, ส่งให้เจ้าของที่ authenticated เท่านั้น และไม่ persist ใน browser storage.

## สิ่งที่มีอยู่ใน repository

- `docs/iam-architecture.md` กำหนด public SPA, Authorization Code + PKCE S256, access token 10 นาที, rotated refresh token, token in-memory, `aud: dcontact-api`, organization context และ WebSocket `auth:refresh`
- ADR-026 กำหนด one working tab, silent SSO ข้าม Workspace–Console และห้าม redirect ระหว่างมีงานในมือ
- `packages/workspace-session` มี WebSocket auth refresh/reconnect contract แล้ว
- dev pin Keycloak `26.0.0`; research เดิมยืนยัน nested `organization` claim และข้อจำกัดของ top-level tenant claims ไว้แล้ว

## ข้อค้นพบ

### 1. Flow และ organization context

OAuth Security BCP บังคับ public client ใช้ PKCE และระบุว่า `S256` เป็น method ที่ใช้ได้ในทางปฏิบัติ; refresh token ของ public client ต้อง sender-constrained หรือ rotate. [RFC 9700](https://www.rfc-editor.org/info/rfc9700/)

Keycloak Organizations รองรับ `organization:<alias>` เพื่อเลือก organization เดียวและ reject เมื่อ alias ไม่มีอยู่หรือผู้ใช้ไม่เป็นสมาชิก. ค่า `organization` แบบไม่ระบุ alias อาจเปิดให้เลือกเมื่อผู้ใช้มีหลาย organizations; ห้ามผสม scope formats. [Keycloak Server Administration Guide](https://www.keycloak.org/docs/latest/server_admin/#_mapping-organization-claims)

Phase 2 จึงต้อง:

- derive tenant alias จาก trusted app origin/config แล้วส่ง `organization:<alias>`
- API validate issuer, signature, expiry, audience และ canonical organization/tenant mapping; ห้ามเชื่อ tenant id จาก URL/body
- มี realm import integration test กับ **Keycloak version ที่ pin** เพราะเอกสาร latest อาจใหม่กว่า dev `26.0.0`

### 2. Library ownership และ token storage

Keycloak JavaScript adapter เก็บ access/refresh token ใน memory และเตือนว่าไม่ควร persist; adapter ต้อง initialize ก่อน SPA router เพราะ auth flow อาจเปลี่ยน URL. ก่อน REST request สามารถใช้ `updateToken(minValidity)` แล้วจึงส่ง bearer token. [Keycloak JavaScript adapter](https://www.keycloak.org/securing-apps/javascript-adapter)

repository ปัจจุบันระบุ `oidc-client-ts` + `react-oidc-context`. Phase 2 ไม่ควรใช้สอง auth runtimes พร้อมกัน: ticket frontend architecture ต้องเลือก owner หนึ่งตัว แล้วห่อหลัง `AuthSession` interface. ไม่ว่าจะเลือกตัวใดต้องรักษา contract ต่อไปนี้:

- access/refresh token อยู่ใน memory ของ leader tab เท่านั้น
- ห้ามส่ง token ผ่าน `localStorage`, `sessionStorage`, URL, log หรือ `BroadcastChannel`
- tab อื่นแชร์ได้เพียงสถานะ ownership/session hint และทำ interactive/silent auth ของตนเมื่อจำเป็น
- refresh ถูก serialize เพื่อไม่ยิงซ้ำพร้อมกัน และ REST client refresh ก่อนส่ง request ตาม min-validity policy

### 3. Silent SSO ไม่ใช่ safety net

Keycloak ระบุว่า Session Status iframe และ silent `check-sso` พึ่ง third-party cookies. Browser ที่ block cookies ลักษณะนี้จะปิด iframe และ silent check อาจ fallback เป็น regular redirect. [Keycloak: Modern Browsers with Tracking Protection](https://www.keycloak.org/securing-apps/javascript-adapter#_modern_browsers)

ดังนั้น:

- ใช้ silent SSO เพื่อ bootstrap/reload ได้เมื่อ browser รองรับ แต่ห้ามผูก active-call survival ไว้กับ hidden iframe
- ตั้ง fallback ที่ไม่เริ่ม redirect อัตโนมัติระหว่าง active interaction
- เมื่อ refresh หมดทาง ให้เข้า `AUTH_DEGRADED`, ปิด new offers และแสดง action ให้ re-auth หลังสาย/wrap-up จบ
- timeout/grace period และ safe controls ขณะ degraded ต้องกำหนดใน call-control/recovery contract

### 4. REST, WebSocket และ SIP credentials

REST ใช้ audience-restricted access token สำหรับ `dcontact-api`; RFC 9700 แนะนำจำกัด token privileges/audience เพื่อลดผลกระทบเมื่อรั่ว. [RFC 9700](https://www.rfc-editor.org/info/rfc9700/)

browser `WebSocket` constructor รับ URL และ optional subprotocol แต่ไม่มีช่องใส่ arbitrary Authorization header. [MDN: WebSocket constructor](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/WebSocket)

จึงรักษา contract ของ repository:

- เปิด `wss://` แล้วส่ง token ใน first-message auth payload; ห้าม query string
- ส่ง `auth:refresh` ก่อน `exp`; server ผูก socket กับ `sid`, user และ tenant และตัดเมื่อ refresh ไม่สำเร็จ
- reconnect ต้องขอ current REST snapshot แล้วตามด้วย ordered events; ห้ามถือ socket continuity เป็น business-state continuity
- `GET /api/me/sip-credentials` คืน credential แยกจาก OIDC token ให้เจ้าของเท่านั้น, อยู่ใน memory และ redact จาก telemetry
- การ refresh OIDC หรือ SIP credentials ห้าม tear down active SIP dialog โดยอัตโนมัติ; lifetime/rotation ที่แน่นอนต้องตัดสินร่วมกับ softphone recovery

### 5. Browser OAuth architecture

RFC 10017 เรียง browser OAuth patterns จากปลอดภัยมากไปน้อยเป็น BFF, token-mediating backend และ browser-based OAuth client. BFF กัน token ออกจาก JavaScript แต่เพิ่ม server-side session, CSRF/cookie และ scaling concerns; browser client เรียบง่ายกว่าแต่ token อยู่ใน execution context ที่ XSS เข้าถึงได้. [RFC 10017](https://www.rfc-editor.org/rfc/rfc10017.html#name-application-architecture-patt)

Phase 2 ยังไม่ควรเปลี่ยนเป็น BFF โดยปริยาย เพราะ baseline และ WebSocket contract เป็น bearer-token SPA อยู่แล้ว. Ticket frontend architecture ต้องบันทึกการยอมรับความเสี่ยงของ browser-client model หรือเลือก BFF อย่างชัดเจนก่อนเขียน spec. ถ้าคง SPA ต้องมี CSP/dependency hygiene, in-memory tokens, refresh rotation, short access-token lifetime และ no-token logging เป็น acceptance boundaries.

## Decisions ที่ส่งต่อ

- ยึด Authorization Code + PKCE S256 และ `organization:<tenant-alias>`
- token/refresh token อยู่ใน memory; refresh rotation และ audience restriction
- เลือก auth runtime เพียงหนึ่งตัวหลัง `AuthSession` interface
- silent SSO เป็น best-effort; ห้าม automatic redirect ระหว่าง active interaction
- REST bearer + WebSocket first-message auth/`auth:refresh`; ห้าม token ใน query/storage/log
- SIP credentials เป็น short-lived separate secret ของผู้ใช้และต้องไม่ผูก refresh เข้ากับการตัด active dialog

## เรื่องที่ยังต้องตัดสิน

- คง browser OAuth client ตาม baseline หรือเพิ่ม BFF/token-mediating backend
- เลือก `oidc-client-ts` หรือ `keycloak-js` เป็น auth runtime
- refresh scheduling, grace period, degraded safe controls และ forced logout semantics
- SIP credential TTL/rotation และ response/error contract
- claim shape ระหว่าง nested `organization` กับ top-level tenant claims ซึ่งต้องยึดผลจาก research เดิมและทดสอบกับ Keycloak `26.0.0`

