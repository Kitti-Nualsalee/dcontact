/**
 * @d-contact/ui-react — component layer ร่วมของ Console และ Workspace (ADR-028, D1.10 #449)
 * token มาจาก `@d-contact/ui/tokens.css` ซึ่งแอปโหลดครั้งเดียวที่ entry
 */
export { Button, type ButtonProps } from './components/Button.js';
export {
  SearchField,
  TextField,
  type SearchFieldProps,
  type TextFieldProps,
} from './components/TextField.js';
export { Select, type SelectOption, type SelectProps } from './components/Select.js';
export { Checkbox, Switch, type CheckboxProps, type SwitchProps } from './components/Toggle.js';
export { Cell, Column, Row, Table, TableBody, TableHeader } from './components/Table.js';
export {
  Badge,
  StatusChip,
  type AgentStatus,
  type BadgeProps,
  type BadgeTone,
  type StatusChipProps,
} from './components/Badge.js';
export { Tab, TabList, TabPanel, Tabs } from './components/Tabs.js';
export { Dialog, DialogTrigger, type DialogProps } from './components/Dialog.js';
export {
  createToastQueue,
  toastQueue,
  ToastRegion,
  type ToastContent,
  type ToastQueue,
} from './components/Toast.js';
export { UI_NAMESPACE, uiResources, useUiText, type UiKey } from './i18n.js';
export * from './shell/index.js';
