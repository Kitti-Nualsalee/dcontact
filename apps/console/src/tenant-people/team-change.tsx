import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '@d-contact/i18n/react';
import { Button, Dialog, Select, TextField } from '@d-contact/ui-react';
import { CatalogApiError } from '../voice-routing/api.js';
import type { PeopleDirectoryApi, PeopleDirectoryUser } from './directory-api.js';
import { accountStatus } from './directory.js';

const KNOWN = [
  'CONFIG_BUSY',
  'REVISION_CONFLICT',
  'REFERENCE_SCOPE_MISMATCH',
  'ACCOUNT_STATE_CONFLICT',
  'AGENT_SESSION_ACTIVE',
] as const;
type Failure = (typeof KNOWN)[number] | 'FAILED' | 'UNKNOWN';

/** statuses that allow a team move — matching what the server accepts (provisioning/disabled/needs-review are rejected) */
const MOVABLE = new Set(['ACTIVE', 'PENDING_ACTIVATION', 'UNKNOWN']);

/**
 * #998 1A: Admin moves an account's team without touching Keycloak
 * the command answers the result immediately; an uncertain result is not resent automatically: reload the detail so the Admin decides from the real status
 */
export function PeopleTeamChange({
  api,
  user,
  teams,
  onUser,
  onFailure,
}: {
  api: PeopleDirectoryApi;
  user: PeopleDirectoryUser;
  teams: { id: string; name: string }[];
  onUser(user: PeopleDirectoryUser): void;
  onFailure(error: unknown): void;
}) {
  const { t: translate } = useTranslation('tenantPeople');
  const label = translate as (key: string, values?: Record<string, unknown>) => string;
  const [open, setOpen] = useState(false);
  const [teamId, setTeamId] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Failure>();
  const [done, setDone] = useState('');
  const mounted = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  if (!api.changeTeam) return null;
  const choices = teams.filter((team) => team.id !== user.teamId);
  const movable = MOVABLE.has(accountStatus(user));
  const trimmed = reason.trim();
  const valid = !!teamId && trimmed.length > 0 && [...trimmed].length <= 500;
  function close() {
    setOpen(false);
    setTeamId('');
    setReason('');
    setError(undefined);
  }
  async function refresh() {
    try {
      const detail = await api.detail(user.id);
      if (mounted.current) onUser(detail);
    } catch (value) {
      onFailure(value);
    }
  }
  async function submit() {
    if (inFlight.current || !valid || !api.changeTeam) return;
    inFlight.current = true;
    setBusy(true);
    setError(undefined);
    const target = teams.find((team) => team.id === teamId);
    try {
      await api.changeTeam(user.id, {
        commandId: crypto.randomUUID(),
        expectedRevision: user.configRevision,
        teamId,
        reason: trimmed,
      });
      if (!mounted.current) return;
      setDone(label('teamChange.done', { team: target?.name ?? '' }));
      close();
      await refresh();
    } catch (value) {
      if (!mounted.current) return;
      if (value instanceof CatalogApiError && [401, 403].includes(value.status)) {
        close();
        onFailure(value);
        return;
      }
      const known =
        value instanceof CatalogApiError &&
        value.status === 409 &&
        (KNOWN as readonly string[]).includes(value.code);
      if (known) setError(value.code as Failure);
      else if (value instanceof CatalogApiError && value.status === 400) setError('FAILED');
      else {
        // not known whether the server moved it: close the Dialog and read the real status, do not resend
        close();
        setDone(label('teamChange.errors.UNKNOWN'));
        await refresh();
      }
      if (known && value.code === 'REVISION_CONFLICT') await refresh();
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <>
      <Button
        variant="secondary"
        isDisabled={busy || !movable || !choices.length}
        onPress={() => {
          setDone('');
          setError(undefined);
          setReason('');
          setTeamId('');
          setOpen(true);
        }}
      >
        {label('teamChange.start')}
      </Button>
      {done ? (
        <p role="status" className="tp-muted tp-help">
          {done}
        </p>
      ) : null}
      {!movable ? <p className="tp-muted tp-help">{label('teamChange.notMovable')}</p> : null}
      <Dialog
        title={label('teamChange.title', { name: user.displayName })}
        isOpen={open}
        isDismissable={!busy}
        onOpenChange={(next) => {
          if (!next && !busy) close();
        }}
        footer={() => (
          <>
            <Button isDisabled={busy} onPress={close}>
              {label('disable.cancel')}
            </Button>
            <Button variant="primary" isDisabled={busy || !valid} onPress={() => void submit()}>
              {busy ? label('teamChange.saving') : label('teamChange.submit')}
            </Button>
          </>
        )}
      >
        <div className="tp-dialog-body">
          <p>
            {label(user.role === 'AGENT' ? 'teamChange.bodyAgent' : 'teamChange.body', {
              team: user.teamId
                ? (teams.find((team) => team.id === user.teamId)?.name ?? '—')
                : '—',
            })}
          </p>
          <Select
            label={label('teamChange.newTeam')}
            placeholder={label('teamChange.chooseTeam')}
            isRequired
            isDisabled={busy}
            selectedKey={teamId || null}
            onSelectionChange={(key) => setTeamId(key ? String(key) : '')}
            options={choices.map((team) => ({ id: team.id, label: team.name }))}
          />
          <TextField
            label={label('invitation.reason')}
            isRequired
            value={reason}
            onChange={setReason}
            isDisabled={busy}
            description={`${[...trimmed].length}/500`}
          />
          {error ? <p role="alert">{label(`teamChange.errors.${error}`)}</p> : null}
        </div>
      </Dialog>
    </>
  );
}
