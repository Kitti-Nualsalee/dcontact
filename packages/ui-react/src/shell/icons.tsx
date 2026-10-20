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
  'core-settings':
    'M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0 -6 M4 12h2 M18 12h2 M12 4v2 M12 18v2 M6.3 6.3l1.4 1.4 M16.3 16.3l1.4 1.4 M6.3 17.7l1.4 -1.4 M16.3 7.7l1.4 -1.4',
  'area-settings':
    'M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0 -6 M4 12h2 M18 12h2 M12 4v2 M12 18v2 M6.3 6.3l1.4 1.4 M16.3 16.3l1.4 1.4 M6.3 17.7l1.4 -1.4 M16.3 7.7l1.4 -1.4',
  plus: 'M12 5l0 14 M5 12l14 0',
  search: 'M3 10a7 7 0 1 0 14 0a7 7 0 1 0 -14 0 M21 21l-6 -6',
  pin: 'M15 4.5l-4 4l-4 1.5l-1.5 1.5l7 7l1.5 -1.5l1.5 -4l4 -4z M9 15l-4.5 4.5',
  external: 'M12 6h-6a2 2 0 0 0 -2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-6 M11 13l9 -9 M15 4h5v5',
  // #651: ไอคอนของพื้นที่งานบน rail (Tabler outline, MIT) — key = `area-<id>` ตาม NAVIGATION_AREAS
  'area-home':
    'M5 4h4a1 1 0 0 1 1 1v6a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1v-6a1 1 0 0 1 1 -1 M5 16h4a1 1 0 0 1 1 1v2a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1v-2a1 1 0 0 1 1 -1 M15 12h4a1 1 0 0 1 1 1v6a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1v-6a1 1 0 0 1 1 -1 M15 4h4a1 1 0 0 1 1 1v2a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1v-2a1 1 0 0 1 1 -1',
  'area-workspace':
    'M4 14v-3a8 8 0 1 1 16 0v3 M18 19c0 1.657 -2.686 3 -6 3 M4 14a2 2 0 0 1 2 -2h1a2 2 0 0 1 2 2v3a2 2 0 0 1 -2 2h-1a2 2 0 0 1 -2 -2v-3z M15 14a2 2 0 0 1 2 -2h1a2 2 0 0 1 2 2v3a2 2 0 0 1 -2 2h-1a2 2 0 0 1 -2 -2v-3z',
  'area-supervisor':
    'M7 16m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0 M17 16m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0 M16.346 9.17l-.729 -1.261c-.16 -.248 -1.056 -.203 -1.117 .091l-.177 1.38 M19.761 14.813l-2.84 -5.133c-.189 -.31 -.592 -.68 -1.421 -.68c-.828 0 -1.5 .448 -1.5 1v6 M7.654 9.17l.729 -1.261c.16 -.249 1.056 -.203 1.117 .091l.177 1.38 M4.239 14.813l2.84 -5.133c.189 -.31 .592 -.68 1.421 -.68c.828 0 1.5 .448 1.5 1v6',
  'area-outbound':
    'M5 4h4l2 5l-2.5 1.5a11 11 0 0 0 5 5l1.5 -2.5l5 2v4a2 2 0 0 1 -2 2c-8.072 -.49 -14.51 -6.928 -15 -15a2 2 0 0 1 2 -2 M15 5h6 M18.5 7.5l2.5 -2.5l-2.5 -2.5',
  'area-journeys':
    'M3 19a2 2 0 1 0 4 0a2 2 0 0 0 -4 0 M19 7a2 2 0 1 0 0 -4a2 2 0 0 0 0 4z M14 5a2 2 0 0 0 -2 2v10a2 2 0 0 1 -2 2',
  'area-governance':
    'M11.46 20.846a12 12 0 0 1 -7.96 -14.846a12 12 0 0 0 8.5 -3a12 12 0 0 0 8.5 3a12 12 0 0 1 -.09 7.06 M15 19l2 2l4 -4',
  'area-cases':
    'M15 5l0 2 M15 11l0 2 M15 17l0 2 M5 5h14a2 2 0 0 1 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-3a2 2 0 0 0 0 -4v-3a2 2 0 0 1 2 -2',
  'area-routing':
    'M3 19a2 2 0 1 0 4 0a2 2 0 0 0 -4 0 M19 7a2 2 0 1 0 0 -4a2 2 0 0 0 0 4z M11 19h5.5a3.5 3.5 0 0 0 0 -7h-8a3.5 3.5 0 0 1 0 -7h4.5',
  'area-ai':
    'M16 18a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2zm0 -12a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2zm-7 12a6 6 0 0 1 6 -6a6 6 0 0 1 -6 -6a6 6 0 0 1 -6 6a6 6 0 0 1 6 6z',
  'area-people':
    'M9 7m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0 M3 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2 M16 3.13a4 4 0 0 1 0 7.75 M21 21v-2a4 4 0 0 0 -3 -3.85',
  'area-wfm':
    'M11.795 21h-6.795a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v4 M18 18m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0 M15 3v4 M7 3v4 M3 11h16 M18 16.496v1.504l1 1',
  'area-qm':
    'M9 5h-2a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-12a2 2 0 0 0 -2 -2h-2 M9 3m0 2a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v0a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2z M9 14l2 2l4 -4',
  'area-analytics':
    'M3 3v18h18 M9 9m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0 M19 7m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0 M14 15m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0 M10.16 10.62l2.34 2.88 M15.088 13.328l2.837 -4.586',
  'area-integrations':
    'M7 12l5 5l-1.5 1.5a3.536 3.536 0 1 1 -5 -5l1.5 -1.5z M17 12l-5 -5l1.5 -1.5a3.536 3.536 0 1 1 5 5l-1.5 1.5z M3 21l2.5 -2.5 M18.5 5.5l2.5 -2.5 M10 11l-2 2 M13 14l-2 2',
  'area-history': 'M12 8l0 4l2 2 M3.05 11a9 9 0 1 1 .5 4m-.5 5v-5h5',
  'area-reports':
    'M3 13a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v6a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z M15 9a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v10a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z M9 5a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v14a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z M4 20h14',
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
