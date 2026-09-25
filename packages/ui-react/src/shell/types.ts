/** แอปหนึ่งตัวบน rail/launcher — label แปลแล้ว, href ประกอบ origin แล้ว (ลิงก์ข้ามแอปใช้ ID เท่านั้น) */
export interface ShellApp {
  id: string;
  groupId: string;
  label: string;
  href: string;
  /** อยู่อีก host app (Console ↔ Workspace) → เปิดแท็บใหม่เสมอ (ADR-026 ข้อ 3) */
  external: boolean;
}

export interface ShellGroup {
  id: string;
  label: string;
}

export interface ShellCreateAction {
  id: string;
  label: string;
  href: string;
  external: boolean;
}
