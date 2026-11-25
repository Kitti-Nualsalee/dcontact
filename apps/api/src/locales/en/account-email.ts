import type { accountEmailTh } from '../th/account-email.js';

/** English text of the account emails rendered by account-email-templates.ts */
export const accountEmailEn: typeof accountEmailTh = {
  footer: 'This email was sent automatically by D-Contact. Please do not reply.',
  fallback: 'If the button does not work, copy this link into your browser',
  'verify-new-email': {
    subject: 'Confirm the new email for your D-Contact account',
    title: 'Confirm your new email',
    intro:
      'A request was made to change your D-Contact account email to this address. Select the button below to confirm.',
    action: 'Confirm email',
    expiry: (minutes: number) =>
      `This link expires in ${minutes} minutes and can be used only once.`,
    ignore:
      'If you did not request this change, no action is needed. Your account email stays the same.',
  },
  'email-changed-notice': {
    subject: 'Your D-Contact account email was changed',
    title: 'Your account email was changed',
    intro: (masked: string, at: string) =>
      `Your D-Contact account email was changed to ${masked} on ${at}. This address will no longer receive account notifications.`,
    action: 'Open my account',
    warning:
      'If you did not make this change, contact your organization administrator immediately.',
  },
  'password-changed-notice': {
    subject: 'Your D-Contact password was changed',
    title: 'Your password was changed',
    intro: (at: string) => `The password for your D-Contact account was changed on ${at}.`,
    action: 'Open my account',
    warning:
      'If you did not make this change, contact your organization administrator immediately.',
  },
};
