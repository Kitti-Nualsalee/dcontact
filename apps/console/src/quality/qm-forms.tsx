import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useLocale, useTranslation } from '@d-contact/i18n/react';
import {
  Badge,
  Button,
  Cell,
  Checkbox,
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
import { useShellTokens } from '../shell/tokens.js';
import {
  QualityApiError,
  type FormDefinition,
  type FormDetail,
  type FormSummary,
  type QualityApi,
  type QuestionType,
} from './api.js';
import {
  addQuestion,
  addSection,
  errorMap,
  removeQuestion,
  removeSection,
  retype,
  updateQuestion,
  updateSection,
} from './model.js';
import { EditorSkeleton, ListSkeleton } from './skeleton.js';
import './quality.css';

interface Props {
  api: QualityApi;
  identityKey: string;
  onSignIn?: () => void;
}

const TOAST_MS = 5000;
const TYPES: QuestionType[] = ['YES_NO', 'SCALE', 'TEXT'];
const statusOf = (failure: unknown) => (failure instanceof QualityApiError ? failure.status : 500);

/** เปลี่ยนผู้ใช้แล้วทิ้ง state ของคนก่อนทั้งหมด */
export function QmForms(props: Props) {
  return <QmFormsSession key={props.identityKey} {...props} />;
}

function QmFormsSession({ api, onSignIn }: Props) {
  const { t } = useTranslation('quality');
  const { locale } = useLocale();
  const ready = useShellTokens();
  const openId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [items, setItems] = useState<FormSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<number>();
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<string>();
  const [name, setName] = useState('');
  const [createError, setCreateError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const format = (value: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(value),
    );

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(undefined);
    void api
      .listForms()
      .then((list) => {
        if (active) setItems(list.items);
      })
      .catch((failure: unknown) => {
        if (active) setError(statusOf(failure));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, reload]);

  if (!ready) return null;
  if (selected) {
    return (
      <FormEditor
        api={api}
        formId={selected}
        onSignIn={onSignIn}
        onBack={() => {
          const opener = selected;
          setSelected(undefined);
          setReload((current) => current + 1);
          requestAnimationFrame(() =>
            (document.getElementById(`${openId}-${opener}`) ?? heading.current)?.focus(),
          );
        }}
      />
    );
  }

  const create = () => {
    setCreating(true);
    setCreateError(undefined);
    void api
      .createForm({ commandId: crypto.randomUUID(), name })
      .then((form) => {
        setName('');
        setSelected(form.formId);
      })
      .catch((failure: unknown) => {
        const code =
          failure instanceof QualityApiError
            ? (failure.errors[0]?.code ?? failure.code ?? 'FAILED')
            : 'FAILED';
        setCreateError(code);
      })
      .finally(() => setCreating(false));
  };

  const errorKey =
    error === 401
      ? 'unauthorized'
      : error === 403
        ? 'forms.forbidden'
        : error
          ? 'failed'
          : undefined;
  return (
    <main className="qm-root">
      <header className="qm-head">
        <h1 ref={heading} tabIndex={-1}>
          {t('forms.title')}
        </h1>
        <p className="qm-muted">{t('forms.scope')}</p>
      </header>
      <form
        className="qm-filters"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) create();
        }}
      >
        <TextField
          className="qm-name-field"
          label={t('forms.newName')}
          value={name}
          maxLength={120}
          isDisabled={creating}
          isInvalid={!!createError}
          errorMessage={
            createError
              ? t(`errors.${createError}`, { defaultValue: t('errors.FAILED') })
              : undefined
          }
          onChange={(next) => {
            setName(next);
            setCreateError(undefined);
          }}
        />
        <Button type="submit" variant="primary" isDisabled={creating || !name.trim()}>
          {t('forms.create')}
        </Button>
      </form>
      {loading && items.length === 0 ? <ListSkeleton label={t('loading')} rows={3} /> : null}
      {errorKey ? (
        <section role="alert" className="qm-alert">
          <p>{t(errorKey)}</p>
          {error === 401 && onSignIn ? <Button onPress={onSignIn}>{t('signIn')}</Button> : null}
          {error !== 403 ? (
            <Button onPress={() => setReload((current) => current + 1)}>{t('retry')}</Button>
          ) : null}
        </section>
      ) : null}
      {!loading && !error && items.length === 0 ? (
        <p className="qm-empty">{t('forms.empty')}</p>
      ) : null}
      {items.length > 0 ? (
        <div className="qm-scroll" aria-busy={loading} data-stale={loading || undefined}>
          <Table aria-label={t('forms.list')}>
            <TableHeader>
              <Column isRowHeader>{t('forms.name')}</Column>
              <Column>{t('forms.current')}</Column>
              <Column>{t('forms.draft')}</Column>
              <Column>{t('forms.updatedAt')}</Column>
              <Column>{t('forms.action')}</Column>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <Row key={item.formId} id={item.formId}>
                  <Cell>
                    <span className="qm-wrap">{item.name}</span>
                  </Cell>
                  <Cell>
                    {item.current ? (
                      <Badge tone="success">
                        {t('forms.versionLabel', { version: item.current.version })}
                      </Badge>
                    ) : (
                      <Badge tone="neutral">{t('forms.notPublished')}</Badge>
                    )}
                  </Cell>
                  <Cell>
                    {item.draft ? (
                      <Badge tone="attention">
                        {t('forms.draftLabel', { version: item.draft.version })}
                      </Badge>
                    ) : (
                      '—'
                    )}
                  </Cell>
                  <Cell>
                    <time className="qm-nowrap" dateTime={item.updatedAt}>
                      {format(item.updatedAt)}
                    </time>
                  </Cell>
                  <Cell>
                    <Button
                      id={`${openId}-${item.formId}`}
                      size="sm"
                      aria-label={t('forms.openItem', { name: item.name })}
                      onPress={() => setSelected(item.formId)}
                    >
                      {item.draft ? t('forms.edit') : t('forms.view')}
                    </Button>
                  </Cell>
                </Row>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
    </main>
  );
}

function FormEditor({
  api,
  formId,
  onBack,
  onSignIn,
}: {
  api: QualityApi;
  formId: string;
  onBack: () => void;
  onSignIn?: () => void;
}) {
  const { t } = useTranslation('quality');
  const { locale } = useLocale();
  const heading = useRef<HTMLHeadingElement>(null);
  const [form, setForm] = useState<FormDetail>();
  const [name, setName] = useState('');
  const [definition, setDefinition] = useState<FormDefinition>();
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<{ status: number } | { code: string }>();
  const [busy, setBusy] = useState<'save' | 'publish' | 'draft'>();
  const [dialog, setDialog] = useState<'publish' | 'leave' | 'removeSection'>();
  const [pendingSection, setPendingSection] = useState<number>();
  const [focusHeading, setFocusHeading] = useState(false);
  const [reload, setReload] = useState(0);

  // ย้าย focus ไปที่หัวข้อหลัง Dialog ปิดแล้วจริง (ปุ่ม publish หายไปหลังเปลี่ยนเป็นอ่านอย่างเดียว)
  useEffect(() => {
    if (!focusHeading || dialog) return;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        heading.current?.focus();
        setFocusHeading(false);
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [focusHeading, dialog]);

  const apply = (next: FormDetail) => {
    setForm(next);
    setName(next.name);
    setDefinition(next.draft?.definition ?? next.current?.definition);
    setDirty(false);
    setErrors({});
  };

  useEffect(() => {
    let active = true;
    setFailure(undefined);
    void api
      .getForm(formId)
      .then((loaded) => {
        if (!active) return;
        apply(loaded);
        setFocusHeading(true);
      })
      .catch((error: unknown) => {
        if (active) setFailure({ status: statusOf(error) });
      });
    return () => {
      active = false;
    };
  }, [api, formId, reload]);

  const handle = (error: unknown) => {
    if (error instanceof QualityApiError && error.errors.length > 0) {
      setErrors(errorMap(error.errors));
      setFailure({ code: 'VALIDATION_FAILED' });
    } else {
      setFailure({
        code: error instanceof QualityApiError && error.code ? error.code : 'FAILED',
      });
    }
  };

  const save = async (): Promise<FormDetail | undefined> => {
    if (!form?.draft || !definition) return undefined;
    setErrors({});
    setFailure(undefined);
    try {
      const saved = await api.saveDraft(formId, {
        revision: form.draft.revision,
        name,
        definition,
      });
      apply(saved);
      return saved;
    } catch (error) {
      handle(error);
      return undefined;
    }
  };

  const publish = async () => {
    setBusy('publish');
    try {
      const saved = dirty ? await save() : form;
      if (!saved?.draft) return;
      const published = await api.publishForm(formId, {
        commandId: crypto.randomUUID(),
        revision: saved.draft.revision,
      });
      apply(published);
      setDialog(undefined);
      toastQueue.add(
        {
          title: t('forms.toast.published', { version: published.current?.version }),
          tone: 'success',
        },
        { timeout: TOAST_MS },
      );
      setFocusHeading(true);
    } catch (error) {
      setDialog(undefined);
      handle(error);
    } finally {
      setBusy(undefined);
    }
  };

  const newDraft = () => {
    setBusy('draft');
    setFailure(undefined);
    void api
      .newDraft(formId, crypto.randomUUID())
      .then(apply)
      .catch(handle)
      .finally(() => setBusy(undefined));
  };

  if (failure && 'status' in failure) {
    return (
      <main className="qm-root">
        <Button variant="ghost" onPress={onBack}>
          {t('forms.back')}
        </Button>
        <section role="alert" className="qm-alert">
          <p>
            {t(
              failure.status === 401
                ? 'unauthorized'
                : failure.status === 404
                  ? 'forms.notFound'
                  : failure.status === 403
                    ? 'forms.forbidden'
                    : 'failed',
            )}
          </p>
          {failure.status === 401 && onSignIn ? (
            <Button onPress={onSignIn}>{t('signIn')}</Button>
          ) : null}
          {failure.status >= 500 ? (
            <Button onPress={() => setReload((current) => current + 1)}>{t('retry')}</Button>
          ) : null}
        </section>
      </main>
    );
  }
  if (!form || !definition) {
    return <EditorSkeleton label={t('loading')} backLabel={t('forms.back')} onBack={onBack} />;
  }

  const editable = !!form.draft;
  const saving = !!busy;
  const change = (next: FormDefinition) => {
    setDefinition(next);
    setDirty(true);
  };
  const fieldError = (path: string) =>
    errors[path] ? t(`errors.${errors[path]}`, { defaultValue: t('errors.INVALID') }) : undefined;
  const draftVersion = form.draft?.version ?? 0;

  return (
    <main className="qm-root">
      <Button variant="ghost" onPress={() => (dirty ? setDialog('leave') : onBack())}>
        {t('forms.back')}
      </Button>
      <header className="qm-head">
        <h1 ref={heading} tabIndex={-1} className="qm-wrap">
          {form.name}
        </h1>
        <p className="qm-muted">
          {editable
            ? t('forms.editingDraft', { version: draftVersion })
            : t('forms.viewingCurrent', { version: form.current?.version })}
        </p>
      </header>
      <div className="qm-layout">
        <div className="qm-main">
          <section className="qm-card">
            <h2>{t('forms.general')}</h2>
            <div className="qm-grid">
              <TextField
                label={t('forms.name')}
                value={name}
                maxLength={120}
                isDisabled={!editable || saving}
                isInvalid={!!fieldError('name')}
                errorMessage={fieldError('name')}
                onChange={(next) => {
                  setName(next);
                  setDirty(true);
                }}
              />
              <NumberInput
                label={t('forms.requireCommentBelow')}
                hint={t('forms.requireCommentBelowHint')}
                value={definition.requireCommentBelow}
                min={1}
                max={100}
                optional
                disabled={!editable || saving}
                error={fieldError('requireCommentBelow')}
                onChange={(value) => change({ ...definition, requireCommentBelow: value })}
              />
            </div>
          </section>
          {fieldError('sections') ? (
            <p className="qm-field-error" role="alert">
              {fieldError('sections')}
            </p>
          ) : null}
          {definition.sections.map((section, s) => (
            <section
              key={section.id}
              className="qm-card"
              aria-label={section.name || t('forms.section', { n: s + 1 })}
            >
              <div className="qm-card-head">
                <h2>{t('forms.section', { n: s + 1 })}</h2>
                {editable ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    isDisabled={saving}
                    aria-label={t('forms.removeSectionItem', { n: s + 1 })}
                    onPress={() => {
                      // หมวดที่มีคำถามแล้วต้องยืนยันก่อนลบ
                      if (section.questions.length === 0) change(removeSection(definition, s));
                      else {
                        setPendingSection(s);
                        setDialog('removeSection');
                      }
                    }}
                  >
                    {t('forms.removeSection')}
                  </Button>
                ) : null}
              </div>
              <div className="qm-grid">
                <TextField
                  label={t('forms.sectionName')}
                  value={section.name}
                  maxLength={120}
                  isDisabled={!editable || saving}
                  isInvalid={!!fieldError(`sections.${s}.name`)}
                  errorMessage={fieldError(`sections.${s}.name`)}
                  onChange={(next) =>
                    change(updateSection(definition, s, (item) => ({ ...item, name: next })))
                  }
                />
                <NumberInput
                  label={t('forms.weight')}
                  hint={t('forms.weightHint')}
                  value={section.weight}
                  min={1}
                  max={100}
                  disabled={!editable || saving}
                  error={fieldError(`sections.${s}.weight`)}
                  onChange={(value) =>
                    change(
                      updateSection(definition, s, (item) => ({ ...item, weight: value ?? 0 })),
                    )
                  }
                />
              </div>
              {fieldError(`sections.${s}.questions`) ? (
                <p className="qm-field-error">{fieldError(`sections.${s}.questions`)}</p>
              ) : null}
              <ol className="qm-questions">
                {section.questions.map((question, q) => {
                  const at = `sections.${s}.questions.${q}`;
                  const update = (next: Partial<typeof question>) =>
                    change(updateQuestion(definition, s, q, (item) => ({ ...item, ...next })));
                  return (
                    <li key={question.id} className="qm-question-edit">
                      <div className="qm-question-row">
                        <Select
                          className="qm-type"
                          label={t('forms.type')}
                          selectedKey={question.type}
                          isDisabled={!editable || saving}
                          onSelectionChange={(key) =>
                            change(
                              updateQuestion(definition, s, q, (item) =>
                                retype(item, key as QuestionType),
                              ),
                            )
                          }
                          options={TYPES.map((id) => ({ id, label: t(`forms.types.${id}`) }))}
                        />
                        <TextField
                          className="qm-question-input"
                          label={t('forms.questionText', { n: q + 1 })}
                          value={question.text}
                          maxLength={500}
                          isDisabled={!editable || saving}
                          isInvalid={!!fieldError(`${at}.text`)}
                          errorMessage={fieldError(`${at}.text`)}
                          onChange={(next) => update({ text: next })}
                        />
                        {question.type !== 'TEXT' ? (
                          <NumberInput
                            label={t('forms.points')}
                            value={question.points ?? null}
                            min={1}
                            max={100}
                            disabled={!editable || saving}
                            error={fieldError(`${at}.points`)}
                            onChange={(value) => update({ points: value ?? undefined })}
                          />
                        ) : null}
                        {question.type === 'SCALE' ? (
                          <>
                            <NumberInput
                              label={t('forms.scaleMin')}
                              value={question.scale?.[0] ?? null}
                              min={0}
                              max={10}
                              disabled={!editable || saving}
                              error={fieldError(`${at}.scale`)}
                              onChange={(value) =>
                                update({ scale: [value ?? 0, question.scale?.[1] ?? 5] })
                              }
                            />
                            <NumberInput
                              label={t('forms.scaleMax')}
                              value={question.scale?.[1] ?? null}
                              min={0}
                              max={10}
                              disabled={!editable || saving}
                              onChange={(value) =>
                                update({ scale: [question.scale?.[0] ?? 1, value ?? 0] })
                              }
                            />
                          </>
                        ) : null}
                      </div>
                      {question.type !== 'TEXT' ? (
                        <div className="qm-question-row">
                          <Checkbox
                            isSelected={!!question.allowNa}
                            isDisabled={!editable || saving}
                            onChange={(value) => update({ allowNa: value || undefined })}
                          >
                            {t('forms.allowNa')}
                          </Checkbox>
                          {question.type === 'YES_NO' ? (
                            <Checkbox
                              isSelected={!!question.autoFail}
                              isDisabled={!editable || saving}
                              onChange={(value) => update({ autoFail: value || undefined })}
                            >
                              {t('forms.autoFail')}
                            </Checkbox>
                          ) : null}
                          {editable ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              isDisabled={saving}
                              aria-label={t('forms.removeQuestionItem', { n: q + 1 })}
                              onPress={() => change(removeQuestion(definition, s, q))}
                            >
                              {t('forms.removeQuestion')}
                            </Button>
                          ) : null}
                        </div>
                      ) : editable ? (
                        <div className="qm-question-row">
                          <Button
                            size="sm"
                            variant="ghost"
                            isDisabled={saving}
                            aria-label={t('forms.removeQuestionItem', { n: q + 1 })}
                            onPress={() => change(removeQuestion(definition, s, q))}
                          >
                            {t('forms.removeQuestion')}
                          </Button>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
              {editable ? (
                <div className="qm-question-row">
                  {TYPES.map((type) => (
                    <Button
                      key={type}
                      size="sm"
                      isDisabled={saving}
                      onPress={() => change(addQuestion(definition, s, type))}
                    >
                      {t(`forms.add.${type}`)}
                    </Button>
                  ))}
                </div>
              ) : null}
            </section>
          ))}
          {editable ? (
            <Button
              isDisabled={saving}
              onPress={() =>
                change(
                  addSection(definition, t('forms.section', { n: definition.sections.length + 1 })),
                )
              }
            >
              {t('forms.addSection')}
            </Button>
          ) : null}
        </div>
        <aside className="qm-aside" aria-label={t('forms.versions')}>
          <section className="qm-card">
            <h2>{t('forms.versions')}</h2>
            <ul className="qm-versions">
              {form.versions.map((version) => (
                <li key={version.versionId}>
                  <span>{t('forms.versionLabel', { version: version.version })}</span>{' '}
                  <Badge
                    tone={
                      version.status === 'PUBLISHED'
                        ? 'success'
                        : version.status === 'DRAFT'
                          ? 'attention'
                          : 'neutral'
                    }
                  >
                    {t(`forms.status.${version.status}`)}
                  </Badge>
                  {version.publishedAt ? (
                    <span className="qm-muted">
                      {' '}
                      {new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(
                        new Date(version.publishedAt),
                      )}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
            {failure && 'code' in failure ? (
              <section role="alert" className="qm-alert qm-alert-aside">
                <p>
                  {t(`forms.failure.${failure.code}`, { defaultValue: t('forms.failure.FAILED') })}
                </p>
                {failure.code === 'STALE_REVISION' ? (
                  <Button onPress={() => setReload((current) => current + 1)}>
                    {t('editor.reload')}
                  </Button>
                ) : null}
              </section>
            ) : null}
            <div className="qm-actions">
              {editable ? (
                <>
                  <Button
                    variant="primary"
                    isDisabled={saving || !dirty}
                    onPress={() => {
                      setBusy('save');
                      void save()
                        .then((saved) => {
                          if (saved)
                            toastQueue.add(
                              { title: t('forms.toast.saved'), tone: 'success' },
                              { timeout: TOAST_MS },
                            );
                        })
                        .finally(() => setBusy(undefined));
                    }}
                  >
                    {busy === 'save' ? t('editor.saving') : t('forms.saveDraft')}
                  </Button>
                  <Button isDisabled={saving} onPress={() => setDialog('publish')}>
                    {t('forms.publish', { version: draftVersion })}
                  </Button>
                  <p className="qm-muted">{t('forms.publishHint')}</p>
                </>
              ) : (
                <>
                  <Button variant="primary" isDisabled={saving} onPress={newDraft}>
                    {t('forms.newVersion')}
                  </Button>
                  <p className="qm-muted">{t('forms.newVersionHint')}</p>
                </>
              )}
            </div>
          </section>
        </aside>
      </div>
      <Dialog
        role="alertdialog"
        isDismissable={false}
        isOpen={dialog === 'publish'}
        onOpenChange={(open) => !open && !busy && setDialog(undefined)}
        title={t('forms.publishDialog.title', { name: form.name, version: draftVersion })}
        footer={(close) => (
          <>
            <Button autoFocus variant="ghost" isDisabled={busy === 'publish'} onPress={close}>
              {t('cancel')}
            </Button>
            <Button
              variant="primary"
              isDisabled={busy === 'publish'}
              onPress={() => void publish()}
            >
              {busy === 'publish' ? t('editor.publishing') : t('forms.publishDialog.confirm')}
            </Button>
          </>
        )}
      >
        <p>{t('forms.publishDialog.body')}</p>
      </Dialog>
      <Dialog
        role="alertdialog"
        isOpen={dialog === 'removeSection'}
        onOpenChange={(open) => !open && setDialog(undefined)}
        title={t('forms.removeSectionDialog.title', {
          name:
            (pendingSection !== undefined && definition.sections[pendingSection]?.name) ||
            t('forms.section', { n: (pendingSection ?? 0) + 1 }),
        })}
        footer={(close) => (
          <>
            <Button autoFocus variant="ghost" onPress={close}>
              {t('cancel')}
            </Button>
            <Button
              variant="danger"
              onPress={() => {
                if (pendingSection !== undefined) change(removeSection(definition, pendingSection));
                setDialog(undefined);
              }}
            >
              {t('forms.removeSection')}
            </Button>
          </>
        )}
      >
        <p>
          {t('forms.removeSectionDialog.body', {
            count:
              pendingSection !== undefined
                ? (definition.sections[pendingSection]?.questions.length ?? 0)
                : 0,
          })}
        </p>
      </Dialog>
      <Dialog
        role="alertdialog"
        isOpen={dialog === 'leave'}
        onOpenChange={(open) => !open && setDialog(undefined)}
        title={t('editor.leaveDialog.title')}
        footer={(close) => (
          <>
            <Button autoFocus variant="ghost" onPress={close}>
              {t('editor.leaveDialog.stay')}
            </Button>
            <Button variant="danger" onPress={onBack}>
              {t('editor.leaveDialog.leave')}
            </Button>
          </>
        )}
      >
        <p>{t('editor.leaveDialog.body')}</p>
      </Dialog>
    </main>
  );
}

/** ui-react ยังไม่มี NumberField จึงใช้ input type="number" ของ browser ในรูปแบบเดียวกับ field อื่น */
function NumberInput({
  label,
  hint,
  value,
  min,
  max,
  optional,
  disabled,
  error,
  onChange,
}: {
  label: ReactNode;
  hint?: ReactNode;
  value: number | null;
  min: number;
  max: number;
  optional?: boolean;
  disabled?: boolean;
  error?: string;
  onChange: (value: number | null) => void;
}) {
  const id = useId();
  const { t } = useTranslation('quality');
  const [touched, setTouched] = useState(false);
  // ตรวจช่วงเองหลังผู้ใช้ออกจากช่อง error จาก server มาก่อนเสมอ
  const outOfRange =
    value === null ? !optional : !Number.isInteger(value) || value < min || value > max;
  const shown = error ?? (touched && outOfRange ? t('errors.RANGE', { min, max }) : undefined);
  const described = [hint ? `${id}-hint` : null, shown ? `${id}-error` : null]
    .filter(Boolean)
    .join(' ');
  return (
    <div className="qm-field qm-number">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        value={value ?? ''}
        required={!optional}
        disabled={disabled}
        aria-invalid={shown ? true : undefined}
        aria-describedby={described || undefined}
        onBlur={() => setTouched(true)}
        onChange={(event) => {
          const raw = event.target.value;
          onChange(raw === '' ? null : Number(raw));
        }}
      />
      {hint ? (
        <span id={`${id}-hint`} className="qm-hint">
          {hint}
        </span>
      ) : null}
      {shown ? (
        <span id={`${id}-error`} className="qm-field-error">
          {shown}
        </span>
      ) : null}
    </div>
  );
}
