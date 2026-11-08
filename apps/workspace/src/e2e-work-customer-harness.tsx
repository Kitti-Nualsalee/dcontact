import { useState } from 'react';
import { WorkCustomerPanel } from './work-customer-panel.js';
import { createWorkCustomerApi } from './work-customer-api.js';
const api = createWorkCustomerApi((path, init) =>
  fetch(path, {
    ...init,
    headers: { ...init.headers, authorization: 'Bearer isolated-ui-fixture' },
  }),
);
/** ใช้เฉพาะ Vite mode e2e; ไม่มี SIP/media จำลองที่อ้างเป็นเสียงจริง */
export function E2eWorkCustomerHarness() {
  const [ready, setReady] = useState(true);
  const [work, setWork] = useState('11111111-1111-4111-8111-111111111111');
  return (
    <>
      <aside aria-label="Test controls">
        <button onClick={() => setReady(false)}>Pause fixture</button>
        <button onClick={() => setReady(true)}>Resume fixture</button>
        <button onClick={() => setWork('22222222-2222-4222-8222-222222222222')}>
          Switch work fixture
        </button>
      </aside>
      <main>
        <WorkCustomerPanel
          key={work}
          api={api}
          workId={work}
          leaseId="33333333-3333-4333-8333-333333333333"
          identityKey="fixture-actor"
          sessionReady={ready}
        />
      </main>
    </>
  );
}
