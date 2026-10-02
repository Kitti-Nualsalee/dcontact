import { useId, useState } from 'react';
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
  onSignOut: () => void;
  /** มีค่า = เลือก "ออกจากระบบ" แล้วถามยืนยันด้วย Dialog ก่อน (Workspace ระหว่างมีสาย); ไม่มี = ออกทันที */
  signOutConfirm?: SignOutConfirm;
}

/**
 * #588: ปุ่มอักษรย่อ + ชื่อ ขวาสุดของแถบบน เปิดเมนูที่มีชื่อ, email, organization, บทบาท และออกจากระบบ
 * ไม่มีลิงก์ไปหน้าของ Keycloak (ผู้ใช้อยู่ในหน้าของ D-Contact ตลอด) และไม่โหลดรูปโปรไฟล์
 */
export function UserMenu({ user, onSignOut, signOutConfirm }: UserMenuProps) {
  const t = useUiText();
  const headerId = useId();
  const [confirming, setConfirming] = useState(false);
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
              else onSignOut();
            }}
          >
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
                  onSignOut();
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
