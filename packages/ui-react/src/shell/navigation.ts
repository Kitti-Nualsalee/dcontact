/**
 * D1.13 (#452): client of the Navigation API (D1.12) for the shell
 *
 * - the app list comes from the server (already filtered by role/plan) — the shell does not hide or guess permissions itself
 * - cross-host-app links use only the registry path + tenant alias (no PII in URLs)
 * - `shellEnabled` (flag `ui.shell.v2`) is decided **once per page load** — the shell is never switched mid-session
 *   because a remounted Workspace would drop the call and WS (ADR-026); a failed call = the old shell (fail-safe)
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ShellApp, ShellArea, ShellGroup } from './types.js';

export type HostApp = 'console' | 'workspace';

export interface NavigationResponseV1 {
  groups: { id: string; labelKey: string }[];
  apps: { id: string; groupId: string; labelKey: string; hostApp: HostApp; path: string }[];
  /** #651: work areas on the rail + sub-menu — an older API does not send them (the rail goes back to showing the old app pins) */
  areas?: {
    id: string;
    labelKey: string;
    sections: {
      id: string;
      labelKey: string;
      /** #658: `pages` = the app's sub-pages (the former tabs in the page) — not sent = a single item for the app */
      items: { appId: string; pages?: { id: string; labelKey: string; path: string }[] }[];
    }[];
  }[];
  pins: { appIds: string[]; source: 'USER' | 'TENANT' | 'SYSTEM'; revision: number };
  limits: { maxPins: number };
  features: { shellV2: boolean };
}

export interface AppHrefInput {
  hostApp: HostApp;
  path: string;
  /** the app currently shown */
  currentHost: HostApp;
  hostOrigins: Partial<Record<HostApp, string>>;
  /** the organization identifier the app already uses (not personal data) — forwarded only when present */
  tenantAlias?: string;
}

/**
 * a path in the same app = relative; the other app = absolute per the configured origin
 * unknown origin of the other app = `null` (never guess localhost — a link in production would point at the user's machine)
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
): { apps: ShellApp[]; groups: ShellGroup[]; areas: ShellArea[] } {
  // an app with an unknown origin (deployment not configured) is dropped from the shell instead of guessing a URL
  const apps = response.apps.flatMap((app) => {
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
  });
  return {
    apps,
    groups: response.groups.map((group) => ({
      id: group.id,
      label: options.translate(group.labelKey),
    })),
    areas: toShellAreas(response, apps, options),
  };
}

/**
 * #651: areas/sub-menu from the server — items with an unknown origin (not in `apps`) are dropped, then sub-groups or areas left empty go with them
 * (the rail has no button that goes nowhere); the area `href` = the first remaining item
 */
function toShellAreas(
  response: NavigationResponseV1,
  apps: readonly ShellApp[],
  options: {
    currentHost: HostApp;
    hostOrigins: Partial<Record<HostApp, string>>;
    tenantAlias?: string;
    translate: (key: string) => string;
  },
): ShellArea[] {
  const { translate } = options;
  const byId = new Map(apps.map((app) => [app.id, app]));
  const hostOf = new Map(response.apps.map((app) => [app.id, app.hostApp]));
  return (response.areas ?? []).flatMap((area) => {
    const sections = area.sections.flatMap((section) => {
      const items = section.items.flatMap((item) => {
        const app = byId.get(item.appId);
        const hostApp = hostOf.get(item.appId);
        if (!app || !hostApp) return [];
        // #658: each sub-page is its own item; a page whose href cannot be composed is dropped (like an app with an unknown origin)
        if (item.pages && item.pages.length > 0) {
          return item.pages.flatMap((page) => {
            const href = buildAppHref({
              hostApp,
              path: page.path,
              currentHost: options.currentHost,
              hostOrigins: options.hostOrigins,
              tenantAlias: options.tenantAlias,
            });
            return href === null
              ? []
              : [
                  {
                    id: app.id,
                    pageId: page.id,
                    label: translate(page.labelKey),
                    href,
                    external: app.external,
                  },
                ];
          });
        }
        return [{ id: app.id, label: app.label, href: app.href, external: app.external }];
      });
      return items.length > 0
        ? [{ id: section.id, label: translate(section.labelKey), items }]
        : [];
    });
    const first = sections[0]?.items[0];
    return first
      ? [
          {
            id: area.id,
            label: translate(area.labelKey),
            href: first.href,
            external: first.external,
            sections,
          },
        ]
      : [];
  });
}

export interface ShellNavigationOptions {
  apiBaseUrl: string;
  accessToken: () => string | undefined;
  currentHost: HostApp;
  /** unknown origin of the other app = that side's apps are not shown in the shell */
  hostOrigins: Partial<Record<HostApp, string>>;
  tenantAlias?: string;
  translate: (key: string) => string;
  /** called when saving pins fails (the screen has already reverted to the previous value) */
  onPinError?: (error: unknown) => void;
  fetch?: typeof fetch;
}

export type ShellNavigationState =
  | { status: 'loading' }
  | { status: 'legacy'; apps?: ShellApp[] }
  | {
      status: 'ready';
      apps: ShellApp[];
      groups: ShellGroup[];
      /** #651: work areas on the rail; empty = an older API → the rail uses the old app pins */
      areas: ShellArea[];
      pinnedIds: string[];
      maxPins: number;
      togglePin: (appId: string) => void;
    };

export function useShellNavigation(options: ShellNavigationOptions): ShellNavigationState {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [response, setResponse] = useState<NavigationResponseV1 | null>(null);
  // ref is the real latest value (including optimistic) — written only through update(), never during render
  // because a render that comes before the update commits may write a stale value over it, and the next press computes from the stale value
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

  // the pins last confirmed by the server — every PUT uses this revision and requests are sent one at a time (no self-collision)
  const confirmed = useRef<{ appIds: string[]; revision: number } | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    if (response && confirmed.current === null) confirmed.current = response.pins;
  }, [response]);

  const reload = useCallback(async () => {
    const body = await load();
    confirmed.current = body.pins;
  }, [load]);

  // send the request outside the setState updater — StrictMode calls the updater twice, which would fire a duplicate PUT
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
        // the previous request already saved the same set (pressed repeatedly) — no need to send again
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
            // keep the order the user currently sees (more presses may have happened while waiting) but take the revision from the server
            update((latest) =>
              latest
                ? { ...latest, pins: { ...latest.pins, revision: saved.revision, source: 'USER' } }
                : latest,
            );
            return;
          }
          // a real revision conflict (another tab/machine already edited) → use the latest value from the server
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
  // #684: with the shell off, the Home can still use the list the server already filtered by permission; a failed load does not guess the list
  if (decision === 'legacy' || !response) {
    return {
      status: 'legacy',
      ...(response ? { apps: toShellModel(response, options).apps } : {}),
    };
  }
  const { apps, groups, areas } = toShellModel(response, options);
  const visible = new Set(apps.map((app) => app.id));
  return {
    status: 'ready',
    apps,
    groups,
    areas,
    pinnedIds: response.pins.appIds.filter((id) => visible.has(id)),
    maxPins: response.limits.maxPins,
    togglePin,
  };
}
