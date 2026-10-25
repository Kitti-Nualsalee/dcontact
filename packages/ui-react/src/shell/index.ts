export {
  AppShell,
  ShellPageNavProvider,
  useInShell,
  useShellPageNav,
  type AppShellProps,
} from './AppShell.js';
export { Rail, RailLink, type RailProps } from './Rail.js';
export { AppLauncher, type AppLauncherProps } from './AppLauncher.js';
export { SubNav, type SubNavItem, type SubNavProps, type SubNavSection } from './SubNav.js';
export {
  Breadcrumb,
  LanguageSwitch,
  TopBar,
  type BreadcrumbProps,
  type LanguageSwitchProps,
  type TopBarProps,
} from './TopBar.js';
export { ShellFrame, type ShellFrameProps } from './ShellFrame.js';
export { areaOf } from './areas.js';
export { ShellIcon } from './icons.js';
export { UserMenu, type SignOutConfirm, type UserMenuProps } from './UserMenu.js';
export {
  SHELL_ROLES,
  displayNameFromClaims,
  shellRolesFromClaims,
  shellUserFromClaims,
  userInitials,
  type ShellRole,
  type ShellUser,
  type ShellUserClaims,
} from './user.js';
export {
  buildAppHref,
  toShellModel,
  useShellNavigation,
  type HostApp,
  type NavigationResponseV1,
  type ShellNavigationOptions,
  type ShellNavigationState,
} from './navigation.js';
export type {
  ShellApp,
  ShellArea,
  ShellAreaItem,
  ShellAreaSection,
  ShellCreateAction,
  ShellGroup,
} from './types.js';
