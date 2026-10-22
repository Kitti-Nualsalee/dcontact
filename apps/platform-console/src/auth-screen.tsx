import { useTranslation } from '@d-contact/i18n/react';
import { Button } from '@d-contact/ui-react';
import { LanguageSwitcher } from './language-switcher.js';

type AuthScreen = 'loading' | 'login' | 'configuration' | 'session-loading' | 'session-error';

export function PlatformAuthScreen({
  state,
  errorCode,
  onSignIn,
}: {
  state: AuthScreen;
  errorCode?: string;
  onSignIn?: () => void;
}) {
  const { t } = useTranslation();
  const busy = state === 'loading' || state === 'session-loading';
  const title =
    state === 'loading'
      ? t('auth.loading')
      : state === 'configuration'
        ? t('configuration.title')
        : state === 'session-loading'
          ? t('session.loading')
          : state === 'session-error'
            ? t('session.title')
            : t('brand.title');
  const sessionMessage =
    errorCode === 'UNAUTHENTICATED'
      ? t('session.expired')
      : errorCode === 'FORBIDDEN'
        ? t('session.forbidden')
        : t('session.unavailable');

  return (
    <main className="centered" aria-busy={busy || undefined}>
      <div className="public-language">
        <LanguageSwitcher />
      </div>
      <h1>{title}</h1>
      {state === 'login' ? <p>{t('auth.intro')}</p> : null}
      {state === 'configuration' ? <p>{t('configuration.description')}</p> : null}
      {state === 'session-error' ? <p role="alert">{sessionMessage}</p> : null}
      {onSignIn ? (
        <Button variant="primary" onPress={onSignIn}>
          {state === 'session-error' ? t('auth.signInAgain') : t('auth.signIn')}
        </Button>
      ) : null}
    </main>
  );
}
