/** Core Settings: the same rules for the API and forms, counting UTF-16 per the contract */
export function coreOrganizationNameError(name: string): boolean {
  return name.length < 2 || name.length > 120 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(name);
}
export function coreTeamNameError(name: string): boolean {
  return name.length < 1 || name.length > 80 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(name);
}
export function coreTimeZoneValid(value: string): boolean {
  if (value !== 'UTC' && !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
