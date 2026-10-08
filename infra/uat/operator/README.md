# ขั้นตอน operator สำหรับ UAT 3 VM (#537)

สคริปต์ถูกออกแบบให้รัน `--check` ก่อน แล้วจึง `--apply` ด้วย `sudo` บน VM ที่ระบุ ทุกสคริปต์ตรวจ IP/สภาพเดิมและหยุดเมื่อไม่ตรงกับ ADR-030 ห้ามนำ credential bundle ไปใส่ GitHub issue, chat หรือ Git

## VM3 — PostgreSQL 15.4 (`192.168.102.113`)

คัดลอก `vm3-bootstrap-uat.sh` และ `vm3-pg-hba-uat.sh` ไปที่ `/home/osdadmin/` แล้วรันตามลำดับนี้บน VM3:

```bash
sudo bash /home/osdadmin/vm3-bootstrap-uat.sh --check
sudo bash /home/osdadmin/vm3-pg-hba-uat.sh --check
sudo bash /home/osdadmin/vm3-bootstrap-uat.sh --apply
sudo bash /home/osdadmin/vm3-pg-hba-uat.sh --apply
```

bootstrap จะสร้าง role UAT 5 ตัวและ database 2 ตัว โดยไม่แตะ role/database เดิม รหัสผ่านสุ่มใหม่อยู่ใน `/home/osdadmin/dcontact-uat-db-credentials.env` (mode 600) เท่านั้น ต้องส่งต่อไฟล์นี้ไป VM2 ผ่าน SSH เพื่อประกอบ `uat.env` แล้วลบจาก VM3 หลังตรวจว่าค่าบน VM2 ใช้งานได้ ห้ามแสดงเนื้อหาไฟล์ใน log หรือ terminal transcript ที่แชร์ต่อ `dcontact_uat_owner` เป็นบัญชีเฉพาะงาน migrate/backup จึงเป็น `BYPASSRLS` แต่ยังเป็น `NOSUPERUSER`; API ใช้ `dcontact_app` ซึ่งต้องเป็น `NOBYPASSRLS` เสมอ

### ซ่อม VM3 ที่ bootstrap ไปแล้ว

ถ้า `uat-deploy.sh backup` รายงานว่า `pg_dump` ถูก FORCE RLS ปฏิเสธ ให้คัดลอก `vm3-uat-backup-role.sh` ไปที่ `/home/osdadmin/` แล้วรันบน VM3 ก่อน retry backup:

```bash
sudo bash /home/osdadmin/vm3-uat-backup-role.sh --check
sudo bash /home/osdadmin/vm3-uat-backup-role.sh --apply
sudo bash /home/osdadmin/vm3-uat-backup-role.sh --check
```

สคริปต์ยอมแก้เฉพาะ `dcontact_uat_owner` จาก `NOBYPASSRLS` เป็น `BYPASSRLS` หลังยืนยันว่าเป็น owner ของ `dcontact_uat`, ไม่ใช่ superuser และ `dcontact_app` ยังเป็น `NOBYPASSRLS`; ไม่แตะ role/database อื่นหรือ password ใด ๆ

สคริปต์ `pg_hba` สำรองไฟล์ก่อนแก้ แทรก 4 กฎก่อน broad `md5` เดิม ตรวจ `pg_hba_file_rules.error` และ `pg_reload_conf()` โดยไม่ restart PostgreSQL ถ้าตรวจหลังแก้ไม่ผ่าน จะคืนไฟล์สำรองและ reload กลับ

หลังรันให้แจ้งเฉพาะ `CHECK ผ่าน`/`APPLY ผ่าน` หรือ error ที่ไม่มี secret เพื่อให้ตรวจจากระยะไกลซ้ำได้

## VM2 — Docker stack (`192.168.102.112`)

หลัง `vm3-bootstrap-uat.sh --apply` สำเร็จ ให้รัน `vm2-install-uat-env.sh` จากเครื่อง operator ที่ SSH เข้า VM2/VM3 ได้ สคริปต์ใช้ `scp -3` ส่ง credential bundle ผ่านหน่วยความจำของเครื่อง operator โดยไม่ต้องมี SSH key ระหว่าง VM และไม่พิมพ์เนื้อหาไฟล์:

```bash
chmod 700 infra/uat/operator/vm2-install-uat-env.sh
bash infra/uat/operator/vm2-install-uat-env.sh
```

คำสั่ง Python สร้าง secret เฉพาะ Keycloak และ object storage เพิ่มเอง, สร้าง tenant UUID, ตรวจ bundle แล้วลบ bundle บน VM2 อัตโนมัติ ผลที่คาดคือ `600 osdadmin:osdadmin /opt/dcontact-uat/uat.env` โดยห้ามใช้ `cat`, `less` หรือส่งเนื้อหาไฟล์ออกจาก VM หลังยืนยันว่า VM2 ใช้งานได้ จึงลบ bundle ที่ VM3:

```bash
# รันจาก VM3 หลัง VM2 ยืนยันว่า uat.env สร้างสำเร็จ
shred -u /home/osdadmin/dcontact-uat-db-credentials.env
```

## VM1 — nginx edge (`192.168.102.114`)

คัดลอก `vm1-nginx-uat.sh` ไปที่ `/home/osdadmin/dcontact-vm1-nginx-uat.sh` แล้วรันบน VM1:

```bash
sudo bash /home/osdadmin/dcontact-vm1-nginx-uat.sh --check
sudo bash /home/osdadmin/dcontact-vm1-nginx-uat.sh --apply
```

สคริปต์ตรวจ wildcard cert/key ที่มีอยู่, เพิ่มเฉพาะ `dcontact-uat.osd.co.th.conf`, ตรวจ `nginx -t` ก่อน reload และไม่เขียนไฟล์ของ vhost อื่น รวมถึงเปลี่ยน permission ของ `/etc/nginx`, `conf.d`, `sites-enabled`, `ssl` จาก `777` เป็น `755` และ key เป็น `600` เพราะ directory/file ที่เปิดให้ทุก user เขียนได้ทำให้ key และ nginx config ถูกเปลี่ยนโดยผู้ใช้ทั่วไปบน VM1 ได้

เมื่อ E1.16 เปิด SIP WebSocket ให้ใช้ `vm1-nginx-websocket-uat.sh` เพื่อให้ nginx ส่ง `Upgrade`/`Connection` ผ่าน generic proxy ไป Caddy ใน release และลบ `/sip-ws` override ชั่วคราวที่ชี้ไป FreeSWITCH โดยตรง สคริปต์ยอมแก้เฉพาะ config UAT ที่ตรงกับ state เก่าที่รู้จัก, สำรองไฟล์ก่อนแก้, `nginx -t` ก่อน reload และคืน config เมื่อ test ไม่ผ่าน:

```bash
sudo bash /home/osdadmin/vm1-nginx-websocket-uat.sh --check
sudo bash /home/osdadmin/vm1-nginx-websocket-uat.sh --apply
sudo bash /home/osdadmin/vm1-nginx-websocket-uat.sh --check
```

หาก VM2 ยังไม่เปิด Caddy ที่ `192.168.102.112:8080` ชื่อ UAT จะตอบ `502` ชั่วคราว แต่ vhost อื่นไม่ควรเปลี่ยน หลังเปิด stack ให้ตรวจ HTTPS ผ่าน hosts mapping `dcontact-uat.osd.co.th → 192.168.102.114` บนเครื่องผู้ทดสอบ
