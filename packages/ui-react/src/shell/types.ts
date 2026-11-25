/** one app on the rail/launcher — label already translated, href already composed with the origin (cross-app links use IDs only) */
export interface ShellApp {
  id: string;
  groupId: string;
  label: string;
  href: string;
  /** lives in the other host app (Console ↔ Workspace) → always opens a new tab (ADR-026 item 3) */
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
 * #651: an item in the area's sub-menu — id = the app's id in the registry
 * #658: an app with sub-pages is spread into several items with the same (app) id, separated by `pageId`
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

/** #651: a work area on the rail — `href` is the first item of the area (the link of the rail button) */
export interface ShellArea {
  id: string;
  label: string;
  href: string;
  external: boolean;
  sections: readonly ShellAreaSection[];
}
