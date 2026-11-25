import { Button } from '@d-contact/ui-react';

/** empty rows while the list loads, the same size as table rows */
export function ListSkeleton({ label, rows = 5 }: { label: string; rows?: number }) {
  return (
    <div className="qm-skeleton" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className="qm-skeleton-row" />
      ))}
    </div>
  );
}

/**
 * detail page skeleton while loading: the back button, heading and two columns are in the same positions as the real page
 * so the real content does not jump when loading finishes
 */
export function EditorSkeleton({
  label,
  backLabel,
  onBack,
}: {
  label: string;
  backLabel: string;
  onBack: () => void;
}) {
  return (
    <main className="qm-root" aria-busy="true">
      <Button variant="ghost" onPress={onBack}>
        {backLabel}
      </Button>
      <div className="qm-head" role="status" aria-label={label}>
        <span className="qm-skeleton-bar qm-skeleton-title" />
        <span className="qm-skeleton-bar" />
      </div>
      <div className="qm-layout">
        <div className="qm-main">
          <section className="qm-card qm-skeleton-card" />
          <section className="qm-card qm-skeleton-card" />
        </div>
        <aside className="qm-aside">
          <section className="qm-card qm-skeleton-card" />
        </aside>
      </div>
    </main>
  );
}
