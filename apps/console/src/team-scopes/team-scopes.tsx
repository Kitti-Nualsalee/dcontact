import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from '@d-contact/i18n/react';
import { Button, TextField } from '@d-contact/ui-react';
import type { TeamScopeApi, TeamViewScope } from './api.js';

export function TeamScopes({ api, canEdit }: { api: TeamScopeApi; canEdit: boolean }) {
  const { t: translate } = useTranslation('integrations');
  const t = translate as unknown as (key: string) => string;
  const [scopes, setScopes] = useState<TeamViewScope[]>([]);
  const [teamId, setTeamId] = useState('');
  const [segmentId, setSegmentId] = useState('');
  const [reasonCode, setReasonCode] = useState('');
  const [error, setError] = useState<string>();
  const reload = useCallback(async () => {
    try {
      setScopes((await api.list()).scopes);
      setError(undefined);
    } catch {
      setError(t('dphoneEmbedding.teamScopes.errors.load'));
    }
  }, [api, t]);
  useEffect(() => void reload(), [reload]);
  const grant = async () => {
    try {
      await api.grant({ teamId, segmentId });
      setTeamId('');
      setSegmentId('');
      await reload();
    } catch {
      setError(t('dphoneEmbedding.teamScopes.errors.grant'));
    }
  };
  const revoke = async (grantId: string) => {
    try {
      await api.revoke(grantId, reasonCode);
      setReasonCode('');
      await reload();
    } catch {
      setError(t('dphoneEmbedding.teamScopes.errors.revoke'));
    }
  };
  return (
    <section className="dphone-embedding__form" aria-label={t('dphoneEmbedding.teamScopes.title')}>
      <h2>{t('dphoneEmbedding.teamScopes.title')}</h2>
      <p>{t('dphoneEmbedding.teamScopes.description')}</p>
      {error ? (
        <p role="alert" className="dphone-embedding__error">
          {error}
        </p>
      ) : null}
      <table className="dphone-embedding__table">
        <thead>
          <tr>
            <th>{t('dphoneEmbedding.teamScopes.table.teamId')}</th>
            <th>{t('dphoneEmbedding.teamScopes.table.segment')}</th>
            <th>{t('dphoneEmbedding.teamScopes.table.grant')}</th>
            {canEdit ? <th>{t('dphoneEmbedding.teamScopes.table.actions')}</th> : null}
          </tr>
        </thead>
        <tbody>
          {scopes.length === 0 ? (
            <tr>
              <td colSpan={canEdit ? 4 : 3}>{t('dphoneEmbedding.teamScopes.table.empty')}</td>
            </tr>
          ) : (
            scopes.map((scope) => (
              <tr key={scope.grantId}>
                <td>
                  <code>{scope.teamId}</code>
                </td>
                <td>{scope.segmentId}</td>
                <td>
                  <code>{scope.grantId}</code>
                </td>
                {canEdit ? (
                  <td>
                    <Button
                      size="sm"
                      variant="danger"
                      isDisabled={reasonCode.trim().length < 3}
                      onPress={() => void revoke(scope.grantId)}
                    >
                      {t('dphoneEmbedding.teamScopes.actions.revoke')}
                    </Button>
                  </td>
                ) : null}
              </tr>
            ))
          )}
        </tbody>
      </table>
      {canEdit ? (
        <>
          <TextField
            label={t('dphoneEmbedding.teamScopes.form.teamId')}
            value={teamId}
            onChange={setTeamId}
          />
          <TextField
            label={t('dphoneEmbedding.teamScopes.form.segmentId')}
            value={segmentId}
            onChange={setSegmentId}
          />
          <TextField
            label={t('dphoneEmbedding.teamScopes.form.revokeReason')}
            value={reasonCode}
            onChange={setReasonCode}
          />
          <Button variant="primary" isDisabled={!teamId || !segmentId} onPress={() => void grant()}>
            {t('dphoneEmbedding.teamScopes.actions.grant')}
          </Button>
        </>
      ) : (
        <p>{t('dphoneEmbedding.teamScopes.readOnly')}</p>
      )}
    </section>
  );
}
