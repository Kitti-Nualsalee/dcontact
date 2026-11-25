import type { PhoneStatus } from './runtime.js';
import english from './locales/en.json' with { type: 'json' };
import thai from './locales/th.json' with { type: 'json' };

export type Language = 'th' | 'en';

type Text = typeof thai & {
  status: Record<PhoneStatus, { label: string; detail: string }>;
};

// The D-Phone extension page loads before Workspace, so it keeps its own small catalog
export const catalog: Record<Language, Text> = { th: thai, en: english satisfies typeof thai };
