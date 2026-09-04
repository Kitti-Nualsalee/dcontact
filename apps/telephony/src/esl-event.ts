import type { FreeSwitchEvent } from './freeswitch-normalizer.js';

/** แยก header ของ event ที่ ESL ส่งแบบ text/event-plain; ไม่ตีความ command reply */
export function parseEslEvent(frame: string): FreeSwitchEvent | undefined {
  const [, body] = frame.split(/\r?\n\r?\n/, 2);
  if (!body) return undefined;
  const event = Object.fromEntries(
    body.split(/\r?\n/).flatMap((line) => {
      const delimiter = line.indexOf(': ');
      return delimiter > 0 ? [[line.slice(0, delimiter), line.slice(delimiter + 2)]] : [];
    }),
  );
  return event['Event-Name'] ? event : undefined;
}
