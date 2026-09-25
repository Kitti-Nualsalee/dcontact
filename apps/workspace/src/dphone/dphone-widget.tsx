/**
 * D1.15 (#454): dphone widget — 3 ขนาด (แถบย่อ / กะทัดรัด / ขยายพร้อมแป้นกด), ลากย้ายได้, แยกหน้าต่างได้
 *
 * เป็น UI ล้วน: รับ view และส่ง command — SIP session อยู่ที่ working tab เสมอ การเปลี่ยนขนาด/ตำแหน่ง/
 * แยกหน้าต่างจึงไม่แตะ WebRTC หรือ WS (ADR-026) ใช้ได้ทั้งใน Workspace (ลอย) และในหน้า `/dphone`
 */
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from '@d-contact/i18n/react';
import { Button } from '@d-contact/ui-react';
import type { DphoneCommand, DphoneView } from './dphone-bridge.js';

export type DphoneSize = 'bar' | 'compact' | 'expanded';
export const DPHONE_SIZES: readonly DphoneSize[] = ['bar', 'compact', 'expanded'];

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'] as const;

export interface DphoneWidgetProps {
  view: DphoneView;
  onCommand(command: DphoneCommand): void;
  size: DphoneSize;
  onSizeChange(size: DphoneSize): void;
  /** มีเมื่อแยกหน้าต่างได้ (working tab ใน Workspace) */
  onDetach?(): void;
  /** ลอยบนหน้า Workspace และลากได้ — ในหน้า `/dphone` เต็มหน้าต่าง */
  floating?: boolean;
}

interface Position {
  right: number;
  bottom: number;
}

const POSITION_KEY = 'dcontact.dphone.position';

function loadPosition(): Position {
  try {
    const saved = JSON.parse(localStorage.getItem(POSITION_KEY) ?? 'null') as Position | null;
    if (saved && Number.isFinite(saved.right) && Number.isFinite(saved.bottom)) return saved;
  } catch {
    // ตำแหน่งเป็นความสะดวก ไม่ใช่ข้อมูลสำคัญ
  }
  return { right: 24, bottom: 24 };
}

export function DphoneWidget({
  view,
  onCommand,
  size,
  onSizeChange,
  onDetach,
  floating = false,
}: DphoneWidgetProps) {
  const { t } = useTranslation('dphone');
  const [position, setPosition] = useState<Position>(loadPosition);
  const drag = useRef<{ x: number; y: number; start: Position } | null>(null);
  const inCall = view.phase === 'CONNECTING' || view.phase === 'ACTIVE' || view.phase === 'HELD';
  const ringing = view.phase === 'RINGING';
  const caller = view.caller ?? (ringing || inCall ? t('noNumber') : t('noCall'));

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!floating || event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
    drag.current = { x: event.clientX, y: event.clientY, start: position };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current) return;
    setPosition({
      right: Math.max(0, current.start.right - (event.clientX - current.x)),
      bottom: Math.max(0, current.start.bottom - (event.clientY - current.y)),
    });
  };
  const onPointerUp = () => {
    if (!drag.current) return;
    drag.current = null;
    try {
      localStorage.setItem(POSITION_KEY, JSON.stringify(position));
    } catch {
      // ดู loadPosition
    }
  };

  return (
    <section
      className={`dp-widget dp-${size}${floating ? ' dp-floating' : ''}`}
      aria-label={t('region')}
      data-phase={view.phase}
      style={floating ? { right: position.right, bottom: position.bottom } : undefined}
    >
      <div
        className="dp-header"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        title={floating ? t('dragHint') : undefined}
      >
        <span className="dp-name">{t('name')}</span>
        <span className="dp-status" role="status" aria-label={t('name')}>
          {t(`phase.${view.phase}`)}
        </span>
        <div className="dp-sizes" role="group" aria-label={t('size.label')}>
          {DPHONE_SIZES.map((option) => (
            <button
              key={option}
              type="button"
              className="dp-icon-button"
              aria-pressed={size === option}
              aria-label={t(`size.${option}`)}
              title={t(`size.${option}`)}
              onClick={() => onSizeChange(option)}
            >
              <SizeIcon size={option} />
            </button>
          ))}
          {onDetach ? (
            <button
              type="button"
              className="dp-icon-button"
              aria-label={t('detach')}
              title={t('detach')}
              onClick={onDetach}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <path d="M14 4h6v6 M20 4l-9 9 M18 14v5a1 1 0 0 1 -1 1h-12a1 1 0 0 1 -1 -1v-12a1 1 0 0 1 1 -1h5" />
              </svg>
            </button>
          ) : null}
        </div>
      </div>

      <div className="dp-body">
        <div className="dp-call">
          <strong className="dp-caller">{caller}</strong>
          {size !== 'bar' && view.queueName ? (
            <span className="dp-queue">{view.queueName}</span>
          ) : null}
        </div>
        <div className="dp-actions">
          {ringing ? (
            <Button
              variant="primary"
              size={size === 'bar' ? 'sm' : 'md'}
              onPress={() => onCommand({ type: 'accept' })}
            >
              {t('accept')}
            </Button>
          ) : null}
          {inCall && size !== 'bar' ? (
            <>
              <Button size="sm" onPress={() => onCommand({ type: 'toggleMute' })}>
                {view.muted ? t('unmute') : t('mute')}
              </Button>
              <Button
                size="sm"
                isDisabled={view.phase === 'CONNECTING'}
                onPress={() => onCommand({ type: 'toggleHold' })}
              >
                {view.phase === 'HELD' ? t('resume') : t('hold')}
              </Button>
            </>
          ) : null}
          {inCall ? (
            <Button variant="danger" size="sm" onPress={() => onCommand({ type: 'hangup' })}>
              {t('hangup')}
            </Button>
          ) : null}
        </div>
        {size === 'expanded' ? (
          <div className="dp-keypad" role="group" aria-label={t('dtmfPad')}>
            {KEYS.map((value) => (
              <button
                key={value}
                type="button"
                aria-label={t('dtmf', { value })}
                disabled={view.phase !== 'ACTIVE'}
                onClick={() => onCommand({ type: 'dtmf', value })}
              >
                {value}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function SizeIcon({ size }: { size: DphoneSize }) {
  const path =
    size === 'bar'
      ? 'M5 17h14'
      : size === 'compact'
        ? 'M6 9h12v8h-12z'
        : 'M5 4h14v16h-14z M9 9h1 M14 9h1 M9 13h1 M14 13h1 M9 17h1 M14 17h1';
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}

/** ที่ว่างของ widget ระหว่างที่ dphone ถูกแยกไปเป็นหน้าต่าง */
export function DphoneDetachedBar({ view, onAttach }: { view: DphoneView; onAttach(): void }) {
  const { t } = useTranslation('dphone');
  return (
    <section
      className="dp-widget dp-bar dp-floating dp-detached"
      aria-label={t('region')}
      style={{ right: 24, bottom: 24 }}
    >
      <div className="dp-header">
        <span className="dp-name">{t('name')}</span>
        <span className="dp-status" role="status" aria-label={t('name')}>
          {t(`phase.${view.phase}`)}
        </span>
      </div>
      <div className="dp-body">
        <p className="dp-detached-note">{t('detached')}</p>
        <Button size="sm" onPress={onAttach}>
          {t('attach')}
        </Button>
      </div>
    </section>
  );
}
