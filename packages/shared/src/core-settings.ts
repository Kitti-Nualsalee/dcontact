/** Core Settings: กฎเดียวกันสำหรับ API และ form โดยนับ UTF-16 ตาม contract */
export function coreOrganizationNameError(name: string): boolean {
  return name.length < 2 || name.length > 120 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(name);
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
