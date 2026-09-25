/**
 * D1.13 (#452): client ของ Navigation API (D1.12) สำหรับ shell
 *
 * - รายการแอปมาจาก server (คัดตาม role/plan แล้ว) — shell ไม่ซ่อนหรือเดาสิทธิ์เอง
 * - ลิงก์ข้าม host app ใช้ path จาก registry + tenant alias เท่านั้น (ห้าม PII ใน URL)
 * - `shellEnabled` (flag `ui.shell.v2`) ตัดสิน **ครั้งเดียวต่อการโหลดหน้า** — ไม่สลับ shell กลางคัน
 *   เพราะ Workspace ที่ถูก remount จะตัดสายและ WS (ADR-026); เรียกไม่สำเร็จ = shell เดิม (fail-safe)
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ShellApp, ShellGroup } from './types.js';

export type HostApp = 'console' | 'workspace';

export interface NavigationResponseV1 {
  groups: { id: string; labelKey: string }[];
  apps: { id: string; groupId: string; labelKey: string; hostApp: HostApp; path: string }[];
  pins: { appIds: string[]; source: 'USER' | 'TENANT' | 'SYSTEM'; revision: number };
  limits: { maxPins: number };
  features: { shellV2: boolean };
}

export interface AppHrefInput {
  hostApp: HostApp;
  path: string;
  /** แอปที่กำลังแสดงอยู่ */
  currentHost: HostApp;
  hostOrigins: Partial<Record<HostApp, string>>;
  /** ตัวระบุ organization ที่แอปใช้อยู่แล้ว (ไม่ใช่ข้อมูลบุคคล) — ส่งต่อเฉพาะเมื่อมี */
  tenantAlias?: string;
}

/**
 * path ในแอปเดียวกัน = relative; อีกแอป = absolute ตาม origin ที่ตั้งค่าไว้
 * ไม่รู้ origin ของอีกแอป = `null` (ห้ามเดาเป็น localhost — ลิงก์ใน production จะชี้เครื่องผู้ใช้)
 */
export function buildAppHref(input: AppHrefInput): string | null {
  const base =
    input.hostApp === input.currentHost
      ? (input.hostOrigins[input.hostApp] ?? 'http://current.invalid')
      : input.hostOrigins[input.hostApp];
  if (!base) return null;
  const url = new URL(input.path, base);
  if (input.tenantAlias) url.searchParams.set('tenant', input.tenantAlias);
  return input.hostApp === input.currentHost
    ? `${url.pathname}${url.search}${url.hash}`
    : url.toString();
}

export function toShellModel(
  response: NavigationResponseV1,
  options: {
    currentHost: HostApp;
    hostOrigins: Partial<Record<HostApp, string>>;
    tenantAlias?: string;
    translate: (key: string) => string;
  },
): { apps: ShellApp[]; groups: ShellGroup[] } {
  return {
    groups: response.groups.map((group) => ({
      id: group.id,
      label: options.translate(group.labelKey),
    })),
    // แอปที่ไม่รู้ origin (ไม่ได้ตั้งค่า deployment) ถูกตัดออกจาก shell แทนการสร้างลิงก์ที่ผิด
    apps: response.apps.flatMap((app) => {
      const href = buildAppHref({
        hostApp: app.hostApp,
        path: app.path,
        currentHost: options.currentHost,
        hostOrigins: options.hostOrigins,
        tenantAlias: options.tenantAlias,
      });
      return href === null
        ? []
        : [
            {
              id: app.id,
              groupId: app.groupId,
              label: options.translate(app.labelKey),
              external: app.hostApp !== options.currentHost,
              href,
            },
          ];
    }),
  };
}

export interface ShellNavigationOptions {
  apiBaseUrl: string;
  accessToken: () => string | undefined;
  currentHost: HostApp;
  /** origin ของอีกแอปที่ไม่ได้ระบุ = แอปของฝั่งนั้นไม่แสดงใน shell */
  hostOrigins: Partial<Record<HostApp, string>>;
  tenantAlias?: string;
  translate: (key: string) => string;
  /** แจ้งเมื่อบันทึกหมุดไม่สำเร็จ (จอย้อนกลับค่าเดิมแล้ว) */
  onPinError?: (error: unknown) => void;
  fetch?: typeof fetch;
}

export type ShellNavigationState =
  | { status: 'loading' }
  | { status: 'legacy' }
  | {
      status: 'ready';
      apps: ShellApp[];
      groups: ShellGroup[];
      pinnedIds: string[];
      maxPins: number;
      togglePin: (appId: string) => void;
    };

