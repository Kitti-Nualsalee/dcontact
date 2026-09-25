/**
 * preview page ของ @d-contact/ui-react (D1.3: หน้า Vite ธรรมดา ไม่ใช้ Storybook)
 * ทุกข้อความผ่าน i18n (`preview` namespace) — ใช้เป็นหน้า axe/keyboard ของ D1.10 ทั้ง TH/EN
 */
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next, useTranslation } from 'react-i18next';
import '@d-contact/ui/tokens.css';
import {
  Badge,
  Button,
  Cell,
  Checkbox,
  Column,
  Dialog,
  DialogTrigger,
  Row,
  SearchField,
  Select,
  StatusChip,
  Switch,
  Tab,
  Table,
  TableBody,
  TableHeader,
  TabList,
  TabPanel,
  Tabs,
  TextField,
  ToastRegion,
  toastQueue,
  uiResources,
  type AgentStatus,
  type BadgeTone,
} from '../src/index.js';
import previewEn from './locales/en/preview.json' with { type: 'json' };
import previewTh from './locales/th/preview.json' with { type: 'json' };
import styles from './preview.module.css';

const initial = new URL(window.location.href).searchParams.get('lang') === 'en' ? 'en' : 'th';
const i18n = i18next.createInstance();
void i18n.use(initReactI18next).init({
  resources: {
    th: { ...uiResources.th, preview: previewTh },
    en: { ...uiResources.en, preview: previewEn },
  },
  lng: initial,
  fallbackLng: 'th',
  ns: ['ui', 'preview'],
  defaultNS: 'preview',
  interpolation: { escapeValue: false },
  initAsync: false,
});
document.documentElement.lang = initial;

const TONES: BadgeTone[] = ['success', 'attention', 'critical', 'info', 'neutral', 'accent'];
const STATUSES: AgentStatus[] = ['available', 'busy', 'acw', 'break', 'offline', 'cooldown'];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className={styles.section} aria-label={title}>
      <h2 className={styles.heading}>{title}</h2>
      <div className={styles.row}>{children}</div>
    </section>
  );
}

function Preview() {
  const { t, i18n: instance } = useTranslation('preview');
  const [name, setName] = useState('');
  const switchLanguage = (lng: 'th' | 'en') => {
    void instance.changeLanguage(lng);
    document.documentElement.lang = lng;
  };
  const queues = [
    { id: 'sales', waiting: 4, sla: '92%', tone: 'success' as const, status: 'ok' },
    { id: 'support', waiting: 11, sla: '78%', tone: 'attention' as const, status: 'warn' },
    { id: 'billing', waiting: 23, sla: '61%', tone: 'critical' as const, status: 'breach' },
  ];

  return (
    <main className={styles.page}>
      <header className={styles.top}>
        <div>
          <h1 className={styles.title}>{t('title')}</h1>
          <p className={styles.lede}>{t('lede')}</p>
        </div>
        <div role="group" aria-label={t('language')} className={styles.row}>
          <Button
            size="sm"
            variant={instance.language === 'th' ? 'primary' : 'secondary'}
            onPress={() => switchLanguage('th')}
          >
            ไทย
          </Button>
          <Button
            size="sm"
            variant={instance.language === 'en' ? 'primary' : 'secondary'}
            onPress={() => switchLanguage('en')}
          >
            English
          </Button>
        </div>
      </header>

      <Section title={t('sections.buttons')}>
        <Button variant="primary">{t('button.primary')}</Button>
        <Button>{t('button.secondary')}</Button>
        <Button variant="ghost">{t('button.ghost')}</Button>
        <Button variant="danger">{t('button.danger')}</Button>
        <Button size="sm">{t('button.small')}</Button>
        <Button isDisabled>{t('button.disabled')}</Button>
      </Section>

      <Section title={t('sections.fields')}>
        <TextField
          label={t('field.name')}
          description={t('field.nameHint')}
          value={name}
          onChange={setName}
          isRequired
          errorMessage={t('field.required')}
          maxLength={80}
          className={styles.field}
        />
        <SearchField
          label={t('field.search')}
          placeholder={t('field.searchPlaceholder')}
          className={styles.field}
        />
      </Section>

      <Section title={t('sections.select')}>
        <Select
          label={t('select.label')}
          className={styles.field}
          options={[
            { id: 'voice', label: t('select.voice') },
            { id: 'line', label: t('select.line') },
            { id: 'email', label: t('select.email') },
            { id: 'fax', label: t('select.fax'), isDisabled: true },
          ]}
        />
      </Section>

      <Section title={t('sections.toggles')}>
        <Checkbox>{t('toggle.consent')}</Checkbox>
        <Switch defaultSelected>{t('toggle.autoAnswer')}</Switch>
      </Section>

      <Section title={t('sections.table')}>
        <Table aria-label={t('table.label')} className={styles.table} selectionMode="single">
          <TableHeader>
            <Column isRowHeader>{t('table.queue')}</Column>
            <Column>{t('table.waiting')}</Column>
            <Column>{t('table.sla')}</Column>
            <Column>{t('table.status')}</Column>
          </TableHeader>
          <TableBody items={queues}>
            {(queue) => (
              <Row id={queue.id}>
                <Cell>{t(`table.${queue.id}`)}</Cell>
                <Cell>{queue.waiting}</Cell>
                <Cell>{queue.sla}</Cell>
                <Cell>
                  <Badge tone={queue.tone}>{t(`table.${queue.status}`)}</Badge>
                </Cell>
              </Row>
            )}
          </TableBody>
        </Table>
      </Section>

      <Section title={t('sections.badges')}>
        {TONES.map((tone) => (
          <Badge key={tone} tone={tone}>
            {t(`badge.${tone}`)}
          </Badge>
        ))}
        {STATUSES.map((status) => (
          <StatusChip key={status} status={status}>
            {t(`badge.${status}`)}
          </StatusChip>
        ))}
      </Section>

      <Section title={t('sections.tabs')}>
        <Tabs className={styles.tabs}>
          <TabList aria-label={t('tabs.label')}>
            <Tab id="overview">{t('tabs.overview')}</Tab>
            <Tab id="steps">{t('tabs.steps')}</Tab>
            <Tab id="history">{t('tabs.history')}</Tab>
          </TabList>
          <TabPanel id="overview">{t('tabs.overviewBody')}</TabPanel>
          <TabPanel id="steps">{t('tabs.stepsBody')}</TabPanel>
          <TabPanel id="history">{t('tabs.historyBody')}</TabPanel>
        </Tabs>
      </Section>

      <Section title={t('sections.dialog')}>
        <DialogTrigger>
          <Button>{t('dialog.open')}</Button>
          <Dialog
            title={t('dialog.title')}
            footer={(close) => (
              <>
                <Button onPress={close}>{t('dialog.cancel')}</Button>
                <Button variant="primary" onPress={close}>
                  {t('dialog.confirm')}
                </Button>
              </>
            )}
          >
            <p>{t('dialog.body')}</p>
          </Dialog>
        </DialogTrigger>
      </Section>

      <Section title={t('sections.toast')}>
        <Button
          onPress={() =>
            toastQueue.add(
              { title: t('toast.title'), description: t('toast.description'), tone: 'success' },
              { timeout: 5000 },
            )
          }
        >
          {t('toast.show')}
        </Button>
      </Section>
      <ToastRegion />
    </main>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('root element is required');
createRoot(root).render(
  <StrictMode>
    <I18nextProvider i18n={i18n}>
      <Preview />
    </I18nextProvider>
  </StrictMode>,
);
