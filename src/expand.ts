import ICAL from 'ical.js';
import { UpdateFieldsError, wrapped } from './errors';
import { frameOf, parseDateValue } from './typedValue';
import type { Anchor } from './typedValue';
import { dayOf, expandWalls, jcalOf, propertyStamps, SeriesUnverifiable, wallIn, WORK_BUDGET } from './series';
import type { RecurrenceBudget, Stamp } from './series';
import { seriesMaster } from './updateFields';
import type { CalendarObjectInput, ComponentType } from './types';
import { wallOf, zoneOf } from './zone';

/*
 * Bounded recurrence expansion for consumers.
 *
 * ical.js' RecurIterator.next() has no bound: a rule that matches rarely or
 * never (FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30) makes it test candidates without
 * end, and a dense rule from long ago (FREQ=SECONDLY;BYHOUR=9;BYMINUTE=0;
 * BYSECOND=0 since 1950) tests billions before reaching today. This expansion
 * charges every candidate ical.js tests to a budget — the same hook and the
 * same costs as updateFields' own series checks — and stops, failing closed,
 * when it runs out.
 */

export type { RecurrenceBudget } from './series';

/**
 * A budget for expandOccurrences, in work units (about a microsecond of
 * ical.js work each; the default is what one updateFields series check may
 * spend). Pass the same object to several calls to bound them together.
 */
export function createRecurrenceBudget(units: number = WORK_BUDGET): RecurrenceBudget {
  if (!Number.isFinite(units) || units < 0) {
    throw new UpdateFieldsError('INVALID_INPUT', `a recurrence budget is a non-negative number of units, not ${units}`,
      { remedy: 'fix-value' });
  }
  return { remaining: units };
}

/** One start or end of an occurrence */
export interface OccurrenceTime {
  /**
   * The value as written in the object's form: a date "2026-10-05", a UTC
   * date-time "2026-10-05T07:00:00Z", or a wall-clock time "2026-10-05T09:00:00"
   * (in `tzid`, or floating when there is none)
   */
  value: string;
  /** the TZID the wall-clock time is in, or null */
  tzid: string | null;
  /** the instant as ISO 8601 UTC, or null for a date or a floating time (no zone to place it) */
  instant: string | null;
}

export interface Occurrence {
  /** the occurrence's original start, as a RECURRENCE-ID names it */
  recurrenceId: OccurrenceTime;
  /** where it starts: the override's DTSTART for an overridden occurrence */
  start: OccurrenceTime;
  /** where it ends (DTEND, DUE, or DTSTART plus DURATION), or null when the component gives no end */
  end: OccurrenceTime | null;
  /** whether an override component (same UID, this RECURRENCE-ID) replaces it */
  overridden: boolean;
}

export interface ExpansionResult {
  /** the occurrences found, by original start */
  occurrences: Occurrence[];
  /** whether every occurrence in the range is in the list */
  complete: boolean;
  /**
   * Why the list stops early: "budget" — the budget ran out (with several
   * RRULEs an earlier occurrence of a later rule may be missing too); "limit"
   * — `limit` occurrences were found. Null when complete.
   */
  stoppedBy: 'budget' | 'limit' | null;
}

export interface ExpandOptions {
  /** the work budget to spend (see createRecurrenceBudget); shared across calls if the same object is passed */
  budget: RecurrenceBudget;
  /** the end of the range, exclusive: occurrences whose original start lies at or after this are not returned */
  until: Date | string;
  /** occurrences whose original start lies before this are skipped (default: all from DTSTART) */
  from?: Date | string;
  /** at most this many occurrences (default 1000) */
  limit?: number;
  /** the component type, as for updateFields */
  type?: ComponentType;
}

/** A range bound as a wall clock of the series' frame */
function boundIn(master: ICAL.Component, frame: Anchor, bound: Date | string, label: string): number {
  let utc: number | null = null;
  let wall: number;
  if (bound instanceof Date) {
    if (Number.isNaN(bound.getTime())) {
      throw new UpdateFieldsError('INVALID_VALUE', `${label} is an invalid Date`, { remedy: 'fix-value' });
    }
    utc = Math.floor(bound.getTime() / 1000);
    wall = utc;
  } else {
    let value;
    try {
      value = parseDateValue(bound);
    } catch (error) {
      throw wrapped(error, `${label}: ${(error as Error).message}`);
    }
    const [y, mo, d, h, mi, s] = value.jcal.match(/\d+/g)!.map(Number);
    wall = wallOf(y, mo, d, h ?? 0, mi ?? 0, s ?? 0);
    utc = value.kind === 'utc' ? wall : null;
  }
  // An instant is placed on the series' wall clock; a wall-clock time or date
  // is taken as one, as is an instant against a floating or all-day series
  if (utc !== null && frame.form === 'tzid') {
    const zone = zoneOf(master, frame.tzid);
    if (!zone) {
      throw new UpdateFieldsError('UNKNOWN_TZID', `the series' zone "${frame.tzid}" has no VTIMEZONE in the object ` +
        'and is no IANA time zone', { remedy: 'rewrite-object' });
    }
    return zone.fromUtc(utc);
  }
  return wall;
}

