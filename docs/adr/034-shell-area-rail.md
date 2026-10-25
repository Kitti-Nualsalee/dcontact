# ADR 034: Rail เป็นพื้นที่งาน และเมนูย่อยขับด้วย registry

- **สถานะ:** Accepted (เจ้าของงานตัดสิน 2026-10-12)
- **ที่มา:** [#651](https://github.com/Kitti-Nualsalee/dcontact/issues/651) — ปรับผลตัดสินของ D1 ([#428](https://github.com/Kitti-Nualsalee/dcontact/issues/428), D1.12 #451, D1.13 #452)

## บริบท

D1 ให้ rail เป็น "แอปที่หมุดไว้" (≤15) พร้อม launcher และให้ Console มี SubNav ที่เขียนมือรายหน้า (`if/else` ต่อแอป รายการละหนึ่ง)
`mockups/` ที่เจ้าของงานออกแบบไว้ใช้โครงอีกแบบ: rail เป็น **พื้นที่งานคงที่** (Home, Workspace, Supervise, Journeys, Governance, …)
และแต่ละพื้นที่มีเมนูย่อยหลายกลุ่ม — เพิ่มหน้าใหม่ในโครงเดิมต้องแก้ shell ทุกครั้ง

## การตัดสินใจ

1. **Rail = พื้นที่งาน** ตามลำดับของ `NAVIGATION_AREAS` (16 พื้นที่ตาม `mockups/assets/app.js`)
   - ปุ่มพื้นที่ลิงก์ไปรายการแรกของพื้นที่; พื้นที่ของอีก host app เปิดแท็บใหม่ (ADR-026 ข้อ 3)
2. **แสดงเฉพาะหน้าที่มีจริง** — พื้นที่ที่ไม่มีรายการที่ผู้ใช้เห็นไม่ถูกส่งไป browser (กติกา registry เดิม: ไม่มีสถานะล็อก)
   ตอนนี้มี 5 พื้นที่: Workspace, Supervise, Journeys, Governance, Integrations (ฝัง dphone)
3. **เมนูขับด้วยข้อมูล:** `NavigationAppDefinition` มี `area` และ `section` เพิ่ม; Navigation API ส่ง `areas`
   (`areas[].sections[].items[].appId` อ้าง `apps`) ที่คัดตาม role + entitlement ที่ server (`visibleAreas`)
   - เพิ่มหน้าใหม่ = เพิ่มแถวใน registry + ข้อความ `navigation.sections.<id>` (และ `navigation.areas.<id>` ถ้าพื้นที่ใหม่)
     ไม่ต้องแก้ `console-shell.tsx`
   - `apps`, `groups`, `pins` เดิมไม่เปลี่ยน — additive, ไม่มี migration; launcher ใช้ต่อได้
4. **หมุดและ launcher คงไว้ แต่ไม่กำหนด rail:** ตาม owner amendment #758 รายการปักหมุดแสดงเฉพาะเมนูย่อยของ Home
   พื้นที่อื่นแสดงเฉพาะเมนูของพื้นที่นั้น (เปลี่ยนที่อยู่ของหมุดได้โดยไม่แตะ API)
5. **Workspace มีแต่ rail ไม่มีเมนูย่อย** — คงผล D1.2 และ ADR-026 (หน้าสด ห้าม remount)
6. หน้านอก registry (หน้าบัญชีของฉัน/นโยบายบัญชี) ไม่อยู่พื้นที่ใด: rail ไม่เลือกพื้นที่ และใช้เมนูย่อยของตัวเอง (AC5 #598)

7. **หน้าย่อยของแอป (`pages`) — ภาคผนวก #658:** แท็บภายในหน้าที่เป็นหน้าย่อยจริงขึ้นเมนูย่อยได้โดยไม่แยกเป็นแอป
   - **1 แอป = 1 หน่วยปักหมุด/launcher** ตามเดิม; หน้าย่อยไม่ปักหมุดและสิทธิ์การมองเห็นเท่ากับแอป (API ปลายทาง authorize เองทุก request)
   - registry: `NavigationAppDefinition.pages?: { id, labelKey, path }[]`; API ส่งใน item เดิม `areas[].sections[].items[] = { appId, pages? }`
     (additive — Console รุ่นเก่าที่ไม่รู้จัก `pages` เห็นรายการเดียวของแอป)
   - shell กระจาย `pages` เป็นรายการเมนูย่อย `<appId>:<pageId>` (ไอคอนของแอป); เนื้อหาหน้าเป็นเจ้าของสถานะหน้าและส่ง `pageId` + `onPageSelect` ให้ shell
     เพื่อเปลี่ยนหน้าแบบไม่โหลดใหม่ (ลิงก์ยังเป็น `href` จริง: คลิกพร้อม ctrl/⌘/shift หรือแท็บใหม่ทำงานตามปกติ)
   - เมนูย่อยมี `pages` ของแอปนั้น → เนื้อหาไม่วาดแท็บซ้ำ (`useShellPageNav`); ไม่มี (flag ปิด, API รุ่นเก่า) → เนื้อหาใช้แท็บของตัวเอง
   - ใช้กับ Governance: ภาพรวม, Exceptions, Policies, Audit (Exceptions/Policies ที่เคยซ้อนแท็บรองในหน้าเป็นรายการระดับเดียวกัน)
   - หน้าที่ "สร้างไว้แล้วแต่ยังไม่เป็นหน้าย่อยจริง" (เช่น Decision explorer, Restrictions ของ mockup) เพิ่มเป็นแถวใน `pages` เมื่อมีหน้าจริงเท่านั้น (ข้อ 2)

## ผลที่ตามมา

- (+) เพิ่มหน้า/พื้นที่ใหม่ด้วยการเพิ่มแถวข้อมูล; ผู้ใช้เห็นเฉพาะที่มีสิทธิ์ (ตัดที่ server ตามเดิม)
- (+) ไม่เปลี่ยน flag `ui.shell.v2` และ rollout ของ D1
- (−) **ลำดับ deploy:** API ก่อน Console/Workspace (เหมือน D1 ข้อ 3) — Console ใหม่กับ API รุ่นเก่าที่ไม่ส่ง `areas` ยังใช้งานได้
  (rail กลับไปแสดงหมุดแอป, เมนูย่อยเหลือรายการเดียวของแอปนั้น) แต่ไม่ได้เมนูพื้นที่
- (−) เมนูย่อยตอนนี้บางมาก (รายการละหนึ่ง) เพราะมีหน้าจริงน้อย — จะหนาขึ้นเมื่อเพิ่มหน้า ไม่ใช่เมื่อแก้ shell
- (−) ชื่อพื้นที่/กลุ่มย่อยต้องมีใน catalog ของทั้ง Console และ Workspace (ซ้ำกัน เหมือนข้อความ `navigation.*` เดิม)
- (−) พื้นที่ที่ผู้ใช้ปักหมุดแอปของอีก host app ไว้ เปิดแท็บใหม่จากเมนูย่อย — เหมือนพฤติกรรมเดิมของ rail


## ภาคผนวก: หน้า Home หลัง login (#684)

ผู้ใช้เลือกแบบที่ 2 เมื่อ 2026-10-15: Home เป็นศูนย์รวมทางเข้าพื้นที่ทำงานแบบรายการ แบ่งงานสดกับจัดการและตั้งค่า และมีเมนูย่อยแสดงทางเข้าที่มีสิทธิ์ทั้งหมด

- เพิ่ม app `home` ในพื้นที่ `home` ของ registry สำหรับบทบาทผู้ใช้ `agent`, `supervisor`, `admin`, `compliance` โดยไม่ผูก module entitlement; service role ไม่ได้เมนูนี้
- ไม่มี explicit `view` หรือ opaque Interaction `context` → Home เสมอ แม้ deployment เก่าส่ง `VITE_CONSOLE_DEFAULT_VIEW=journeys`; explicit deep link และ OIDC return URL มาก่อนตามเดิม
- Home ใช้ข้อมูล `apps` จาก Navigation API request เดียวกับ shell และตัดรายการของตัวเองออกจากเนื้อหา ไม่ใช้หมุดเป็นตัวกำหนดเมนูใน Home และไม่สร้างรายชื่อสำรองจาก role ฝั่ง browser
- เมนูย่อยของ Home แสดงรายการแอปทั้งหมดที่ server คัดให้ พร้อมบัญชีของฉัน; หน้าย่อยของ Governance ยังปรากฏเมื่อเข้าไปที่พื้นที่ Governance
- ปิด flag shell → Home แสดงรายการกับแถบบนโดยไม่มี rail/เมนูย่อย; API ล้มเหลว → แจ้งโหลดไม่สำเร็จพร้อมลองใหม่ ไม่แสดงเมนูที่เดาเอง
- คงส่วนประกอบ rail, launcher, แถบบน, icons และ tokens เดิมของระบบ; external-link indicator แสดงเฉพาะลิงก์ข้าม host จริง
- จอแคบซ่อนเมนูย่อยซึ่งซ้ำกับรายการใน Home และย่อแถบบน โดยยังเข้าถึงทุกพื้นที่จากรายการและบัญชีจากเมนูผู้ใช้ได้

## ภาคผนวก: แสดง PINNED เฉพาะ Home (#758)

Owner ยืนยันวันที่ 25 ตุลาคม 2569 ให้หมวด PINNED อยู่เฉพาะหน้า Home เพื่อไม่แทรกทางลัดซ้ำบนทุกพื้นที่ของ Console

- Home เพิ่มส่วนปักหมุดตามลำดับของผู้ใช้และเฉพาะแอปที่ server อนุญาต โดยไม่ซ้ำลิงก์ Home ถาวรและไม่แสดงหมวดว่าง
- Home ยังคงรายการทางเข้าทั้งหมดและบัญชีของฉันตาม #684; ปักหมุดเป็นทางลัดเพิ่มเติม
- เมนูย่อยพื้นที่อื่นแสดงเฉพาะกลุ่มและหน้าย่อยของพื้นที่จาก registry; Account และ legacy fallback คงพฤติกรรมเดิม
- การเก็บหมุด, ปัก/ถอนหมุดผ่าน launcher, API และสิทธิ์ไม่เปลี่ยน; ลิงก์ข้าม host ยังคงเปิดแท็บใหม่

## ภาคผนวก: Breadcrumb เหนือเนื้อหา Console (#758)

Owner ยืนยันวันที่ 25 ตุลาคม 2569 ให้ย้ายตำแหน่งปัจจุบันจากแถบบนมาอยู่เหนือเนื้อหาของแต่ละหน้า Console รวม Home และ Account. แถบบนคงโลโก้ ภาษา และเมนูผู้ใช้ ส่วน breadcrumb เลื่อนตามเนื้อหา ตัดบรรทัดบนจอแคบได้ และคง locale/aria-current เดิม

ใช้ `Breadcrumb` และตัวเลือก `ShellFrame.breadcrumbPlacement` ร่วม ไม่ทำสำเนารายหน้า. ค่าเริ่มต้นของ shared shell และ Workspace ยังเป็นแถบบน ไม่เปลี่ยน lifecycle ของงานสด. Home ที่ปิด shell ย้าย breadcrumb เหนือเนื้อหาเช่นกัน; legacy ที่ไม่แสดง shell ไม่เพิ่ม breadcrumb ใหม่

## ภาคผนวก: ทางเข้าระบบสดบนแถบบน Console (#758)

Owner ยืนยันวันที่ 25 ตุลาคม 2569 ให้ย้าย Workspace และ Supervisor จาก rail ของ Console ไปแถบบน เพราะมีหน้า main/menu ของระบบสดแยกอยู่แล้ว. แสดงเฉพาะรายการที่ Navigation API อนุญาตพร้อม host origin จริง คง tenant และเปิดแท็บใหม่ตาม ADR-026. จอแคบแสดงไอคอนพร้อม accessible name

ใช้ TopBarLinks ร่วมและกรองเฉพาะ projection ของ rail ไม่ลบ apps/pins ของ launcher หรือทางลัดใน Home. Workspace ไม่ส่งตัวเลือก rail ใหม่และคง layout/mount/session เดิม ไม่เปลี่ยน API หรือสิทธิ์
