/**
 * E1.13 (#487): แถบ login ของ dphone ที่ถูกฝัง — DOM ธรรมดา (entry embed ไม่โหลด React)
 *
 * ปุ่ม "เข้าสู่ระบบ" เรียก `auth.login()` ตรงใน click handler (user gesture) จึงเปิด popup ได้;
 * สถานะแสดงผ่าน `role="status"` ให้ screen reader อ่าน
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