export function useShellNavigation(options: ShellNavigationOptions): ShellNavigationState {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [response, setResponse] = useState<NavigationResponseV1 | null>(null);
  // ref คือค่าล่าสุดจริง (รวม optimistic) — เขียนเฉพาะผ่าน update() ไม่เขียนตอน render
  // เพราะ render ที่มาก่อน update จะ commit อาจเขียนค่าเก่าทับ แล้วการกดครั้งถัดไปคำนวณจากค่าเก่า
  const responseRef = useRef<NavigationResponseV1 | null>(null);
  const update = useCallback(
    (next: (current: NavigationResponseV1 | null) => NavigationResponseV1 | null) => {
      responseRef.current = next(responseRef.current);
      setResponse(responseRef.current);
    },
    [],
  );
  const [decision, setDecision] = useState<'pending' | 'shell' | 'legacy'>('pending');

  const request = useCallback(async (path: string, init?: RequestInit) => {
    const { apiBaseUrl, accessToken, fetch: fetcher = fetch } = optionsRef.current;
    const token = accessToken();
    return fetcher(`${apiBaseUrl.replace(/\/+$/, '')}/api/v1/${path}`, {
      ...init,
      headers: {
        accept: 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
      },
    });
  }, []);

  const load = useCallback(async () => {
    const reply = await request('me/navigation');
    if (!reply.ok) throw new Error(`navigation ${reply.status}`);
    const body = (await reply.json()) as NavigationResponseV1;
    update(() => body);
    return body;
  }, [request]);

  useEffect(() => {
    let active = true;
    load()
      .then(
        (body) =>
          active &&
          setDecision((d) => (d === 'pending' ? (body.features?.shellV2 ? 'shell' : 'legacy') : d)),
      )
      .catch(() => active && setDecision((d) => (d === 'pending' ? 'legacy' : d)));
    return () => {
      active = false;
    };
  }, [load]);

  // หมุดที่ server ยืนยันล่าสุด — ทุก PUT ใช้ revision นี้ และคำขอถูกส่งทีละคำขอ (ไม่ชนกันเอง)
  const confirmed = useRef<{ appIds: string[]; revision: number } | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    if (response && confirmed.current === null) confirmed.current = response.pins;
  }, [response]);

  const reload = useCallback(async () => {
    const body = await load();
    confirmed.current = body.pins;
  }, [load]);

  // ส่ง request นอก setState updater — StrictMode เรียก updater สองครั้ง ซึ่งจะยิง PUT ซ้ำ
  const togglePin = useCallback(
    (appId: string) => {
      const current = responseRef.current;
      if (!current) return;
      const pinned = current.pins.appIds.includes(appId);
      const appIds = pinned
        ? current.pins.appIds.filter((id) => id !== appId)
        : [...current.pins.appIds, appId];
      update(() => ({ ...current, pins: { ...current.pins, appIds } }));

      queue.current = queue.current.then(async () => {
        const base = confirmed.current ?? current.pins;
        const desired = responseRef.current?.pins.appIds ?? appIds;
        // คำขอก่อนหน้าบันทึกชุดเดียวกันไปแล้ว (กดติดกันหลายครั้ง) — ไม่ต้องส่งซ้ำ
        if (
          desired.length === base.appIds.length &&
          desired.every((id, i) => id === base.appIds[i])
        )
          return;
        try {
          const reply = await request('me/navigation/pins', {
            method: 'PUT',
            body: JSON.stringify({ appIds: desired, expectedRevision: base.revision }),
          });
          if (reply.ok) {
            const saved = (await reply.json()) as { appIds: string[]; revision: number };
            confirmed.current = saved;
            // คงลำดับที่ผู้ใช้เห็นอยู่ (อาจมีการกดเพิ่มระหว่างรอ) แต่รับ revision จาก server
            update((latest) =>
              latest
                ? { ...latest, pins: { ...latest.pins, revision: saved.revision, source: 'USER' } }
                : latest,
            );
            return;
          }
          // revision ชนจริง (อีกแท็บ/อีกเครื่องแก้ไปแล้ว) → ใช้ค่าล่าสุดจาก server
          if (reply.status === 409) await reload();
          else {
            const fallback = confirmed.current ?? base;
            update((latest) =>
              latest ? { ...latest, pins: { ...latest.pins, appIds: fallback.appIds } } : latest,
            );
          }
          optionsRef.current.onPinError?.(new Error(`pins ${reply.status}`));
        } catch (error) {
          const fallback = confirmed.current ?? base;
          update((latest) =>
            latest ? { ...latest, pins: { ...latest.pins, appIds: fallback.appIds } } : latest,
          );
          optionsRef.current.onPinError?.(error);
        }
      });
    },
    [reload, request, update],
  );

  if (decision === 'pending') return { status: 'loading' };
  if (decision === 'legacy' || !response) return { status: 'legacy' };
  const { apps, groups } = toShellModel(response, options);
  const visible = new Set(apps.map((app) => app.id));
  return {
    status: 'ready',
    apps,
    groups,
    pinnedIds: response.pins.appIds.filter((id) => visible.has(id)),
    maxPins: response.limits.maxPins,
    togglePin,
  };
}
