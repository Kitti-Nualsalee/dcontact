# ตรวจหน้า Home ตามแบบที่ 2 — #684

- แหล่งภาพที่ผู้ใช้เลือก: `docs/evidence/684/selected-home-2.jpg` (สำเนาจากภาพลำดับที่ 2 ในแชต)
- ภาพ implementation จาก Codex In-app Browser: `docs/evidence/684/home-th.jpg`
- viewport: 1440×1024 CSS px; implementation 1440×1024 pixels, density 1
- source เดิม 1487×1058 pixels; ปรับขนาดเป็น 1440×1024 เพื่อเปรียบเทียบ aspect ratio เดียวกัน (ต่างจาก 1440/1024 ไม่ถึง 0.1%)
- สถานะ: ภาษาไทย, Home, ผู้ใช้สังเคราะห์ admin ของ demo ที่มีสิทธิ์ครบทั้ง 5 พื้นที่, shell เปิด, ไม่มีเมนูผู้ใช้เปิดทับ
- full-view comparison: `docs/evidence/684/comparison.jpg` — source ซ้าย, implementation ขวา
- focused comparison: `docs/evidence/684/comparison-detail.jpg` — ชื่อแอป คำอธิบาย และแถวแบ่งหมวด
- จอแคบ: `docs/evidence/684/home-mobile.jpg`, 390×844 CSS px; เลื่อนลงตรวจถึง dphone แล้ว

## Findings

ไม่พบ P0/P1/P2 ที่ยังต้องแก้ในหน้าที่ตรวจ

- ตัวอักษร: ใช้ token `Inter`, `Noto Sans Thai`, system fallback ของผลิตภัณฑ์; หัวข้อ 36px, ชื่อพื้นที่ 18px, คำอธิบาย 14px ตามลำดับชั้นเดิม ข้อความไทยอ่านได้ ไม่ตัดบรรทัดบน desktop
- ระยะและ layout: คงหัวข้อ → รายการกลุ่มงานสด → จัดการและตั้งค่า → ข้อความเรื่องสิทธิ์ตามแบบ; ครบ 5 รายการใน viewport เดียว มี sidebar และ Home active จอแคบซ่อน sidebar ที่ซ้ำกับเนื้อหา และเลื่อนอ่านครบทุกแอปได้
- สี: ใช้ tokens เดิม; ตรวจ computed rail เป็น `rgb(15, 118, 110)` ตรง `--dc-surface-brand` ใช้ surface/border/text tokens ร่วมกันทั้งหมด
- ภาพและ icons: ใช้ brand asset และ ShellIcon ของผลิตภัณฑ์เดิม ไม่สร้างภาพหรือไอคอนเลียนแบบใหม่
- เนื้อหา: ชื่อ/คำอธิบายครบตามแบบ แสดงเฉพาะรายการจาก API ใช้ external indicator เฉพาะ Workspace ซึ่งเปิดแท็บใหม่จริง; Journeys/Governance/dphone เปิดใน Console

## ความต่างที่ยอมรับตามสเปก

- ใช้ rail 76px, SubNav 240px และ topbar 44px ของ shell จริง แทนการเปลี่ยน chrome ทั้งระบบตามสัดส่วนภาพ ImageGen; launcher คงตำแหน่งเดิมด้านบน
- ใช้ icons และฟอนต์ตาม tokens/fallback ของระบบเดิม; ภาพต้นแบบมี icons ที่ต่างจากระบบและขนาดตัวอักษรบางส่วนต่างเล็กน้อย
- ไม่ใส่สัญลักษณ์เปิดแท็บใหม่ให้เมนูใน Console ซึ่งภาพต้นแบบใส่ทุกแถว เพราะลิงก์เหล่านี้เปิดแท็บเดิมจริง

## ประวัติการตรวจและแก้ไข

1. ตรวจภาพ implementation รอบแรกใน browser พบชื่อ “กล่องงาน (Agent Workspace)” ยาวจนถูกตัดใน sidebar [P2] แก้โดยใช้ชื่อเมนูสั้นจาก registry เฉพาะ sidebar และคงชื่อเต็มในรายการหลัก
2. เก็บภาพหลังแก้ `home-th.jpg` แล้วประกอบภาพเปรียบเทียบทั้งหน้าและส่วนข้อความตามไฟล์ข้างต้น: sidebar ไม่ตัดชื่อกล่องงาน, ชื่อและคำอธิบายในรายการหลักอ่านครบ ไม่พบ P0/P1/P2 เพิ่ม
3. ตรวจจอแคบจริง: ปุ่มภาษาและบัญชียังอยู่ในแถบบน, ไม่มี horizontal overflow, เลื่อนถึง dphone และข้อความเรื่องสิทธิ์ได้

## พฤติกรรมที่ตรวจ

- สลับ TH/EN, เมนูบัญชี, keyboard focus และ Tab ระหว่างพื้นที่ทำงาน
- default Home, explicit Journeys และ back, role/plan ที่เห็นเมนูต่างกัน, หมุดว่าง, API รุ่นเก่า, flag ปิด, API ล้มเหลวและ retry, empty state
- browser error log ของ local preview: ไม่พบ warning/error ณ การตรวจ
- browser tests ตรวจ axe ทั้ง TH/EN: ไม่มี serious/critical

## ข้อจำกัด

Preview ใช้ข้อมูลสังเคราะห์และโหมด e2e สำหรับดูหน้าจอ; production route ใช้ OIDC/Navigation API จริง แต่ยังไม่ได้ตรวจ login กับ Keycloak บน UAT หรือ deploy งานนี้

## Implementation checklist

- [x] เปรียบเทียบภาพเต็มและส่วนสำคัญ
- [x] แก้ชื่อใน sidebar ที่ถูกตัด
- [x] ตรวจ desktop และจอแคบ
- [x] ใช้เมนูและ tokens เดิมตามสเปก

## Follow-up polish

- [P3] หากต้องการให้ไอคอนและ launcher ตรงภาพ ImageGen ทุกจุด ควรปรับ shell ทั้งระบบเป็นงานแยก เพื่อคงความสม่ำเสมอกับหน้าปัจจุบัน

final result: passed
