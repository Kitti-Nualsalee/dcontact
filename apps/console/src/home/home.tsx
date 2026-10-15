import { useTranslation } from '@d-contact/i18n/react';
import { Button, ShellIcon, type ShellNavigationState } from '@d-contact/ui-react';
import './home.css';

/** #684: รายการมาจาก shell request เดียวกัน ไม่มีรายชื่อสำรองที่เดาสิทธิ์เอง */
export function ConsoleHome({ navigation }: { navigation: ShellNavigationState }) {
  const { t } = useTranslation('home');
  const apps = navigation.status === 'loading' ? undefined : navigation.apps;
  const available = apps?.filter((app) => app.id !== 'home');
  const groups = [
    { id: 'live', apps: available?.filter((app) => app.groupId === 'live') ?? [] },
    { id: 'manage', apps: available?.filter((app) => app.groupId !== 'live') ?? [] },
  ] as const;
  return (
    <div className="home">
      <div className="home__heading">
        <h1>{t('title')}</h1>
        <p>{t('subtitle')}</p>
      </div>
      {apps === undefined ? (
        <section className="home__panel" role="status">
          <h2>{t('error')}</h2>
          <p>{t('errorDetail')}</p>
          <Button onPress={() => window.location.reload()}>{t('retry')}</Button>
        </section>
      ) : available?.length === 0 ? (
        <section className="home__panel" role="status">
          <h2>{t('empty')}</h2>
          <p>{t('emptyDetail')}</p>
        </section>
      ) : (
        <section className="home__panel" aria-labelledby="home-choose">
          <h2 id="home-choose">{t('choose')}</h2>
          {groups
            .filter((group) => group.apps.length > 0)
            .map((group) => (
              <section className="home__group" key={group.id} aria-labelledby={`home-${group.id}`}>
                <h3 id={`home-${group.id}`}>{t(group.id)}</h3>
                <ul className="home__list">
                  {group.apps.map((app) => (
                    <li key={app.id}>
                      <a
                        className="home__entry"
                        href={app.href}
                        {...(app.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                      >
                        <span className="home__icon" data-app={app.id}>
                          <ShellIcon
                            name={app.id === 'dphone-embedding' ? 'area-integrations' : app.id}
                            size={28}
                          />
                        </span>
                        <span className="home__copy">
                          <span className="home__name">
                            {t(`names.${app.id}`, { defaultValue: app.label })}
                          </span>
                          <span className="home__description">
                            {t(`descriptions.${app.id}`, {
                              defaultValue: t('descriptionFallback'),
                            })}
                          </span>
                        </span>
                        <span className="home__open" aria-hidden="true">
                          {t('open')}
                          {app.external ? <ShellIcon name="external" size={18} /> : null}
                        </span>
                        {app.external ? (
                          <span className="home__sr-only">{t('external')}</span>
                        ) : null}
                      </a>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
        </section>
      )}
      <p className="home__permission">{t('permission')}</p>
    </div>
  );
}
