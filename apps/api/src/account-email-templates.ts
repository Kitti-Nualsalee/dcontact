/**
 * Owner: IAM — D-Contact account email templates (AC3 #596, #589)
 *
 * - TH/EN by the user's locale; same tone and layout as the Keycloak `dcontact` email theme (#522)
 *   Colors and type come from `@d-contact/ui` tokens (inline styles: mail clients ignore stylesheets/var())
 * - Text lives in `locales/{th,en}/account-email.ts`
 * - Links only point to the Console "My account" page (`{consoleUrl}/?view=account`); the content never
 *   names or links the identity system
 * - Every user-supplied value is escaped; the new address is partly masked in mail to the old address
 */
import { tokens } from '@d-contact/ui';
import { accountEmailEn } from './locales/en/account-email.js';
import { accountEmailTh } from './locales/th/account-email.js';

export const ACCOUNT_EMAIL_TEMPLATES = [
  'verify-new-email',
  'email-changed-notice',
  'password-changed-notice',
] as const;
export type AccountEmailTemplate = (typeof ACCOUNT_EMAIL_TEMPLATES)[number];

export const ACCOUNT_EMAIL_LOCALES = ['th', 'en'] as const;
export type AccountEmailLocale = (typeof ACCOUNT_EMAIL_LOCALES)[number];

export interface AccountEmailVariables {
  'verify-new-email': { token: string; expiresInMinutes: number };
  'email-changed-notice': { newEmail: string; changedAt: string };
  'password-changed-notice': { changedAt: string };
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export interface RenderOptions {
  /** Console origin, e.g. `https://uat.osd.co.th` — must be https except on localhost */
  consoleUrl: string;
  /** Time zone for times shown in the email (defaults to the Thai tenant default) */
  timeZone?: string;
}

export class AccountEmailTemplateError extends Error {
  constructor(readonly reason: 'INVALID_TEMPLATE' | 'INVALID_LOCALE' | 'INVALID_VARIABLES') {
    super(reason);
    this.name = 'AccountEmailTemplateError';
  }
}

const messages = { th: accountEmailTh, en: accountEmailEn };

/** rem → px (16px root) because some mail clients miscompute rem — same as keycloak-theme-build.mjs */
const px = (value: string) =>
  value.replace(/(\d*\.?\d+)rem\b/g, (_, rem: string) => `${Number(rem) * 16}px`);
const dc = new Proxy(tokens as Record<string, string>, {
  get: (target, name: string) => px(target[name] ?? ''),
});
const font = `font-family:${dc.fontSans};`;

const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

/** `someone@example.com` → `s*****e@example.com` (mail to the old address never shows the full new one) */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  const local = email.slice(0, at);
  const masked =
    local.length <= 2
      ? `${local[0]}*`
      : `${local[0]}${'*'.repeat(local.length - 2)}${local.at(-1)}`;
  return `${masked}${email.slice(at)}`;
}

export function consoleAccountUrl(consoleUrl: string, verifyToken?: string): string {
  const url = new URL('/', consoleUrl);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new AccountEmailTemplateError('INVALID_VARIABLES');
  }
  url.searchParams.set('view', 'account');
  if (verifyToken !== undefined) url.searchParams.set('verify', verifyToken);
  return url.href;
}

function formatTime(iso: string, locale: AccountEmailLocale, timeZone: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new AccountEmailTemplateError('INVALID_VARIABLES');
  return new Intl.DateTimeFormat(locale === 'th' ? 'th-TH' : 'en-GB', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone,
  }).format(date);
}

interface Content {
  subject: string;
  title: string;
  paragraphs: string[];
  action: { label: string; href: string };
  notes: string[];
}

