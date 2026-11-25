/**
 * E1.13 (#487): login bar of the embedded dphone — plain DOM (the embed entry does not load React)
 *
 * the "Sign in" button calls `auth.login()` directly in the click handler (user gesture), so it can open a popup;
 * the state is shown through `role="status"` for screen readers to read
 */
import type { i18n as I18n } from 'i18next';
import type { EmbeddedAuth, EmbeddedAuthStatus } from './embedded-auth.js';

const SIGN_IN_VISIBLE: ReadonlySet<EmbeddedAuthStatus> = new Set([
  'signed-out',
  'popup-blocked',
  'reauth',
]);

export function mountAuthBar(root: HTMLElement, auth: EmbeddedAuth, i18n: I18n): () => void {
  const section = document.createElement('section');
  section.className = 'dphone-embed-auth';
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const signIn = document.createElement('button');
  signIn.type = 'button';
  signIn.addEventListener('click', () => auth.login());
  section.append(status, signIn);
  root.append(section);

  const render = () => {
    const fixed = i18n.getFixedT(null, 'dphone');
    section.dataset.status = auth.status;
    section.setAttribute('aria-label', fixed('embedAuth.label'));
    status.textContent = fixed(`embedAuth.status.${auth.status}`);
    signIn.textContent = fixed('embedAuth.signIn');
    signIn.hidden = !SIGN_IN_VISIBLE.has(auth.status);
  };
  render();
  const unsubscribe = auth.subscribe(render);
  i18n.on('languageChanged', render);
  return () => {
    unsubscribe();
    i18n.off('languageChanged', render);
    section.remove();
  };
}
