/**
 * J5.6 (#344): template catalog, instantiate และ explicit upgrade (#330)
 *
 * - instantiate อ้าง template ด้วย id + version + content digest ที่เห็นอยู่ ถ้า server มีฉบับอื่นจะชน
 * - ค่า parameter อยู่แค่ใน form นี้และ request เท่านั้น ไม่ถูกเก็บลง storage ใด ๆ ของ browser
 * - upgrade เป็น proposal ที่ผู้ใช้ต้องเลือกวิธีแก้ทุก conflict เอง แล้วได้ draft revision ใหม่ ไม่ publish
 */
import { useEffect, useId, useState } from 'react';
import type {
  JourneyTemplateConflictResolution,
  JourneyTemplateParameterV1,
  JourneyTemplateParameterValue,
  JourneyTemplateUpgradeProposalV1,
  JourneyTemplateVersionViewV1,
} from '@d-contact/cxa-contracts';
import { JourneyAuthoringApiError, type JourneyAuthoringApi, type JourneySnapshot } from './api.js';
import { errorMessage } from './model.js';

const BLOCKING = new Set(['PARAMETER_REQUIRED_UNBOUND', 'UNKNOWN_NODE_OR_CAPABILITY']);

function parameterValue(
  parameter: JourneyTemplateParameterV1,
  raw: string,
): JourneyTemplateParameterValue | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  if (parameter.type === 'BOOLEAN') return text === 'true';
  if (parameter.type === 'INTEGER' || parameter.type === 'DURATION_SECONDS') return Number(text);
  return text;
}

