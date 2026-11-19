import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from '@d-contact/i18n/react';
import {
  Badge,
  Button,
  Cell,
  Column,
  Dialog,
  Row,
  Select,
  Table,
  TableBody,
  TableHeader,
  TextField,
  toastQueue,
} from '@d-contact/ui-react';
import { Skeleton } from '../customers/skeleton.js';
import { ConsoleShell, type ConsoleShellProps } from '../shell/console-shell.js';
import type { TeamScopeApi, TeamScopePermission } from '../team-scopes/api.js';
import {
  accessRows,
  grantableTeams,
  hasGrant,
  PERMISSIONS,
  remainingPermission,
  SEGMENT_LABEL_KEYS,
  SYSTEM_SEGMENTS,
  validRevokeReason,
  type AccessRow,
  type AccessTeam,
} from './model.js';
import '../customers/customers.css';
import './customer-access.css';

export interface CustomerAccessTeamsApi {
  list(cursor?: string): Promise<{ teams: AccessTeam[]; nextCursor: string | null }>;
}

type Props = {
  scopes: TeamScopeApi;
  teams: CustomerAccessTeamsApi;
  identityKey: string;
  signedIn?: boolean;
  onSignIn?: () => void;
  teamsHref: string;
  shell: Omit<ConsoleShellProps, 'appId' | 'children'>;
};

/** รายชื่อทีมไม่เกิน 10 หน้า (500 ทีม) — เกินนั้นแถวที่ไม่รู้จักแสดงรหัสทีมแทน */
const TEAM_PAGES = 10;

/** #915: Admin ให้/ถอนสิทธิ์ WORK และ VIEW ของทีมบน segment ระบบของ #911 */
export function CustomerAccessPage(props: Props) {
  return (
    <ConsoleShell {...props.shell} appId="customer-access">
      <AccessSession key={props.identityKey} {...props} />
    </ConsoleShell>
  );
}

function status(error: unknown) {
  return error instanceof Error ? /HTTP_(\d+)|^(\d{3})$/.exec(error.message) : null;
}

function denied(error: unknown) {
  const match = status(error);
  const code = Number(match?.[1] ?? match?.[2] ?? (error as { status?: number })?.status);
  return code === 401 || code === 403;
}

