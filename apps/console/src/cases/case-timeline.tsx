import { useState, type ReactNode } from 'react';
import { useTranslation } from '@d-contact/i18n/react';
import { Button } from '@d-contact/ui-react';
import type { CaseActivity, CasePeople } from './api.js';
import { CaseStatusChip, marker, renderTemplate, useDateFormat } from './common.js';
import {
  TIMELINE_WINDOW,
  historyHref,
  isLongNote,
  orderActivities,
  shortId,
  visibleActivities,
} from './model.js';
import { useConsoleNavigation } from '../shell/console-navigation.js';

interface Props {
  activities: readonly CaseActivity[];
  people: CasePeople;
}

const ICONS: Record<CaseActivity['kind'], ReactNode> = {
  CREATED: <path d="M2 4.5h4l1.2 1.5H14v6.5H2zM8 8v3M6.5 9.5h3" />,
  LINKED: (
    <path d="M6.5 9.5l3-3M5 8l-1.2 1.2a2.2 2.2 0 003.1 3.1L8 11M11 8l1.2-1.2a2.2 2.2 0 00-3.1-3.1L8 5" />
  ),
  REOPENED: <path d="M3 8a5 5 0 109-3M12 2v3H9" />,
  NOTE: <path d="M3 3h10v7l-3 3H3zM10 13v-3h3M5.5 6h5M5.5 8.5h3" />,
  ASSIGNED: (
    <path d="M6 7.5a2.2 2.2 0 100-4.4 2.2 2.2 0 000 4.4zM2 13c0-2.2 1.8-3.6 4-3.6M10 9l3 2-3 2" />
  ),
  STATUS_CHANGED: <path d="M3 5.5h9l-2.5-2.5M13 10.5H4L6.5 13" />,
};

/** timeline oldest to newest; shows the latest 50 entries and loads earlier entries 50 at a time */
export function CaseTimeline({ activities, people }: Props) {
  const { t } = useTranslation('cases');
  const ordered = orderActivities(activities);
  const [size, setSize] = useState(TIMELINE_WINDOW);
  const { items, hidden } = visibleActivities(ordered, size);
  return (
    <div>
      <div className="cs-timeline-head">
        <h2>{t('timeline.title')}</h2>
        <span className="cs-muted">{t('timeline.count', { count: ordered.length })}</span>
      </div>
      {hidden > 0 ? (
        <Button variant="ghost" onPress={() => setSize((current) => current + TIMELINE_WINDOW)}>
          {t('timeline.loadEarlier', { count: hidden })}
        </Button>
      ) : null}
      <ol className="cs-timeline" aria-label={t('timeline.title')}>
        {items.map((activity) => (
          <TimelineItem key={activity.id} activity={activity} people={people} />
        ))}
      </ol>
    </div>
  );
}

function TimelineItem({ activity, people }: { activity: CaseActivity; people: CasePeople }) {
  const { t } = useTranslation('cases');
  const format = useDateFormat();
  const navigate = useConsoleNavigation();
  const name = (userId: string | null) =>
    userId ? (people[userId] ?? t('actor.unknown')) : t('actor.unknown');
  // a row without an actor was written by an automation (Journey), not by a person who left the team
  const actor = (
    <strong>
      {activity.actorUserId ? name(activity.actorUserId) : t('actor.automation')}
    </strong>
  );
  const assignee = <strong>{name(activity.assigneeUserId)}</strong>;
  let text: ReactNode;
  switch (activity.kind) {
    case 'CREATED':
      text = activity.actorUserId ? (
        renderTemplate(
          t(
            activity.assigneeUserId && activity.assigneeUserId !== activity.actorUserId
              ? 'timeline.opened'
              : 'timeline.openedSelf',
            { actor: marker('actor'), assignee: marker('assignee') },
          ),
          { actor, assignee },
        )
      ) : (
        <>
          {renderTemplate(t('timeline.openedAuto', { actor: marker('actor') }), { actor })}{' '}
          {activity.interactionId ? (
            <code className="cs-code" title={activity.interactionId}>
              {shortId(activity.interactionId)}
            </code>
          ) : null}
        </>
      );
      break;
    case 'LINKED': {
      const channel = activity.interactionChannel
        ? (t(`channel.${activity.interactionChannel}` as 'channel.VOICE', {
            defaultValue: activity.interactionChannel,
          }) as string)
        : '';
      const direction = activity.interactionDirection
        ? t(`direction.${activity.interactionDirection}`)
        : '';
      text = (
        <>
          {renderTemplate(t('timeline.linked', { actor: marker('actor'), channel, direction }), {
            actor,
          })}{' '}
          {activity.interactionId ? (
            <code className="cs-code" title={activity.interactionId}>
              {shortId(activity.interactionId)}
            </code>
          ) : null}{' '}
          {activity.interactionMine && activity.interactionId ? (
            <HistoryLink interactionId={activity.interactionId} navigate={navigate} />
          ) : null}
        </>
      );
      break;
    }
    case 'NOTE':
      text = renderTemplate(t('timeline.note', { actor: marker('actor') }), { actor });
      break;
    case 'ASSIGNED':
      text = renderTemplate(
        t('timeline.assigned', { actor: marker('actor'), assignee: marker('assignee') }),
        { actor, assignee },
      );
      break;
    case 'REOPENED':
      text = renderTemplate(t('timeline.reopened', { actor: marker('actor') }), { actor });
      break;
    case 'STATUS_CHANGED':
      text = renderTemplate(
        t('timeline.status', {
          actor: marker('actor'),
          from: marker('from'),
          to: marker('to'),
        }),
        {
          actor,
          from: activity.fromStatus ? <CaseStatusChip status={activity.fromStatus} /> : null,
          to: activity.toStatus ? <CaseStatusChip status={activity.toStatus} /> : null,
        },
      );
      break;
  }
  return (
    <li className={`cs-event cs-event-${activity.kind.toLowerCase()}`}>
      <span className="cs-event-icon" aria-hidden="true">
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {ICONS[activity.kind]}
        </svg>
      </span>
      <div className="cs-event-body">
        <div className="cs-event-line">
          <span>{text}</span>
          <time dateTime={activity.occurredAt} className="cs-muted">
            {format(activity.occurredAt)}
          </time>
        </div>
        {activity.kind === 'NOTE' && activity.body ? <NoteBody body={activity.body} /> : null}
      </div>
    </li>
  );
}

function HistoryLink({
  interactionId,
  navigate,
}: {
  interactionId: string;
  navigate: ((href: string) => boolean) | undefined;
}) {
  const { t } = useTranslation('cases');
  const href = historyHref(new URL(window.location.href), interactionId);
  const relative = href.pathname + href.search;
  return (
    <a
      className="cs-link"
      href={relative}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        if (navigate?.(relative)) event.preventDefault();
      }}
    >
      {t('timeline.openHistory')}
    </a>
  );
}

/** a note is plain text only (no HTML rendering); longer than 300 characters is clamped at 6 lines */
function NoteBody({ body }: { body: string }) {
  const { t } = useTranslation('cases');
  const long = isLongNote(body);
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="cs-note">
      <p className={long && !expanded ? 'cs-note-text cs-note-clamp' : 'cs-note-text'}>{body}</p>
      {long ? (
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={expanded}
          onPress={() => setExpanded(!expanded)}
        >
          {expanded ? t('timeline.showLess') : t('timeline.showAll')}
        </Button>
      ) : null}
    </div>
  );
}
