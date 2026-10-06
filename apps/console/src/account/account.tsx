/**
 * AC5 (#598): Console › "บัญชีของฉัน" (ทุก role) และ "นโยบายบัญชี" (admin) — Phase Contract #589
 *
 * - ทุกอย่างอยู่ในหน้าของ D-Contact: ไม่มีลิงก์/ข้อความของระบบ identity (D2, D6)
 * - token ยืนยัน email ถูกย้ายออกจาก URL ก่อน render (`stashVerifyToken`) แล้วอ่านครั้งเดียวที่นี่
 * - สิทธิ์จริงตัดสินที่ API — role ใช้แค่เลือกว่าจะแสดงหน้า/ลิงก์ของ admin
 */
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { encode } from 'uqr';
import { useLocale, useTranslation } from '@d-contact/i18n/react';
import { Badge, Button, Dialog, Select, Switch, TextField, toastQueue } from '@d-contact/ui-react';
import {
  AccountApiError,
  type AccountApi,
  type AccountPolicy,
  type AccountPolicyApi,
  type AccountView,
  type EmailChangePolicy,
  type OtpDevice,
  type PasswordRule,
  type TotpEnrolment,
} from './api.js';
import {
  accountErrorKey,
  passwordRuleKey,
  REASON_MAX,
  REASON_MIN,
  takeVerifyToken,
} from './model.js';
import { useShellTokens } from '../shell/tokens.js';
import './account.css';

type T = (key: string, options?: Record<string, unknown>) => string;

function useAccountText(): T {
  const { t } = useTranslation('account');
  return t as unknown as T;
}

const notify = (title: string, tone: 'success' | 'attention' = 'success') =>
  toastQueue.add({ title, tone }, { timeout: 6000 });

function useFormatDate() {
  const { locale } = useLocale();
  return (iso: string | null | undefined) =>
    iso
      ? new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'th-TH', {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(new Date(iso))
      : '';
}

/** QR เป็น SVG ล้วน (ไม่ใช้ innerHTML/canvas) — เข้มบนพื้นขาวเสมอเพื่อให้กล้องอ่านได้ทุกธีม */
export function QrCode({ value, label }: { value: string; label: string }) {
  const { size, data } = encode(value, { ecc: 'M', border: 2 });
  let path = '';
  data.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) path += `M${x} ${y}h1v1h-1z`;
    }),
  );
  return (
    <svg
      className="account__qr"
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
    >
      <rect width={size} height={size} className="account__qr-light" />
      <path d={path} className="account__qr-dark" />
    </svg>
  );
}

// ── หน้า "บัญชีของฉัน" ──