/** An occurrence time from a wall clock in a form (a date, UTC, floating, or a TZID) */
function timeIn(master: ICAL.Component, wall: number, kind: Stamp['kind'], tzid: string | null): OccurrenceTime {
  const value = jcalOf(wall, kind === 'tzid' ? 'floating' : kind);
  let instant: number | null = null;
  if (kind === 'utc') {
    instant = wall;
  } else if (kind === 'tzid' && tzid) {
    instant = zoneOf(master, tzid)?.toUtc(wall) ?? null;
  }
  return { value, tzid: kind === 'tzid' ? tzid : null, instant: instant === null ? null : new Date(instant * 1000).toISOString() };
}

const frameKind = (frame: Anchor): Stamp['kind'] => frame.form;
const frameTzid = (frame: Anchor) => frame.form === 'tzid' ? frame.tzid : null;

/** The first value of a date or date-time property as a time of its own form */
function ownTime(master: ICAL.Component, property: ICAL.Property): OccurrenceTime {
  const [stamp] = propertyStamps(property);
  return timeIn(master, stamp.wall, stamp.kind, stamp.tzid ?? null);
}

/** Where an occurrence of the master ends: DTEND or DUE moved with it on the wall clock, or DTSTART plus DURATION */
function endOf(master: ICAL.Component, frame: Anchor, startWall: number): OccurrenceTime | null {
  const dtstart = master.getFirstProperty('dtstart')!;
  const [start] = propertyStamps(dtstart);
  for (const name of ['dtend', 'due']) {
    const property = master.getFirstProperty(name);
    if (property) {
      const [end] = propertyStamps(property);
      // the end keeps its distance from the start on the series' wall clock,
      // and its own form
      const length = wallIn(master, end, frame) - start.wall;
      const wall = startWall + length;
      if (end.kind === 'tzid' && frame.form === 'tzid' && end.tzid !== frame.tzid) {
        const instant = zoneOf(master, frame.tzid)!.toUtc(wall);
        const own = zoneOf(master, end.tzid!);
        return own ? timeIn(master, own.fromUtc(instant), 'tzid', end.tzid!) : null;
      }
      return timeIn(master, wall, frameKind(frame), frameTzid(frame));
    }
  }
  const length = durationOf(master);
  return length === null ? null : timeIn(master, startWall + length, frameKind(frame), frameTzid(frame));
}

/**
 * A component's DURATION as seconds to add on the wall clock, or null. Days
 * and weeks are nominal, whole days on the wall clock (RFC 5545 3.3.6); the
 * time part is added there too, which differs from elapsed time only across a
 * DST change within the duration.
 */
function durationOf(component: ICAL.Component): number | null {
  const duration = component.getFirstPropertyValue('duration') as ICAL.Duration | null;
  if (!duration || typeof duration.toSeconds !== 'function') {
    return null;
  }
  const days = (duration.weeks ?? 0) * 7 + (duration.days ?? 0);
  const seconds = (duration.hours ?? 0) * 3600 + (duration.minutes ?? 0) * 60 + (duration.seconds ?? 0);
  return (duration.isNegative ? -1 : 1) * (days * 86400 + seconds);
}

/**
 * Where an overridden occurrence ends. An override is a whole component (RFC
 * 5545 3.8.4.4): its own DTEND or DUE, else its own DURATION from its own
 * start, else the master's length (DTEND - DTSTART on the series' wall clock,
 * or its DURATION) from its own start, in the form of that start.
 */
function overrideEnd(master: ICAL.Component, frame: Anchor, override: ICAL.Component, start: Stamp): OccurrenceTime | null {
  const own = override.getFirstProperty('dtend') ?? override.getFirstProperty('due');
  if (own) {
    return ownTime(master, own);
  }
  let length = durationOf(override);
  if (length === null) {
    const dtstart = master.getFirstProperty('dtstart')!;
    const end = master.getFirstProperty('dtend') ?? master.getFirstProperty('due');
    length = end
      ? wallIn(master, propertyStamps(end)[0], frame) - propertyStamps(dtstart)[0].wall
      : durationOf(master);
  }
  return length === null ? null : timeIn(master, start.wall + length, start.kind, start.tzid ?? null);
}

