import { Button } from '@d-contact/ui-react';

/** แถวเปล่าระหว่างโหลดรายการ ขนาดเท่าแถวตาราง */
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
 * โครงหน้ารายละเอียดระหว่างโหลด: ปุ่มกลับ หัวข้อ และสองคอลัมน์อยู่ตำแหน่งเดียวกับของจริง
 * เนื้อหาจริงจึงไม่กระโดดเมื่อโหลดเสร็จ
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
