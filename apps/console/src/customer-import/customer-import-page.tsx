import { useEffect, useMemo, useRef, useState } from 'react';
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
} from '@d-contact/ui-react';
import { CustomersApiError } from '../customers/api.js';
import { ConsoleShell, type ConsoleShellProps } from '../shell/console-shell.js';
import type { CustomerImportApi, ImportPreview, ImportResult } from './api.js';
import {
  IMPORT_FIELDS,
  PHONE_COUNTRIES,
  buildMapping,
  canResume,
  checkImportFile,
  filterPreviewRows,
  readCsvHeaders,
  suggestSelection,
  type ImportField,
  type ImportMapping,
  type ImportSelection,
  type RowFilter,
} from './model.js';
import '../customers/customers.css';
import './customer-import.css';

const PAGE_ROWS = 200;
const NONE = '__none';
const COUNTRY_NONE = '__none';

type Phase = 'pick' | 'previewing' | 'preview' | 'confirming' | 'result';
type Props = {
  api: CustomerImportApi;
  identityKey: string;
  signedIn?: boolean;
  onSignIn?: () => void;
  shell: Omit<ConsoleShellProps, 'appId' | 'children'>;
};

export function CustomerImportPage(props: Props) {
  return (
    <ConsoleShell {...props.shell} appId="customer-import">
      <ImportSession key={props.identityKey} {...props} />
    </ConsoleShell>
  );
}

