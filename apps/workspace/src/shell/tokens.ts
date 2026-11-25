/**
 * D1.13/D1.14: load `@d-contact/ui/tokens.css` dynamically, once per page
 *
 * the tokens carry global html/body rules, so they are not statically imported across the whole app — load only on pages moved to the new system
 * (the shell when the flag is on, and the Journeys page in both flag states) so the other Console pages do not change
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

/** true once the tokens are ready — render content after this so no page without colors is seen */
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
