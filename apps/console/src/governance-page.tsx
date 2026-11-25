/**
 * #658: the Governance page in ConsoleShell — holds the page location above the shell so the submenu
 * (Overview / Exceptions / Policies / Audit) highlights the page matching the content and switches pages without reloading
 * flag off/API down = the shell returns the content without wrapping it and the page uses its own original tabs
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
        // an unknown id (server newer than Console) = do nothing; the link href still goes to the page
        if (section) go({ ...location, section });
      }}
    >
      <GovernanceConsole api={api} cg5Api={cg5Api} viewer={viewer} location={location} go={go} />
    </ConsoleShell>
  );
}
