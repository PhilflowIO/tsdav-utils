import ICAL from 'ical.js';
import { frameOf, isRecurProperty, pad, timezoneOf, utcMillis } from './typedValue';
import type { Anchor } from './typedValue';

/*
 * A series moves as a whole.
 *
 * Overrides (RECURRENCE-ID, RFC 5545 3.8.4.4) and exclusions (EXDATE, 3.8.5.1)
 * name an occurrence of the master by its original start, and RRULE's UNTIL
 * (3.3.10) and RDATE are instants of the same schedule. When the master's
 * DTSTART moves and they stay where they are, an override stops matching (its
 * instance silently reverts to the master's data), an EXDATE stops excluding,
 * and an UNTIL can cut the last occurrence. So a DTSTART write carries them
 * along by the same move, as Thunderbird does on the same edit
 * (CalRecurrenceInfo.onStartDateChange). The overrides' own DTSTART/DTEND are
 * instance data the caller set and stay as they are.
 *
 * A changed RRULE or RDATE has no such move; whatever no longer names an
 * occurrence is refused instead of being orphaned.
 */

const DAY = 86400;

/**
 * One date or date-time value: its wall clock as seconds of a naive (zoneless)
 * calendar, and where that wall clock lives.
 */
interface Stamp {
  wall: number;
  kind: 'date' | 'utc' | 'floating' | 'tzid';
  tzid?: string;
}

const JCAL = /^(\d{4,})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(Z)?)?$/i;

function stampOf(jcal: string, tzid?: unknown): Stamp {
  const m = JCAL.exec(jcal);
  if (!m) {
    throw new Error(`"${jcal}" is not a date or date-time`);
  }
  const [y, mo, d, h, mi, s] = [1, 2, 3, 4, 5, 6].map((i) => Number(m[i] ?? 0));
  const wall = utcMillis(y, mo, d, h, mi, s) / 1000;
  if (m[4] === undefined) {
    return { wall, kind: 'date' };
  }
  if (m[7]) {
    return { wall, kind: 'utc' };
  }
  return typeof tzid === 'string' && tzid ? { wall, kind: 'tzid', tzid } : { wall, kind: 'floating' };
}

/** The values of a property as jCal strings (PERIOD values are arrays) */
const valuesOf = (property: ICAL.Property): unknown[] => (property.toJSON() as unknown[]).slice(3);

function fields(wall: number) {
  const t = new Date(wall * 1000);
  return {
    year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate(),
    hour: t.getUTCHours(), minute: t.getUTCMinutes(), second: t.getUTCSeconds(),
  };
}

const dayOf = (wall: number) => Math.floor(wall / DAY) * DAY;

/** A wall clock as jCal in a frame's form: a date, UTC with "Z", or zoneless */
function jcalOf(wall: number, frame: Anchor): string {
  const f = fields(wall);
  const date = `${pad(f.year, 4)}-${pad(f.month)}-${pad(f.day)}`;
  if (frame.form === 'date') {
    return date;
  }
  return `${date}T${pad(f.hour)}:${pad(f.minute)}:${pad(f.second)}${frame.form === 'utc' ? 'Z' : ''}`;
}

/** Convert a wall clock between zones (null = UTC) with the document's VTIMEZONEs */
function convert(component: ICAL.Component, wall: number, from: string | null, to: string | null): number {
  const zone = (tzid: string | null) => {
    if (tzid === null) {
      return ICAL.Timezone.utcTimezone;
    }
    const tz = timezoneOf(component, tzid);
    if (!tz) {
      throw new Error(`the zone "${tzid}" has no VTIMEZONE in the document to convert it with`);
    }
    return tz;
  };
  const t = ICAL.Time.fromData(fields(wall), zone(from)).convertToZone(zone(to));
  return utcMillis(t.year, t.month, t.day, t.hour, t.minute, t.second) / 1000;
}

/**
 * A value's wall clock in a series' frame: as it is when it already lives
 * there (or has no zone), converted when it is in UTC or another zone. Against
 * an all-day series a timed value keeps its own wall clock, whose date counts.
 */
