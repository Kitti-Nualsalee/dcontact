/**
 * D1.13/D1.14: load `@d-contact/ui/tokens.css` dynamically once per page
 *
 * tokens hold global rules for html/body so they are not statically imported app-wide — loaded only for pages moved to the new system
 * (the shell when the flag is on and the Journeys page in both flag states), so other Console pages do not change
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

/** true once tokens are ready — render content after this so the page is never seen without colors */
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
