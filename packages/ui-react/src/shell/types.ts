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

/**
 * #651: รายการในเมนูย่อยของพื้นที่ — id = id ของแอปใน registry
 * #658: แอปที่มีหน้าย่อยกระจายเป็นหลายรายการ id เดียวกัน (ของแอป) แยกด้วย `pageId`
 */
export interface ShellAreaItem {
  id: string;
  pageId?: string;
  label: string;
  href: string;
  external: boolean;
}

export interface ShellAreaSection {
  id: string;
  label: string;
  items: readonly ShellAreaItem[];
}

/** #651: พื้นที่งานบน rail — `href` คือรายการแรกของพื้นที่ (ลิงก์ของปุ่มบน rail) */
export interface ShellArea {
  id: string;
  label: string;
  href: string;
  external: boolean;
  sections: readonly ShellAreaSection[];
}