function wallIn(component: ICAL.Component, stamp: Stamp, frame: Anchor): number {
  if (stamp.kind === 'date' || stamp.kind === 'floating' || frame.form === 'date') {
    return stamp.wall;
  }
  if (frame.form === 'floating') {
    if (stamp.kind === 'utc') {
      throw new Error('it is in UTC, and a floating series has no zone to read it in');
    }
    return stamp.wall;
  }
  const own = stamp.kind === 'utc' ? null : stamp.tzid!;
  const target = frame.form === 'utc' ? null : frame.tzid;
  return own === target ? stamp.wall : convert(component, stamp.wall, own, target);
}

/** The DTSTART of a series before and after a write, each in its own frame */
interface Move {
  component: ICAL.Component;
  from: Anchor;
  fromWall: number;
  to: Anchor;
  toWall: number;
}

/**
 * Where a value lands when the series moves: the same distance from the new
 * DTSTART as it had from the old one, measured on the series' wall clock (so
 * a weekly 09:00 Berlin series moved to 10:00 keeps its weeks across a DST
 * change). Across an all-day/timed switch the distance is counted in days: a
 * value keeps its day, and a timed one takes the new DTSTART's time of day.
 */
function moved(stamp: Stamp, move: Move): number {
  const wall = wallIn(move.component, stamp, move.from);
  if (move.from.form === 'date' || move.to.form === 'date' || stamp.kind === 'date') {
    const days = (dayOf(wall) - dayOf(move.fromWall)) / DAY;
    return (move.to.form === 'date' ? dayOf(move.toWall) : move.toWall) + days * DAY;
  }
  return move.toWall + (wall - move.fromWall);
}

/** Rewrite a RECURRENCE-ID, EXDATE or RDATE property's values in a frame's form */
function writeInstants(property: ICAL.Property, walls: number[], frame: Anchor) {
  if (frame.form === 'tzid') {
    property.setParameter('tzid', frame.tzid);
  } else {
    property.removeParameter('tzid');
  }
  property.resetType(frame.form === 'date' ? 'date' : 'date-time');
  const values = walls.map((wall) => jcalOf(wall, frame));
  if (property.name === 'recurrence-id') {
    property.setValue(values[0]);
  } else {
    property.setValues(values);
  }
}

function moveInstants(property: ICAL.Property, move: Move) {
  if (property.type === 'period') {
    throw new Error('it holds periods, which updateFields does not move');
  }
  const tzid = property.getParameter('tzid');
  const walls = valuesOf(property).map((v) => moved(stampOf(String(v), tzid), move));
  writeInstants(property, walls, move.to);
}

/**
 * Move a rule's UNTIL. UNTIL is a date next to an all-day DTSTART, local time
 * next to a floating one and UTC otherwise (RFC 5545 3.3.10), so a wall clock
 * in a TZID is converted to UTC with the document's VTIMEZONE.
 */
function moveUntil(property: ICAL.Property, move: Move) {
  const recur = property.getFirstValue() as ICAL.Recur;
  const wall = moved(stampOf(recur.until!.toString()), move);
  if (move.to.form === 'date') {
    recur.until = ICAL.Time.fromDateString(jcalOf(wall, move.to));
  } else if (move.to.form === 'tzid') {
    recur.until = ICAL.Time.fromDateTimeString(
      jcalOf(convert(move.component, wall, move.to.tzid, null), { form: 'utc' }));
  } else {
    recur.until = ICAL.Time.fromDateTimeString(jcalOf(wall, move.to));
  }
  property.setValue(recur);
}

/** The DTSTART of a series as frame and wall clock, or null without one */
function startOf(master: ICAL.Component): { frame: Anchor; wall: number; text: string } | null {
  const frame = frameOf(master);
  const dtstart = master.getFirstProperty('dtstart');
  if (!frame || !dtstart) {
    return null;
  }
  return { frame, wall: stampOf(String(valuesOf(dtstart)[0])).wall, text: dtstart.toICALString() };
}

/** Iterations per rule before an occurrence check gives up and says "cannot tell" */
const EXPANSION_LIMIT = 100000;