/**
 * The occurrences of a recurring event, todo or journal in a range, bounded
 * by a work budget: DTSTART, RRULE and RDATE, without EXDATEs, with overrides
 * (same UID, RECURRENCE-ID) applied. Occurrences are selected by their
 * original start; an override moved into the range from outside it is not
 * found. Times are read with the object's VTIMEZONEs (IANA data as fallback),
 * on the series' wall clock, so a weekly 09:00 Berlin series stays at 09:00.
 *
 * Never loops: every candidate ical.js tests is charged to `budget`, and when
 * it runs out the result says so (complete false, stoppedBy "budget") — fail
 * closed: an incomplete list must not be taken for the whole series.
 *
 * @throws {UpdateFieldsError} for an object that does not parse or holds no
 *   such component (as updateFields), a range bound that does not parse, a
 *   zone that cannot be read, or a value or rule in the object that cannot be
 *   read; a plain Error for a failure of the library
 */
export function expandOccurrences(calendarObject: CalendarObjectInput | ICAL.Component, options: ExpandOptions): ExpansionResult {
  const { budget, until } = options ?? ({} as ExpandOptions);
  if (!budget || typeof budget.remaining !== 'number') {
    throw new UpdateFieldsError('INVALID_INPUT', 'expandOccurrences needs options.budget (see createRecurrenceBudget)',
      { remedy: 'fix-value' });
  }
  const limit = options.limit ?? 1000;
  if (!Number.isInteger(limit) || limit < 0) {
    throw new UpdateFieldsError('INVALID_INPUT', `options.limit must be a non-negative integer, not ${limit}`,
      { remedy: 'fix-value' });
  }
  let root: ICAL.Component;
  if (calendarObject && typeof (calendarObject as ICAL.Component).toJSON === 'function' &&
      typeof (calendarObject as ICAL.Component).getAllSubcomponents === 'function') {
    root = new ICAL.Component((calendarObject as ICAL.Component).toJSON());
  } else {
    const text = typeof calendarObject === 'string' ? calendarObject : (calendarObject as { data?: unknown })?.data;
    if (typeof text !== 'string') {
      throw new UpdateFieldsError('INVALID_INPUT', 'expandOccurrences takes iCalendar text, an object with "data", ' +
        'or an ICAL.Component', { remedy: 'fix-value' });
    }
    try {
      root = new ICAL.Component(ICAL.parse(text));
    } catch (error) {
      throw new UpdateFieldsError('INVALID_ICALENDAR', `Failed to parse iCal data: ${(error as Error).message}`,
        { remedy: 'rewrite-object', cause: error });
    }
  }
  const master = root.name === 'vcalendar' ? seriesMaster(root, options.type) : root;
  const frame = frameOf(master);
  if (!frame) {
    return { occurrences: [], complete: true, stoppedBy: null };
  }
  const norm = (wall: number) => frame.form === 'date' ? dayOf(wall) : wall;
  const end = boundIn(master, frame, until, 'until');
  const start = options.from === undefined ? -Infinity : boundIn(master, frame, options.from, 'from');

  let found: { walls: Set<number>; complete: boolean };
  let excluded: Set<number>;
  const overrides = new Map<number, ICAL.Component>();
  try {
    found = expandWalls(master, end - 1, budget);
    excluded = new Set(master.getAllProperties('exdate').filter((p) => p.type !== 'period')
      .flatMap((p) => propertyStamps(p).map((stamp) => norm(wallIn(master, stamp, frame)))));
    const uid = master.getFirstPropertyValue('uid');
    for (const c of root.name === 'vcalendar' ? root.getAllSubcomponents(master.name) : []) {
      const rid = c.getFirstProperty('recurrence-id');
      if (c !== master && rid && c.getFirstPropertyValue('uid') === uid) {
        overrides.set(norm(wallIn(master, propertyStamps(rid)[0], frame)), c);
      }
    }
  } catch (error) {
    if (error instanceof SeriesUnverifiable) {
      throw error.source instanceof UpdateFieldsError ? error.source
        : wrapped(error.source ?? error, `the series cannot be expanded: ${error.message}`);
    }
    throw error;
  }

  const occurrences: Occurrence[] = [];
  let limited = false;
  for (const wall of [...found.walls].sort((a, b) => a - b)) {
    if (wall < norm(start) || excluded.has(wall)) {
      continue;
    }
    if (occurrences.length === limit) {
      limited = true;
      break;
    }
    const override = overrides.get(wall);
    const recurrenceId = timeIn(master, wall, frameKind(frame), frameTzid(frame));
    if (override) {
      const own = override.getFirstProperty('dtstart');
      const start: Stamp = own ? propertyStamps(own)[0]
        : { wall, kind: frameKind(frame), ...(frame.form === 'tzid' ? { tzid: frame.tzid } : {}) };
      occurrences.push({ recurrenceId, start: own ? ownTime(master, own) : recurrenceId,
        end: overrideEnd(master, frame, override, start), overridden: true });
    } else {
      occurrences.push({ recurrenceId, start: recurrenceId, end: endOf(master, frame, wall), overridden: false });
    }
  }
  const complete = found.complete && !limited;
  return { occurrences, complete, stoppedBy: complete ? null : !found.complete ? 'budget' : 'limit' };
}
