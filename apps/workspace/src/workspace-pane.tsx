/**
 * Agent Workspace V3 (mockups/d-contact-agent-workspace-v3.html): ส่วนประกอบของ layout แบบแผงที่ปรับขนาดได้
 * — เส้นแบ่งแผง (ลาก, ปุ่มลูกศร, ดับเบิลคลิกคืนค่า) และไอคอนเส้นของ Workspace
 * ความกว้างที่ผู้ใช้ตั้งเก็บใน localStorage ของ browser เท่านั้น เป็นความสะดวกต่อผู้ใช้ ไม่ใช่สถานะงาน
 */
import { useState, type PointerEvent as ReactPointerEvent } from 'react';

export interface PaneWidth {
  value: number;
  min: number;
  max: number;
  initial: number;
  set: (next: number) => void;
}

/** ความกว้างของแผงที่จำไว้ต่อ browser — อ่าน/เขียนไม่ได้ (private mode) ใช้ค่าเริ่มต้น */
export function usePaneWidth(key: string, initial: number, min: number, max: number): PaneWidth {
  const clamp = (n: number) => Math.min(max, Math.max(min, Math.round(n)));
  const [value, setValue] = useState(() => {
    try {
      const stored = Number(localStorage.getItem(key));
      return stored ? clamp(stored) : initial;
    } catch {
      return initial;
    }
  });
  const set = (next: number) => {
    const width = clamp(next);
    setValue(width);
    try {
      localStorage.setItem(key, String(width));
    } catch {
      // ดูด้านบน — ไม่จำค่าได้ก็ใช้ต่อในหน้านี้
    }
  };
  return { value, min, max, initial, set };
}

const STEP = 16;

/**
 * เส้นแบ่งแผงแนวตั้ง — `edge="end"` = แผงอยู่ด้านขวาของเส้น (ลากไปทางซ้ายแผงกว้างขึ้น)
 */
export function PaneSplitter({
  label,
  hint,
  width,
  edge = 'start',
}: {
  label: string;
  hint: string;
  width: PaneWidth;
  edge?: 'start' | 'end';
}) {
  const direction = edge === 'end' ? -1 : 1;
  const [drag, setDrag] = useState<{ x: number; width: number }>();
  return (
    <div
      className="aw-v3-split"
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuenow={width.value}
      aria-valuemin={width.min}
      aria-valuemax={width.max}
      tabIndex={0}
      title={hint}
      onDoubleClick={() => width.set(width.initial)}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          width.set(width.value + (event.key === 'ArrowRight' ? STEP : -STEP) * direction);
        } else if (event.key === 'Home') {
          event.preventDefault();
          width.set(width.initial);
        }
      }}
      onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        setDrag({ x: event.clientX, width: width.value });
      }}
      onPointerMove={(event) => {
        if (drag) width.set(drag.width + (event.clientX - drag.x) * direction);
      }}
      onPointerUp={(event) => {
        event.currentTarget.releasePointerCapture(event.pointerId);
        setDrag(undefined);
      }}
      onPointerCancel={() => setDrag(undefined)}
    />
  );
}

/** ไอคอนเส้น (Tabler outline, MIT) ที่ Workspace ใช้ — ไม่ส่งความหมายด้วยไอคอนอย่างเดียว ต้องมีข้อความกำกับ */
const PATHS = {
  phone:
    'M5 4h4l2 5l-2.5 1.5a11 11 0 0 0 5 5l1.5 -2.5l5 2v4a2 2 0 0 1 -2 2a16 16 0 0 1 -15 -15a2 2 0 0 1 2 -2',
  notes:
    'M14 3v4a1 1 0 0 0 1 1h4 M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z M9 13h6 M9 17h6',
  details: 'M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0 M12 8h.01 M11 12h1v4h1',
  events: 'M12 8l0 4l2 2 M3.05 11a9 9 0 1 1 .5 4m-.5 5v-5h5',
  readiness:
    'M4 14v-3a8 8 0 1 1 16 0v3 M4 14a2 2 0 0 1 2 -2h1a2 2 0 0 1 2 2v3a2 2 0 0 1 -2 2h-1a2 2 0 0 1 -2 -2v-3z M15 14a2 2 0 0 1 2 -2h1a2 2 0 0 1 2 2v3a2 2 0 0 1 -2 2h-1a2 2 0 0 1 -2 -2v-3z',
  panel: 'M4 6a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2z M15 4v16',
  user: 'M8 7a4 4 0 1 0 8 0a4 4 0 0 0 -8 0 M6 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2',
} as const;

export type PaneIconName = keyof typeof PATHS;

export function PaneIcon({ name, size = 18 }: { name: PaneIconName; size?: number }) {
  return (
    <svg
      className="aw-v3-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