/**
 * Which of the given values name an occurrence of the series as it stands —
 * DTSTART, an instance of an RRULE, or an RDATE; EXDATE does not count, an
 * override of an excluded instance still names it. undefined where it cannot
 * be told (a zone without VTIMEZONE, a rule too dense to expand that far).
 * Rules are expanded on the series' wall clock, with UNTIL read on it too.
 */
function occurrences(master: ICAL.Component, stamps: Stamp[]): (boolean | undefined)[] {
  const start = startOf(master);
  if (!start) {
    return stamps.map(() => undefined);
  }
  const { frame } = start;
  const day = frame.form === 'date';
  const timeOf = (wall: number) => day
    ? ICAL.Time.fromDateString(jcalOf(wall, frame))
    : ICAL.Time.fromDateTimeString(jcalOf(wall, { form: 'floating' }));
  const wallOf = (t: ICAL.Time) => utcMillis(t.year, t.month, t.day, t.hour, t.minute, t.second) / 1000;
  const norm = (wall: number) => day ? dayOf(wall) : wall;

  const targets = stamps.map((stamp) => {
    try {
      return norm(wallIn(master, stamp, frame));
    } catch {
      return undefined;
    }
  });
  const result: (boolean | undefined)[] = targets.map((t) => t === undefined ? undefined : t === norm(start.wall));

  const known = (wall: number) => targets.forEach((t, i) => {
    if (t === wall) {
      result[i] = true;
    }
  });
  try {
    for (const rdate of master.getAllProperties('rdate')) {
      const tzid = rdate.getParameter('tzid');
      for (const value of valuesOf(rdate)) {
        const first = Array.isArray(value) ? value[0] : value;
        known(norm(wallIn(master, stampOf(String(first), tzid), frame)));
      }
    }
  } catch {
    return result.map((r) => r || undefined);
  }

  const latest = Math.max(...targets.filter((t): t is number => t !== undefined));
  for (const property of master.getAllProperties('rrule')) {
    const recur = (property.getFirstValue() as ICAL.Recur).clone();
    try {
      if (recur.until) {
        recur.until = timeOf(norm(wallIn(master, stampOf(recur.until.toString()), frame)));
      }
    } catch {
      return result.map((r) => r || undefined);
    }
    const iterator = recur.iterator(timeOf(start.wall));
    let reached = false;
    for (let i = 0; i < EXPANSION_LIMIT; i++) {
      const next = iterator.next();
      if (!next) {
        reached = true;
        break;
      }
      const wall = norm(wallOf(next));
      known(wall);
      if (wall >= latest) {
        reached = true;
        break;
      }
    }
    if (!reached) {
      return result.map((r) => r || undefined);
    }
  }
  return result;
}

/** An override or exclusion that has to keep naming an occurrence */
interface Reference {
  property: ICAL.Property;
  index: number;
  /** as it was before the write, for the error */
  label: string;
}

const icalForm = (jcal: string) => jcal.replace(/[-:]/g, '');

function referenceStamp(ref: Reference): Stamp {
  return stampOf(String(valuesOf(ref.property)[ref.index]), ref.property.getParameter('tzid'));
}

function checkable(refs: Reference[], master: ICAL.Component): (boolean | undefined)[] {
  const stamps: (Stamp | undefined)[] = refs.map((ref) => {
    try {
      return referenceStamp(ref);
    } catch {
      return undefined;
    }
  });
  const present = stamps.filter((s): s is Stamp => s !== undefined);
  const found = present.length ? occurrences(master, present) : [];
  let k = 0;
  return stamps.map((s) => s === undefined ? undefined : found[k++]);
}

/** Properties that decide which occurrences a series has */
const SHAPING = ['dtstart', 'rrule', 'rdate'];

/**
 * Start a series-level write on a master: reject what would corrupt the
 * series, and capture what has to follow it. Call before the fields are
 * written, and finish() after.
 *
 * @param calendar - the VCALENDAR
 * @param master - the component updateFields writes (see seriesMaster)
 * @param written - the lower-case property names the call writes
 */
