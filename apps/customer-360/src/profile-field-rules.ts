import {
  C360_PHONE_RAW_MAX,
  C360_EMAIL_RAW_MAX,
  C360_TAG_NAME_MAX,
  C360_PHONE_NORMALIZATION_VERSION,
  C360_EMAIL_NORMALIZATION_VERSION,
  C360_TAG_NORMALIZATION_VERSION,
} from '@d-contact/contact-points';
import { C360_CONTACT_POINT_QUOTA } from './profile-points.js';

/** C4 writer และ M1 metadata ใช้ authority เดียวกัน ไม่ใช่ UI validation fallback */
export const C360_PROFILE_RULE_VERSION = 'c360-profile-v1';
export const C360_PROFILE_TEXT_RULES = Object.freeze({
  displayName: Object.freeze({ maxCodeUnits: 160, required: true }),
  company: Object.freeze({ maxCodeUnits: 200, required: false }),
});
export function c360ProfileFieldRules() {
  return {
    version: C360_PROFILE_RULE_VERSION,
    fields: [
      ...(['displayName', 'company'] as const).map((name) => ({
        name,
        type: 'string',
        required: C360_PROFILE_TEXT_RULES[name].required,
        constraints: {
          maxCodeUnits: C360_PROFILE_TEXT_RULES[name].maxCodeUnits,
          controlsAllowed: false,
        },
        normalization: 'trim,NFC',
        normalizationVersion: C360_PROFILE_RULE_VERSION,
      })),
      {
        name: 'vip',
        type: 'boolean',
        required: false,
        constraints: null,
        normalization: null,
        normalizationVersion: null,
      },
      {
        name: 'phone',
        type: 'string',
        required: false,
        constraints: { maxCodeUnits: C360_PHONE_RAW_MAX, activePerKind: C360_CONTACT_POINT_QUOTA },
        normalization: 'E164,explicit-country,no-extension',
        normalizationVersion: C360_PHONE_NORMALIZATION_VERSION,
      },
      {
        name: 'email',
        type: 'string',
        required: false,
        constraints: { maxCodeUnits: C360_EMAIL_RAW_MAX, activePerKind: C360_CONTACT_POINT_QUOTA },
        normalization: 'local-part-case-preserved,IDNA-domain',
        normalizationVersion: C360_EMAIL_NORMALIZATION_VERSION,
      },
      {
        name: 'tags',
        type: 'catalog',
        required: false,
        constraints: { maxCodeUnits: C360_TAG_NAME_MAX },
        normalization: 'trim,NFC,Unicode-default-full-casefold,NFC',
        normalizationVersion: C360_TAG_NORMALIZATION_VERSION,
      },
    ],
  };
}
