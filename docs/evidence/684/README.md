# หลักฐาน Console Home — #684

เป้าหมายคือหน้า Home ตามภาพที่ผู้ใช้เลือกแบบที่ 2 เมื่อ 15 ตุลาคม 2026 โดยเป็น default หลัง login แทน Journeys และแสดงทางเข้าที่ผู้ใช้มีสิทธิ์เท่านั้น

## ภาพ

- `selected-home-2.jpg`: ภาพที่ผู้ใช้เลือก (ปรับเป็น 1440×1024)
- `home-th.jpg`, `home-en.jpg`: หน้าจอจริงจาก Codex In-app Browser, 1440×1024
- `home-mobile.jpg`: หน้าจอจริง 390×844
- `comparison.jpg`, `comparison-detail.jpg`: ภาพต้นแบบซ้าย เทียบ implementation ขวา
- ผลตรวจภาพและข้อแตกต่างที่ยอมรับ: [design-qa.md](../../../design-qa.md)

ภาพใช้ข้อมูลสังเคราะห์ admin ของ demo ไม่มี token หรือข้อมูลลูกค้าจริง

## ผลการตรวจ

| ชุดตรวจ                                           | คำสั่ง                                                                                            | ผล                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------- |
| Console unit (รวม auth/callback/sign-out/default) | `pnpm --filter @d-contact/console test`                                                           | 50 ผ่าน                     |
| Registry role/plan/pins                           | `pnpm --filter @d-contact/api exec tsx --test src/navigation-registry.test.ts`                    | 12 ผ่าน                     |
| ui-react รวม navigation model                     | `pnpm --filter @d-contact/ui-react test`                                                          | 13 ผ่าน พร้อม typecheck/CSS |
| Navigation API บน Postgres/RLS จริง               | `pnpm --filter @d-contact/api exec tsx --test src/navigation-api.integration.ts`                  | 8 ผ่าน                      |
| Home + shell browser                              | `pnpm --filter @d-contact/console test:e2e --project=chromium e2e/home.spec.ts e2e/shell.spec.ts` | 20 ผ่าน                     |
| Console production build                          | `pnpm --filter @d-contact/console build`                                                          | ผ่าน                        |
| API/Workspace types                               | `pnpm --filter @d-contact/api typecheck`, `pnpm --filter @d-contact/workspace typecheck`          | ผ่าน                        |
| Catalog TH/EN                                     | `pnpm --filter @d-contact/console i18n:check`, `pnpm --filter @d-contact/workspace i18n:check`    | ผ่าน                        |
| UI literals/CSS                                   | `pnpm --filter @d-contact/console i18n:literals`, `pnpm --filter @d-contact/console lint:css`     | ผ่าน                        |

Integration tests ใช้ Postgres 16 container แยกที่ port 55484 สร้าง migrations และ RLS จาก repository เดียวกันก่อนทดสอบ แล้วหยุด container หลังจบ

Browser tests ตรวจ default Home, deep link และ back, keyboard focus/Tab, TH/EN, axe ไม่มี serious/critical, role/entitlement ที่ต่างกัน, หมุดว่าง, API รุ่นเก่าที่ไม่มี Home/areas, shell flag ปิด, API failure/retry, empty และจอแคบทั้ง flag เปิด/ปิด

## ขอบเขตหลักฐาน

Local preview ใช้โหมด e2e กับข้อมูลสังเคราะห์สำหรับตรวจหน้าตาและลิงก์ ส่วน production ใช้ OIDC และ Navigation API จริงตามเดิม ยังไม่ได้ deploy บน UAT และไม่ได้รัน login กับ Keycloak บน UAT สำหรับ patch นี้
