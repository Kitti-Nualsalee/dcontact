/**
 * #956 the floating dphone (`.dp-floating`, position fixed, draggable) overlaps the bottom of the right work panel
 * this hook measures the real overlapping height and sets `--aw-dphone-inset` on the panel so the content leaves room and the button pinned at the end of the panel
 * rises above dphone; no overlap = 0, so the layout does not change when dphone is elsewhere or detached into a window
 */
import { useEffect, type RefObject } from 'react';

const FLOATING = '.dp-floating';
const GAP_PX = 8;

/** height by which `floating` overlaps the bottom edge of `pane` (0 when there is no overlap both horizontally and vertically) */
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
    // dphone moves position through inline style and changes size/mode through class
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