function layout(locale: AccountEmailLocale, content: Content): RenderedEmail {
  const m = messages[locale];
  const paragraph = (text: string) => `<p style="margin:0 0 ${dc.space6};">${escapeHtml(text)}</p>`;
  const note = (text: string) =>
    `<p style="margin:0 0 ${dc.space5};font-size:${dc.textSm};color:${dc.textSecondary};">${escapeHtml(text)}</p>`;
  const href = escapeHtml(content.action.href);
  const html = `<!DOCTYPE html>
<html lang="${locale}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(content.subject)}</title></head>
<body style="margin:0;padding:0;background:${dc.surfacePage};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${dc.surfacePage};">
<tr><td align="center" style="padding:${dc.space9} ${dc.space6};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:${dc.surfaceRaised};border:1px solid ${dc.borderSubtle};border-top:4px solid ${dc.surfaceBrand};border-radius:${dc.radiusXl};">
<tr><td style="padding:${dc.space8} ${dc.space9} 0;${font}font-size:${dc.textXl};font-weight:${dc.weightBold};color:${dc.textBrand};">D-Contact</td></tr>
<tr><td style="padding:${dc.space6} ${dc.space9} ${dc.space9};${font}font-size:${dc.textMd};line-height:${dc.leadingNormal};color:${dc.textPrimary};">
<h1 style="margin:0 0 ${dc.space5};${font}font-size:${dc.textLg};line-height:${dc.leadingSnug};font-weight:${dc.weightSemibold};color:${dc.textPrimary};">${escapeHtml(content.title)}</h1>
${content.paragraphs.map(paragraph).join('\n')}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 ${dc.space8};"><tr><td style="background:${dc.surfaceBrand};border-radius:${dc.radiusMd};"><a href="${href}" target="_blank" style="display:inline-block;padding:${dc.space5} ${dc.space8};${font}font-size:${dc.textMd};font-weight:${dc.weightSemibold};color:${dc.textOnBrand};text-decoration:none;">${escapeHtml(content.action.label)}</a></td></tr></table>
${content.notes.map(note).join('\n')}
${note(m.fallback)}
<p style="margin:0;font-size:${dc.textSm};"><a href="${href}" style="color:${dc.textBrand};word-break:break-all;">${href}</a></p>
</td></tr>
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;"><tr><td style="padding:${dc.space6} ${dc.space9};${font}font-size:${dc.textXs};line-height:${dc.leadingNormal};color:${dc.textMuted};">${escapeHtml(m.footer)}</td></tr></table>
</td></tr>
</table>
</body>
</html>
`;
  // Plain text: the link always sits on its own line (same as the Keycloak email theme)
  const text = [
    content.title,
    '',
    ...content.paragraphs.flatMap((line) => [line, '']),
    `${content.action.label}:`,
    content.action.href,
    '',
    ...content.notes.flatMap((line) => [line, '']),
    '--',
    m.footer,
    '',
  ].join('\n');
  return { subject: content.subject, html, text };
}

const isString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** Validates template variables — used both on enqueue (reject before writing) and on render */
export function assertAccountEmailVariables<T extends AccountEmailTemplate>(
  template: T,
  variables: unknown,
): asserts variables is AccountEmailVariables[T] {
  const value = (variables ?? {}) as Record<string, unknown>;
  const valid =
    template === 'verify-new-email'
      ? isString(value.token) &&
        value.token.length <= 512 &&
        Number.isInteger(value.expiresInMinutes) &&
        (value.expiresInMinutes as number) > 0
      : template === 'email-changed-notice'
        ? isString(value.newEmail) && value.newEmail.includes('@') && isString(value.changedAt)
        : template === 'password-changed-notice'
          ? isString(value.changedAt)
          : false;
  if (!valid) throw new AccountEmailTemplateError('INVALID_VARIABLES');
}

export function renderAccountEmail(
  template: string,
  locale: string,
  variables: unknown,
  options: RenderOptions,
): RenderedEmail {
  if (!(ACCOUNT_EMAIL_TEMPLATES as readonly string[]).includes(template)) {
    throw new AccountEmailTemplateError('INVALID_TEMPLATE');
  }
  if (!(ACCOUNT_EMAIL_LOCALES as readonly string[]).includes(locale)) {
    throw new AccountEmailTemplateError('INVALID_LOCALE');
  }
  const lang = locale as AccountEmailLocale;
  const kind = template as AccountEmailTemplate;
  assertAccountEmailVariables(kind, variables);
  const timeZone = options.timeZone ?? 'Asia/Bangkok';

  if (kind === 'verify-new-email') {
    const { token, expiresInMinutes } = variables as AccountEmailVariables['verify-new-email'];
    const m = messages[lang]['verify-new-email'];
    return layout(lang, {
      subject: m.subject,
      title: m.title,
      paragraphs: [m.intro],
      action: { label: m.action, href: consoleAccountUrl(options.consoleUrl, token) },
      notes: [m.expiry(expiresInMinutes), m.ignore],
    });
  }
  if (kind === 'email-changed-notice') {
    const { newEmail, changedAt } = variables as AccountEmailVariables['email-changed-notice'];
    const m = messages[lang]['email-changed-notice'];
    return layout(lang, {
      subject: m.subject,
      title: m.title,
      paragraphs: [m.intro(maskEmail(newEmail), formatTime(changedAt, lang, timeZone))],
      action: { label: m.action, href: consoleAccountUrl(options.consoleUrl) },
      notes: [m.warning],
    });
  }
  const { changedAt } = variables as AccountEmailVariables['password-changed-notice'];
  const m = messages[lang]['password-changed-notice'];
  return layout(lang, {
    subject: m.subject,
    title: m.title,
    paragraphs: [m.intro(formatTime(changedAt, lang, timeZone))],
    action: { label: m.action, href: consoleAccountUrl(options.consoleUrl) },
    notes: [m.warning],
  });
}
