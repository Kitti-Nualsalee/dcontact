# UI-state inventory สำหรับส่งต่อ Phase Contract

นี่เป็น **ข้อเสนอ UX ให้ owner ตรวจ** ตาม contract ที่ตัดสินแล้ว ไม่ใช่ acceptance evidence ของ backend แต่ละแบบใช้ controls/fixtures ร่วมกันเพื่อเปรียบเทียบโครงได้

| สถานะ                         | สิ่งที่ผู้ใช้เห็น/ทำต่อ                                                                         | ตำแหน่งทดลอง                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Loading                       | ยังไม่แสดง form/ข้อมูลว่าพร้อม                                                                  | scenario loading                                |
| Load failed                   | แจ้งโหลดไม่สำเร็จ + ลองใหม่                                                                     | scenario loadError                              |
| Empty teams                   | ไม่มีรายการ + สร้างทีมเฉพาะ Admin desktop                                                       | scenario empty                                  |
| No permission / missing proof | ข้อความปฏิเสธ ไม่มี Core mutation และทางไปบัญชีตนเอง                                            | role AGENT/COMPLIANCE หรือ proofMissing         |
| Supervisor                    | อ่านองค์กร/ทีมตนเท่านั้น ไม่มี create/edit/deactivate                                           | role SUPERVISOR                                 |
| Narrow                        | ≤760px ซ่อน SubNav ที่ซ้ำ ใช้ทางเข้าในหน้า ไม่มี mutation controls                              | ย่อเบราว์เซอร์                                  |
| Legacy defaults unset         | แสดง unset/fallback; เริ่ม defaults ต้องเลือกทั้งสองค่า ไม่ตั้งจาก name-only save               | scenario legacy                                 |
| Dirty                         | แสดงว่ามีการแก้ และเตือนเมื่อกดเปลี่ยนหมวด/ทีมในหน้า; beforeunload เตือน reload                 | แก้ field แล้ว navigate                         |
| Validation                    | ข้อผิดพลาดชื่อ/เลือก defaults ไม่ครบ; ร่างอยู่                                                  | กรอกชื่อว่างหรือยาวเกิน/เลือก default ด้านเดียว |
| Exact duplicate team          | แจ้งซ้ำรวม inactive; แยกตัวพิมพ์ตามเดิม                                                         | สร้างชื่อเดียวกับ fixture                       |
| Sending / readback            | ปิดปุ่มส่งซ้ำและ fields ระหว่างรอ                                                               | บันทึก                                          |
| Saved / no-op                 | แจ้งหลัง simulated readback; no-op revision เดิมมี receipt                                      | บันทึกข้อมูลใหม่/ค่าเดิม                        |
| Conflict                      | ร่างไม่ถูก overwrite; โหลด latest เพื่อเทียบ แล้วกดบันทึกใหม่เอง                                | scenario conflict แล้วบันทึก                    |
| Busy                          | แจ้งไม่ commit และ retry command เดิม                                                           | scenario busy แล้วบันทึก                        |
| Unknown / not-found           | ไม่เปลี่ยน commandId ไม่แจ้ง failure จาก not-found; ปิด save ใหม่ ให้ตรวจคำสั่งเดิม             | scenario unknown + lookup selector              |
| Committed/readback failed     | ไม่แจ้ง success ก่อน readback; ตรวจ command เดิมต่อ                                             | scenario readbackFailed                         |
| Reauth                        | แสดงทาง sign-in จำลอง ไม่รับ mutation ก่อนตรวจกลับ                                              | scenario reauth                                 |
| Team referenced               | แสดงเหตุผลปิดไม่ได้ ไม่มี auto-move/unassign                                                    | ปิดทีมดูแลลูกค้า                                |
| Team free / inactive          | ยืนยันปิดและคงข้อมูล/UUID; inactive ไม่มี reactivate                                            | ทีมทดลองใหม่/ทีมเก็บประวัติ                     |
| TH/EN                         | เปลี่ยนข้อความร่วมกับ shell โดยไม่ reload/ไม่ล้าง form                                          | TopBar language                                 |
| Deep link / back / refresh    | query เก็บ view/variant/page/team; refresh reset fixture; prototype ไม่พิสูจน์ durable recovery | URL และ browser controls                        |

## สิ่งที่ Phase Contract ต้องแยกจากการตัดสิน UX

- Server-authoritative navigation/active user/proof/tenant-team scopes และ RLS; fixture hiding ไม่ใช่ authorization test
- API/error/revision/normalizer/timezone/provenance migration/receipt retention และ readback ที่ distinguish committed result จาก revision ใหม่
- Atomic audit/receipt/no-op semantics และ guards ครบทุก current-reference writer จริง
- Draft/reauth identity scoping, command-only reload recovery และ privacy ต้องทดสอบ browser จริงหลังต่อ API; full OIDC redirect ไม่อยู่ในการรับประกัน in-page draft
- Focus restoration/keyboard/back+dirty/race ระหว่าง navigation, narrow mutation policy และ a11y ต้องมี acceptance ของ implementation ไม่ถือว่า React Aria หรือ smoke นี้พิสูจน์ครบแล้ว
- แบบที่เลือกและข้อความ/ตำแหน่งสถานะต้องบันทึกจาก owner feedback ก่อนใช้เป็น UI acceptance ของ first slice
