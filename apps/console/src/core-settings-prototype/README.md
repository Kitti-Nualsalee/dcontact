# ต้นแบบ Core Settings — เพื่อเลือก UX เท่านั้น

งานเจ้าของ: [Core Settings 4: ทดลองโครงเมนูและ UX หน้าตั้งค่ารอบแรกด้วย UI เดิม](https://github.com/Kitti-Nualsalee/dcontact/issues/721)

ต้นแบบทิ้งได้บน branch `codex/prototype-core-settings-721` ตั้งคำถามว่า **ผู้ดูแลองค์กรควรค้นพบและแก้ข้อมูลองค์กร/ทีมผ่านโครงใด** ใช้ ShellFrame/SubNav/ปุ่ม/fields/table/dialog และ tokens เดิม แยก catalog TH/EN ผ่าน i18n เดิม ข้อมูลทุกชิ้นสังเคราะห์และ mutation อยู่ใน memory ไม่มี fetch, DB, Keycloak, email, routing WS, lease หรือ SIP

## เปิดใช้งาน

จาก root ของ branch นี้ (ใช้ dependencies ของ workspace เดิม):

```sh
pnpm prototype:core-settings
```

เปิด [ต้นแบบ A](http://127.0.0.1:5187/?view=core-settings-prototype&variant=A) แล้วใช้ลูกศรที่แถบด้านล่างสลับแบบ หรือเปิด URL ของ [B](http://127.0.0.1:5187/?view=core-settings-prototype&variant=B) / [C](http://127.0.0.1:5187/?view=core-settings-prototype&variant=C)

ArrowLeft/ArrowRight สลับแบบเมื่อไม่ได้แก้ field/ใช้งาน widget ที่มี keyboard ของตัวเอง URL เก็บ variant/page/team เพื่อ deep link และ refresh ส่วนข้อมูลจำลองและร่างไม่อยู่รอดหลัง reload เครื่องมือทดลองสถานะใช้ reset fixture ได้ทุกเมื่อ ไม่ใช่ปุ่มในผลิตภัณฑ์จริง

| แบบ                     | โครงสร้าง                                                                             | คำถามที่ช่วยตัดสิน                                             |
| ----------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| A — หน้าแยกหมวด         | องค์กร/ทีมอยู่ SubNav คนละหน้า; form เต็มหน้าและคำอธิบายด้านข้าง; ทีมใช้ table+dialog | ทางเข้าชัดและใกล้ registry pages เดิมเพียงพอหรือไม่            |
| B — รายการและรายละเอียด | SubNav ทางเข้าเดียว; เลือกองค์กรหรือทีมใน master list และแก้ใน pane คู่กัน            | การสลับทีมบ่อยคุ้มกับพื้นที่ที่ใช้เพิ่มหรือไม่                 |
| C — หน้ารวมและ editor   | Hub สรุปสองหมวด; ดูค่าที่อ่านกลับก่อนเปิดแก้; editor มีขั้นตรวจเทียบก่อน direct save  | การแยกดู/แก้และทบทวนเพิ่มความเข้าใจ หรือเพิ่มขั้นตอนเกินจำเป็น |

**Owner เลือก A แล้วเมื่อ 2026-10-19** ด้วยคำตอบ “A: หน้าแยกหมวด (แนะนำ)” โดยรับข้อเสนอหน้าองค์กร/ทีมผ่าน SubNav และ form เต็มหน้าไว้เป็นแนวทาง first slice เก็บ B/C และ switcher ไว้บน throwaway branch เป็นหลักฐานตัวเลือกเดิม ไม่ promote ต้นแบบเข้า production

## ลองอย่างไร

- กดบันทึกค่าเดิม: ได้ no-op พร้อม command จำลองโดย revision ไม่เพิ่ม
- เปลี่ยนชื่อองค์กรแล้วบันทึก: ส่งคำสั่ง → readback → สำเร็จจำลอง; tenant default ไม่เปลี่ยนภาษา UI ที่เปิดอยู่
- หน้า Teams: สร้าง/เปลี่ยนชื่อ; ทีมดูแลลูกค้ามี references จึงปิดไม่ได้; ทีมทดลองใหม่ไม่มี references จึงแสดงยืนยันการปิด; inactive Team อ่านได้ ไม่มี reactivate
- เปิด “เครื่องมือทดลองสถานะ”: เลือก ADMIN/SUPERVISOR/AGENT/COMPLIANCE และ scenario จากนั้นใช้ form ตามปกติ สลับ scenario/role จะ reset fixture เพื่อเริ่มกรณีนั้นชัดเจน
- Unknown: เลือก scenario แล้วบันทึก ตั้งผลตรวจเป็น “ยังไม่พบ receipt” กดตรวจคำสั่งเดิม จะยังไม่สรุป failure เปลี่ยนเป็นพบ receipt แล้วตรวจอีกครั้งจะ readback ด้วย command เดิม
- Defaults unset: ชื่อแก้แยกได้; หากเริ่มตั้ง defaults ต้องเลือก locale/timezone ทั้งคู่
- สลับ TH/EN บน TopBar และย่อ viewport ≤760px: จอแคบซ่อน SubNav ที่ซ้ำ ใช้ทางเข้าในหน้าและซ่อน mutation controls
- ดู “สถานะทั้งหมดของต้นแบบ” เพื่อเทียบค่าที่อ่านกลับ/ร่าง/revision/command/receipt/role/scope ระหว่างลอง

## Authority และข้อจำกัด

ใช้ [ขอบเขต first slice](https://github.com/Kitti-Nualsalee/dcontact/issues/718#issuecomment-6254287714), [เจ้าของข้อมูล/สิทธิ์/lifecycle](https://github.com/Kitti-Nualsalee/dcontact/issues/719#issuecomment-6258835015) และ [config contract ที่ owner ยืนยัน](https://github.com/Kitti-Nualsalee/dcontact/issues/720#issuecomment-6260259720)

- Core proposal เป็นข้อมูลเมนูเฉพาะต้นแบบ ไม่เขียน production navigation registry เมนู Voice/Account เป็น deep links ของหน้าที่มีอยู่ตาม source; People ไม่เพิ่มเพราะยังไม่มีหน้าสร้างบัญชีจริง Calendar ไม่เพิ่มปุ่ม placeholder
- รูปแบบ permission และ verified-proof failure เป็น fixture แสดง UX ไม่ใช่การทดสอบ server authorization ตัวเลข refs และ guard เป็น synthetic ไม่มีการพิสูจน์ atomicity/concurrency จากต้นแบบ
- ไม่มี durable receipt/audit จริง ไม่มี sessionStorage recovery ของ command จริง และ reload ล้าง fixture ทั้งหมด ภาพ unknown/reauth แสดง intended UX เท่านั้น การทดสอบ durable recovery อยู่ Phase Contract/UAT ภายหลัง
- Timezone dropdown ใช้ตัวอย่าง 3 ค่า ไม่ใช่ production allowlist ของ IANA; string validation/normalizer/revision scopes ต้องกำหนด exact contract ต่อ ไม่คัดลอกต้นแบบไป production โดยตรง
- หน้าบัญชี/Voice ที่ลิงก์ออกไปใช้ auth/readiness ของหน้าเหล่านั้นตามปกติ ไม่มี synthetic success แทน API จริง; fixture นี้ไม่ใช้เตรียม identity/account หรือรับรองการเข้าใช้หน้าจริง
- แถบควบคุมและ loader เปิดเฉพาะ DEV + mode `prototype`; production build ไม่รวม code/catalog ของต้นแบบที่ไม่ได้ถูกอ้างจาก entry อื่น ไม่มีการ merge/deploy จาก decision นี้
- Owner ยืนยัน UX แล้ว ส่งผลการเลือกไปบันทึก resolution ของงาน UX; ยังไม่ใช่ implementation-ready Phase Contract หรือผล VM UAT PASS และไม่อนุมัติ merge/deploy จากการเลือกต้นแบบ

## หลักฐานตรวจเบื้องต้น

ตรวจด้วยเบราว์เซอร์บนเครื่อง: สลับ A/B/C, no-op revision4, create team revision1, Supervisor เห็นเฉพาะทีมตนและไม่มี mutation controls, unknown→receipt not found→matching receipt/readback โดย command เดิมและ revision5, สลับ TH/EN โดย state เดิมยังอยู่, C review step และ narrow read-only 390×844 หลังแก้ SubNav กินพื้นที่

`pnpm --filter @d-contact/console typecheck` และ production `build` ผ่าน ตรวจ dist ไม่พบ prototype route/banner/catalog ไม่มี automated tests เพิ่มตามขอบเขต throwaway prototype; ยังไม่ได้ทดสอบทุก scenario/keyboard/a11y หรือ runtime/backend gates จึงห้ามนับแทน acceptance

ภาพ: [A](evidence/variant-A.jpg), [B](evidence/variant-B.jpg), [C](evidence/variant-C.jpg), [C review](evidence/variant-C-review.jpg), [จอแคบอ่านอย่างเดียว](evidence/narrow-readonly.jpg)

## Verdict ของ owner — 2026-10-19

Owner ตอบคำถามที่แนบต้นแบบและรูปแบบสถานะครบ 3 ข้อ:

1. **“A: หน้าแยกหมวด (แนะนำ)”** — หน้าองค์กร/ทีมแยกผ่าน SubNav; form เต็มหน้า; ทีมใช้รายการและ dialog ตามแบบ A
2. **“เห็นด้วย: ทางเข้า Core เดียวและเชื่อมหน้าจริง”** — Core เป็น app เดียวสำหรับองค์กร+ทีมในพื้นที่ตั้งค่าองค์กร เพิ่ม production registry เมื่อหน้าจริงและ server-authoritative navigation พร้อม Account/Account policy/Voice เป็นลิงก์ตาม authority เดิม Calendar/People ที่ยังไม่มีหน้าจริงไม่มี placeholder
3. **“เห็นด้วย: ใช้รูปแบบสถานะตาม prototype”** — validation ใกล้ field; สถานะบันทึก/readback/no-op/conflict/unknown ในบริบท form; เก็บร่าง/ตรวจคำสั่งเดิม/เตือนก่อนทิ้งร่าง/ยืนยันปิดทีม; Supervisor และ narrow อ่านอย่างเดียว

ใช้ [UI-state inventory](UI-STATES.md) เป็นแนวทางส่งต่อ Phase Contract ภายใต้ scope/permission/config contracts ที่ยืนยันแล้ว และต้องออกแบบ production ใหม่พร้อม exact API/error/accessibility/recovery/concurrency tests ไม่ยกการคลิก fixture เป็น acceptance ของ backend

รายละเอียด resolution และ handoff อยู่ที่ [Core Settings 4: ทดลองโครงเมนูและ UX หน้าตั้งค่ารอบแรกด้วย UI เดิม](https://github.com/Kitti-Nualsalee/dcontact/issues/721) แผนที่อ้าง ticket เป็น authority ของคำตอบ ส่วน branch นี้เก็บ prototype และ verdict เป็น primary-source asset