function ImportSession({ api, signedIn = true, onSignIn }: Props) {
  const { t: translate } = useTranslation('customerImport');
  const t = translate as (key: string, options?: Record<string, unknown>) => string;
  const [file, setFile] = useState<File>();
  const [headers, setHeaders] = useState<string[]>([]);
  const [selection, setSelection] = useState<ImportSelection>({});
  const [country, setCountry] = useState('TH');
  const [phase, setPhase] = useState<Phase>('pick');
  const [preview, setPreview] = useState<ImportPreview>();
  const [used, setUsed] = useState<ImportMapping>();
  const [result, setResult] = useState<ImportResult>();
  const [filter, setFilter] = useState<RowFilter>('ALL');
  const [shown, setShown] = useState(PAGE_ROWS);
  const [error, setError] = useState('');
  const [blocked, setBlocked] = useState<'session' | 'access'>();
  const [asking, setAsking] = useState(false);
  // commandId คงเดิมต่อ (ไฟล์, plan) เพื่อให้ส่งซ้ำ/ส่งต่อไม่สร้างลูกค้าซ้ำ; ไม่เก็บลง storage
  const command = useRef<{ planHash: string; id: string } | undefined>(undefined);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const abort = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abort.current?.abort();
    };
  }, []);

  const unfinished =
    phase === 'confirming' || (phase === 'result' && !!result && canResume(result.counts));
  useEffect(() => {
    if (!unfinished) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [unfinished]);

  const mapping = useMemo(
    () => buildMapping(selection, headers, country === COUNTRY_NONE ? '' : country),
    [selection, headers, country],
  );
  const rows = useMemo(
    () => (preview ? filterPreviewRows(preview.rows, filter) : []),
    [preview, filter],
  );
  const nameIndex = preview && used ? preview.headers.indexOf(used.columns.displayName) : -1;

  function fail(failure: unknown) {
    if (failure instanceof DOMException && failure.name === 'AbortError') return;
    const code = failure instanceof CustomersApiError ? failure.code : 'REQUEST_FAILED';
    const status = failure instanceof CustomersApiError ? failure.status : 0;
    if (status === 401 || code === 'SESSION_REQUIRED') setBlocked('session');
    else if (status === 403) setBlocked('access');
    else setError(code);
  }

  async function onFile(next: File | undefined) {
    setError('');
    setPreview(undefined);
    setResult(undefined);
    setUsed(undefined);
    command.current = undefined;
    setPhase('pick');
    if (!next) {
      setFile(undefined);
      setHeaders([]);
      return;
    }
    // ตรวจขนาดก่อนอ่าน: ไฟล์ใหญ่ไม่ถูกโหลดเข้าหน่วยความจำ
    const early = checkImportFile(next.size, []);
    if (early === 'EMPTY' || early === 'TOO_LARGE') {
      setFile(undefined);
      setHeaders([]);
      setError(`file:${early}`);
      return;
    }
    const parsed = readCsvHeaders(new Uint8Array(await next.arrayBuffer()));
    if (!mounted.current) return;
    const check = checkImportFile(next.size, parsed);
    if (check !== 'OK' || !parsed) {
      setFile(undefined);
      setHeaders([]);
      setError(`file:${check}`);
      return;
    }
    setFile(next);
    setHeaders(parsed);
    setSelection(suggestSelection(parsed));
  }

  async function runPreview() {
    if (!file || !mapping || inFlight.current) return;
    inFlight.current = true;
    abort.current = new AbortController();
    setError('');
    setPhase('previewing');
    try {
      const next = await api.preview(file, mapping, abort.current.signal);
      if (!mounted.current) return;
      setPreview(next);
      setUsed(mapping);
      setFilter('ALL');
      setShown(PAGE_ROWS);
      setPhase('preview');
    } catch (failure) {
      if (!mounted.current) return;
      setPhase('pick');
      fail(failure);
    } finally {
      inFlight.current = false;
    }
  }

  async function runConfirm() {
    if (!file || !preview || !used || inFlight.current) return;
    inFlight.current = true;
    abort.current = new AbortController();
    if (command.current?.planHash !== preview.planHash)
      command.current = { planHash: preview.planHash, id: crypto.randomUUID() };
    setAsking(false);
    setError('');
    setPhase('confirming');
    try {
      const next = await api.confirm(
        file,
        { mapping: used, planHash: preview.planHash, commandId: command.current.id },
        abort.current.signal,
      );
      if (!mounted.current) return;
      setResult(next);
      setShown(PAGE_ROWS);
      setPhase('result');
    } catch (failure) {
      if (!mounted.current) return;
      const code = failure instanceof CustomersApiError ? failure.code : '';
      if (code === 'PREVIEW_STALE' || code === 'NO_VALID_ROWS') {
        // plan เปลี่ยน: commandId เดิมไม่ใช้ต่อ ต้องตรวจไฟล์ใหม่
        command.current = undefined;
        setPreview(undefined);
        setPhase('pick');
      } else setPhase(result ? 'result' : 'preview');
      fail(failure);
    } finally {
      inFlight.current = false;
    }
  }

  function reset() {
    command.current = undefined;
    void onFile(undefined);
  }

  const noteFor = (row: {
    fieldErrors: readonly { field: string; code: string }[];
    warnings: readonly string[];
  }) =>
    row.fieldErrors.length > 0
      ? row.fieldErrors
          .map((item) => `${t(`fieldNames.${item.field}`)}: ${t(`fieldCodes.${item.code}`)}`)
          .join(' · ')
      : row.warnings.length > 0
        ? t('rowDuplicate')
        : '';
  const errorText = error.startsWith('file:')
    ? t(`fileErrors.${error.slice(5)}`)
    : error
      ? t(`errors.${error}`)
      : '';
  const busy = phase === 'previewing' || phase === 'confirming';

  return (
    <main className="cu-root">
      <h1>{t('title')}</h1>
      <p className="cu-muted">{t('description')}</p>
      {!signedIn || blocked ? (
        <div role="alert" className="cu-alert">
          <p>{t(!signedIn || blocked === 'session' ? 'session' : 'access')}</p>
          {onSignIn && (!signedIn || blocked === 'session') ? (
            <Button onPress={onSignIn}>{t('signIn')}</Button>
          ) : null}
        </div>
      ) : (
        <div className="ci-steps">
          {errorText ? (
            <div role="alert" className="cu-alert">
              <p>{errorText}</p>
            </div>
          ) : null}
          {phase === 'confirming' ? (
            <div role="status" className="cu-notice">
              <p>{t('confirming')}</p>
            </div>
          ) : null}
          {phase !== 'result' ? (
            <section className="ci-card" aria-labelledby="ci-file-title">
              <h2 id="ci-file-title">{t('chooseFile')}</h2>
              <p className="cu-muted">{t('limits')}</p>
              <p className="cu-muted">{t('keepFile')}</p>
              <div className="ci-file">
                <input
                  type="file"
                  accept=".csv,text/csv"
                  aria-label={t('chooseFile')}
                  disabled={busy}
                  onChange={(event) => {
                    const input = event.currentTarget;
                    void onFile(input.files?.[0]);
                    input.value = '';
                  }}
                />
                {file ? (
                  <span className="cu-muted">
                    {t('fileInfo', { name: file.name, size: Math.ceil(file.size / 1024) })}
                  </span>
                ) : null}
              </div>
            </section>
          ) : null}
          {file && phase !== 'result' ? (
            <section className="ci-card" aria-labelledby="ci-map-title">
              <h2 id="ci-map-title">{t('stepMap')}</h2>
              <p className="cu-muted">{t('mapHint')}</p>
              <div className="ci-map">
                {IMPORT_FIELDS.map((field: ImportField) => (
                  <Select
                    key={field}
                    label={t(`fields.${field}`)}
                    isDisabled={busy || phase === 'preview'}
                    options={[
                      ...(field === 'displayName' ? [] : [{ id: NONE, label: t('notImported') }]),
                      ...headers.map((header) => ({ id: header, label: header })),
                    ]}
                    selectedKey={selection[field] ?? (field === 'displayName' ? null : NONE)}
                    onSelectionChange={(key) =>
                      setSelection((old) => {
                        const next = { ...old };
                        if (key === NONE || key === null) delete next[field];
                        else next[field] = String(key);
                        return next;
                      })
                    }
                  />
                ))}
                <Select
                  label={t('phoneCountry')}
                  isDisabled={busy || phase === 'preview' || !selection.phone}
                  options={[
                    { id: COUNTRY_NONE, label: t('phoneCountryNone') },
                    ...PHONE_COUNTRIES.map((code) => ({ id: code, label: t(`countries.${code}`) })),
                  ]}
                  selectedKey={country}
                  onSelectionChange={(key) => setCountry(String(key))}
                />
              </div>
              <div className="cu-actions">
                {phase === 'preview' ? (
                  <Button
                    onPress={() => {
                      command.current = undefined;
                      setPreview(undefined);
                      setPhase('pick');
                    }}
                  >
                    {t('changeFile')}
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    isDisabled={!mapping || busy}
                    onPress={() => void runPreview()}
                  >
                    {phase === 'previewing' ? t('previewing') : t('preview')}
                  </Button>
                )}
              </div>
            </section>
          ) : null}
          {preview && phase !== 'result' ? (
            <section className="ci-card" aria-labelledby="ci-preview-title">
              <h2 id="ci-preview-title">{t('stepPreview')}</h2>
              <div className="ci-counts">
                <Badge tone="success">{t('countValid', { count: preview.counts.valid })}</Badge>
                <Badge tone={preview.counts.invalid > 0 ? 'critical' : 'neutral'}>
                  {t('countInvalid', { count: preview.counts.invalid })}
                </Badge>
                <Badge tone={preview.counts.warning > 0 ? 'attention' : 'neutral'}>
                  {t('countWarning', { count: preview.counts.warning })}
                </Badge>
              </div>
              {preview.counts.valid === 0 ? <p role="alert">{t('noValid')}</p> : null}
              {preview.counts.invalid > 0 && preview.counts.valid > 0 ? (
                <p className="cu-muted">{t('invalidSkipped')}</p>
              ) : null}
              <Select
                label={t('filter')}
                options={(['ALL', 'INVALID', 'WARNING'] as const).map((value) => ({
                  id: value,
                  label: t(`filters.${value}`),
                }))}
                selectedKey={filter}
                onSelectionChange={(key) => {
                  setFilter(key as RowFilter);
                  setShown(PAGE_ROWS);
                }}
              />
              {rows.length === 0 ? (
                <p>{t('emptyRows')}</p>
              ) : (
                <>
                  <Table aria-label={t('stepPreview')} className="ci-table">
                    <TableHeader>
                      <Column isRowHeader>{t('colRow')}</Column>
                      <Column>{t('colName')}</Column>
                      <Column>{t('colState')}</Column>
                      <Column>{t('colNote')}</Column>
                    </TableHeader>
                    <TableBody>
                      {rows.slice(0, shown).map((row) => (
                        <Row key={row.rowNo} id={row.rowNo}>
                          <Cell>{row.rowNo}</Cell>
                          <Cell>{nameIndex >= 0 ? (row.cells[nameIndex] ?? '') : ''}</Cell>
                          <Cell>
                            <Badge
                              tone={
                                row.valid
                                  ? row.warnings.length > 0
                                    ? 'attention'
                                    : 'success'
                                  : 'critical'
                              }
                            >
                              {t(row.valid ? 'rowValid' : 'rowInvalid')}
                            </Badge>
                          </Cell>
                          <Cell>{noteFor(row)}</Cell>
                        </Row>
                      ))}
                    </TableBody>
                  </Table>
                  <p className="cu-muted">
                    {t('showing', { shown: Math.min(shown, rows.length), total: rows.length })}
                  </p>
                  {shown < rows.length ? (
                    <div className="cu-more">
                      <Button onPress={() => setShown((value) => value + PAGE_ROWS)}>
                        {t('more')}
                      </Button>
                    </div>
                  ) : null}
                </>
              )}
              <div className="cu-actions">
                <Button
                  variant="primary"
                  isDisabled={preview.counts.valid === 0 || busy}
                  onPress={() => setAsking(true)}
                >
                  {t('confirm', { count: preview.counts.valid })}
                </Button>
              </div>
            </section>
          ) : null}
          {result ? (
            <section className="ci-card" aria-labelledby="ci-result-title">
              <h2 id="ci-result-title">{t('stepResult')}</h2>
              <p role="status">
                {t(result.state === 'COMPLETED' ? 'resultDone' : 'resultIncomplete')}
              </p>
              <p className="cu-muted">{t('resultCounts', { ...result.counts })}</p>
              <Table aria-label={t('stepResult')} className="ci-table">
                <TableHeader>
                  <Column isRowHeader>{t('colRow')}</Column>
                  <Column>{t('colName')}</Column>
                  <Column>{t('colState')}</Column>
                  <Column>{t('colNote')}</Column>
                </TableHeader>
                <TableBody>
                  {result.rows.slice(0, shown).map((row) => {
                    const source = preview?.rows.find((item) => item.rowNo === row.rowNo);
                    return (
                      <Row key={row.rowNo} id={row.rowNo}>
                        <Cell>{row.rowNo}</Cell>
                        <Cell>{nameIndex >= 0 ? (source?.cells[nameIndex] ?? '') : ''}</Cell>
                        <Cell>
                          <Badge
                            tone={
                              row.state === 'APPLIED'
                                ? 'success'
                                : row.state === 'NOT_SELECTED'
                                  ? 'neutral'
                                  : row.state === 'REJECTED'
                                    ? 'critical'
                                    : 'attention'
                            }
                          >
                            {t(`resultState.${row.state}`)}
                          </Badge>
                        </Cell>
                        <Cell>
                          {row.fieldErrors && row.fieldErrors.length > 0
                            ? noteFor({ fieldErrors: row.fieldErrors, warnings: [] })
                            : row.code
                              ? t(`resultCodes.${row.code}`, { defaultValue: row.code })
                              : ''}
                        </Cell>
                      </Row>
                    );
                  })}
                </TableBody>
              </Table>
              <p className="cu-muted">
                {t('showing', {
                  shown: Math.min(shown, result.rows.length),
                  total: result.rows.length,
                })}
              </p>
              {shown < result.rows.length ? (
                <div className="cu-more">
                  <Button onPress={() => setShown((value) => value + PAGE_ROWS)}>
                    {t('more')}
                  </Button>
                </div>
              ) : null}
              <div className="cu-actions">
                {canResume(result.counts) ? (
                  <Button variant="primary" isDisabled={busy} onPress={() => void runConfirm()}>
                    {t('resume')}
                  </Button>
                ) : null}
                <Button isDisabled={busy} onPress={reset}>
                  {t('startOver')}
                </Button>
              </div>
              {canResume(result.counts) ? <p className="cu-muted">{t('leaveWarning')}</p> : null}
            </section>
          ) : null}
        </div>
      )}
      <Dialog
        role="alertdialog"
        title={t('confirmTitle')}
        isOpen={asking}
        onOpenChange={(open) => {
          if (!open) setAsking(false);
        }}
      >
        <p>{t('confirmBody', { count: preview?.counts.valid ?? 0 })}</p>
        <div className="cu-actions">
          <Button onPress={() => setAsking(false)}>{t('cancel')}</Button>
          <Button variant="primary" onPress={() => void runConfirm()}>
            {t('confirm', { count: preview?.counts.valid ?? 0 })}
          </Button>
        </div>
      </Dialog>
    </main>
  );
}
