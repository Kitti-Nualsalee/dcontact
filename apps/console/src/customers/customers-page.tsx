import { useEffect, useState } from 'react';
import { useTranslation } from '@d-contact/i18n/react';
import { ConsoleShell, type ConsoleShellProps } from '../shell/console-shell.js';
import type { CustomersApi } from './api.js';
import { CustomerDirectory } from './directory.js';
import { parseCustomersRoute, customersHref } from './model.js';
import { CustomerProfileView } from './profile.js';
import './customers.css';

interface Props {
  api: CustomersApi;
  /** เปลี่ยนเมื่อ user/tenant/session เปลี่ยน — remount เพื่อทิ้งข้อมูลลูกค้าทั้งหมดของ identity เดิม */
  identityKey: string;
  onSignIn?: () => void;
  shell: Omit<ConsoleShellProps, 'appId' | 'children'>;
}

/** Customers (Console A): รายการ → โปรไฟล์เต็มหน้า; อ่านอย่างเดียว ไม่มี write control */
export function CustomersPage(props: Props) {
  return (
    <ConsoleShell {...props.shell} appId="customers">
      <CustomersSession key={props.identityKey} {...props} />
    </ConsoleShell>
  );
}

function CustomersSession({ api, shell, onSignIn }: Props) {
  const { t } = useTranslation('customers');
  const [route, setRoute] = useState(() => parseCustomersRoute(new URL(window.location.href)));

  useEffect(() => {
    const onPop = () => setRoute(parseCustomersRoute(new URL(window.location.href)));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  function go(contactId?: string) {
    window.history.pushState(null, '', customersHref(shell.tenantAlias, contactId));
    setRoute(contactId ? { contactId } : {});
    window.scrollTo?.({ top: 0 });
  }

  return (
    <main className="cu-root">
      <h1>{t('title')}</h1>
      <p className="cu-muted">{t('readOnly')}</p>
      {route.contactId === undefined ? (
        <CustomerDirectory api={api} onOpen={go} onSignIn={onSignIn} />
      ) : (
        <CustomerProfileView
          key={route.contactId ?? 'invalid'}
          api={api}
          contactId={route.contactId}
          onBack={() => go()}
          onOpen={go}
          onSignIn={onSignIn}
        />
      )}
    </main>
  );
}
