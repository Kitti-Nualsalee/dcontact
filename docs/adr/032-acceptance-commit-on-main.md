# ADR 032: Acceptance marker ออกจาก commit ที่อยู่บน main แล้ว และรัน chain ใน dispatch เดียว

- **สถานะ:** Accepted
- **วันที่:** 2026-10-01
- **ที่มา:** ผู้ใช้ตัดสิน 2026-10-01 ([#580](https://github.com/Kitti-Nualsalee/dcontact/issues/580)) ต่อจาก
  [#559](https://github.com/Kitti-Nualsalee/dcontact/issues/559) และ [#572](https://github.com/Kitti-Nualsalee/dcontact/issues/572)

## บริบท

acceptance ของ phase หลัง ๆ ต้องเห็น marker ของ phase ก่อนหน้าบน SHA เดียวกัน (REG01) หลัง #559/#572
REG ไม่รัน acceptance ซ้อนแล้ว แต่ตรวจ marker จาก CI artifact ทำให้ต้องรันเป็น chain:

```
S1 → J2 + CG4 → J3 → J5
```

marker ทุกตัวมีเงื่อนไขว่า commit ที่ทดสอบต้อง **เป็น HEAD ของ main ตอน run** (`HEAD == origin/main ==
expectedCommitSha`, blocker `NOT_FINAL_MAIN_SHA`) chain ทั้งเส้นใช้เวลาราว 5–6 ชม. แต่ main รับ commit
จากหลาย session ราวทุก 30–60 นาที วันที่ 2026-10-01 chain หลุด 4 รอบติด (`0cb9392`, `25b6381`, `f8bc7ab`,
`0d09a0c`) แม้ S1 บน `25b6381` จะผ่านและได้ marker ครบ เพราะ J2/CG4 ที่สั่งต่อรันบน HEAD ใหม่ที่ไม่มี S1 marker

ทางเลือกที่พิจารณา:

| ทาง | ข้อดี | ข้อเสีย |
|---|---|---|
| ก. ล็อก main ระหว่างรัน chain | ไม่ต้องแก้อะไร | ต้องหยุดทุก session ราว 6 ชม. ทุกครั้งที่ต้องการ marker |
| **ข. marker จาก commit ที่อยู่บน main + chain ใน dispatch เดียว** | main ไม่ต้องหยุด; ทุก job ใช้ SHA เดียวโดยโครงสร้าง | เปลี่ยนความหมายของ marker (ดูผลที่ตามมา) |
| ค. chain ใน dispatch เดียว แต่คงกติกา HEAD | ไม่ต้องสั่งทีละขั้น | ยังหลุดถ้ามีใคร merge ระหว่าง chain |

## การตัดสินใจ

เลือกทาง **ข**

1. **marker ออกได้เมื่อ commit อยู่บน main แล้ว:** เงื่อนไข `HEAD == origin/main` เปลี่ยนเป็น
   `git merge-base --is-ancestor <commit> origin/main` (`scripts/acceptance-main-proof.mjs`) ส่วนเงื่อนไขอื่นยังเหมือนเดิมทุกข้อ:
   - commit ตรง `expectedCommitSha` ของ run (= `GITHUB_SHA`)
   - ref เป็น `refs/heads/main` และไม่ใช่ PR run
   - checkout สะอาด
   - evidence อยู่ใน immutable CI artifact

   manifest บันทึก `commitOnMain` (S1 ไว้ที่ top level ส่วน J3/J5/CG4 ไว้ใน `refProof`) validator ตรวจ field นี้แทน
   `commitSha === finalMainSha` ส่วน `finalMainSha` ยังบันทึกไว้เป็นข้อมูลว่าตอน run main อยู่ที่ไหน
2. **`acceptance=chain`:** `gh workflow run CI --ref main -f acceptance=chain` รัน S1 → J2 + CG4 → J3 → J5
   ต่อกันด้วย `needs:` ใน run เดียว ทุก job checkout `GITHUB_SHA` เดียวกัน job ถัดไปดึง evidence ของ job ก่อนหน้า
   จาก artifact ของ run เดียวกันผ่านกลไก provenance เดิมของ #559 ส่วน J3 เรียก `cxa-j3-acceptance.yml`
   ผ่าน `workflow_call` และการสั่งทีละตัวยังใช้ได้เหมือนเดิม
3. S1 เลิกใช้ `cancel-in-progress` เพื่อไม่ให้ S1 ที่สั่งทีหลังไปตัด S1 ของ chain ที่กำลังรัน

## ผลที่ตามมา

- marker ยืนยันว่า "commit X ผ่าน acceptance" ไม่ได้ยืนยันว่า "HEAD ปัจจุบันของ main ผ่าน" ถ้าต้องการสถานะของ HEAD
  ต้องดู marker ของ commit นั้นเอง commit ที่ merge ทีหลังไม่ได้รับ marker ไปด้วย
- REG ยังต้องเห็น marker บน **SHA เดียวกัน** เหมือนเดิม จึงไม่มีการผสม evidence ข้าม commit
- commit ที่ยังไม่ merge (PR หรือ branch) ไม่ได้ marker เพราะไม่ใช่ ancestor ของ `origin/main`
- chain ใช้ runner ต่อเนื่องราว 5–6 ชม. แต่แต่ละ job อยู่ใต้ timeout ของตัวเอง
  (S1 ไม่กำหนด, J2 150, CG4 90, J3 90, J5 120 นาที)
