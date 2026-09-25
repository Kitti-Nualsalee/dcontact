/**
 * D1.15 (#454): หน้าเดี่ยว `/dphone` ของ apps/workspace
 *
 * ใน D1 เป็นหน้าต่างที่แยกออกจาก Agent Workspace: ไม่มี SIP/WebRTC/WS ของตัวเอง ควบคุมสายของ working tab
 * ผ่าน BroadcastChannel (same-origin) จึงไม่ต้องใช้ token และไม่สร้างจุดรับงานที่สอง
 * การใช้เป็น iframe ในระบบภายนอก (auth แบบ popup, allowlist, postMessage API) เป็นงานของ map E1
 */
import { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslation } from '@d-contact/i18n/react';
import { useShellTokens } from '../shell/tokens.js';
import { createDphoneRemote, type DphoneView } from './dphone-bridge.js';
import { DphoneWidget, type DphoneSize } from './dphone-widget.js';
import './dphone.css';

type PageState = 'waiting' | 'no-host' | 'connected' | 'closed';

export function DphonePage() {
  const tokensReady = useShellTokens();
  const { t } = useTranslation('dphone');
  const { locale, setLocale } = useLocale();
  const [view, setView] = useState<DphoneView>();
  const [state, setState] = useState<PageState>('waiting');
  const [size, setSize] = useState<DphoneSize>('expanded');
  const remote = useRef<ReturnType<typeof createDphoneRemote>>(undefined);

  useEffect(() => {
    document.title = t('page.title');
  }, [t]);

  useEffect(() => {
    const connection = createDphoneRemote({
      onView: (next) => {
        setView(next);
        setState('connected');
      },
      onClosed: () => {
        setState('closed');
        window.close();
      },
    });
    remote.current = connection;
    const timeout = window.setTimeout(
      () => setState((current) => (current === 'waiting' ? 'no-host' : current)),
      3_000,
    );
    const bye = () => connection.close();
    window.addEventListener('pagehide', bye);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener('pagehide', bye);
      connection.close();
      remote.current = undefined;
    };
  }, []);

  // ภาษาตาม working tab — ผู้ใช้สลับภาษาใน Workspace แล้วหน้าต่างแยกเปลี่ยนตาม
  useEffect(() => {
    if (view && view.locale !== locale) void setLocale(view.locale);
  }, [locale, setLocale, view]);

  if (!tokensReady) return null;
  return (
    <main className="dp-page">
      {state === 'connected' && view ? (
        <DphoneWidget
          view={view}
          size={size}
          onSizeChange={setSize}
          onCommand={(command) => remote.current?.send(command)}
        />
      ) : (
        <p className="dp-page-message" role="status">
          {state === 'no-host'
            ? t('page.noHost')
            : state === 'closed'
              ? t('page.closed')
              : t('page.waiting')}
        </p>
      )}
    </main>
  );
}