function AccessSession({ scopes, teams, signedIn = true, onSignIn, teamsHref }: Props) {
  const { t: translate } = useTranslation('customerAccess');
  const t = translate as (key: string, options?: Record<string, unknown>) => string;
  const [rows, setRows] = useState<AccessRow[]>([]);
  const [teamList, setTeamList] = useState<AccessTeam[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<'load' | 'access' | undefined>();
  const [teamsError, setTeamsError] = useState(false);
  const [version, setVersion] = useState(0);
  const [teamId, setTeamId] = useState<string>();
  const [segmentId, setSegmentId] = useState<string>(SYSTEM_SEGMENTS[0]);
  const [permission, setPermission] = useState<TeamScopePermission>('WORK');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string>();
  const [revoking, setRevoking] = useState<AccessRow>();
  const [reason, setReason] = useState('');
  const [revokeError, setRevokeError] = useState<string>();

  const reload = useCallback(() => setVersion((value) => value + 1), []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void (async () => {
      const loadedTeams: AccessTeam[] = [];
      let teamsFailed = false;
      try {
        let cursor: string | undefined;
        for (let page = 0; page < TEAM_PAGES; page += 1) {
          const result = await teams.list(cursor);
          loadedTeams.push(...result.teams);
          if (!result.nextCursor) break;
          cursor = result.nextCursor;
        }
      } catch {
        teamsFailed = true;
      }
      try {
        const result = await scopes.list();
        if (!active) return;
        setRows(accessRows(result.scopes, loadedTeams));
        setTeamList(loadedTeams);
        setTeamsError(teamsFailed);
        setLoadError(undefined);
      } catch (error) {
        if (!active) return;
        setLoadError(denied(error) ? 'access' : 'load');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [scopes, teams, version]);

  const options = useMemo(() => grantableTeams(teamList), [teamList]);
  const selectedTeam = teamId && options.some((team) => team.id === teamId) ? teamId : undefined;
  const duplicate =
    !!selectedTeam && hasGrant(rows, { teamId: selectedTeam, segmentId, permission });
  const segmentLabel = (id: string) =>
    Object.hasOwn(SEGMENT_LABEL_KEYS, id)
      ? t(SEGMENT_LABEL_KEYS[id as keyof typeof SEGMENT_LABEL_KEYS])
      : id;
  // รายชื่อทีมโหลดไม่สำเร็จ ≠ ทีมไม่มีอยู่ — อย่าติดป้าย "ไม่พบ" ให้ทุกแถว
  const teamLabel = (row: AccessRow) =>
    row.teamName ?? t(teamsError ? 'teamUnresolved' : 'unknownTeam');
  // ถอนสิทธิ์หนึ่งแบบไม่กระทบอีกแบบบน team+segment เดียวกัน — บอก Admin ให้ชัด
  const keptPermission = revoking ? remainingPermission(rows, revoking) : undefined;

  async function grant() {
    if (!selectedTeam || duplicate) return;
    setBusy(true);
    setFormError(undefined);
    try {
      const result = await scopes.grant({ teamId: selectedTeam, segmentId, permission });
      toastQueue.add(
        { title: t(result?.outcome === 'DUPLICATE' ? 'duplicate' : 'granted'), tone: 'success' },
        { timeout: 6000 },
      );
      setTeamId(undefined);
      reload();
    } catch (error) {
      setFormError(t(denied(error) ? 'errors.access' : 'errors.grant'));
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (!revoking || !validRevokeReason(reason)) return;
    setBusy(true);
    setRevokeError(undefined);
    try {
      await scopes.revoke(revoking.grantId, reason.trim());
      setRevoking(undefined);
      setReason('');
      toastQueue.add({ title: t('revoked'), tone: 'success' }, { timeout: 6000 });
      reload();
    } catch (error) {
      setRevokeError(t(denied(error) ? 'errors.access' : 'errors.revoke'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="cu-root">
      <h1>{t('title')}</h1>
      <p className="cu-muted">{t('description')}</p>
      {!signedIn ? (
        <div role="alert" className="cu-alert">
          <p>{t('errors.session')}</p>
          {onSignIn ? <Button onPress={onSignIn}>{t('signIn')}</Button> : null}
        </div>
      ) : loadError ? (
        <div role="alert" className="cu-alert">
          <p>{t(`errors.${loadError}`)}</p>
          {loadError === 'load' ? <Button onPress={reload}>{t('retry')}</Button> : null}
        </div>
      ) : (
        <>
          <section className="cu-search" aria-label={t('grantTitle')}>
            {!loading && options.length === 0 && !teamsError ? (
              <div role="status" className="cu-notice">
                <p>{t('noTeams')}</p>
                <a className="ca-link" href={teamsHref}>
                  {t('openTeams')}
                </a>
              </div>
            ) : (
              <>
                <Select
                  label={t('team')}
                  options={options.map((team) => ({ id: team.id, label: team.name }))}
                  selectedKey={selectedTeam ?? null}
                  onSelectionChange={(key) => {
                    setTeamId(key ? String(key) : undefined);
                    setFormError(undefined);
                  }}
                  isDisabled={loading || busy}
                />
                <Select
                  label={t('segment')}
                  options={SYSTEM_SEGMENTS.map((id) => ({ id, label: segmentLabel(id) }))}
                  selectedKey={segmentId}
                  onSelectionChange={(key) => key && setSegmentId(String(key))}
                  isDisabled={loading || busy}
                />
                <Select
                  label={t('permission')}
                  options={PERMISSIONS.map((id) => ({ id, label: t(`permissions.${id}`) }))}
                  selectedKey={permission}
                  onSelectionChange={(key) => key && setPermission(key as TeamScopePermission)}
                  isDisabled={loading || busy}
                />
                <div className="cu-actions">
                  <Button
                    variant="primary"
                    isDisabled={loading || busy || !selectedTeam || duplicate}
                    onPress={() => void grant()}
                  >
                    {t('grant')}
                  </Button>
                </div>
              </>
            )}
          </section>
          <section className="ca-perms" aria-labelledby="ca-perms-title">
            <h2 id="ca-perms-title">{t('permissionsTitle')}</h2>
            <dl>
              {PERMISSIONS.map((id) => (
                <div key={id}>
                  <dt>
                    <Badge tone={id === 'WORK' ? 'info' : 'neutral'}>
                      {t(`permissions.${id}`)}
                    </Badge>
                  </dt>
                  <dd>{t(`permissionHint.${id}`)}</dd>
                </div>
              ))}
            </dl>
            <p className="cu-muted">{t('permissionAdvice')}</p>
          </section>
          {duplicate ? (
            <p role="status" className="cu-muted ca-duplicate">
              {t('duplicate')}
            </p>
          ) : null}
          {formError ? (
            <div role="alert" className="cu-alert">
              <p>{formError}</p>
            </div>
          ) : null}
          {teamsError ? (
            <div role="status" className="cu-notice">
              <p>{t('errors.teams')}</p>
              <Button onPress={reload}>{t('retry')}</Button>
            </div>
          ) : null}
          {loading ? (
            <Skeleton label={t('loading')} rows={4} />
          ) : rows.length === 0 ? (
            <p>{t('empty')}</p>
          ) : (
            <div className="ca-scroll" role="region" aria-label={t('title')} tabIndex={0}>
              <Table aria-label={t('title')} className="ca-table">
                <TableHeader>
                  <Column isRowHeader>{t('team')}</Column>
                  <Column>{t('segment')}</Column>
                  <Column>{t('permission')}</Column>
                  <Column>{t('actions')}</Column>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <Row key={row.grantId} id={row.grantId}>
                      <Cell>
                        <div>{teamLabel(row)}</div>
                        {row.teamName === null ? (
                          <code className="cu-muted ca-id">{row.teamId}</code>
                        ) : !row.teamActive ? (
                          <span className="cu-muted">{t('inactiveTeam')}</span>
                        ) : null}
                      </Cell>
                      <Cell>{segmentLabel(row.segmentId)}</Cell>
                      <Cell>
                        <Badge
                          className="ca-badge"
                          tone={row.permission === 'WORK' ? 'info' : 'neutral'}
                        >
                          {t(`permissions.${row.permission}`)}
                        </Badge>
                      </Cell>
                      <Cell>
                        <div className="cu-actions">
                          <Button
                            isDisabled={busy}
                            onPress={() => {
                              setRevoking(row);
                              setReason('');
                              setRevokeError(undefined);
                            }}
                          >
                            {t('revoke')}
                          </Button>
                        </div>
                      </Cell>
                    </Row>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <Dialog
            role="alertdialog"
            title={t('revokeTitle')}
            isOpen={!!revoking}
            onOpenChange={(open) => {
              if (!open && !busy) setRevoking(undefined);
            }}
            footer={() => (
              <>
                <Button onPress={() => setRevoking(undefined)} isDisabled={busy}>
                  {t('cancel')}
                </Button>
                <Button
                  variant="danger"
                  isDisabled={busy || !validRevokeReason(reason)}
                  onPress={() => void revoke()}
                >
                  {t('revoke')}
                </Button>
              </>
            )}
          >
            <div className="ca-dialog">
              {revoking ? (
                <>
                  <p>
                    <strong>{teamLabel(revoking)}</strong> · {segmentLabel(revoking.segmentId)} ·{' '}
                    {t(`permissions.${revoking.permission}`)}
                  </p>
                  <p>{t(`revokeBody.${revoking.permission}`)}</p>
                  {keptPermission ? (
                    <p>{t('revokeKeeps', { permission: t(`permissions.${keptPermission}`) })}</p>
                  ) : null}
                  <p className="cu-muted">{t('revokeAgain')}</p>
                </>
              ) : null}
              <TextField
                label={t('reason')}
                description={t('reasonHint')}
                value={reason}
                onChange={setReason}
                isDisabled={busy}
              />
              {revokeError ? (
                <div role="alert" className="cu-alert">
                  <p>{revokeError}</p>
                </div>
              ) : null}
            </div>
          </Dialog>
        </>
      )}
    </main>
  );
}
