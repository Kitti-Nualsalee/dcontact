/**
 * D1.13/D1.14: โหลด `@d-contact/ui/tokens.css` แบบ dynamic ครั้งเดียวต่อหน้า
 *
 * token มีกฎ global ของ html/body จึงไม่ import แบบ static ทั้งแอป — โหลดเฉพาะหน้าที่ย้ายมาใช้ระบบใหม่
 * (shell เมื่อเปิด flag และหน้า Journeys ทั้งสองสถานะของ flag) หน้าอื่นของ Console จึงไม่เปลี่ยน
 */
import { useEffect, useState } from 'react';

let loaded: Promise<unknown> | undefined;
let ready = false;

export function loadShellTokens(): Promise<unknown> {
  loaded ??= import('@d-contact/ui/tokens.css').then(() => {
    ready = true;
  });
  return loaded;
}

/** true เมื่อ token พร้อมแล้ว — render เนื้อหาหลังจากนี้เพื่อไม่ให้เห็นหน้าที่ยังไม่มีสี */
export function useShellTokens(enabled = true): boolean {
  const [isReady, setReady] = useState(ready);
  useEffect(() => {
    if (!enabled || isReady) return;
    let active = true;
    void loadShellTokens().then(() => active && setReady(true));
    return () => {
      active = false;
    };
  }, [enabled, isReady]);
  return isReady;
}
