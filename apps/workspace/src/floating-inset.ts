/**
 * #956 dphone แบบลอย (`.dp-floating`, position fixed ลากย้ายได้) ทับส่วนล่างของแผงงานด้านขวา
 * hook นี้วัดความสูงที่ทับจริงแล้วตั้ง `--aw-dphone-inset` บนแผง ให้เนื้อหาเว้นที่และปุ่มที่ติดท้ายแผง
 * ยกขึ้นพ้น dphone ไม่ทับ = 0 จึงไม่เปลี่ยน layout เมื่อ dphone อยู่ที่อื่นหรือถูกแยกหน้าต่าง
 */
import { useEffect, type RefObject } from 'react';

const FLOATING = '.dp-floating';
const GAP_PX = 8;

/** ความสูงที่ `floating` ทับขอบล่างของ `pane` (0 เมื่อไม่ทับทั้งแนวนอนและแนวตั้ง) */
export function overlapInset(pane: DOMRectReadOnly, floating: DOMRectReadOnly | undefined): number {
  if (!floating || floating.width === 0 || floating.height === 0) return 0;
  const horizontal = floating.left < pane.right && floating.right > pane.left;
  const vertical = floating.top < pane.bottom && floating.bottom > pane.top;
  if (!horizontal || !vertical) return 0;
  return Math.max(0, Math.ceil(pane.bottom - floating.top) + GAP_PX);
}

export function useFloatingOverlapInset(pane: RefObject<HTMLElement | null>, enabled: boolean) {
  useEffect(() => {
    const element = pane.current;
    if (!enabled || !element) return;
    let frame = 0;
    let watched: Element | null = null;
    const resize = new ResizeObserver(() => schedule());
    const mutations = new MutationObserver(() => schedule());
    function measure() {
      frame = 0;
      const floating = document.querySelector(FLOATING);
      if (floating !== watched) {
        if (watched) resize.unobserve(watched);
        watched = floating;
        if (floating) resize.observe(floating);
      }
      const inset = overlapInset(
        element!.getBoundingClientRect(),
        floating?.getBoundingClientRect(),
      );
      element!.style.setProperty('--aw-dphone-inset', `${inset}px`);
    }
    function schedule() {
      if (!frame) frame = requestAnimationFrame(measure);
    }
    resize.observe(element);
    // dphone ย้ายตำแหน่งด้วย inline style และเปลี่ยนขนาด/โหมดด้วย class
    mutations.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['style', 'class'],
    });
    window.addEventListener('resize', schedule);
    measure();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      window.removeEventListener('resize', schedule);
      element.style.removeProperty('--aw-dphone-inset');
    };
  }, [pane, enabled]);
}
