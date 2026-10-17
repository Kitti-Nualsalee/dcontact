# V1-A3 — ประวัติงาน Voice ของ Agent ใน Console

วันที่ตรวจ: 17 ตุลาคม 2026 · authority: #699 / #702 · base: `7399e6b8124658f7927599e1df76ac14010b4fe2`

โค้ดหลังแก้ review: `15c8b74b7518864d7989f90bc2c663bff042b68b`; final candidate, required CI, review และ merge/main CI ให้ตรวจจาก PR #707 และ tracker เอกสารนี้ไม่ใช่หลักฐาน VM UAT PASS

## ขอบเขต

- HTTP history อ่านเฉพาะ COMPLETED VOICE ของ tenant/owner ที่ยืนยันจาก bearer และ active domain AGENT; role ผสมไม่ข้าม owner guard และ application database role ยังคง NOBYPASSRLS
- List ไม่มี note/caller/contact; detail อ่านจาก endpoint ผลบันทึกเฉพาะและแสดง note เป็น plain text พร้อม no-store
- Keyset เรียง recordedAt/UUID ลดหลั่น, default 20/max 100; cursor ตรวจรูปแบบ/ขนาด/version/identity และไม่ใช่ authority แทน owner WHERE
- Legacy อ้าง completion event แรกตาม createdAt/id หรือ endedAt/queuedAt พร้อมระบุแหล่งเวลาและไม่มี note; ไม่ backfill หรือเปลี่ยนข้อมูลจาก read
- Console มี list/detail/load more/refresh/deep link/loading/empty/error/retry และภาษาไทย/อังกฤษ; เปลี่ยน verified identity แล้ว remount shell/history และทิ้งคำตอบเก่า
- Registry เพิ่ม agent-history ในพื้นที่ history/work; server กรอง active domain AGENT ทั้ง visibility และ pins ด้วย predicate เดียวกับ history/result
- Workspace เปิดผลใน Console แท็บใหม่ URL มีเพียง view/tenant/opaque interaction ID; Console ไม่ขอ lease/SIP หรือเปลี่ยน availability

## หลักฐานระหว่างพัฒนาและ review

- HTTP + PostgreSQL/RLS เริ่ม RED 404 ก่อนเพิ่ม endpoint แล้ว GREEN รวม keyset ties, invalid limit/cursor, cross-identity, forged cursor ที่ยังถูก owner WHERE จำกัด, inactive/domain role, legacy, VOICE filter และไม่มี read-side mutation
- API integration ผ่าน **168 tests / 29 files** ทั้งก่อนและหลังแก้ review; API unit **92/92**, Console unit **50/50**, Workspace unit **92/92**
- Console browser ก่อน review รอบแรก **93/95** พบ Home expected count เดิมหลังเพิ่มเมนู; แก้เฉพาะ golden ที่เกี่ยวข้องแล้ว full **95/95 PASS**
- Spec review พบ shell/navigation ไม่ reset พร้อม history เมื่อ identity เปลี่ยน; เพิ่ม browser ผ่าน HistorySurface/AuthProvider/UserManager ของจริงกับ synthetic identity ให้ **RED** เพราะไม่ส่ง navigation ของบัญชีใหม่ แล้วเพิ่ม verified identity key ให้ **GREEN**
- Standards review พบตารางไม่ใช้ UI กลางและ predicate active Agent ซ้ำ; เปลี่ยนเป็น Table/Column/Row/Cell ร่วมและรวม query สิทธิ์เฉพาะโดยไม่เปลี่ยนนโยบาย
- หลังแก้ review focused Console history/Home **17/17 PASS** รวม error 401/403/404/503, retry, plain-text note, deep reload, legacy และ stale detail หลังเปลี่ยนบัญชี
- Workspace browser **73/73 PASS** รวม saved summary เปิด Console แท็บใหม่โดย document เดิมไม่ reload
- Real Keycloak sandbox: `e1:auth:boundary` **6/6 PASS**, API boundary **15/15 PASS**, ไม่มี skip; ใช้ PostgreSQL/Mailpit และ Keycloak 26.7.5 ตาม digest ที่ pin ไว้
- หลัง remediation Console browser รวม **96/96 PASS**, build ทั้ง repository **28/28 tasks**, typecheck, `test:d1-i18n` และ lint ผ่าน
- Independent re-review ที่ `15c8b74`: Standards **0 actionable findings** (ข้อเดิมแก้ครบ) และ Spec **CLEAR / 0 actionable findings**; ผู้ review อ่าน source อย่างเดียว ผล runtime รันโดย agent หลัก

## ข้อจำกัด

- Browser ใช้ synthetic HTTP/identity/media fixtures สำหรับ UI; persistence/RLS และ Keycloak boundary ใช้บริการจริงใน dev แยก ไม่ใช่ VM/headset proof
- ไม่มี VM deployment, การเปลี่ยนบัญชีจริง, People/Routing UI, SMTP onboarding หรือ final V1 acceptance จากงานนี้
- #703 ยังต้องพิสูจน์ package/readiness/capacity/backup/idle/real UI และ human acoustic trial ก่อนปิด A; B/C และ final สองรอบยังเป็นเกตแยก
- ไม่เผย raw HAR/trace/token/credentials/OTP/PII; เก็บเฉพาะ source และผลทดสอบสังเคราะห์ที่สรุปแล้ว
