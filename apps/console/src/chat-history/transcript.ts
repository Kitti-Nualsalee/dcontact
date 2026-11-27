/**
 * #1044: the conversation of a finished chat as the history pages read it, and how it becomes `ChatTranscript` lines
 *
 * kept free of React so the mapping can be unit tested
 */
import type { ChatTranscriptMessage } from '@d-contact/ui-react';
import type { HistoryChannel } from '../agent-history/model.js';

export const END_REASONS = [
  'CUSTOMER_ENDED',
  'AGENT_ENDED',
  'IDLE_TIMEOUT',
  'CUSTOMER_LEFT',
] as const;
export type EndReason = (typeof END_REASONS)[number];

export interface WorkTranscriptMessage {
  id: string;
  at: string;
  from: 'visitor' | 'agent' | 'system';
  text?: string;
  /** a system line: `AGENT_JOINED` or the end reason */
  event?: string;
}

export interface WorkTranscript {
  interactionId: string;
  channel: HistoryChannel;
  endReason: EndReason | null;
  customerLinked: boolean;
  messages: WorkTranscriptMessage[];
}

export function isWorkTranscript(value: unknown): value is WorkTranscript {
  if (!value || typeof value !== 'object') return false;
  const transcript = value as WorkTranscript;
  return (
    typeof transcript.interactionId === 'string' &&
    (transcript.channel === 'VOICE' || transcript.channel === 'WEBCHAT') &&
    (transcript.endReason === null ||
      (END_REASONS as readonly string[]).includes(transcript.endReason)) &&
    typeof transcript.customerLinked === 'boolean' &&
    Array.isArray(transcript.messages) &&
    transcript.messages.every(
      (message) =>
        !!message &&
        typeof message.id === 'string' &&
        typeof message.at === 'string' &&
        (message.from === 'visitor' || message.from === 'agent' || message.from === 'system'),
    )
  );
}

/** who closed the chat, as the catalog key under `chat.closedBy` */
export function closedByKey(endReason: EndReason | null): 'AGENT' | 'CUSTOMER' | 'IDLE' | null {
  switch (endReason) {
    case 'AGENT_ENDED':
      return 'AGENT';
    case 'CUSTOMER_ENDED':
    case 'CUSTOMER_LEFT':
      return 'CUSTOMER';
    case 'IDLE_TIMEOUT':
      return 'IDLE';
    default:
      return null;
  }
}

/** short code of a chat in the page title; the history has no visitor name, so the work id gives the reader something to quote */
export function visitorCode(interactionId: string): string {
  return interactionId.replace(/-/g, '').slice(0, 4).toUpperCase();
}

/** the number of lines a person wrote (system lines are not counted) */
export function writtenCount(transcript: Pick<WorkTranscript, 'messages'>): number {
  return transcript.messages.filter((message) => message.from !== 'system').length;
}

export interface TranscriptText {
  visitor: string;
  agent: string;
  /** text of a system line; the agent's name fills `{{agent}}` */
  system(event: string | undefined): string;
  time(at: string): string;
}

/**
 * the reader of a history page is not a party to the chat, so the visitor is on the left, the Agent on the right,
 * and every line names its sender (colour and side are never the only cue)
 */
export function toTranscriptMessages(
  transcript: Pick<WorkTranscript, 'messages'>,
  text: TranscriptText,
): ChatTranscriptMessage[] {
  return transcript.messages.map((message) => {
    const time = text.time(message.at);
    if (message.from === 'system')
      return { id: message.id, side: 'system', text: text.system(message.event), time };
    return {
      id: message.id,
      side: message.from === 'agent' ? 'self' : 'other',
      author: message.from === 'agent' ? text.agent : text.visitor,
      time,
      text: message.text ?? '',
    };
  });
}
