import { createHash, createHmac, randomBytes } from 'node:crypto';

/**
 * A1.2 (#407): login ผ่าน browser flow ของ `platform-console` แบบที่ browser ทำจริง (authorization code +
 * PKCE, ฟอร์มรหัสผ่านแล้วฟอร์ม OTP) — ใช้ใน real-boundary test เท่านั้น เพราะ client นี้ปิด direct grant
 */
const keycloakBaseUrl = process.env.KEYCLOAK_ADMIN_URL ?? 'http://localhost:8081';

/** RFC 6238 TOTP ด้วย secret ดิบแบบที่ Keycloak เก็บ (UTF-8 bytes ไม่ใช่ base32) */
export function totp(secret, at = Date.now(), period = 30, digits = 6) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / period)));
  const digest = createHmac('sha1', Buffer.from(secret, 'utf8')).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, '0');
}

/**
 * Keycloak ไม่รับรหัส TOTP ซ้ำภายใน window เดียวกัน (replay protection) — process เดียวกันที่ login
 * user เดิมสองครั้งติดกันต้องรอ window ถัดไป ไม่ใช่ลดความเข้มของ flow
 */
const lastOtpWindow = new Map();
async function freshOtp(secret, period = 30) {
  let window = Math.floor(Date.now() / 1000 / period);
  if (lastOtpWindow.get(secret) === window) {
    await new Promise((resolveWait) =>
      setTimeout(resolveWait, (window + 1) * period * 1000 - Date.now() + 250),
    );
    window = Math.floor(Date.now() / 1000 / period);
  }
  lastOtpWindow.set(secret, window);
  return totp(secret, Date.now(), period);
}

function formAction(html) {
  const match = String(html).match(/<form[^>]*action="([^"]+)"/i);
  return match ? match[1].replaceAll('&amp;', '&') : null;
}

/**
 * คืน `{ status: 'TOKEN', accessToken }` เมื่อผ่านครบ หรือ `{ status: 'STOPPED', stage }` เมื่อ flow ไม่ยอมให้ผ่าน
 * (เช่นไม่มี OTP) — ไม่ log token/รหัสผ่านใด ๆ
 */
export async function platformConsoleLogin({
  username,
  password,
  totpSecret,
  realm = 'dcontact',
  clientId = 'platform-console',
  redirectUri = 'http://localhost:5180/callback',
  skipOtp = false,
  otpDelayMs = 0,
}) {
  const cookies = new Map();
  const remember = (response) => {
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const index = pair.indexOf('=');
      cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
  };
  const cookieHeader = () => [...cookies].map(([key, value]) => `${key}=${value}`).join('; ');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorize = new URL(`${keycloakBaseUrl}/realms/${realm}/protocol/openid-connect/auth`);
  for (const [key, value] of Object.entries({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid',
    state: randomBytes(8).toString('hex'),
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })) {
    authorize.searchParams.set(key, value);
  }

  let response = await fetch(authorize, { redirect: 'manual' });
  remember(response);
  let action = formAction(await response.text());
  if (!action) return { status: 'STOPPED', stage: 'LOGIN_FORM' };

  const submit = async (url, fields) => {
    const result = await fetch(url, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader() },
      body: new URLSearchParams(fields),
    });
    remember(result);
    return result;
  };

  response = await submit(action, { username, password, credentialId: '' });
  let location = response.headers.get('location');
  if (!location) {
    const html = await response.text();
    action = formAction(html);
    if (!action || !/otp/i.test(html)) return { status: 'STOPPED', stage: 'AFTER_PASSWORD' };
    if (skipOtp || !totpSecret) return { status: 'STOPPED', stage: 'OTP_REQUIRED' };
    // จำลองคนพิมพ์ OTP ช้า — ขั้นรหัสผ่านต้องยังอยู่ใน amr
    if (otpDelayMs > 0) await new Promise((resolveWait) => setTimeout(resolveWait, otpDelayMs));
    response = await submit(action, { otp: await freshOtp(totpSecret) });
    location = response.headers.get('location');
    if (!location) return { status: 'STOPPED', stage: 'AFTER_OTP' };
  }
  const code = new URL(location).searchParams.get('code');
  if (!code) return { status: 'STOPPED', stage: 'NO_CODE' };

  const token = await fetch(`${keycloakBaseUrl}/realms/${realm}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  if (!token.ok) return { status: 'STOPPED', stage: 'TOKEN_EXCHANGE' };
  const { access_token: accessToken } = await token.json();
  return { status: 'TOKEN', accessToken };
}
