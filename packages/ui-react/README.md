# @d-contact/ui-react

component layer ร่วมของ `apps/console` และ `apps/workspace` — ดู [ADR-028](../../docs/adr/028-frontend-component-layer.md)
(D1.10 [#449](https://github.com/Kitti-Nualsalee/dcontact/issues/449))

- React Aria Components รับผิดชอบ keyboard, focus และ ARIA
- CSS Modules อ้าง `var(--dc-*)` จาก `@d-contact/ui/tokens.css` เท่านั้น (stylelint บังคับ)
- ข้อความของ component อยู่ใน namespace `ui` ของ react-i18next

| กลุ่ม  | component                                                                                                                                                                                   |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ฟอร์ม  | `Button`, `TextField`, `SearchField`, `Select`, `Checkbox`, `Switch`                                                                                                                        |
| แสดงผล | `Table` (+ `TableHeader`, `Column`, `TableBody`, `Row`, `Cell`), `Badge`, `StatusChip`, `Tabs` (+ `TabList`, `Tab`, `TabPanel`), `Dialog` (+ `DialogTrigger`), `ToastRegion` / `toastQueue` |
| Shell  | `AppShell`, `Rail`, `AppLauncher`, `SubNav` — มาใน D1.13 (#452)                                                                                                                             |

## ใช้ในแอป

```ts
// entry ของแอป — token โหลดครั้งเดียว
import '@d-contact/ui/tokens.css';
```

```ts
// resources ของ i18n (D1.11) ต้องรวม namespace `ui`
import { uiResources } from '@d-contact/ui-react';
const resources = {
  th: { ...uiResources.th, common: commonTh },
  en: { ...uiResources.en, common: commonEn },
};
```

```tsx
import { Button, Dialog, DialogTrigger, toastQueue, ToastRegion } from '@d-contact/ui-react';

<DialogTrigger>
  <Button>{t('journeys.publish.open')}</Button>
  <Dialog
    title={t('journeys.publish.title')}
    footer={(close) => <Button onPress={close}>…</Button>}
  >
    …
  </Dialog>
</DialogTrigger>;

toastQueue.add({ title: t('journeys.saved'), tone: 'success' }, { timeout: 5000 });
// วาง <ToastRegion /> หนึ่งครั้งที่ root ของแอป
```

ข้อความของงาน (label, ปุ่ม) ส่งเข้ามาทาง props จาก catalog ของแอปเสมอ — ห้าม hardcode

## Shell (D1.13)

```tsx
const nav = useShellNavigation({ apiBaseUrl, accessToken, currentHost: 'console', hostOrigins, tenantAlias, translate: t });
if (nav.status === 'legacy') return <LegacyPage />; // flag ปิด หรือ API ล้มเหลว
if (nav.status === 'loading') return <Loading />;   // ตัดสินก่อน mount หน้า — ห้ามสลับกลางคัน
return <ShellFrame {...nav} onTogglePin={nav.togglePin} currentAppId="journeys" … >{page}</ShellFrame>;
```

- รายการแอปมาจาก `GET /api/v1/me/navigation` (server คัดตาม role/plan แล้ว) — shell ไม่ซ่อนหรือเดาสิทธิ์เอง
- flag `ui.shell.v2` (`features.shellV2`) ตัดสินครั้งเดียวต่อการโหลดหน้า เพราะ Workspace ที่ remount จะตัดสาย/WS
- ลิงก์ข้าม host app เปิดแท็บใหม่ด้วย path จาก registry + tenant alias เท่านั้น (ห้าม PII ใน URL)
- แอปโหลด `@d-contact/ui/tokens.css` แบบ dynamic เฉพาะตอนเปิด shell — หน้าเดิมตอนปิด flag จึงไม่เปลี่ยน
- preview: `?view=shell` (Navigation API จำลอง)

## คำสั่ง

```bash
pnpm --filter @d-contact/ui-react dev        # preview page http://localhost:5190 (?lang=en)
pnpm --filter @d-contact/ui-react build      # dist/ (JS + d.ts + CSS Modules) + build preview
pnpm --filter @d-contact/ui-react test       # stylelint + typecheck
pnpm --filter @d-contact/ui-react test:e2e   # axe TH/EN + keyboard ของทุก component (Playwright)
```

`dist/` ส่ง CSS Modules แบบยังไม่ bundle ให้ Vite ของแอปประมวลผลเอง — ต้อง `build` ก่อนแอปที่ใช้จะ typecheck ได้
