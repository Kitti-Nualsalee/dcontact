# @d-contact/i18n

ระบบภาษา TH/EN ของ `apps/console` และ `apps/workspace` ตาม [D1.5 #425](https://github.com/Kitti-Nualsalee/dcontact/issues/425)
(implementation: [D1.11 #450](https://github.com/Kitti-Nualsalee/dcontact/issues/450))

- react-i18next + typed keys (`CustomTypeOptions`) — key ที่ไม่มีใน catalog ตกที่ typecheck
- ลำดับภาษา: ผู้ใช้ (Keycloak `locale`) → tenant (`tenant_settings.locale`) → browser → `th`
- timezone: ผู้ใช้ (Keycloak `zoneinfo`) → tenant (`tenant_settings.timezone`) → `Asia/Bangkok` — ไม่ใช้เวลาเครื่อง
- formatter กลาง: `th` ปี พ.ศ. (`12 ก.ย. 2569 16:40`), `en` = en-GB (`12 Sep 2026 16:40`), 24 ชั่วโมง,
  relative time เฉพาะภายใน 24 ชั่วโมง
- สลับภาษาด้วย `changeLanguage` ไม่ reload; bundle ทั้งสองภาษาโหลดตั้งแต่เริ่ม
- ไม่แปลข้อความที่ผู้ใช้/ลูกค้าพิมพ์ และไม่จัดรูปแบบวันที่/ตัวเลขใน catalog

## ใช้ในแอป

```
src/i18n/
  locales/th/common.json   ต้นแบบของ typed keys
  locales/en/common.json
  resources.ts             import ทั้งสองภาษา (ไม่ lazy)
  i18next.d.ts             CustomTypeOptions
  index.ts                 appI18n = createI18n(...)
```

```tsx
// ครอบภายใต้ AuthProvider ครั้งเดียว — ตำแหน่งใน tree ต้องคงที่ทั้งก่อนและหลัง login
<SessionLocaleProvider i18n={appI18n} session={{ claims, accessToken, apiBaseUrl, issuer }}>
  {children}
</SessionLocaleProvider>
```

```tsx
const { t } = useTranslation(); // t('language.label')
const { locale, setLocale, formatters } = useLocale();
formatters.dateTime(interaction.startedAt); // ตาม locale + timezone ของผู้ใช้
await setLocale('en'); // สลับทันที แล้วบันทึกลง Keycloak ด้วย token ของผู้ใช้เอง
```

key convention: namespace ตามแอป/หน้าจอ (`common`, `journeys`, `workspace`) และ key รูป
`<หมวด>.<สิ่งของ>.<การกระทำ>` เช่น `journeys.list.create`; plural ใช้ suffix ของ i18next
(`_other` ในภาษาไทย, `_one`/`_other` ในภาษาอังกฤษ)

## ตรวจความครบของ catalog

```bash
pnpm --filter @d-contact/console i18n:check   # dc-i18n-check src/i18n/locales
pnpm test:d1-i18n                             # ทั้งหมดของ D1.11 (CI)
```

typed keys จับได้แค่ key ที่ขาดจาก catalog ไทย `dc-i18n-check` จับ key ที่ขาดจากภาษาใดภาษาหนึ่ง
รวมถึงไฟล์ namespace ที่ขาดและข้อความว่าง — exit 1 ให้ CI ล้ม

## Keycloak

- `internationalizationEnabled` + `supportedLocales: [th, en]` + `defaultLocale: th` (realm JSON และ
  `pnpm infra:identity:locale` สำหรับ realm ที่ import ไปแล้ว)
- attribute `zoneinfo` ใน user profile (ผู้ใช้เห็นได้ แก้ได้เฉพาะ admin) — ประกาศโดยสคริปต์เดียวกัน
- ผู้ใช้บันทึกภาษาผ่าน Account REST API (`{issuer}/account`) ด้วย access token ของตัวเอง
  API ของ D-Contact ไม่ถือสิทธิ์ admin ของ realm
- ค่า `locale` ใหม่จะอยู่ใน token หลัง renew ครั้งถัดไป ระหว่างนั้น provider คงภาษาที่ผู้ใช้เลือกไว้
