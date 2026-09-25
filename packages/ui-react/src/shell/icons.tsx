/** ไอคอนเส้นของแอปใน shell (ชุดเดียวกับ prototype D1.2) — id ที่ไม่รู้จักได้ไอคอนตาราง */
const PATHS: Record<string, string> = {
  'agent-workspace': 'M4 4h16v16h-16z M4 13h3l3 3h4l3 -3h3',
  'supervisor-workspace': 'M3 12h4l3 8l4 -16l3 8h4',
  journeys:
    'M3 19a2 2 0 1 0 4 0a2 2 0 1 0 -4 0 M17 5a2 2 0 1 0 4 0a2 2 0 1 0 -4 0 M11 19h5.5a3.5 3.5 0 0 0 0 -7h-8a3.5 3.5 0 0 1 0 -7h4.5',
  'contact-governance':
    'M12 3a12 12 0 0 0 8.5 3a12 12 0 0 1 -8.5 15a12 12 0 0 1 -8.5 -15a12 12 0 0 0 8.5 -3',
  settings:
    'M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0 -6 M4 12h2 M18 12h2 M12 4v2 M12 18v2 M6.3 6.3l1.4 1.4 M16.3 16.3l1.4 1.4 M6.3 17.7l1.4 -1.4 M16.3 7.7l1.4 -1.4',
  plus: 'M12 5l0 14 M5 12l14 0',
  search: 'M3 10a7 7 0 1 0 14 0a7 7 0 1 0 -14 0 M21 21l-6 -6',
  pin: 'M15 4.5l-4 4l-4 1.5l-1.5 1.5l7 7l1.5 -1.5l1.5 -4l4 -4z M9 15l-4.5 4.5',
  external: 'M12 6h-6a2 2 0 0 0 -2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-6 M11 13l9 -9 M15 4h5v5',
  fallback: 'M4 4h6v6h-6z M14 4h6v6h-6z M4 14h6v6h-6z M14 14h6v6h-6z',
};

export function ShellIcon({
  name,
  size = 20,
  filled = false,
}: {
  name: string;
  size?: number;
  filled?: boolean;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name] ?? PATHS.fallback} />
    </svg>
  );
}

/** ปุ่มตาราง 9 จุดของ launcher */
export function WaffleIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      {[5, 12, 19].flatMap((cy) =>
        [5, 12, 19].map((cx) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="2" />),
      )}
    </svg>
  );
}
