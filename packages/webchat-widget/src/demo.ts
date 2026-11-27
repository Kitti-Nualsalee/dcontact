/** #1044: text of the preview page served by the API (`/api/v1/webchat/demo`). */
import { pickLocale, translator } from './messages.js';

const locale = pickLocale(navigator.languages ?? [navigator.language]);
const t = translator(locale);
document.documentElement.lang = locale;
document.title = t('demo.title');
const main = document.getElementById('dcw-demo');
if (main) {
  const heading = document.createElement('h1');
  heading.textContent = t('demo.title');
  const body = document.createElement('p');
  body.textContent = t('demo.body');
  main.append(heading, body);
}