function ParameterInput({
  parameter,
  value,
  onChange,
}: {
  parameter: JourneyTemplateParameterV1;
  value: string;
  onChange: (value: string) => void;
}) {
  const inputId = useId();
  const label = `${parameter.parameterKey}${parameter.required ? ' *' : ''}`;
  const hint =
    parameter.type === 'OPAQUE_RESOURCE_REF'
      ? `อ้าง ${parameter.resourceKind} ที่มีอยู่ใน tenant นี้`
      : parameter.type === 'INTEGER' || parameter.type === 'DURATION_SECONDS'
        ? `ตัวเลข ${parameter.min}–${parameter.max}`
        : parameter.type;
  return (
    <div className="j5-field">
      <label htmlFor={inputId}>{label}</label>
      {parameter.type === 'ENUM' || parameter.type === 'BOOLEAN' ? (
        <select id={inputId} value={value} onChange={(event) => onChange(event.target.value)}>
          <option value="">— เลือก —</option>
          {(parameter.type === 'ENUM' ? parameter.values : ['true', 'false']).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={inputId}
          type="text"
          autoComplete="off"
          value={value}
          aria-required={parameter.required}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      <small className="j5-help">{hint}</small>
    </div>
  );
}

export function TemplateCatalog({
  api,
  readOnly,
  onInstantiated,
}: {
  api: JourneyAuthoringApi;
  readOnly: boolean;
  onInstantiated: (journeyId: string) => void;
}) {
  const teamId = useId();
  const nameId = useId();
  const [templates, setTemplates] = useState<JourneyTemplateVersionViewV1[] | null>(null);
  const [selected, setSelected] = useState<JourneyTemplateVersionViewV1 | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [team, setTeam] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [intentKey, setIntentKey] = useState<string | null>(null);

  useEffect(() => {
    api
      .templates()
      .then((page) => setTemplates(page.items))
      .catch((failure: unknown) =>
        setError(
          errorMessage(failure instanceof JourneyAuthoringApiError ? failure.code : undefined),
        ),
      );
  }, [api]);

  const choose = (template: JourneyTemplateVersionViewV1) => {
    setSelected(template);
    setValues(
      Object.fromEntries(
        template.content.parameterSchema.map((parameter) => [
          parameter.parameterKey,
          'default' in parameter && parameter.default !== undefined
            ? String(parameter.default)
            : '',
        ]),
      ),
    );
    setName(template.name);
    setIntentKey(null);
    setError(null);
  };

  const instantiate = async () => {
    if (!selected) return;
    const bindings: Record<string, JourneyTemplateParameterValue> = {};
    for (const parameter of selected.content.parameterSchema) {
      const value = parameterValue(parameter, values[parameter.parameterKey] ?? '');
      if (value !== undefined) bindings[parameter.parameterKey] = value;
    }
    // key เดียวต่อหนึ่ง intent: กดซ้ำหลังเน็ตหลุดไม่สร้าง Journey ซ้ำ
    const key = intentKey ?? `instantiate-${crypto.randomUUID()}`;
    setIntentKey(key);
    setError(null);
    try {
      const result = await api.instantiate(
        selected.templateId,
        selected.version,
        {
          expectedContentDigest: selected.contentDigest,
          bindings,
          targetOwnerTeamId: team.trim(),
          name: name.trim(),
        },
        key,
      );
      onInstantiated(result.journeyId);
    } catch (failure) {
      if (failure instanceof JourneyAuthoringApiError) setIntentKey(null);
      setError(
        errorMessage(failure instanceof JourneyAuthoringApiError ? failure.code : undefined),
      );
    }
  };

  return (
    <section className="gov-panel" aria-labelledby="j5-template-heading">
      <h2 id="j5-template-heading">เริ่มจาก template</h2>
      {templates === null && !error ? <p role="status">กำลังโหลด template…</p> : null}
      {templates?.length === 0 ? <p>ยังไม่มี template ที่คุณมองเห็น</p> : null}
      <ul className="j5-template-list">
        {templates?.map((template) => (
          <li key={`${template.templateId}-${template.version}`}>
            <button
              type="button"
              className="gov-link"
              aria-current={selected?.templateId === template.templateId ? 'true' : undefined}
              onClick={() => choose(template)}
            >
              {template.name}
            </button>
            <span className="j5-help">
              {' '}
              · {template.origin === 'PLATFORM_BUILTIN' ? 'built-in' : 'ของ tenant'} · v
              {template.version}
              {template.lifecycle === 'DEPRECATED' ? ' · เลิกใช้แล้ว' : ''}
            </span>
          </li>
        ))}
      </ul>
      {selected && !readOnly ? (
        <form
          className="j5-template-form"
          aria-label={`สร้าง Journey จาก ${selected.name}`}
          onSubmit={(event) => {
            event.preventDefault();
            void instantiate();
          }}
        >
          <div className="j5-field">
            <label htmlFor={nameId}>ชื่อ Journey</label>
            <input
              id={nameId}
              value={name}
              required
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="j5-field">
            <label htmlFor={teamId}>ทีมเจ้าของ (team ID)</label>
            <input
              id={teamId}
              value={team}
              required
              onChange={(event) => setTeam(event.target.value)}
            />
          </div>
          {selected.content.parameterSchema.map((parameter) => (
            <ParameterInput
              key={parameter.parameterKey}
              parameter={parameter}
              value={values[parameter.parameterKey] ?? ''}
              onChange={(value) =>
                setValues((current) => ({ ...current, [parameter.parameterKey]: value }))
              }
            />
          ))}
          <button type="submit" className="gov-primary" disabled={!name.trim() || !team.trim()}>
            สร้าง Journey จาก template
          </button>
        </form>
      ) : null}
      {error ? (
        <p className="j5-status-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

export function TemplateUpgrade({
  api,
  snapshot,
  dirty,
  readOnly,
  onChanged,
}: {
  api: JourneyAuthoringApi;
  snapshot: JourneySnapshot;
  dirty: boolean;
  readOnly: boolean;
  onChanged: () => Promise<void>;
}) {
  const [proposal, setProposal] = useState<JourneyTemplateUpgradeProposalV1 | null>(null);
  const [resolutions, setResolutions] = useState<Record<string, JourneyTemplateConflictResolution>>(
    {},
  );
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<string | null>(null);
  const notices = snapshot.templateNotices;
  // หลัง apply สำเร็จ notice หายไป แต่ยังต้องประกาศผลให้ผู้ใช้เห็น
  if (notices.length === 0 && !applied) return null;
  const update = notices.find((notice) => notice.kind === 'UPDATE_AVAILABLE');
  const { head } = snapshot;

  const check = async () => {
    if (!update) return;
    setError(null);
    setApplied(null);
    try {
      setProposal(
        await api.checkUpgrade(head.journeyId, {
          draftRevision: head.currentDraftRevision,
          draftDigest: head.currentDraftDigest,
          targetVersion: update.latestVersion,
        }),
      );
      setResolutions({});
    } catch (failure) {
      setError(
        errorMessage(failure instanceof JourneyAuthoringApiError ? failure.code : undefined),
      );
    }
  };

  const apply = async () => {
    if (!proposal) return;
    setError(null);
    try {
      await api.applyUpgrade(
        head.journeyId,
        {
          targetVersion: proposal.toVersion,
          expectedHeadVersion: head.version,
          expectedDraftRevision: head.currentDraftRevision,
          expectedDraftDigest: head.currentDraftDigest,
          proposalDigest: proposal.proposalDigest,
          conflictDigest: proposal.conflictDigest,
          resolutions,
        },
        `upgrade-${proposal.proposalDigest.slice(0, 16)}-${head.currentDraftRevision}`,
      );
      setProposal(null);
      setApplied(`ปรับเป็น template version ${proposal.toVersion} ในฉบับร่างแล้ว ยังไม่ publish`);
      await onChanged();
    } catch (failure) {
      setError(
        errorMessage(failure instanceof JourneyAuthoringApiError ? failure.code : undefined),
      );
    }
  };

  const unresolved = proposal
    ? proposal.conflicts.some(
        (conflict) => BLOCKING.has(conflict.kind) || !resolutions[conflict.conflictId],
      )
    : true;

  return (
    <section className="gov-panel" aria-labelledby="j5-upgrade-heading">
      <h2 id="j5-upgrade-heading">Template ต้นทาง</h2>
      <ul>
        {notices.map((notice) => (
          <li key={notice.kind}>
            {notice.kind === 'UPDATE_AVAILABLE'
              ? `มี template version ${notice.latestVersion} (ใช้อยู่ ${notice.source.version}) — ข้อมูลเท่านั้น ไม่เปลี่ยนเอง`
              : 'template ต้นทางถูกเลิกใช้แล้ว Journey นี้ยังทำงานได้ตามเดิม'}
          </li>
        ))}
      </ul>
      {update && !readOnly ? (
        <button
          type="button"
          className="gov-secondary"
          disabled={dirty}
          onClick={() => void check()}
        >
          ตรวจการ upgrade
        </button>
      ) : null}
      {proposal ? (
        <div className="j5-upgrade">
          <p>
            จาก v{proposal.fromVersion} เป็น v{proposal.toVersion} · conflict{' '}
            {proposal.conflicts.length} รายการ
          </p>
          {proposal.conflicts.map((conflict) => (
            <fieldset key={conflict.conflictId}>
              <legend>
                {conflict.kind}
                {conflict.nodeId ? ` · ${conflict.nodeId}` : ''}
                {conflict.field ? ` · ${conflict.field}` : ''}
              </legend>
              {BLOCKING.has(conflict.kind) ? (
                <p className="j5-status-error">
                  ต้องแก้ต้นทางหรือผูก parameter ก่อน เลือกแทนไม่ได้
                </p>
              ) : (
                (['KEEP_LOCAL', 'TAKE_TEMPLATE'] as const).map((choice) => (
                  <label key={choice} className="j5-radio">
                    <input
                      type="radio"
                      name={conflict.conflictId}
                      checked={resolutions[conflict.conflictId] === choice}
                      onChange={() =>
                        setResolutions((current) => ({ ...current, [conflict.conflictId]: choice }))
                      }
                    />
                    {choice === 'KEEP_LOCAL' ? 'ใช้ของ Journey นี้' : 'ใช้ของ template'}
                  </label>
                ))
              )}
            </fieldset>
          ))}
          <button
            type="button"
            className="gov-primary"
            disabled={unresolved}
            onClick={() => void apply()}
          >
            ปรับฉบับร่างตาม proposal
          </button>
        </div>
      ) : null}
      <p className="gov-live" role="status" aria-live="polite">
        {applied ?? ''}
      </p>
      {error ? (
        <p className="j5-status-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
