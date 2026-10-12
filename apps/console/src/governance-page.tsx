/**
 * #658: หน้า Governance ใน ConsoleShell — ถือตำแหน่งของหน้าเหนือ shell เพื่อให้เมนูย่อย
 * (ภาพรวม / Exceptions / Policies / Audit) ไฮไลต์ตรงกับเนื้อหาและเปลี่ยนหน้าแบบไม่โหลดใหม่
 * flag ปิด/API ล้ม = shell ส่งเนื้อหากลับโดยไม่ครอบ และหน้าใช้แท็บเดิมของตัวเอง
 */
import { ConsoleShell, type ConsoleShellProps } from './shell/console-shell.js';
import { GovernanceConsole, useGovernanceLocation } from './governance-console.js';
import type { GovernanceApi } from './governance-api.js';
import type { Cg5ConsoleApi } from './cg5-console-api.js';
import type { GovernanceLocation, GovernanceViewer } from './governance-model.js';

export type GovernancePageShellProps = Omit<
  ConsoleShellProps,
  'appId' | 'pageId' | 'onPageSelect' | 'children'
>;

const PAGE_SECTIONS: readonly GovernanceLocation['section'][] = [
  'overview',
  'exceptions',
  'policies',
  'audit',
];

export function GovernancePage({
  shell,
  api,
  cg5Api,
  viewer,
  initialLocation,
}: {
  shell: GovernancePageShellProps;
  api: GovernanceApi;
  cg5Api: Cg5ConsoleApi;
  viewer: GovernanceViewer;
  initialLocation: GovernanceLocation;
}) {
  const [location, go] = useGovernanceLocation(initialLocation);
  return (
    <ConsoleShell
      {...shell}
      appId="contact-governance"
      pageId={location.section}
      onPageSelect={(pageId) => {
        const section = PAGE_SECTIONS.find((candidate) => candidate === pageId);
        // id ที่ไม่รู้จัก (server ใหม่กว่า Console) = ไม่ทำอะไร ลิงก์ href ยังพาไปหน้าได้
        if (section) go({ ...location, section });
      }}
    >
      <GovernanceConsole api={api} cg5Api={cg5Api} viewer={viewer} location={location} go={go} />
    </ConsoleShell>
  );
}
