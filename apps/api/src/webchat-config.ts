/**
 * #1044: the switch for web chat, per deployment.
 *
 * Off by default: the widget, Agent and settings routes answer 404/403, the menu is not shown and no
 * background round runs. A tenant still has to enable its own widget before a visitor can chat.
 */
export function resolveWebchat(env: NodeJS.ProcessEnv): boolean {
  const value = env.WEBCHAT;
  if (value === undefined || value === '' || value === 'off') return false;
  if (value === 'on') return true;
  // a misspelled value must not be silently interpreted as on or off
  throw new Error('WEBCHAT must be "on" or "off"');
}
