import type { FreeSwitchEvent } from './freeswitch-normalizer.js';

/** Splits the headers of an event ESL sends as text/event-plain; does not interpret command replies */
export function parseEslEvent(frame: string): FreeSwitchEvent | undefined {
  const separator = frame.search(/\r?\n\r?\n/);
  const body = separator < 0 ? undefined : frame.slice(separator).replace(/^\r?\n\r?\n/, '');
  if (!body) return undefined;
  const eventSeparator = body.search(/\r?\n\r?\n/);
  const headers = eventSeparator < 0 ? body : body.slice(0, eventSeparator);
  const eventBody =
    eventSeparator < 0 ? undefined : body.slice(eventSeparator).replace(/^\r?\n\r?\n/, '');
  const event = Object.fromEntries(
    headers.split(/\r?\n/).flatMap((line) => {
      const delimiter = line.indexOf(': ');
      return delimiter > 0 ? [[line.slice(0, delimiter), line.slice(delimiter + 2)]] : [];
    }),
  );
  if (eventBody) event.Body = eventBody;
  return event['Event-Name'] ? event : undefined;
}
