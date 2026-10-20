import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '@d-contact/i18n/react';
import { Button } from '@d-contact/ui-react';
import { CatalogApiError } from '../voice-routing/api.js';
import type { PeopleDirectoryApi, PeopleDirectoryUser } from './directory-api.js';

export function PeopleDirectory({
  api,
  onFailure,
  onOperation,
  canOpenOperation,
}: {
  api: PeopleDirectoryApi;
  canOpenOperation: boolean;
  onFailure(error: unknown): void;
  onOperation(reference: { commandId: string; operationId: string }): void;
}) {
  const { t: translate } = useTranslation('tenantPeople');
  const label = translate as (key: string) => string;
  const [items, setItems] = useState<PeopleDirectoryUser[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<PeopleDirectoryUser>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const active = useRef(false),
    inFlight = useRef(false);
  const callbacks = useRef({ onFailure, onOperation });
  callbacks.current = { onFailure, onOperation };
  function failed(error: unknown) {
    if (!active.current) return;
    setError(true);
    if (error instanceof CatalogApiError && [401, 403].includes(error.status)) {
      setItems([]);
      setSelected(undefined);
      setNextCursor(null);
      callbacks.current.onFailure(error);
    }
  }
  async function load(cursor?: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(false);
    try {
      const result = await api.list(cursor);
      if (active.current) {
        setItems((previous) => (cursor ? [...previous, ...result.items] : result.items));
        setNextCursor(result.nextCursor);
      }
    } catch (error) {
      failed(error);
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  }
  async function select(userId: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(false);
    setSelected(undefined);
    try {
      const value = await api.detail(userId);
      if (active.current) setSelected(value);
    } catch (error) {
      failed(error);
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  }
  useEffect(() => {
    active.current = true;
    void load();
    return () => {
      active.current = false;
    };
  }, [api]);
  return (
    <section aria-label={label('directory.title')} aria-busy={busy}>
      <h2>{label('directory.title')}</h2>
      {error ? <p role="status">{label('directory.failed')}</p> : null}
      {!busy && !error && !items.length ? <p>{label('directory.empty')}</p> : null}
      <Button isDisabled={busy} onPress={() => void load()}>
        {label('directory.reload')}
      </Button>
      <ul>
        {items.map((user) => (
          <li key={user.id}>
            <span>
              {user.displayName} — {label(`roles.${user.role}`)}
            </span>
            <Button isDisabled={busy} onPress={() => void select(user.id)}>
              {label('directory.open')} {user.displayName}
            </Button>
          </li>
        ))}
      </ul>
      {nextCursor ? (
        <Button isDisabled={busy} onPress={() => void load(nextCursor)}>
          {label('directory.more')}
        </Button>
      ) : null}
      {selected ? (
        <section aria-label={label('directory.detail')}>
          <h3>{selected.displayName}</h3>
          <dl>
            <dt>{label('email')}</dt>
            <dd>{selected.email}</dd>
            <dt>{label('directory.username')}</dt>
            <dd>{selected.username}</dd>
            <dt>{label('role')}</dt>
            <dd>{label(`roles.${selected.role}`)}</dd>
            <dt>{label('extension')}</dt>
            <dd>{selected.extensionRef ?? label('directory.none')}</dd>
          </dl>
          <p>
            {selected.accountState === 'PENDING_ACTIVATION' &&
            selected.provisioningState === 'PROVISIONED'
              ? label('provisioned')
              : label('directory.unverified')}
          </p>
          {selected.operationId && selected.commandId ? (
            <Button
              isDisabled={busy || !canOpenOperation}
              onPress={() =>
                callbacks.current.onOperation({
                  operationId: selected.operationId!,
                  commandId: selected.commandId!,
                })
              }
            >
              {label('directory.status')}
            </Button>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}
