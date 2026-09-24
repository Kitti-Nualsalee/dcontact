/**
 * Owner: IAM + Platform edge — ตรวจ access token ของ Platform API (A1.2 #407)
 *
 * signature (JWKS ของ realm), issuer, audience `dcontact-platform-api`, expiry และ header `typ=JWT`
 * ครบก่อนส่ง claims ต่อ — audience ของ tenant API (`dcontact-api`) ใช้ที่นี่ไม่ได้และกลับกัน
 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { PLATFORM_API_AUDIENCE } from './platform-identity.js';

export interface PlatformAccessTokenVerifier {
  verifyAccessToken(accessToken: string): Promise<Record<string, unknown>>;
}

export class JosePlatformAccessTokenVerifier implements PlatformAccessTokenVerifier {
  constructor(
    private readonly options: {
      issuer: string;
      keys: JWTVerifyGetKey;
      clockToleranceSeconds?: number;
    },
  ) {}

  static remote(options: { issuer: string; jwksUri: string }) {
    return new JosePlatformAccessTokenVerifier({
      issuer: options.issuer,
      keys: createRemoteJWKSet(new URL(options.jwksUri)),
    });
  }

  async verifyAccessToken(accessToken: string): Promise<Record<string, unknown>> {
    const { payload } = await jwtVerify(accessToken, this.options.keys, {
      issuer: this.options.issuer,
      audience: PLATFORM_API_AUDIENCE,
      typ: 'JWT',
      clockTolerance: this.options.clockToleranceSeconds ?? 0,
    });
    return payload as Record<string, unknown>;
  }
}
