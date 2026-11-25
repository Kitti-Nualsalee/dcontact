/**
 * The right tool bar of Workspace V3 is a vertical toolbar with a roving tabindex
 * (docs/ui-principles.md item 2 and the WAI-ARIA APG Toolbar pattern):
 * Tab enters the bar at a single stop and the next Tab leaves it; buttons inside use arrow up/down (wrapping), Home and End
 * the entry point is the last focused button in the bar; if none has been focused yet, use the pressed button (the open tab) or the first button
 */
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export interface UtilityToolbarItem {
  id: string;
  label: string;
  icon: ReactNode;
  onPress: () => void;
  pressed?: boolean;
}

export function UtilityToolbar({ label, items }: { label: string; items: UtilityToolbarItem[] }) {
  const [lastFocused, setLastFocused] = useState<string | null>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const tabStop =
    items.find((item) => item.id === lastFocused)?.id ??
    items.find((item) => item.pressed)?.id ??
    items[0]?.id;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = items.findIndex((item) => buttons.current.get(item.id) === event.target);
    if (index < 0) return;
    const last = items.length - 1;
    const next =
      event.key === 'ArrowDown'
        ? index === last
          ? 0
          : index + 1
        : event.key === 'ArrowUp'
          ? index === 0
            ? last
            : index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    buttons.current.get(items[next]!.id)?.focus();
  };

  return (
    <div
      className="aw-v3-utility"
      role="toolbar"
      aria-orientation="vertical"
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      {items.map((item) => (
        <button
          key={item.id}
          ref={(node) => {
            if (node) buttons.current.set(item.id, node);
            else buttons.current.delete(item.id);
          }}
          type="button"
          tabIndex={item.id === tabStop ? 0 : -1}
          aria-label={item.label}
          title={item.label}
          aria-pressed={item.pressed}
          onFocus={() => setLastFocused(item.id)}
          onClick={item.onPress}
        >
          {item.icon}
        </button>
      ))}
    </div>
  );
}
