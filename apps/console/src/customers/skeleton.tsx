import type { CSSProperties } from 'react';

/**
 * Skeleton ขนาดเท่าของจริง (docs/ui-principles.md: Loading ต้องไม่ทำให้ layout กระโดด)
 * ข้อความสถานะอ่านออกเสียงได้ผ่าน `role=status`; แท่งสีเป็นของตกแต่ง (`aria-hidden`)
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
