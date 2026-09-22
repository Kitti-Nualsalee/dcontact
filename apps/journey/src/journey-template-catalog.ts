import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type {
  JourneyTemplateContentV1,
  JourneyTemplateLifecycle,
  JourneyTemplateVersionViewV1,
} from '@d-contact/cxa-contracts';
import {
  JOURNEY_RUNTIME_CAPABILITIES,
  compareText,
  journeyAuthoringDigest,
  type JourneyRuntimeCapability,
} from './journey-authoring-canonical.js';
import { validateTemplatePackage } from './journey-template-binder.js';

/**
 * J5.4 (#342): PLATFORM_BUILTIN catalog จาก release asset (Phase Spec §1, คำตัดสิน #330 §2)
 *
 * built-in ไม่มีแถวใน DB ของ tenant — อ่านจากไฟล์ที่มากับ release เท่านั้น และต้องมี SHA-256 ตรงกับ
 * allowlist (`catalog.v1.sha256`) ก่อนใช้งาน ไฟล์ที่ถูกแก้โดยไม่อัปเดต allowlist ผ่าน review/CI ทำให้ทั้ง
 * catalog ใช้ไม่ได้ (fail closed) แทนที่จะเสิร์ฟเนื้อหาที่ไม่มีใครรับรอง
 */

export class JourneyTemplatePackageUntrustedError extends Error {
  readonly code = 'TEMPLATE_PACKAGE_UNTRUSTED' as const;

  constructor(readonly reason: string) {
    super(`built-in template catalog ไม่น่าเชื่อถือ: ${reason}`);
    this.name = 'JourneyTemplatePackageUntrustedError';
  }
}

interface BuiltInCatalogFile {
  readonly catalogVersion: 1;
  readonly templates: ReadonlyArray<{
    readonly templateId: string;
    readonly version: number;
    readonly name: string;
    readonly lifecycle: JourneyTemplateLifecycle;
    readonly publishedAt: string;
    readonly content: JourneyTemplateContentV1;
  }>;
}

const DEFAULT_CATALOG = new URL('../templates/builtin/catalog.v1.json', import.meta.url);
const DEFAULT_ALLOWLIST = new URL('../templates/builtin/catalog.v1.sha256', import.meta.url);

export function templateNodeMappingDigest(content: JourneyTemplateContentV1): string {
  return journeyAuthoringDigest(
    content.document.nodes
      .map((node) => ('templateNodeKey' in node ? node.templateNodeKey : undefined))
      .filter((key): key is string => Boolean(key))
      .sort(compareText),
  );
}

export class BuiltInTemplateCatalog {
  private readonly versions: readonly JourneyTemplateVersionViewV1[];

  constructor(
    options: {
      readonly catalogPath?: URL | string;
      readonly allowlistPath?: URL | string;
      readonly capabilities?: readonly JourneyRuntimeCapability[];
    } = {},
  ) {
    const bytes = readFileSync(options.catalogPath ?? DEFAULT_CATALOG);
    const expected = readFileSync(options.allowlistPath ?? DEFAULT_ALLOWLIST, 'utf8').trim();
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (!/^[a-f0-9]{64}$/.test(expected) || actual !== expected) {
      throw new JourneyTemplatePackageUntrustedError('DIGEST_MISMATCH');
    }
    const file = JSON.parse(bytes.toString('utf8')) as BuiltInCatalogFile;
    if (file.catalogVersion !== 1 || !Array.isArray(file.templates)) {
      throw new JourneyTemplatePackageUntrustedError('CATALOG_VERSION');
    }
    const capabilities = options.capabilities ?? JOURNEY_RUNTIME_CAPABILITIES;
    this.versions = Object.freeze(
      file.templates.map((entry) => {
        const diagnostics = validateTemplatePackage(entry.content, capabilities);
        if (diagnostics.length > 0) {
          throw new JourneyTemplatePackageUntrustedError(
            `${entry.templateId}:${diagnostics[0]!.code}`,
          );
        }
        return Object.freeze({
          origin: 'PLATFORM_BUILTIN' as const,
          templateId: entry.templateId,
          version: entry.version,
          contentDigest: journeyAuthoringDigest(entry.content),
          name: entry.name,
          // built-in เห็นได้ทุก tenant และไม่มีเจ้าของทีม
          visibility: 'TENANT' as const,
          ownerTeamId: null,
          lifecycle: entry.lifecycle,
          content: entry.content,
          compileDigest: journeyAuthoringDigest(entry.content.document),
          nodeMappingDigest: templateNodeMappingDigest(entry.content),
          publishedAt: entry.publishedAt,
        });
      }),
    );
  }

  list(): readonly JourneyTemplateVersionViewV1[] {
    return this.versions;
  }

  get(templateId: string, version?: number): JourneyTemplateVersionViewV1 | undefined {
    const matches = this.versions.filter((entry) => entry.templateId === templateId);
    if (version === undefined) return [...matches].sort((a, b) => b.version - a.version)[0];
    return matches.find((entry) => entry.version === version);
  }
}
