export type PlatformConsoleLoginResult =
  { status: 'TOKEN'; accessToken: string } | { status: 'STOPPED'; stage: string };
export function totp(secret: string, at?: number, period?: number, digits?: number): string;
export function platformConsoleLogin(options: {
  username: string;
  password: string;
  totpSecret?: string;
  realm?: string;
  clientId?: string;
  redirectUri?: string;
  skipOtp?: boolean;
  otpDelayMs?: number;
}): Promise<PlatformConsoleLoginResult>;
