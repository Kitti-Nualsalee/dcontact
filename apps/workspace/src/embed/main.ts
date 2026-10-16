import { resolveLocale } from '@d-contact/i18n';
import { appI18n } from '../i18n/index.js';
import type { EmbeddedAuth } from './embedded-auth.js';
import type { EmbedRuntime } from './embed-runtime.js';
import { mountRuntime } from './embedded-runtime-window.js';
import { mountOwner, mountOwnerController } from './owner-window.js';
import {
  lockHostOrigin,
  parseEmbedConfig,
  resolveHostOrigin,
  type HostOriginLock,
} from './origin-lock.js';

declare global {
  interface Window {
    __dphoneEmbed?: {
      lock: HostOriginLock | null;
      tenant: string | null;
      auth: EmbeddedAuth | null;
      runtime?: EmbedRuntime;
    };
  }
}

const config = parseEmbedConfig(document.getElementById('dphone-embed-config')?.textContent);
const locale = resolveLocale({ browser: navigator.languages });
void appI18n.changeLanguage(locale);
document.documentElement.lang = locale;
const lock =
  window.parent === window
    ? null
    : lockHostOrigin(
        config,
        resolveHostOrigin({
          ancestorOrigins: window.location.ancestorOrigins,
          referrer: document.referrer,
        }),
        window.parent,
      );
document.documentElement.dataset.embedState = lock ? 'locked' : 'blocked';
window.__dphoneEmbed = { lock, tenant: config?.tenant ?? null, auth: null };

if (config?.ownerWindow && window.parent === window) {
  mountOwner(config);
} else if (config && lock) {
  if (config.ownerWindow) mountOwnerController(config, lock);
  else {
    const runtime = mountRuntime(config, lock, window.parent);
    if (runtime) {
      window.addEventListener('message', (event) => runtime.receive(event));
      runtime.reconnect();
    }
  }
}
