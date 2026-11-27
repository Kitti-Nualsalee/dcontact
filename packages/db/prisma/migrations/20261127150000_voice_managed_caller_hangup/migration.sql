-- Managed voice: record CALLER_HANGUP when the customer ends a bridged call (previously always AGENT_HANGUP).
-- Only widens the allowed values; existing rows keep their reason.
ALTER TABLE voice_managed_calls DROP CONSTRAINT voice_managed_calls_terminal_reason_check;
ALTER TABLE voice_managed_calls ADD CONSTRAINT voice_managed_calls_terminal_reason_check
  CHECK (terminal_reason IN ('PREANSWER_DEADLINE_EXCEEDED','CALLER_CANCELLED','AGENT_HANGUP','CALLER_HANGUP'));
