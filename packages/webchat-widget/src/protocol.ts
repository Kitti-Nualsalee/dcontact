/**
 * #1044: messages between the loader on the host page and the chat frame. Both sides check the sender:
 * the frame listens only to its parent window, the loader only to its own iframe on the widget's origin.
 */
export const WEBCHAT_SOURCE = 'dc-webchat';

export type FrameToHost =
  | { source: typeof WEBCHAT_SOURCE; type: 'ready' }
  | { source: typeof WEBCHAT_SOURCE; type: 'minimize' }
  | { source: typeof WEBCHAT_SOURCE; type: 'unread'; count: number }
  /** the session to keep on the host page too, for browsers that give an embedded frame no storage */
  | { source: typeof WEBCHAT_SOURCE; type: 'session'; value: string | null };

export type HostToFrame =
  | { source: typeof WEBCHAT_SOURCE; type: 'visibility'; open: boolean }
  | { source: typeof WEBCHAT_SOURCE; type: 'session'; value: string | null };

export function isWebchatMessage(data: unknown): data is { source: string; type: string } {
  return (
    !!data &&
    typeof data === 'object' &&
    (data as { source?: unknown }).source === WEBCHAT_SOURCE &&
    typeof (data as { type?: unknown }).type === 'string'
  );
}
