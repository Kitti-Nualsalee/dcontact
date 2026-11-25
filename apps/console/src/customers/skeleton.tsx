import type { CSSProperties } from 'react';

/**
 * Skeleton the same size as the real thing (docs/ui-principles.md: Loading must not make the layout jump)
 * the status text is read aloud through `role=status`; the colored bars are decorative (`aria-hidden`)
 */
export function Skeleton({
  label,
  rows,
  kind = 'rows',
}: {
  label: string;
  rows: number;
  kind?: 'rows' | 'card';
}) {
  return (
    <div
      role="status"
      aria-busy="true"
      style={{ '--cu-rows': rows } as CSSProperties}
      className={kind === 'card' ? 'cu-skel cu-skel-card' : 'cu-skel'}
    >
      <span className="cu-sr">{label}</span>
      <div aria-hidden="true" className="cu-skel-bars">
        {Array.from({ length: rows }, (_, index) => (
          <span key={index} className="cu-skel-bar" />
        ))}
      </div>
    </div>
  );
}
