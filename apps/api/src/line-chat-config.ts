import { LINE_API_DEFAULT_BASE_URL } from './line-chat-client.js';

/**
 * #1054: the switch for LINE chat, per deployment. Off by default: the webhook and settings routes do
 * not exist and no LINE work runs. A tenant still has to enable its own LINE channel.
 */
export function resolveLineChat(env: NodeJS.ProcessEnv): boolean {
  const value = env.LINE_CHAT;
  if (value === undefined || value === '' || value === 'off') return false;
  if (value === 'on') return true;
  throw new Error('LINE_CHAT must be "on" or "off"');
}

/** LINE's API, or a stand-in for it (the LINE simulator on a dev stack) */
export function resolveLineApiBaseUrl(env: NodeJS.ProcessEnv): string {
  const value = env.LINE_API_BASE_URL?.trim();
  if (!value) return LINE_API_DEFAULT_BASE_URL;
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && loopback) &&
    env.NODE_ENV === 'production'
  )
    throw new Error('LINE_API_BASE_URL must be https outside a loopback host');
  return url.origin;
}
