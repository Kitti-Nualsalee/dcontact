import { useId } from 'react';
import { useLocale, useTranslation } from '@d-contact/i18n/react';
import { Badge, TextField } from '@d-contact/ui-react';
import type { Answers, EvaluationScore, FormDefinition, FormQuestion } from './api.js';
import { formatScore, scaleValues, setAnswer } from './model.js';

interface Props {
  definition: FormDefinition;
  answers: Answers;
  /** omitted = read-only */
  onChange?: (answers: Answers) => void;
  errors?: Record<string, string>;
  sectionScores?: EvaluationScore['sections'];
  disabled?: boolean;
}

/**
 * one evaluation form — used both when a Supervisor scores and when showing a published result
 * the answer buttons are browser radios because ui-react has no RadioGroup yet (noted in the PR)
 */
export function EvaluationForm({
  definition,
  answers,
  onChange,
  errors = {},
  sectionScores,
  disabled,
}: Props) {
  const { t } = useTranslation('quality');
  const { locale } = useLocale();
  const readOnly = !onChange;
  return (
    <div className="qm-sections">
      {definition.sections.map((section) => {
        const sectionScore = sectionScores?.find((item) => item.sectionId === section.id);
        return (
          <section key={section.id} className="qm-card" aria-labelledby={`qm-sec-${section.id}`}>
            <header className="qm-card-head">
              <h2 id={`qm-sec-${section.id}`}>{section.name}</h2>
              <span className="qm-muted">
                {t('evaluation.weight', { weight: section.weight })}
                {sectionScore
                  ? ` · ${t('evaluation.sectionScore', {
                      score:
                        sectionScore.score === null
                          ? t('evaluation.na')
                          : formatScore(sectionScore.score, locale),
                    })}`
                  : null}
              </span>
            </header>
            <ol className="qm-questions">
              {section.questions.map((question) => (
                <li key={question.id}>
                  <Question
                    question={question}
                    answer={answers[question.id]}
                    error={errors[`answers.${question.id}`]}
                    readOnly={readOnly}
                    disabled={disabled}
                    onChange={(value) => onChange?.(setAnswer(answers, question.id, value))}
                  />
                </li>
              ))}
            </ol>
          </section>
        );
      })}
    </div>
  );
}

function Question({
  question,
  answer,
  error,
  readOnly,
  disabled,
  onChange,
}: {
  question: FormQuestion;
  answer: Answers[string] | undefined;
  error?: string;
  readOnly: boolean;
  disabled?: boolean;
  onChange: (value: Answers[string] | undefined) => void;
}) {
  const { t } = useTranslation('quality');
  const name = useId();
  const errorId = `${name}-error`;
  const meta = [
    question.type === 'TEXT'
      ? t('evaluation.notScored')
      : t('evaluation.points', { points: question.points }),
    question.autoFail ? t('evaluation.autoFailHint') : null,
  ]
    .filter(Boolean)
    .join(' · ');

  if (question.type === 'TEXT') {
    const value =
      answer && 'value' in answer && typeof answer.value === 'string' ? answer.value : '';
    if (readOnly) {
      return (
        <div className="qm-question">
          <p className="qm-question-text">{question.text}</p>
          <p className="qm-answer-text">{value || t('evaluation.noText')}</p>
        </div>
      );
    }
    return (
      <div className="qm-question">
        <TextField
          label={question.text}
          description={meta}
          multiline
          value={value}
          isDisabled={disabled}
          maxLength={2000}
          onChange={(next) => onChange(next === '' ? undefined : { value: next })}
        />
      </div>
    );
  }

  const options: { key: string; label: string; answer: Answers[string] }[] =
    question.type === 'YES_NO'
      ? [
          { key: 'yes', label: t('evaluation.yes'), answer: { value: true } },
          { key: 'no', label: t('evaluation.no'), answer: { value: false } },
        ]
      : scaleValues(question).map((value) => ({
          key: String(value),
          label: String(value),
          answer: { value },
        }));
  if (question.allowNa)
    options.push({ key: 'na', label: t('evaluation.na'), answer: { na: true } });
  const selectedKey =
    answer === undefined
      ? undefined
      : 'na' in answer
        ? 'na'
        : typeof answer.value === 'boolean'
          ? answer.value
            ? 'yes'
            : 'no'
          : String(answer.value);

  if (readOnly) {
    const selected = options.find((option) => option.key === selectedKey);
    return (
      <div className="qm-question">
        <p className="qm-question-text">{question.text}</p>
        <p className="qm-question-meta">{meta}</p>
        <p className="qm-answer">
          <Badge
            tone={
              selectedKey === 'no' && question.autoFail
                ? 'critical'
                : selectedKey === undefined
                  ? 'neutral'
                  : 'info'
            }
          >
            {selected
              ? question.type === 'SCALE' && selectedKey !== 'na'
                ? t('evaluation.scaleAnswer', {
                    value: selected.label,
                    max: question.scale?.[1],
                  })
                : selected.label
              : t('evaluation.unanswered')}
          </Badge>
        </p>
      </div>
    );
  }

  return (
    <fieldset
      className="qm-question"
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? errorId : undefined}
      disabled={disabled}
    >
      <legend className="qm-question-text">{question.text}</legend>
      <p className="qm-question-meta">
        {question.type === 'SCALE'
          ? `${meta} · ${t('evaluation.scaleRange', {
              min: question.scale?.[0],
              max: question.scale?.[1],
            })}`
          : meta}
      </p>
      <div className="qm-choices">
        {options.map((option) => (
          <label key={option.key} className="qm-choice">
            <input
              type="radio"
              name={name}
              value={option.key}
              checked={selectedKey === option.key}
              onChange={() => onChange(option.answer)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
      {error ? (
        <p id={errorId} className="qm-field-error">
          {t(`errors.${error}`, { defaultValue: t('errors.INVALID') })}
        </p>
      ) : null}
    </fieldset>
  );
}
