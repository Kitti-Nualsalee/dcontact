# Cus360 UX prototype — ทิ้งหลังเลือกแบบ

Prototype สำหรับ [Cus360: เลือก UX ของ Console และแผงลูกค้าใน Workspace](https://github.com/Kitti-Nualsalee/dcontact/issues/762) ใช้กรอบข้อมูล/สิทธิ์จาก [resolution ที่ยืนยันแล้ว](https://github.com/Kitti-Nualsalee/dcontact/issues/761#issuecomment-6403026011)

## คำถามที่ใช้ตัดสิน

Console ควรเป็น A รายการแล้วเปิดโปรไฟล์เต็มหน้า, B รายการคู่แผงรายละเอียด หรือ C โปรไฟล์เป็นศูนย์กลาง? Workspace ควรวางแผงลูกค้าข้างงาน, แท็บในพื้นที่หลัก หรือคอลัมน์ลูกค้าคู่บันทึกผล? เลือกต่างแบบระหว่าง Console/Workspace หรือผสมส่วนที่ชอบได้

## เปิดดู

จาก root ของ worktree ที่ติดตั้ง dependencies และ build workspace dependencies แล้ว:

```sh
pnpm prototype:cus360
```

- Console: <http://127.0.0.1:5190/?view=cus360-prototype&variant=A&surface=console>
- Workspace: <http://127.0.0.1:5190/?view=cus360-prototype&variant=A&surface=workspace>
- เปลี่ยน `variant=A|B|C` หรือกดลูกศรแถบล่าง/แป้นซ้ายขวา; ไม่ดักลูกศรเมื่อกำลังกรอกข้อมูล
- แถบเส้นประด้านบนใช้สลับ surface, บทบาท และสถานการณ์จำลอง ไม่ใช่ส่วนของ production UI
- TH/EN เปลี่ยนได้จาก shared top bar; layout ยุบคอลัมน์บนจอแคบ

เตรียม dependencies ใน checkout ใหม่ได้ด้วย `pnpm install --frozen-lockfile --ignore-scripts` และ `pnpm exec turbo run build --filter='@d-contact/console^...'`

## สิ่งที่ลองได้

- รายการ/ค้นหา/เปิดโปรไฟล์, สร้าง/แก้ข้อมูลใน memory, เพิ่มรายการ phone/email, ตัวอย่าง validation ชื่อ, อ่านค่าที่จำลองบันทึกแล้ว
- Admin มีฟอร์มสร้าง/แก้; Supervisor อ่านอย่างเดียว; Agent ใช้ customer panel ของงาน ไม่มี directory หรือสร้างลูกค้าใหม่
- Candidate มีข้อมูลจำกัดและปุ่มเลือกผูกชัดเจน; ไม่เปลี่ยนสถานะ identity เป็น verified และไม่ merge
- ลูกค้าใหม่แสดงรอสิทธิ์ทีม ไม่สร้างประวัติหรือสถานะ Contact Governance แทนข้อมูลที่ยังไม่มี
- Timeline มีเฉพาะวันเวลา/channel/state ของ fixtures ที่อนุญาต ไม่มีโน้ตผู้อื่น/เสียงสนทนา
- Dirty navigation ใช้ shared dialog; ยกเลิกคงร่าง ยืนยันจึงทิ้งร่าง. Reload ใช้ beforeunload และไม่กู้ร่างหลัง reload
- จำลองจบสาย/WRAPUP/บันทึกผลแบบไม่ผูกลูกค้าได้; สลับงานมีคำเตือนเมื่อมีร่างและล้างข้อมูลของงานเดิมเมื่อยืนยัน

## State inventory

| สถานะจำลอง            | พฤติกรรมที่ให้ประเมิน                                  |
| --------------------- | ------------------------------------------------------ |
| loading / empty       | แยกกำลังอ่านจากไม่มีผลลัพธ์                            |
| forbidden / not-found | ไม่แสดงข้อมูลที่เปิดไม่ได้                             |
| ambiguous             | บอกว่าหลาย candidate; ไม่ผูก/merge อัตโนมัติ           |
| partial               | Governance ไม่พร้อม ไม่ตีความว่าอนุญาตให้ติดต่อ        |
| conflict              | คงร่าง อ่านค่าล่าสุดก่อนตรวจแก้; ไม่เขียนทับอัตโนมัติ  |
| unknown               | คงร่าง ตรวจคำสั่งเดิม/receipt ก่อนแสดงผลสำเร็จ         |
| session               | ซ่อนเนื้อหาลูกค้าระหว่างกลับเข้าใช้ เก็บร่างในหน้าเดิม |
| scope                 | ปิดโปรไฟล์เมื่อสิทธิ์ทีมยังไม่พร้อม                    |
| assignment            | ปิดข้อมูลลูกค้าเก่าเมื่อผู้รับผิดชอบเปลี่ยน            |

## ขอบเขตสำคัญ

ข้อมูลสมมติทั้งหมด เก็บใน memory ไม่มี fetch/write API, OIDC login, SIP/media, DB หรือ storage; refresh เริ่มใหม่. Role dropdown เป็นเครื่องมือสาธิต ไม่ใช่ authorization. หน้านี้เปิดได้เฉพาะ Vite DEV route; production build ไม่โหลด prototype

กฎ validation, duplicate/shared-phone, การแก้ tags/VIP โดย Agent, candidate fields, attach/relink lifecycle และ permission/resource scope ขั้นสุดท้ายยังเป็นงาน API/runtime contract ไม่อ้างว่าการสาธิตตัดสินแทน owner แล้ว. Production ต้อง implement ใหม่พร้อม real boundary tests; prototype ไม่ใช่ VM UAT PASS

เก็บ source บน throwaway branch `codex/762-cus360-prototype` เท่านั้น ไม่เปิด PR ให้ merge prototype เข้า main