export function beginSeriesEdit(calendar: ICAL.Component, master: ICAL.Component, written: Set<string>) {
  if (written.has('recurrence-id') && !master.hasProperty('recurrence-id')) {
    throw new Error('RECURRENCE-ID cannot be written on the series master: it would turn the master into an ' +
      'override of a single instance (RFC 5545 3.8.4.4). updateFields edits the series; to change one ' +
      'instance, add or edit an override component (same UID, with RECURRENCE-ID) by rewriting the whole ' +
      'iCalendar object');
  }

  // A property the call writes itself is the caller's, for the new series: the
  // first line of its name is the one replaced (see setDateValue/setRecurValue)
  const replaced = new Set([...written].map((name) => master.getFirstProperty(name)).filter(Boolean));
  const own = (name: string) => master.getAllProperties(name).filter((p) => !replaced.has(p));

  const uid = master.getFirstPropertyValue('uid');
  const overrides = master.hasProperty('recurrence-id') ? [] : calendar.getAllSubcomponents(master.name)
    .filter((c) => c !== master && c.hasProperty('recurrence-id') && c.getFirstPropertyValue('uid') === uid);
  const rids = overrides.map((c) => c.getFirstProperty('recurrence-id')!);
  const exdates = own('exdate');
  const rdates = own('rdate');
  const rules = master.getAllProperties()
    .filter((p) => isRecurProperty(master, p.name) && !replaced.has(p) && (p.getFirstValue() as ICAL.Recur)?.until);

  const references: Reference[] = [
    ...rids.map((property) => ({ property, index: 0, label: `the override for ${property.toICALString()}` })),
    ...exdates.flatMap((property) => valuesOf(property).map((_, index) => ({
      property, index,
      label: `EXDATE ${icalForm(String(valuesOf(property)[index]))}`,
    }))),
  ];
  const shaping = SHAPING.filter((name) => written.has(name));
  // Only what names an occurrence now has to keep naming one; an override that
  // was already stale is not this call's doing
  const before = shaping.length && references.length ? checkable(references, master) : [];
  const watched = references.filter((_, i) => before[i] === true);
  const start = written.has('dtstart') ? startOf(master) : null;

  return {
    finish() {
      const now = start && startOf(master);
      if (start && now && (start.text !== now.text)) {
        const move: Move = { component: master, from: start.frame, fromWall: start.wall, to: now.frame, toWall: now.wall };
        for (const property of rules) {
          const upper = property.name.toUpperCase();
          const until = (property.getFirstValue() as ICAL.Recur).until!.toICALString();
          try {
            moveUntil(property, move);
          } catch (error) {
            throw new Error(`DTSTART changed, and the existing ${upper} UNTIL=${until} ` +
              `cannot follow it (${(error as Error).message}): give ${upper}, with UNTIL, in the same call`);
          }
        }
        for (const property of [...exdates, ...rdates]) {
          const line = property.toICALString();
          try {
            moveInstants(property, move);
          } catch (error) {
            throw new Error(`DTSTART changed, and the existing ${line} cannot follow it ` +
              `(${(error as Error).message}): give ${property.name.toUpperCase()} in the same call`);
          }
        }
        for (const property of rids) {
          const line = property.toICALString();
          try {
            moveInstants(property, move);
          } catch (error) {
            throw new Error(`DTSTART changed, and the override for ${line} cannot follow it ` +
              `(${(error as Error).message}): move the override by rewriting the whole iCalendar ` +
              'object, since updateFields edits only the master');
          }
        }
      }

      if (!watched.length) {
        return;
      }
      const after = checkable(watched, master);
      const lost = watched.filter((_, i) => after[i] === false);
      if (lost.length) {
        const what = shaping.map((n) => n.toUpperCase()).join(' and ');
        throw new Error(`The new ${what} leaves ${lost.map((ref) => ref.label).join(', ')} naming no ` +
          `occurrence of the series, so ${lost.length > 1 ? 'they' : 'it'} would silently stop applying ` +
          '(RFC 5545 3.8.4.4, 3.8.5.1). ' +
          'Keep a series these instances belong to, give EXDATE in the same call with the exclusions the ' +
          'new series should have, or move or remove an override by rewriting the whole iCalendar object ' +
          '(updateFields edits only the master)');
      }
    },
  };
}
