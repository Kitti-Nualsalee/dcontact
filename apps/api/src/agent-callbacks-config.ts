/**
 * #1061: the switch for agent-scheduled callbacks, per deployment.
 *
 * Off by default: the Agent routes do not exist, the menu is not shown and no background round runs.
 */
export function resolveAgentCallbacks(env: NodeJS.ProcessEnv): boolean {
  const value = env.AGENT_CALLBACKS;
  if (value === undefined || value === '' || value === 'off') return false;
  if (value === 'on') return true;
  // a misspelled value must not be silently interpreted as on or off
  throw new Error('AGENT_CALLBACKS must be "on" or "off"');
}
