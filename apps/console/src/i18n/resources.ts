import coreSettingsTh from './locales/th/core-settings.json' with { type: 'json' };
import coreSettingsEn from './locales/en/core-settings.json' with { type: 'json' };
import voiceRoutingTh from './locales/th/voice-routing.json' with { type: 'json' };
import tenantPeopleTh from './locales/th/tenant-people.json' with { type: 'json' };
import tenantPeopleEn from './locales/en/tenant-people.json' with { type: 'json' };
import voiceRoutingEn from './locales/en/voice-routing.json' with { type: 'json' };
/**
 * D1.11 (#450): the app's message catalogs — both language bundles load at startup (not lazy)
 * so the language can be switched instantly with no request and no reload
 *
 * namespaces by app/screen: `common` is shared across the app; pages moved to the new shell (D1.14/D1.15)
 * add their own namespace, e.g. `journeys` — keys have the shape `<category>.<thing>.<action>`
 * `pnpm i18n:check` in CI fails when a key is missing from either language
 */
// subpath without CSS — resources can be imported in Node unit tests
import { uiResources } from '@d-contact/ui-react/i18n';
import commonEn from './locales/en/common.json' with { type: 'json' };
import commonTh from './locales/th/common.json' with { type: 'json' };
import journeysEn from './locales/en/journeys.json' with { type: 'json' };
import journeysTh from './locales/th/journeys.json' with { type: 'json' };
import integrationsEn from './locales/en/integrations.json' with { type: 'json' };
import integrationsTh from './locales/th/integrations.json' with { type: 'json' };
import governanceEn from './locales/en/governance.json' with { type: 'json' };
import governanceTh from './locales/th/governance.json' with { type: 'json' };
import accountEn from './locales/en/account.json' with { type: 'json' };
import accountTh from './locales/th/account.json' with { type: 'json' };

import homeEn from './locales/en/home.json' with { type: 'json' };
import homeTh from './locales/th/home.json' with { type: 'json' };
import historyEn from './locales/en/history.json' with { type: 'json' };
import historyTh from './locales/th/history.json' with { type: 'json' };
import customersEn from './locales/en/customers.json' with { type: 'json' };
import customersTh from './locales/th/customers.json' with { type: 'json' };
import customerTagsEn from './locales/en/customer-tags.json' with { type: 'json' };
import customerTagsTh from './locales/th/customer-tags.json' with { type: 'json' };

import customerOverviewTh from './locales/th/customer-overview.json' with { type: 'json' };
import customerOverviewEn from './locales/en/customer-overview.json' with { type: 'json' };

import customerActivityTh from './locales/th/customer-activity.json' with { type: 'json' };
import customerActivityEn from './locales/en/customer-activity.json' with { type: 'json' };

import customerImportTh from './locales/th/customer-import.json' with { type: 'json' };
import customerImportEn from './locales/en/customer-import.json' with { type: 'json' };

import customerAccessTh from './locales/th/customer-access.json' with { type: 'json' };
import customerAccessEn from './locales/en/customer-access.json' with { type: 'json' };

import casesTh from './locales/th/cases.json' with { type: 'json' };
import casesEn from './locales/en/cases.json' with { type: 'json' };
import recordingsTh from './locales/th/recordings.json' with { type: 'json' };
import recordingsEn from './locales/en/recordings.json' with { type: 'json' };
import qualityTh from './locales/th/quality.json' with { type: 'json' };
import qualityEn from './locales/en/quality.json' with { type: 'json' };
import teamHistoryTh from './locales/th/team-history.json' with { type: 'json' };
import teamHistoryEn from './locales/en/team-history.json' with { type: 'json' };

export const DEFAULT_NAMESPACE = 'common';

// the component layer's `ui` namespace (ADR-028) loads together, so the language switches across the whole screen at once
export const resources = {
  th: {
    common: commonTh,
    coreSettings: coreSettingsTh,
    voiceRouting: voiceRoutingTh,
    tenantPeople: tenantPeopleTh,
    home: homeTh,
    history: historyTh,
    customers: customersTh,
    customerTags: customerTagsTh,
    customerOverview: customerOverviewTh,
    customerActivity: customerActivityTh,
    customerImport: customerImportTh,
    customerAccess: customerAccessTh,
    cases: casesTh,
    recordings: recordingsTh,
    quality: qualityTh,
    teamHistory: teamHistoryTh,
    journeys: journeysTh,
    integrations: integrationsTh,
    account: accountTh,
    governance: governanceTh,
    ...uiResources.th,
  },
  en: {
    common: commonEn,
    coreSettings: coreSettingsEn,
    voiceRouting: voiceRoutingEn,
    tenantPeople: tenantPeopleEn,
    home: homeEn,
    history: historyEn,
    customers: customersEn,
    customerTags: customerTagsEn,
    customerOverview: customerOverviewEn,
    customerActivity: customerActivityEn,
    customerImport: customerImportEn,
    customerAccess: customerAccessEn,
    cases: casesEn,
    recordings: recordingsEn,
    quality: qualityEn,
    teamHistory: teamHistoryEn,
    journeys: journeysEn,
    integrations: integrationsEn,
    account: accountEn,
    governance: governanceEn,
    ...uiResources.en,
  },
} as const;
