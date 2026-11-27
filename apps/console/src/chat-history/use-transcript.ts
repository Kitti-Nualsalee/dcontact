import { useCallback, useEffect, useState } from 'react';
import type { WorkTranscript } from './transcript.js';

export type TranscriptState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready'; transcript: WorkTranscript }
  | { phase: 'failed'; status: number };

/**
 * #1044: loads the conversation of one work item; `enabled` is false for a call, which has nothing to load.
 * A failure is kept apart from the page's own error so the recorded outcome stays on screen (spec "partial")
 */
export function useTranscript(
  load: (interactionId: string) => Promise<WorkTranscript>,
  interactionId: string | null,
  enabled: boolean,
): { state: TranscriptState; retry(): void } {
  const [state, setState] = useState<TranscriptState>({ phase: 'idle' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!interactionId || !enabled) {
      setState({ phase: 'idle' });
      return;
    }
    let active = true;
    setState({ phase: 'loading' });
    void load(interactionId)
      .then((transcript) => {
        if (active) setState({ phase: 'ready', transcript });
      })
      .catch((failure: unknown) => {
        const status = (failure as { status?: unknown } | null)?.status;
        if (active)
          setState({ phase: 'failed', status: typeof status === 'number' ? status : 500 });
      });
    return () => {
      active = false;
    };
  }, [load, interactionId, enabled, attempt]);
  const retry = useCallback(() => setAttempt((current) => current + 1), []);
  return { state, retry };
}
