import { useTranslation } from '@d-contact/i18n/react';
import { Badge, Button } from '@d-contact/ui-react';
import { LanguageSwitcher } from './language-switcher.js';
import { canMutate, type Route, type SessionView } from './model.js';

export function PlatformHeader({
  session,
  route,
  navigate,
  onSignOut,
}: {
  session: SessionView;
  route: Route;
  navigate: (route: Route) => void;
  onSignOut?: () => void;
}) {
  const { t } = useTranslation();
  const mutate = canMutate(session);
  const identity = mutate
    ? t('identity.operator')
    : session.mutations === 'DISABLED'
      ? t('identity.disabled')
      : session.mutations === 'NOT_ALLOWLISTED'
        ? t('identity.canary')
        : t('identity.auditor');
  return (
    <>
      <a className="skip-link" href="#main">
        {t('navigation.skip')}
      </a>
      <header className="topbar">
        <div className="brand">
          <span className="eyebrow">{t('brand.internal')}</span>
          <strong>{t('brand.title')}</strong>
        </div>
        <nav aria-label={t('navigation.label')} className="topnav">
          <Button
            variant="ghost"
            className={`nav-link${route.name === 'list' ? ' active' : ''}`}
            aria-current={route.name === 'list' ? 'page' : undefined}
            onPress={() => navigate({ name: 'list' })}
          >
            {t('navigation.tenants')}
          </Button>
          {mutate ? (
            <Button
              variant="ghost"
              className={`nav-link${route.name === 'new' ? ' active' : ''}`}
              aria-current={route.name === 'new' ? 'page' : undefined}
              onPress={() => navigate({ name: 'new' })}
            >
              {t('navigation.create')}
            </Button>
          ) : null}
        </nav>
        <div className="identity">
          <Badge tone="neutral">{identity}</Badge>
          <LanguageSwitcher />
          {onSignOut ? (
            <Button variant="ghost" onPress={onSignOut}>
              {t('auth.signOut')}
            </Button>
          ) : null}
        </div>
      </header>
    </>
  );
}
