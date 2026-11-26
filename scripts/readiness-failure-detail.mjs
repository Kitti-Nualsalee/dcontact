import { sanitizeDiagnostic } from './phase-zero-readiness.mjs';

const NESTED_DETAIL_CHARACTERS = 1_200;
const TAIL_LINES = 40;

/**
 * #559: a nested acceptance (e.g. CG4 -> S1) prints its result as the JSON lines `readiness.suite`/`readiness.check`
 * which a `not ok`/`Error` style regex does not catch - pull out the lines with `status: FAIL` together with the detail of the innermost layer
 * so the detail of the outer suite can say which suite failed
 */
export function nestedReadinessFailures(output) {
  return sanitizeDiagnostic(output)
    .split('\n')
    .flatMap((line) => {
      const start = line.indexOf('{"type":"readiness.');
      if (start < 0) return [];
      let value;
      try {
        value = JSON.parse(line.slice(start));
      } catch {
        return [];
      }
      if (value?.status !== 'FAIL') return [];
      if (value.type !== 'readiness.suite' && value.type !== 'readiness.check') return [];
      const id = value.id ?? value.checkId ?? 'unknown';
      const command = Array.isArray(value.command) ? ` ${value.command.slice(-2).join(' ')}` : '';
      const detail =
        typeof value.detail === 'string' && value.detail
          ? `: ${
              value.detail.length > NESTED_DETAIL_CHARACTERS
                ? `${value.detail.slice(-NESTED_DETAIL_CHARACTERS)} (cut to the end)`
                : value.detail
            }`
          : '';
      return [`[nested ${value.type.slice('readiness.'.length)} ${id} FAIL${command}]${detail}`];
    });
}

/** The tail of the output for when no line at all can say what failed - better than only an exit status */
export function outputTail(output, lines = TAIL_LINES) {
  return sanitizeDiagnostic(output).split('\n').filter(Boolean).slice(-lines);
}
