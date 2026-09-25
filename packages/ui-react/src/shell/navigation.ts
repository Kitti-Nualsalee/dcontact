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
  hostOrigins: Record<HostApp, string>;
  /** ตัวระบุ organization ที่แอปใช้อยู่แล้ว (ไม่ใช่ข้อมูลบุคคล) — ส่งต่อเฉพาะเมื่อมี */
  tenantAlias?: string;
}

/** path ในแอปเดียวกัน = relative; อีกแอป = absolute ตาม origin ที่ตั้งค่าไว้ */
export function buildAppHref(input: AppHrefInput): string {
  const base = input.hostOrigins[input.hostApp];
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
    hostOrigins: Record<HostApp, string>;
    tenantAlias?: string;
    translate: (key: string) => string;
  },
): { apps: ShellApp[]; groups: ShellGroup[] } {
  return {
    groups: response.groups.map((group) => ({
      id: group.id,
      label: options.translate(group.labelKey),
    })),
    apps: response.apps.map((app) => ({
      id: app.id,
      groupId: app.groupId,
      label: options.translate(app.labelKey),
      external: app.hostApp !== options.currentHost,
      href: buildAppHref({
        hostApp: app.hostApp,
        path: app.path,
        currentHost: options.currentHost,
        hostOrigins: options.hostOrigins,
        tenantAlias: options.tenantAlias,
      }),
    })),
  };
}

export interface ShellNavigationOptions {
  apiBaseUrl: string;
  accessToken: () => string | undefined;
  currentHost: HostApp;
  hostOrigins: Record<HostApp, string>;
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
    setResponse(body);
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

  const responseRef = useRef(response);
  responseRef.current = response;

  // ส่ง request นอก setState updater — StrictMode เรียก updater สองครั้ง ซึ่งจะยิง PUT ซ้ำ
  const togglePin = useCallback(
    (appId: string) => {
      const previous = responseRef.current;
      if (!previous) return;
      const pinned = previous.pins.appIds.includes(appId);
      const appIds = pinned
        ? previous.pins.appIds.filter((id) => id !== appId)
        : [...previous.pins.appIds, appId];
      const optimistic = { ...previous, pins: { ...previous.pins, appIds } };
      responseRef.current = optimistic;
      setResponse(optimistic);
      void request('me/navigation/pins', {
        method: 'PUT',
        body: JSON.stringify({ appIds, expectedRevision: previous.pins.revision }),
      })
        .then(async (reply) => {
          if (reply.ok) {
            const saved = (await reply.json()) as { appIds: string[]; revision: number };
            setResponse((latest) =>
              latest ? { ...latest, pins: { ...latest.pins, ...saved, source: 'USER' } } : latest,
            );
            return;
          }
          // revision ชน (อีกแท็บ/อีกเครื่องแก้ไปแล้ว) → ใช้ค่าล่าสุดจาก server
          if (reply.status === 409) await load();
          else setResponse(previous);
          optionsRef.current.onPinError?.(new Error(`pins ${reply.status}`));
        })
        .catch((error: unknown) => {
          setResponse(previous);
          optionsRef.current.onPinError?.(error);
        });
    },
    [load, request],
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
