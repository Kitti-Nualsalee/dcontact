/**
 * #967: the switch for Supervisors listening to recordings, per deployment
 *
 * off by default: the new route answers 403 and the existing presign route works as before
 * once on, a Supervisor listens through the API with permission checked on every chunk and the existing presign route answers 403
 */
export function resolveRecordingSupervisorPlayback(env: NodeJS.ProcessEnv): boolean {
  const value = env.RECORDING_SUPERVISOR_PLAYBACK;
  if (value === undefined || value === '' || value === 'off') return false;
  if (value === 'on') return true;
  // a misspelled value must not be silently interpreted as on or off
  throw new Error('RECORDING_SUPERVISOR_PLAYBACK must be "on" or "off"');
}
