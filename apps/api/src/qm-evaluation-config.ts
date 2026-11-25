/**
 * #971: the switch for human quality evaluation, per deployment
 *
 * off by default: the form/evaluation routes answer 403 and the menu is not shown
 * the existing QM routes (transcript, auto-QM draft) do not depend on this switch
 */
export function resolveQmHumanEvaluation(env: NodeJS.ProcessEnv): boolean {
  const value = env.QM_HUMAN_EVALUATION;
  if (value === undefined || value === '' || value === 'off') return false;
  if (value === 'on') return true;
  // a misspelled value must not be silently interpreted as on or off
  throw new Error('QM_HUMAN_EVALUATION must be "on" or "off"');
}
