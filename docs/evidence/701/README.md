# V1-A2 — recovery/auth และร่างใน document runtime

วันที่ตรวจ: 17 ตุลาคม 2026 · authority: #699 / #701 · base: `58fa15859c6fc72cdb9131b97166e3783f242ac9`

โค้ดที่ตรวจรอบสุดท้าย: `45ba61d03ff47e3eda049e52d042c00f084b6aa0`; candidate ที่รวมเอกสาร, required CI, merge และ completion ให้ยึด PR #706 และ tracker ไม่ใช้เอกสารนี้แทน VM UAT PASS

## ขอบเขตที่ส่งมอบ

- API/lease clients คง instance เดิมและอ่าน token ล่าสุด ไม่สร้าง dphone หรือ work-session client ใหม่เพราะ token refresh
- ร่าง, intent, in-flight/unknown และ saved result อยู่ใน memory ของ document runtime ผูก issuer/tenant/domain user/subject และ Interaction; ไม่เก็บ note ใน storage, URL หรือ server autosave
- คง Workspace subtree/media เมื่อ auth ไม่พร้อม ปิดรับงานใหม่และใช้ user-initiated OIDC popup ผ่าน library เดิม พร้อม PKCE/state/nonce และ callback URI ของ origin/tenant เดิม
- Popup callback ส่งกลับให้ OIDC navigator โดยไม่ mount Workspace/lease/SIP อีกชุด; popup blocked/cancel/error ลองใหม่ได้
- Same-identity recovery ตรวจ receipt/result/snapshot ก่อนเปิดรับงานใหม่; ไม่ถือว่า command ยังไม่พบเป็นหลักฐานว่า POST ไม่ commit
- Pending/unknown intent ยังคง commandId/payload เดิมและผูกงานเดิม แม้ snapshot เปลี่ยนเป็นงานใหม่; ฟอร์มงานใหม่ไม่รับร่างเก่า
- Identity ใหม่หรือ authenticated claims ที่ไม่ผ่านการตรวจทำให้ล้าง/ซ่อนร่างและ summary ทันที; generation guard กันคำตอบเก่าคืนข้อมูล ไม่โอน lease/สายให้บัญชีใหม่
- แยกสถานะ reconciling/saving/unknown/saved ผ่าน TH/EN และมีคำเตือนก่อน internal navigation/signout/beforeunload ตาม browser support

## หลักฐานทดสอบ

- Browser regression แรกทำให้เห็น RED ว่า auth หายแล้ว textarea หาย; แก้ให้คง subtree และ stable clients แล้วผ่าน
- Independent Spec review พบ P1 authenticated identity ที่ claims ไม่ครบยังเห็นร่างเก่า; เพิ่ม wrong tenant/missing claim/wrong issuer ให้ RED ทั้ง 3 ก่อนแก้ แล้ว GREEN ทั้ง 3
- Focused recovery browser **11/11 PASS**: stale POST response หลังเปลี่ยน identity, invalid identity, unknown/new Interaction, popup blocked/cancel/wrong state/wrong nonce/retry, navigation/signout/reload warnings และ token/locale change
- Full Workspace browser **73/73 PASS** หลัง remediation รวม legacy และ Embedded dphone regression
- ระหว่างสายสังเคราะห์ใน browser: SIP session ID, lease ID และ document time origin เท่าเดิมหลัง refresh/expire/locale/reauth; วางสายแล้วกรอก wrap-up ต่อได้
- Workspace unit **92/92 PASS**, typecheck, production/embedded build, `test:d1-i18n` และ `pnpm lint` PASS
- Affected Agent HTTP integration **1/1 PASS** กับ PostgreSQL จริงผ่าน application role/NOBYPASSRLS รวม committed-response-loss, replay/readback/atomicity/owner guards ของ #700
- `e1:auth:boundary` **6/6 PASS** (API 3 + Workspace 3), API boundary **15/15 PASS** กับ Keycloak 26.7.5 ตาม pinned digest และ isolated PostgreSQL/Mailpit; ไม่มี skip ในชุดที่รัน
- Production bundle ไม่พบ synthetic auth fixture; test controls เปิดเฉพาะ Vite mode `e2e`
- Independent re-review ที่ `45ba61d`: Standards **0 actionable findings** หลังแก้ shared Button/fake-ref proxies/fixture duplication; Spec **0 actionable findings** หลังปิด P1

Review agents อ่านโค้ดอย่างเดียว ไม่ได้รัน tests; ผล runtime ข้างต้นรันโดย agent หลักแยกจาก review

## ข้อจำกัดและเกตถัดไป

- Browser ใช้ synthetic IdP response และ media transport เพื่อพิสูจน์ UI/OIDC-library flow; HTTP persistence และ real Keycloak boundary ใช้บริการจริงใน dev แยก ไม่ใช่ VM/headset proof
- ไม่มี durable draft หลัง reload/close/crash ตามสัญญา; note ที่ยังไม่ commit อาจหายเมื่อยืนยันออกจาก document
- Required CI บน final candidate และ merge/main CI ต้องตรวจจาก PR ก่อนปิด #701
- #702 Console history และ #703 packaging/release/limited VM trial ยังเป็นงานถัดไป ไม่อ้างว่า V1 ทั้งหมดผ่าน
- ไม่มี VM mutation, บัญชีจริง, email invitation, provider egress หรือ raw HAR/trace/token/credentials/OTP/PII ในเอกสารนี้
