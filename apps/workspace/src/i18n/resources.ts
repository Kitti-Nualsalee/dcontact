/**
 * D1.11 (#450): the app's message catalog — both languages' bundles load at start (not lazy)
 * so the language can switch at once with no request and no reload
 *
 * namespaces by app/screen: `common` is shared across the app; pages moved to the new shell (D1.14/D1.15)
 * add their own namespace, e.g. `journeys` — keys have the form `<category>.<thing>.<action>`
 * `pnpm i18n:check` in CI fails when a key is missing in either language
 */
// subpath without CSS — resources can be imported in Node unit tests
import { uiResources } from '@d-contact/ui-react/i18n';
import commonEn from './locales/en/common.json' with { type: 'json' };
import commonTh from './locales/th/common.json' with { type: 'json' };
import dphoneEn from './locales/en/dphone.json' with { type: 'json' };
import dphoneTh from './locales/th/dphone.json' with { type: 'json' };
import supervisorEn from './locales/en/supervisor.json' with { type: 'json' };
import supervisorTh from './locales/th/supervisor.json' with { type: 'json' };
import workspaceEn from './locales/en/workspace.json' with { type: 'json' };
import workspaceTh from './locales/th/workspace.json' with { type: 'json' };

export const DEFAULT_NAMESPACE = 'common';

// the `ui` namespace of the component layer (ADR-028) loads together, so the language switches across the whole screen at once
export const resources = {
  th: {
    common: commonTh,
    workspace: workspaceTh,
    dphone: dphoneTh,
    supervisor: supervisorTh,
    ...uiResources.th,
  },
  en: {
    common: commonEn,
    workspace: workspaceEn,
    dphone: dphoneEn,
    supervisor: supervisorEn,
    ...uiResources.en,
  },
} as const;