export function AccountPage({
  api,
  verifyStorage,
}: {
  api: AccountApi;
  /** ที่เก็บ token ยืนยัน email ชั่วคราว (sessionStorage) — ไม่มี = ไม่มีการยืนยันค้าง */
  verifyStorage?: Pick<Storage, 'getItem' | 'removeItem'>;
}) {
  const t = useAccountText();
  const tokensReady = useShellTokens();
  const [account, setAccount] = useState<AccountView>();
  const [loadError, setLoadError] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const verifyStarted = useRef(false);

  const reload = useCallback(async () => {
    try {
      setAccount(await api.get());
      setLoadError(undefined);
    } catch (error) {
      setLoadError(t(accountErrorKey(error)));
    }
  }, [api, t]);

  useEffect(() => {
    // ยืนยัน email จากลิงก์ก่อนโหลดข้อมูล — ทำครั้งเดียวแม้ StrictMode เรียก effect ซ้ำ
    if (verifyStarted.current) return;
    verifyStarted.current = true;
    const token = verifyStorage ? takeVerifyToken(verifyStorage) : null;
    if (!token) {
      void reload();
      return;
    }
    setConfirming(true);
    void api
      .confirmEmailChange(token)
      .then(({ email }) => notify(t('email.confirmed', { email })))
      .catch((error) => notify(t(accountErrorKey(error)), 'attention'))
      .finally(() => {
        setConfirming(false);
        void reload();
      });
  }, [api, reload, t, verifyStorage]);

  if (!tokensReady) return null;
  return (
    <main className="account" aria-busy={!account && !loadError}>
      <header className="account__header">
        <h1>{t('page.title')}</h1>
      </header>
      {confirming ? <p role="status">{t('email.confirming')}</p> : null}
      {loadError ? (
        <div className="account__callout account__callout--critical" role="alert">
          <p>{t('page.loadFailed')}</p>
          <p>{loadError}</p>
          <Button onPress={() => void reload()}>{t('page.retry')}</Button>
        </div>
      ) : !account ? (
        <p role="status">{t('page.loading')}</p>
      ) : (
        <>
          <ProfileSection api={api} account={account} onChanged={reload} />
          <EmailSection api={api} account={account} onChanged={reload} />
          <PasswordSection api={api} />
          <MfaSection api={api} account={account} onChanged={reload} />
        </>
      )}
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const id = useId();
  return (
    <section className="account__section" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  );
}

function ProfileSection({
  api,
  account,
  onChanged,
}: {
  api: AccountApi;
  account: AccountView;
  onChanged: () => Promise<void>;
}) {
  const t = useAccountText();
  const [firstName, setFirstName] = useState(account.firstName);
  const [lastName, setLastName] = useState(account.lastName);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const changed = firstName.trim() !== account.firstName || lastName.trim() !== account.lastName;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!firstName.trim() || !lastName.trim()) return setError(t('errors.required'));
    setPending(true);
    try {
      await api.updateProfile({ firstName: firstName.trim(), lastName: lastName.trim() });
      setError(undefined);
      notify(t('profile.saved'));
      await onChanged();
    } catch (caught) {
      setError(t(accountErrorKey(caught)));
    } finally {
      setPending(false);
    }
  };
  return (
    <Section title={t('profile.heading')}>
      <form className="account__form" onSubmit={(event) => void submit(event)} noValidate>
        <div className="account__row">
          <TextField
            label={t('profile.firstName')}
            value={firstName}
            onChange={setFirstName}
            isRequired
            maxLength={100}
            autoComplete="given-name"
          />
          <TextField
            label={t('profile.lastName')}
            value={lastName}
            onChange={setLastName}
            isRequired
            maxLength={100}
            autoComplete="family-name"
          />
        </div>
        {error ? (
          <p className="account__error" role="alert">
            {error}
          </p>
        ) : null}
        <div>
          <Button type="submit" variant="primary" isDisabled={!changed || pending}>
            {t('profile.save')}
          </Button>
        </div>
      </form>
    </Section>
  );
}

function EmailSection({
  api,
  account,
  onChanged,
}: {
  api: AccountApi;
  account: AccountView;
  onChanged: () => Promise<void>;
}) {
  const t = useAccountText();
  const [newEmail, setNewEmail] = useState('');
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const policy = account.policy.emailChange;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!newEmail.trim()) return setError(t('errors.required'));
    setPending(true);
    try {
      const result = await api.requestEmailChange(newEmail.trim());
      setError(undefined);
      setNewEmail('');
      notify(
        result.status === 'PENDING'
          ? t('email.sent', { email: result.pendingEmail })
          : t('email.changed', { email: result.email }),
      );
      await onChanged();
    } catch (caught) {
      setError(t(accountErrorKey(caught)));
    } finally {
      setPending(false);
    }
  };
  const cancel = async () => {
    try {
      await api.cancelEmailChange();
      notify(t('email.cancelled'));
      await onChanged();
    } catch (caught) {
      notify(t(accountErrorKey(caught)), 'attention');
    }
  };
  return (
    <Section title={t('email.heading')}>
      <dl className="account__facts">
        <dt>{t('email.current')}</dt>
        <dd>{account.email}</dd>
      </dl>
      {account.pendingEmail ? (
        <div className="account__callout" role="status">
          <p>{t('email.pending', { email: account.pendingEmail })}</p>
          <Button size="sm" onPress={() => void cancel()}>
            {t('email.cancelPending')}
          </Button>
        </div>
      ) : null}
      {policy === 'ADMIN_ONLY' ? (
        <p className="account__hint">{t('email.adminOnly')}</p>
      ) : (
        <form className="account__form" onSubmit={(event) => void submit(event)} noValidate>
          <TextField
            label={t('email.newEmail')}
            description={t(policy === 'VERIFY' ? 'email.verifyHint' : 'email.immediateHint')}
            type="email"
            value={newEmail}
            onChange={setNewEmail}
            isRequired
            autoComplete="email"
          />
          {error ? (
            <p className="account__error" role="alert">
              {error}
            </p>
          ) : null}
          <div>
            <Button type="submit" variant="primary" isDisabled={pending}>
              {t('email.change')}
            </Button>
          </div>
        </form>
      )}
    </Section>
  );
}

