/**
 * E1.15 (#489): hosting ของ `<dphone-launcher>` บน dphone origin (E1.7 #463 ข้อ 1, 5)
 *
 * - `GET /embed/vX.Y.Z/dphone-launcher.js` — release ที่ตรึงเวอร์ชัน: `immutable` 1 ปี ใช้คู่กับ SRI ได้
 * - `GET /embed/vN/dphone-launcher.js`     — alias ของ major: cache 5 นาที; rollback = ชี้ alias กลับ
 *   (`pnpm --filter @d-contact/dphone-embed launcher:alias v1 <X.Y.Z>`) มีผลภายใน 5 นาทีโดยไม่ต้อง deploy API
 * - `GET /embed/releases.json`             — version, integrity และ alias ปัจจุบัน (สำหรับทำ SRI ฝั่ง host)
 * - เป็นไฟล์สาธารณะ (ไม่มีข้อมูล tenant): CORS `*` เพราะ host โหลดเป็น module script ข้าม origin
 * - ส่งเฉพาะไฟล์ที่อยู่ใน `releases/index.json` และตรงกับ integrity — ไม่อ่าน path จาก request ตรงๆ
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { Controller, Get, Inject, Param, Res } from '@nestjs/common';
import { GatewayPublic } from './gateway-auth.js';

export const DPHONE_LAUNCHER_OPTIONS = Symbol('DPHONE_LAUNCHER_OPTIONS');
export const LAUNCHER_FILE = 'dphone-launcher.js';
export const ALIAS_MAX_AGE_SECONDS = 300;
export const IMMUTABLE_MAX_AGE_SECONDS = 31_536_000;

export interface DphoneLauncherOptions {
  /** โฟลเดอร์ `releases/` ของ `@d-contact/dphone-embed` (มี `index.json` + `<version>/dphone-launcher.js`) */
  releasesDir: string;
}

interface ReleaseIndex {
  versions: Record<string, { integrity: string }>;
  aliases: Record<string, string>;
}

const PINNED = /^v(\d+\.\d+\.\d+)$/;
const ALIAS = /^v\d+$/;

export function defaultLauncherReleasesDir(): string {
  return (
    process.env.DPHONE_LAUNCHER_RELEASES_DIR ??
    join(dirname(require.resolve('@d-contact/dphone-embed/package.json')), 'releases')
  );
}

function integrityOf(content: Buffer): string {
  return `sha384-${createHash('sha384').update(content).digest('base64')}`;
}

export type LauncherResolution =
  | { status: 'ok'; body: Buffer; version: string; integrity: string; cacheControl: string }
  | { status: 'not_found' };

/** หาไฟล์ของ `v1` หรือ `v1.2.3` จาก index — ไม่มีใน index/ไฟล์ถูกแก้ = not_found (fail closed) */
export async function resolveLauncher(
  releasesDir: string,
  requested: string,
): Promise<LauncherResolution> {
  let index: ReleaseIndex;
  try {
    index = JSON.parse(await readFile(join(releasesDir, 'index.json'), 'utf8')) as ReleaseIndex;
  } catch {
    return { status: 'not_found' };
  }
  const pinned = PINNED.exec(requested)?.[1];
  const version = pinned ?? (ALIAS.test(requested) ? index.aliases[requested] : undefined);
  const entry = version ? index.versions[version] : undefined;
  if (!version || !entry) return { status: 'not_found' };
  let body: Buffer;
  try {
    body = await readFile(join(releasesDir, version, LAUNCHER_FILE));
  } catch {
    return { status: 'not_found' };
  }
  if (integrityOf(body) !== entry.integrity) return { status: 'not_found' };
  return {
    status: 'ok',
    body,
    version,
    integrity: entry.integrity,
    cacheControl: pinned
      ? `public, max-age=${IMMUTABLE_MAX_AGE_SECONDS}, immutable`
      : `public, max-age=${ALIAS_MAX_AGE_SECONDS}`,
  };
}

const PUBLIC_HEADERS = {
  'access-control-allow-origin': '*',
  'cross-origin-resource-policy': 'cross-origin',
  'x-content-type-options': 'nosniff',
};

@Controller('embed')
export class DphoneLauncherController {
  constructor(@Inject(DPHONE_LAUNCHER_OPTIONS) private readonly options: DphoneLauncherOptions) {}

  @Get('releases.json')
  @GatewayPublic()
  async releases(@Res() response: ServerResponse) {
    try {
      const index = JSON.parse(
        await readFile(join(this.options.releasesDir, 'index.json'), 'utf8'),
      ) as ReleaseIndex;
      response.writeHead(200, {
        ...PUBLIC_HEADERS,
        'content-type': 'application/json; charset=utf-8',
        'cache-control': `public, max-age=${ALIAS_MAX_AGE_SECONDS}`,
      });
      response.end(JSON.stringify({ versions: index.versions, aliases: index.aliases }));
    } catch {
      response.writeHead(404, PUBLIC_HEADERS);
      response.end();
    }
  }

  @Get(':version/dphone-launcher.js')
  @GatewayPublic()
  async launcher(@Param('version') version: string, @Res() response: ServerResponse) {
    const resolved = await resolveLauncher(this.options.releasesDir, version);
    if (resolved.status !== 'ok') {
      response.writeHead(404, { ...PUBLIC_HEADERS, 'cache-control': 'no-store' });
      response.end();
      return;
    }
    response.writeHead(200, {
      ...PUBLIC_HEADERS,
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': resolved.cacheControl,
      'x-dphone-launcher-version': resolved.version,
      'x-dphone-launcher-integrity': resolved.integrity,
    });
    response.end(resolved.body);
  }
}
