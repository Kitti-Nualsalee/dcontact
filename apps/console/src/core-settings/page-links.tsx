import { useShellPageNav } from '@d-contact/ui-react';
/** Console ใหม่กับ Navigation API รุ่นก่อนที่ยังไม่มี pages */
export function CorePageLinks({
  tenant,
  teams,
  t,
  onSelect,
}: {
  tenant?: string;
  teams: boolean;
  t: (key: string) => string;
  onSelect?: (pageId: string) => void;
}) {
  const hasPages = useShellPageNav();
  if (hasPages) return null;
  return (
    <nav aria-label={t('title')} className="core-settings__actions">
      {['organization', ...(teams ? ['teams'] : [])].map((page) => (
        <a
          key={page}
          href={`?view=core-settings&page=${page}${tenant ? `&tenant=${encodeURIComponent(tenant)}` : ''}`}
          onClick={(e) => {
            if (
              onSelect &&
              e.button === 0 &&
              !e.ctrlKey &&
              !e.metaKey &&
              !e.shiftKey &&
              !e.altKey
            ) {
              e.preventDefault();
              onSelect(page);
            }
          }}
        >
          {t(page === 'organization' ? 'profile' : 'team.title')}
        </a>
      ))}
    </nav>
  );
}