function PasswordSection({ api }: { api: AccountApi }) {
  const t = useAccountText();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string>();
  const [rules, setRules] = useState<PasswordRule[]>([]);
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setRules([]);
    if (!password) return setError(t('errors.required'));
    if (password !== confirm) return setError(t('password.mismatch'));
    setPending(true);
    try {
      await api.changePassword(password);
      setPassword('');
      setConfirm('');
      setError(undefined);
      notify(t('password.changed'));
    } catch (caught) {
      setError(t(accountErrorKey(caught)));
      if (caught instanceof AccountApiError && caught.details.rules) setRules(caught.details.rules);
    } finally {
      setPending(false);
    }
  };
  return (
    <Section title={t('password.heading')}>
      <p className="account__hint">{t('password.hint')}</p>
      <form className="account__form" onSubmit={(event) => void submit(event)} noValidate>
        <div className="account__row">
          <TextField
            label={t('password.newPassword')}
            type="password"
            value={password}
            onChange={setPassword}
            isRequired
            autoComplete="new-password"
          />
          <TextField
            label={t('password.confirmPassword')}
            type="password"
            value={confirm}
            onChange={setConfirm}
            isRequired
            autoComplete="new-password"
          />
        </div>
        {error ? (
          <div className="account__error" role="alert">
            <p>{rules.length > 0 ? t('password.rulesTitle') : error}</p>
            {rules.length > 0 ? (
              <ul>
                {rules.map((rule) => (
                  <li key={rule.rule}>{t(passwordRuleKey(rule.rule), { value: rule.value })}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        <div>
          <Button type="submit" variant="primary" isDisabled={pending}>
            {t('password.change')}
          </Button>
        </div>
      </form>
    </Section>
  );
}

function MfaSection({
  api,
  account,
  onChanged,
}: {
  api: AccountApi;
  account: AccountView;
  onChanged: () => Promise<void>;
}) {
  const t = useAccountText();
  const format = useFormatDate();
  const [enrolment, setEnrolment] = useState<TotpEnrolment>();
  const [removing, setRemoving] = useState<OtpDevice | null>(null);
  const [starting, setStarting] = useState(false);
  const { devices, required } = account.mfa;
  const lastLocked = required && devices.length <= 1;

  const start = async () => {
    setStarting(true);
    try {
      setEnrolment(await api.startTotp());
    } catch (caught) {
      notify(t(accountErrorKey(caught)), 'attention');
    } finally {
      setStarting(false);
    }
  };
  const remove = async (device: OtpDevice) => {
    try {
      await api.removeTotp(device.id);
      notify(t('mfa.removed'));
      await onChanged();
    } catch (caught) {
      notify(t(accountErrorKey(caught)), 'attention');
    }
  };
  return (
    <Section title={t('mfa.heading')}>
      {required ? (
        <p>
          <Badge tone="info">{t('mfa.required')}</Badge>
        </p>
      ) : null}
      {devices.length === 0 ? (
        <p className="account__hint">{t('mfa.notEnrolled')}</p>
      ) : (
        <>
          <h3 className="account__subheading">{t('mfa.devices')}</h3>
          <ul className="account__devices">
            {devices.map((device) => (
              <li key={device.id} className="account__device">
                <span>
                  <strong>{device.label}</strong>
                  {device.createdAt ? (
                    <span className="account__muted">
                      {' · '}
                      {t('mfa.addedAt', { date: format(device.createdAt) })}
                    </span>
                  ) : null}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  isDisabled={lastLocked}
                  aria-label={t('mfa.remove', { label: device.label })}
                  onPress={() => setRemoving(device)}
                >
                  {t('mfa.removeConfirm')}
                </Button>
              </li>
            ))}
          </ul>
          {lastLocked ? <p className="account__hint">{t('mfa.lastDeviceHint')}</p> : null}
        </>
      )}
      <div>
        <Button onPress={() => void start()} isDisabled={starting}>
          {t('mfa.add')}
        </Button>
      </div>
      {enrolment ? (
        <EnrolDialog
          api={api}
          enrolment={enrolment}
          onClose={() => setEnrolment(undefined)}
          onEnrolled={async () => {
            setEnrolment(undefined);
            notify(t('mfa.enrolled'));
            await onChanged();
          }}
        />
      ) : null}
      <Dialog
        role="alertdialog"
        title={t('mfa.removeTitle', { label: removing?.label ?? '' })}
        isOpen={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        footer={(close) => (
          <>
            <Button onPress={close}>{t('actions.cancel')}</Button>
            <Button
              variant="danger"
              onPress={() => {
                const device = removing;
                close();
                if (device) void remove(device);
              }}
            >
              {t('mfa.removeConfirm')}
            </Button>
          </>
        )}
      >
        <p>{t('mfa.removeDescription')}</p>
      </Dialog>
    </Section>
  );
}

function EnrolDialog({
  api,
  enrolment,
  onClose,
  onEnrolled,
}: {
  api: AccountApi;
  enrolment: TotpEnrolment;
  onClose: () => void;
  onEnrolled: () => Promise<void>;
}) {
  const t = useAccountText();
  const format = useFormatDate();
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState(false);
  const grouped = enrolment.secret.replace(/(.{4})/g, '$1 ').trim();

  const submit = async () => {
    if (!/^\d{6}$/.test(code.trim()) || !label.trim()) return setError(t('errors.required'));
    setPending(true);
    try {
      await api.confirmTotp(enrolment.enrolmentId, { code: code.trim(), label: label.trim() });
      await onEnrolled();
    } catch (caught) {
      setError(t(accountErrorKey(caught)));
      setCode('');
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      title={t('mfa.enrolTitle')}
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      footer={(close) => (
        <>
          <Button onPress={close}>{t('actions.cancel')}</Button>
          <Button variant="primary" isDisabled={pending} onPress={() => void submit()}>
            {t('mfa.confirm')}
          </Button>
        </>
      )}
    >
      <div className="account__enrol">
        <p>{t('mfa.enrolStep1')}</p>
        <QrCode value={enrolment.otpauthUri} label={t('mfa.qrLabel')} />
        <p className="account__muted">{t('mfa.manualKey')}</p>
        <p className="account__secret">
          <code>{grouped}</code>{' '}
          <Button
            size="sm"
            variant="ghost"
            onPress={() => {
              void navigator.clipboard?.writeText(enrolment.secret).then(() => setCopied(true));
            }}
          >
            {copied ? t('mfa.copied') : t('mfa.copy')}
          </Button>
        </p>
        <p className="account__muted">
          {t('mfa.expiresAt', { time: format(enrolment.expiresAt) })}
        </p>
        <p>{t('mfa.enrolStep2')}</p>
        <form
          className="account__row"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          noValidate
        >
          <TextField
            label={t('mfa.code')}
            value={code}
            onChange={(value) => setCode(value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            isRequired
          />
          <TextField
            label={t('mfa.label')}
            placeholder={t('mfa.labelPlaceholder')}
            value={label}
            onChange={setLabel}
            maxLength={64}
            isRequired
          />
          <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
        </form>
        {error ? (
          <p className="account__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

// ── หน้า "นโยบายบัญชี" (admin) ──

export function AccountPolicyPage({ api, canEdit }: { api: AccountPolicyApi; canEdit: boolean }) {
  const t = useAccountText();
  const format = useFormatDate();
  const tokensReady = useShellTokens();
  const [policy, setPolicy] = useState<AccountPolicy>();
  const [emailChange, setEmailChange] = useState<EmailChangePolicy>('VERIFY');
  const [mfaRequired, setMfaRequired] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
  const [pending, setPending] = useState(false);

  const apply = (next: AccountPolicy) => {
    setPolicy(next);
    setEmailChange(next.emailChange);
    setMfaRequired(next.mfaRequired);
  };
  const reload = useCallback(async () => {
    try {
      apply(await api.get());
      setLoadError(undefined);
    } catch (caught) {
      setLoadError(t(accountErrorKey(caught)));
    }
  }, [api, t]);
  useEffect(() => {
    if (canEdit) void reload();
  }, [canEdit, reload]);

  const changed =
    policy !== undefined &&
    (emailChange !== policy.emailChange || mfaRequired !== policy.mfaRequired);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!policy) return;
    if (!changed) return notify(t('policy.unchanged'));
    const trimmed = reason.trim();
    if (trimmed.length < REASON_MIN || trimmed.length > REASON_MAX) {
      return setError(t('errors.reasonLength'));
    }
    setPending(true);
    try {
      apply(
        await api.update({
          emailChange,
          mfaRequired,
          reason: trimmed,
          expectedRevision: policy.revision,
        }),
      );
      setReason('');
      setError(undefined);
      notify(t('policy.saved'));
    } catch (caught) {
      setError(t(accountErrorKey(caught)));
      if (caught instanceof AccountApiError && caught.code === 'REVISION_CONFLICT') await reload();
    } finally {
      setPending(false);
    }
  };

  if (!tokensReady) return null;
  return (
    <main className="account" aria-busy={canEdit && !policy && !loadError}>
      <header className="account__header">
        <h1>{t('page.policyTitle')}</h1>
        <p className="account__hint">{t('policy.intro')}</p>
      </header>
      {!canEdit ? (
        <p className="account__callout" role="status">
          {t('policy.adminOnly')}
        </p>
      ) : loadError ? (
        <div className="account__callout account__callout--critical" role="alert">
          <p>{loadError}</p>
          <Button onPress={() => void reload()}>{t('page.retry')}</Button>
        </div>
      ) : !policy ? (
        <p role="status">{t('page.loading')}</p>
      ) : (
        <form
          className="account__section account__form"
          onSubmit={(event) => void submit(event)}
          noValidate
        >
          <p className="account__muted">
            {policy.updatedAt
              ? t('policy.lastUpdated', { date: format(policy.updatedAt) })
              : t('policy.neverUpdated')}
          </p>
          <Select
            label={t('policy.emailChange')}
            options={(['VERIFY', 'IMMEDIATE', 'ADMIN_ONLY'] as const).map((id) => ({
              id,
              label: t(`policy.emailOptions.${id}`),
            }))}
            selectedKey={emailChange}
            onSelectionChange={(key) => setEmailChange(key as EmailChangePolicy)}
          />
          <div>
            <Switch isSelected={mfaRequired} onChange={setMfaRequired}>
              {t('policy.mfaRequired')}
            </Switch>
            <p className="account__hint">{t('policy.mfaHint')}</p>
          </div>
          <TextField
            label={t('policy.reason')}
            description={t('policy.reasonHint')}
            value={reason}
            onChange={setReason}
            multiline
            maxLength={REASON_MAX}
            isRequired
          />
          {error ? (
            <p className="account__error" role="alert">
              {error}
            </p>
          ) : null}
          <div>
            <Button type="submit" variant="primary" isDisabled={pending || !changed}>
              {t('policy.save')}
            </Button>
          </div>
        </form>
      )}
    </main>
  );
}
