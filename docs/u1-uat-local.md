# ซ้อม deploy UAT บนเครื่องตัวเอง (`uat-local.sh`)

Authority: runbook `docs/u1-uat-deployment.md`, provisioning gate #508

`infra/uat/bin/uat-local.sh` รันขั้นเดียวกับ VM จริงบนเครื่องของผู้พัฒนา แล้วเปิด stack ค้างไว้ให้เดิน Console ใน browser
ได้จริง ใช้ซ้อมก่อน deploy ครั้งแรกและลองแก้ปัญหาโดยไม่ต้องมี VM

รองรับ macOS (Apple Silicon/Intel) + Docker Desktop และ Linux + Docker Engine — base image ทุกตัวที่ pin digest
เป็น multi-arch (มี `arm64`) จึง build/รันแบบ native บน Apple Silicon

## ลำดับที่ script ทำ

1. build image `api`/`ops`/`console`/`keycloak` จาก `HEAD` แล้ว push เข้า registry ในเครื่อง (`localhost:5055`)
   เพื่ออ้างด้วย digest เหมือน GHCR — รันซ้ำจะข้าม image ที่ build แล้วของ SHA เดิม
2. สร้าง `~/.dcontact-uat-local/uat.env` (secret สุ่ม, mode 600), cert ของ `uat.dcontact.test`
   และเพิ่ม `127.0.0.1 uat.dcontact.test` ใน `/etc/hosts` (ขอรหัสผ่าน sudo ครั้งแรก)
3. `uat-deploy.sh` ตัวจริง: `prepare` → `migrate` → `keycloak` → `deploy` → `smoke`
4. render fixture pack `uat-first-slice.v1` (U1.9) จาก `infra/uat/uat-provision.example.json` → `provision --check`
   → `provision` (U1.8) → สร้างบัญชี maker/reviewer ใน Keycloak (U1.6)
5. พิมพ์ URL และรหัสผ่านชั่วคราว (เก็บใน `~/.dcontact-uat-local/credentials.txt` mode 600)

## ใช้งาน

ต้องมี: Docker Desktop (แนะนำ memory 8 GB ขึ้นไป), Node 20, `openssl`, `curl` และพอร์ต 443/80 ว่าง
แนะนำ `brew install mkcert && mkcert -install` เพื่อให้ browser เชื่อ cert ทันที

```bash
bash infra/uat/bin/uat-local.sh up        # ครั้งแรกราว 10–20 นาที (build image)
bash infra/uat/bin/uat-local.sh status
bash infra/uat/bin/uat-local.sh logs api proxy
bash infra/uat/bin/uat-local.sh down      # ลบ stack, volume, registry และ ~/.dcontact-uat-local
```

เปิด URL ที่ script พิมพ์ (`https://uat.dcontact.test/?tenant=uat-local-…`) แล้ว login ด้วยบัญชี maker —
ครั้งแรกต้องตั้งรหัสผ่านใหม่และผูก authenticator app (TOTP) จากนั้นเดินตาม `docs/u1-uat-acceptance-checklist.md`
(ส่งตรวจด้วย maker, อนุมัติด้วย reviewer ใน browser อีกโปรไฟล์หรือหน้าต่าง private)

ถ้าไม่มี mkcert script สร้าง CA ของเครื่อง และพิมพ์คำสั่ง `security add-trusted-cert` ให้ — หรือกดยอมรับคำเตือนของ browser

## ต่างจาก VM จริงอย่างไร

| เรื่อง                    | บนเครื่อง                                                                        | VM จริง (#508)                              |
| ------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------- |
| registry                  | `localhost:5055` ในเครื่อง                                                       | GHCR                                        |
| cert                      | mkcert หรือ CA ของเครื่อง                                                        | cert จริงของ `UAT_HOST`                     |
| TLS key                   | mode 644 ในโฟลเดอร์ 700 (ไม่ต้อง sudo chown)                                     | `chown 10001:10001` + `chmod 400`           |
| allowlist                 | `127.0.0.1/32 172.16.0.0/12 192.168.65.0/24` (gateway ของ Docker/Docker Desktop) | gateway จริง + pool ของ Docker bridge       |
| smoke                     | Docker Desktop: bridge + `host.docker.internal`                                  | `--network host` + `127.0.0.1`              |
| UAT-L07 (พอร์ตภายในปิด)   | เตือนแต่ไม่หยุด — มักชนกับ service อื่นในเครื่อง เช่น dev stack (5433/3000/8080) | ต้อง PASS                                   |
| workflow `uat-preview`    | ไม่ใช้ (ไม่มี migration guard, backup, deployment record)                         | ใช้                                         |

ผลบนเครื่องจึงไม่ใช่หลักฐานของ provisioning gate หรือ acceptance gate — ใช้หาปัญหาก่อน deploy จริงเท่านั้น

## ปัญหาที่พบบ่อย

- proxy ตอบ 403: Caddy ไม่เห็น source IP อยู่ใน allowlist — ดู IP ใน `uat-local.sh logs proxy` แล้ว
  `down` และรันใหม่ด้วย `UAT_LOCAL_ALLOWED_CIDRS='127.0.0.1/32 <ช่วงที่เห็น>'`
- พอร์ต 5055 ถูกใช้: ตั้ง `UAT_LOCAL_REGISTRY_PORT` เป็นพอร์ตอื่น (5000 ชนกับ AirPlay Receiver ของ macOS)
- เปลี่ยนโค้ดแล้วอยากลองใหม่: commit แล้วรัน `up` อีกรอบ — SHA ใหม่ = build image ใหม่และ deploy ทับ
  (migration ต้อง additive เหมือนบน VM); ส่วน tenant/บัญชีไม่ provision ซ้ำ ถ้าต้องการเริ่มสะอาดให้ `down` ก่อน
