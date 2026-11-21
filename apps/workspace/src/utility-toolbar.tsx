/**
 * แถบเครื่องมือด้านขวาของ Workspace V3 เป็น toolbar แนวตั้งแบบ roving tabindex
 * (docs/ui-principles.md ข้อ 2 และ WAI-ARIA APG Toolbar pattern):
 * Tab เข้าแถบได้จุดเดียวแล้ว Tab ถัดไปออกจากแถบ ปุ่มภายในใช้ลูกศรขึ้น/ลง (วนรอบ), Home และ End
 * จุดที่ Tab เข้าคือปุ่มที่ focus ล่าสุดในแถบ ถ้ายังไม่เคย focus ใช้ปุ่มที่กดอยู่ (แท็บที่เปิด) หรือปุ่มแรก
 */
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export interface UtilityToolbarItem {
  id: string;
  label: string;
  icon: ReactNode;
  onPress: () => void;
  pressed?: boolean;
  expanded?: boolean;
}

export function UtilityToolbar({ label, items }: { label: string; items: UtilityToolbarItem[] }) {
  const [lastFocused, setLastFocused] = useState<string | null>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const tabStop =
    items.find((item) => item.id === lastFocused)?.id ??
    items.find((item) => item.pressed)?.id ??
    items[0]?.id;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = items.findIndex((item) => buttons.current.get(item.id) === event.target);
    if (index < 0) return;
    const last = items.length - 1;
    const next =
      event.key === 'ArrowDown'
        ? index === last
          ? 0
          : index + 1
        : event.key === 'ArrowUp'
          ? index === 0
            ? last
            : index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    buttons.current.get(items[next]!.id)?.focus();
  };

  return (
    <div
      className="aw-v3-utility"
      role="toolbar"
      aria-orientation="vertical"
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      {items.map((item) => (
        <button
          key={item.id}
          ref={(node) => {
            if (node) buttons.current.set(item.id, node);
            else buttons.current.delete(item.id);
          }}
          type="button"
          tabIndex={item.id === tabStop ? 0 : -1}
          aria-label={item.label}
          title={item.label}
          aria-pressed={item.pressed}
          aria-expanded={item.expanded}
          onFocus={() => setLastFocused(item.id)}
          onClick={item.onPress}
        >
          {item.icon}
        </button>
      ))}
    </div>
  );
}
