import { useEffect, useId, useState } from 'react';
import { Button as AriaButton, Menu, MenuItem, MenuTrigger, Popover } from 'react-aria-components';
import { Badge } from '../components/Badge.js';
import { Button } from '../components/Button.js';
import { Dialog } from '../components/Dialog.js';
import { useUiText } from '../i18n.js';
import { userInitials, type ShellUser } from './user.js';
import styles from './UserMenu.module.css';

export interface SignOutConfirm {
  title: string;
  description: string;
  confirmLabel: string;
}

export interface UserMenuProps {
  user: ShellUser;
  /** may return a Promise — the app reports the error itself (e.g. a failed redirect to sign out) */
  onSignOut: () => void | Promise<void>;
  /** has a value = choosing "Sign out" asks for confirmation with a Dialog first (Workspace during a call); none = sign out immediately */
  signOutConfirm?: SignOutConfirm;
  /**
   * AC5 (#598): the "My account" item — always a D-Contact (Console) page
   * `newTab` = opens a new tab (Workspace: does not remount during a call — ADR-026)
   */
  accountLink?: { href: string; newTab?: boolean };
}

/**
 * #588: initials button + name at the far right of the top bar, opens a menu with name, email, organization, role and sign out
 * no link to the Keycloak page (the user stays on D-Contact pages all the time) and no profile picture is loaded
 * AC5 (#598): "My account" points to the D-Contact Console page
 */
export function UserMenu({ user, onSignOut, signOutConfirm, accountLink }: UserMenuProps) {
  const t = useUiText();
  const headerId = useId();
  const [confirming, setConfirming] = useState(false);
  // no work left while the dialog is open = no need to ask any more — clear the state so the dialog does not pop back on its own on the next work item
  useEffect(() => {
    if (!signOutConfirm) setConfirming(false);
  }, [signOutConfirm]);
  const initials = userInitials(user.displayName);
  const name = user.displayName || user.email || t('userMenu.unnamed');

  return (
    <>
      <MenuTrigger>
        <AriaButton className={styles.trigger} aria-label={t('userMenu.open', { name })}>
          <span className={styles.avatar} aria-hidden="true">
            {initials || <PersonIcon />}
          </span>
          <span className={styles.name} aria-hidden="true">
            {name}
          </span>
        </AriaButton>
        <Popover className={styles.popover} placement="bottom end" offset={6}>
          <div id={headerId} className={styles.header}>
            <span className={styles.headerName}>{name}</span>
            {user.email && user.email !== name ? (
              <span className={styles.detail}>{user.email}</span>
            ) : null}
            {user.organization ? (
              <span className={styles.detail}>
                {t('userMenu.organization', { organization: user.organization })}
              </span>
            ) : null}
            {user.roles.length > 0 ? (
              <span className={styles.roles}>
                {user.roles.map((role) => (
                  <Badge key={role} tone="neutral">
                    {t(`userMenu.roles.${role}`)}
                  </Badge>
                ))}
              </span>
            ) : null}
          </div>
          <Menu
            className={styles.menu}
            aria-labelledby={headerId}
            onAction={(key) => {
              if (key !== 'sign-out') return;
              if (signOutConfirm) setConfirming(true);
              else void onSignOut();
            }}
          >
            {accountLink ? (
              <MenuItem
                id="account"
                className={styles.item}
                href={accountLink.href}
                {...(accountLink.newTab ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
              >
                {t('userMenu.account')}
              </MenuItem>
            ) : null}
            <MenuItem id="sign-out" className={styles.item}>
              {t('userMenu.signOut')}
            </MenuItem>
          </Menu>
        </Popover>
      </MenuTrigger>
      {signOutConfirm ? (
        <Dialog
          role="alertdialog"
          title={signOutConfirm.title}
          isOpen={confirming}
          onOpenChange={setConfirming}
          footer={(close) => (
            <>
              <Button onPress={close}>{t('userMenu.cancel')}</Button>
              <Button
                variant="danger"
                onPress={() => {
                  close();
                  void onSignOut();
                }}
              >
                {signOutConfirm.confirmLabel}
              </Button>
            </>
          )}
        >
          <p className={styles.confirmText}>{signOutConfirm.description}</p>
        </Dialog>
      ) : null}
    </>
  );
}

function PersonIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M8 7a4 4 0 1 0 8 0a4 4 0 1 0 -8 0 M6 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2" />
    </svg>
  );
}
