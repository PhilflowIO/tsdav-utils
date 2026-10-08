import ICAL from 'ical.js';
import { frameOf, isRecurProperty, pad } from './typedValue';
import type { Anchor } from './typedValue';
import { fieldsOf, unknownZone, wallOf, zoneOf } from './zone';

/*
 * A DTSTART write on a series master moves the whole series.
 *
 * Overrides (RECURRENCE-ID, RFC 5545 3.8.4.4) and exclusions (EXDATE, 3.8.5.1)
 * name an occurrence of the master by its original start; RDATE and RRULE's
 * UNTIL (3.3.10) are instants of the same schedule. Left where they are when
 * DTSTART moves, an override stops matching (its instance silently reverts to
 * the master's data, or shows twice), an EXDATE stops excluding, and an UNTIL
 * cuts or adds occurrences.
 *
 * So the series moves by the distance DTSTART moved, measured on the series'
 * wall clock: every RECURRENCE-ID, EXDATE, RDATE and UNTIL the call does not
 * write itself, and each override's own DTSTART/DTEND/DUE, so an override
 * sits on its moved occurrence at its own time moved by the same distance.
 * This is the whole-item move Thunderbird makes (calItemUtils shiftOffset on
 * the master and its exceptions, CalRecurrenceInfo.onStartDateChange).
 *
 * The invariant: the occurrences after are the occurrences before, each moved
 * by that distance. A rule part that pins days (BYDAY=MO, BYMONTHDAY=5) does
 * not move with DTSTART, so when the caller gives no new RRULE the expansion
 * is compared before and after, and a difference throws. When the caller does
 * give RRULE or RDATE, the occurrences are theirs to choose, but an override or
 * EXDATE that named an occurrence before must still name one.
 */

const DAY = 86400;

/**
 * One date or date-time value: its wall clock as naive seconds (see zone.ts),
 * and where that wall clock lives.
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
  const wall = wallOf(y, mo, d, h, mi, s);
  if (m[4] === undefined) {
    return { wall, kind: 'date' };
  }
  if (m[7]) {
    return { wall, kind: 'utc' };
  }
  return typeof tzid === 'string' && tzid ? { wall, kind: 'tzid', tzid } : { wall, kind: 'floating' };
}

/** A wall clock in a frame, as the stamp of a value written there */
const inFrame = (wall: number, frame: Anchor): Stamp => frame.form === 'tzid'
  ? { wall, kind: 'tzid', tzid: frame.tzid }
  : { wall, kind: frame.form };

/** The values of a property as jCal strings (PERIOD values are arrays) */
const valuesOf = (property: ICAL.Property): unknown[] => (property.toJSON() as unknown[]).slice(3);

const propertyStamps = (property: ICAL.Property) => {
  const tzid = property.getParameter('tzid');
  return valuesOf(property).map((v) => stampOf(String(Array.isArray(v) ? v[0] : v), tzid));
};

const dayOf = (wall: number) => Math.floor(wall / DAY) * DAY;

/** A wall clock as jCal in a frame's form: a date, UTC with "Z", or zoneless */
function jcalOf(wall: number, frame: Anchor | Stamp['kind']): string {
  const form = typeof frame === 'string' ? frame : frame.form;
  const f = fieldsOf(wall);
  const date = `${pad(f.year, 4)}-${pad(f.month)}-${pad(f.day)}`;
  if (form === 'date') {
    return date;
  }
  return `${date}T${pad(f.hour)}:${pad(f.minute)}:${pad(f.second)}${form === 'utc' ? 'Z' : ''}`;
}

const icalForm = (jcal: string) => jcal.replace(/[-:]/g, '');

function zone(component: ICAL.Component, tzid: string) {
  const resolved = zoneOf(component, tzid);
  if (!resolved) {
    throw new Error(unknownZone(tzid));
  }
  return resolved;
}

/** Convert a wall clock between zones (null = UTC) */
function convert(component: ICAL.Component, wall: number, from: string | null, to: string | null): number {
  const utc = from === null ? wall : zone(component, from).toUtc(wall);
  return to === null ? utc : zone(component, to).fromUtc(utc);
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

/** Whether a move switches between all-day and timed, so distances count in days */
const byDays = (move: Move) => move.from.form === 'date' || move.to.form === 'date';

/**
 * Where a value of the series lands: the same distance from the new DTSTART as
 * it had from the old one, measured on the series' wall clock (so a weekly
 * 09:00 Berlin series moved to 10:00 keeps 10:00 across a DST change). Across
 * an all-day/timed switch the distance is counted in days: a value keeps its
 * day, and a timed one takes the new DTSTART's time of day.
 */
function moved(stamp: Stamp, move: Move): number {
  const wall = wallIn(move.component, stamp, move.from);
  if (byDays(move) || stamp.kind === 'date') {
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
  writeInstants(property, propertyStamps(property).map((stamp) => moved(stamp, move)), move.to);
}

/**
 * A wall clock of a series' frame as a value in another value's own form:
 * converted into its zone, or to UTC.
 */
function wallOut(component: ICAL.Component, wall: number, frame: Anchor, own: Stamp): number {
  if (own.kind === 'floating' || own.kind === 'date' || frame.form === 'floating' || frame.form === 'date') {
    return wall;
  }
  const from = frame.form === 'utc' ? null : frame.tzid;
  const to = own.kind === 'utc' ? null : own.tzid!;
  return from === to ? wall : convert(component, wall, from, to);
}

/**
 * Move an override's own DTSTART, DTEND and DUE with the series, keeping each
 * one's own form. A timed value moves like every value of the series: read on
 * the series' wall clock, moved by the distance DTSTART moved, and written back
 * in its own zone (a UTC value too, so an instance rescheduled across a DST
 * change keeps its wall-clock time in the series' zone). A date, or any value
 * across an all-day/timed switch, moves by the days its RECURRENCE-ID moved.
 * In a floating series, whose wall clock has no zone to read a zoned value
 * in, a value moves by its RECURRENCE-ID's wall-clock distance.
 */
function moveOverrideTimes(override: ICAL.Component, before: Stamp, after: Stamp, move: Move) {
  const component = move.component;
  const days = (dayOf(after.wall) - dayOf(before.wall)) / DAY;
  const floating = move.from.form === 'floating' || move.to.form === 'floating';
  for (const name of ['dtstart', 'dtend', 'due']) {
    for (const property of override.getAllProperties(name)) {
      const [stamp] = propertyStamps(property);
      let wall: number;
      if (stamp.kind === 'date' || byDays(move)) {
        wall = stamp.wall + days * DAY;
      } else if (floating || stamp.kind === 'floating') {
        wall = stamp.wall + (after.wall - before.wall);
      } else {
        wall = wallOut(component, moved(stamp, move), move.to, stamp);
      }
      const type = property.type;
      property.resetType(type);
      property.setValue(jcalOf(wall, stamp.kind));
    }
  }
}

/**
 * Move a rule's UNTIL. UNTIL is a date next to an all-day DTSTART, local time
 * next to a floating one and UTC otherwise (RFC 5545 3.3.10), so a wall clock
 * in a TZID is converted to UTC with the zone's rules.
 */
function moveUntil(property: ICAL.Property, move: Move) {
  const recur = property.getFirstValue() as ICAL.Recur;
  const until = stampOf(recur.until!.toString());
  // Timed to all-day: the day of the last occurrence UNTIL lets through, which
  // is the day before UNTIL's when UNTIL falls earlier in the day than DTSTART
  const wall = move.from.form !== 'date' && move.to.form === 'date'
    ? dayOf(move.toWall) + Math.floor((wallIn(move.component, until, move.from) - move.fromWall) / DAY) * DAY
    : moved(until, move);
  if (move.to.form === 'date') {
    recur.until = ICAL.Time.fromDateString(jcalOf(wall, move.to));
  } else if (move.to.form === 'tzid') {
    recur.until = ICAL.Time.fromDateTimeString(
      jcalOf(convert(move.component, wall, move.to.tzid, null), 'utc'));
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

/** Occurrences expanded per rule before an expansion stops and is partial */
const EXPANSION_LIMIT = 1000;

/** The occurrences of a series on its wall clock, ascending; partial when a rule went on past the limit */
interface Expansion {
  frame: Anchor;
  walls: number[];
  /** the last wall clock the expansion vouches for: Infinity when it is complete */
  horizon: number;
}

/**
 * The occurrences of the series as it stands — DTSTART, the instances of each
 * RRULE and the RDATEs (EXDATE does not count: an override of an excluded
 * instance still names it), on the series' wall clock with UNTIL read on it
 * too. Each rule is expanded up to `until` (a wall clock), or EXPANSION_LIMIT
 * instances. Null where it cannot be told (a zone that cannot be resolved).
 */
function expand(master: ICAL.Component, until = Infinity): Expansion | null {
  const start = startOf(master);
  if (!start) {
    return null;
  }
  const { frame } = start;
  const day = frame.form === 'date';
  const norm = (wall: number) => day ? dayOf(wall) : wall;
  const timeOf = (wall: number) => day
    ? ICAL.Time.fromDateString(jcalOf(wall, frame))
    : ICAL.Time.fromDateTimeString(jcalOf(wall, 'floating'));
  const walls = new Set([norm(start.wall)]);
  let horizon = Infinity;
  try {
    for (const rdate of master.getAllProperties('rdate')) {
      for (const stamp of propertyStamps(rdate)) {
        walls.add(norm(wallIn(master, stamp, frame)));
      }
    }
    for (const property of master.getAllProperties('rrule')) {
      const recur = (property.getFirstValue() as ICAL.Recur).clone();
      if (recur.until) {
        recur.until = timeOf(norm(wallIn(master, stampOf(recur.until.toString()), frame)));
      }
      const iterator = recur.iterator(timeOf(start.wall));
      for (let i = 0; ; i++) {
        const next = iterator.next();
        if (!next) {
          break;
        }
        const wall = norm(wallOf(next.year, next.month, next.day, next.hour, next.minute, next.second));
        walls.add(wall);
        if (wall >= until) {
          break;
        }
        if (i >= EXPANSION_LIMIT) {
          horizon = Math.min(horizon, wall);
          break;
        }
      }
    }
  } catch {
    return null;
  }
  return { frame, walls: [...walls].sort((a, b) => a - b), horizon };
}

/** Which stamps name an occurrence of the series; undefined where it cannot be told */
function occurrences(master: ICAL.Component, stamps: (Stamp | undefined)[]): (boolean | undefined)[] {
  const frame = frameOf(master);
  if (!frame) {
    return stamps.map(() => undefined);
  }
  const targets = stamps.map((stamp) => {
    if (!stamp) {
      return undefined;
    }
    try {
      const wall = wallIn(master, stamp, frame);
      return frame.form === 'date' ? dayOf(wall) : wall;
    } catch {
      return undefined;
    }
  });
  const known = targets.filter((t): t is number => t !== undefined);
  const expansion = known.length ? expand(master, Math.max(...known)) : null;
  if (!expansion) {
    return stamps.map(() => undefined);
  }
  const walls = new Set(expansion.walls);
  return targets.map((t) => t === undefined ? undefined
    : walls.has(t) ? true
    : t > expansion.horizon ? undefined
    : false);
}

/** An override or exclusion that has to keep naming an occurrence */
interface Reference {
  property: ICAL.Property;
  index: number;
  /** as it was before the write, for the error */
  label: string;
}

function referenceStamps(refs: Reference[]): (Stamp | undefined)[] {
  return refs.map((ref) => {
    try {
      return propertyStamps(ref.property)[ref.index];
    } catch {
      return undefined;
    }
  });
}

/**
 * A suggested rule for a moved DTSTART: the rule with each single-valued part
 * that pins the old start (BYDAY, BYMONTHDAY, BYMONTH, BYHOUR, BYMINUTE) set
 * to the new start's, or null when there is none to set.
 */
function suggestedRule(rule: ICAL.Recur, start: number, timed: boolean): string | null {
  const f = fieldsOf(start);
  const weekday = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][new Date(start * 1000).getUTCDay()];
  const values: Record<string, string> = {
    BYDAY: weekday, BYMONTHDAY: String(f.day), BYMONTH: String(f.month),
    ...(timed ? { BYHOUR: String(f.hour), BYMINUTE: String(f.minute) } : {}),
  };
  let changed = false;
  const parts = rule.toString().split(';').map((part) => {
    const [name, value] = part.split('=');
    if (values[name] && /^[A-Z]{2}$|^\d+$/.test(value) && value !== values[name]) {
      changed = true;
      return `${name}=${values[name]}`;
    }
    return part;
  });
  return changed ? parts.join(';') : null;
}

/** Properties whose change decides which occurrences a series has */
const SHAPING = ['dtstart', 'rrule', 'rdate'];

const NO_SERIES = { finish() {} };

/**
 * Start a write on an event, todo or journal: reject what would corrupt the
 * series, and capture what has to follow it. Call before the fields are
 * written, and finish() after. Anything else (a vCard, a detached instance
 * that carries its own RECURRENCE-ID) is left to the plain write.
 *
 * @param calendar - the VCALENDAR, to find the overrides in; null for a bare
 *   component, which has none
 * @param master - the component updateFields writes (see seriesMaster)
 * @param written - the lower-case property names the call writes
 */
export function beginSeriesEdit(calendar: ICAL.Component | null, master: ICAL.Component, written: Set<string>) {
  if (!['vevent', 'vtodo', 'vjournal'].includes(master.name) || master.hasProperty('recurrence-id')) {
    return NO_SERIES;
  }
  if (written.has('recurrence-id')) {
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
  const overrides = (calendar?.getAllSubcomponents(master.name) ?? [])
    .filter((c) => c !== master && c.hasProperty('recurrence-id') && c.getFirstPropertyValue('uid') === uid);
  const exdates = own('exdate');
  const rdates = own('rdate');
  const rules = master.getAllProperties()
    .filter((p) => isRecurProperty(master, p.name) && !replaced.has(p) && (p.getFirstValue() as ICAL.Recur)?.until);

  const references: Reference[] = [
    ...overrides.map((c) => {
      const property = c.getFirstProperty('recurrence-id')!;
      return { property, index: 0, label: `the override for ${property.toICALString()}` };
    }),
    ...exdates.flatMap((property) => valuesOf(property).map((v, index) => ({
      property, index, label: `EXDATE ${icalForm(String(v))}`,
    }))),
  ];
  const shaping = SHAPING.filter((name) => written.has(name));
  // Only what names an occurrence now has to keep naming one; an override that
  // was already stale is not this call's doing
  const before = shaping.length && references.length ? occurrences(master, referenceStamps(references)) : [];
  const watched = references.filter((_, i) => before[i] === true);
  const start = written.has('dtstart') ? startOf(master) : null;
  // Without a new rule the series has to come out the same, moved
  const keepsRule = !['rrule', 'exrule', 'rdate'].some((name) => written.has(name));
  const expansion = start && keepsRule ? expand(master) : null;

  return {
    finish() {
      const now = start && startOf(master);
      if (start && now && start.text !== now.text) {
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
        for (const override of overrides) {
          const rid = override.getFirstProperty('recurrence-id')!;
          const line = rid.toICALString();
          try {
            const [old] = propertyStamps(rid);
            moveInstants(rid, move);
            moveOverrideTimes(override, old, propertyStamps(rid)[0], move);
          } catch (error) {
            throw new Error(`DTSTART changed, and the override for ${line} cannot follow it ` +
              `(${(error as Error).message}): rewrite the whole iCalendar object with the override moved`);
          }
        }
        if (expansion) {
          checkMovedSeries(master, expansion, move, start.text, now.text);
        }
      }

      if (!watched.length) {
        return;
      }
      const after = occurrences(master, referenceStamps(watched));
      const lost = watched.filter((_, i) => after[i] === false);
      if (lost.length) {
        const what = shaping.map((n) => n.toUpperCase()).join(' and ');
        throw new Error(`The new ${what} leaves ${lost.map((ref) => ref.label).join(', ')} naming no ` +
          `occurrence of the series, so ${lost.length > 1 ? 'they' : 'it'} would silently stop applying ` +
          '(RFC 5545 3.8.4.4, 3.8.5.1). Give RRULE (or RDATE) in the same call so the series still has ' +
          `${lost.length > 1 ? 'these occurrences' : 'this occurrence'}, and EXDATE in the same call with the ` +
          'exclusions the new series should have; or rewrite the whole iCalendar object to move or remove ' +
          'the override');
      }
    },
  };
}

/**
 * Throw when the series after a DTSTART move does not have the occurrences it
 * had before, each moved by the same distance — when the rule pins days or
 * times the move does not change (BYDAY=MO and a start moved to Tuesday).
 */
function checkMovedSeries(master: ICAL.Component, before: Expansion, move: Move, from: string, to: string) {
  const day = move.to.form === 'date';
  const expected = [...new Set(before.walls.map((wall) => {
    const w = moved(inFrame(wall, before.frame), move);
    return day ? dayOf(w) : w;
  }))].sort((a, b) => a - b);
  const expectedHorizon = before.horizon === Infinity ? Infinity
    : moved(inFrame(before.horizon, before.frame), move);
  const after = expand(master, expectedHorizon);
  if (!after) {
    return;
  }
  const horizon = Math.min(expectedHorizon, after.horizon);
  const want = expected.filter((w) => w <= horizon);
  const have = after.walls.filter((w) => w <= horizon);
  const i = want.findIndex((w, k) => w !== have[k]);
  const at = i >= 0 ? i : want.length < have.length ? want.length : -1;
  if (at < 0) {
    return;
  }
  const show = (wall: number) => icalForm(jcalOf(wall, move.to));
  const lost = want[at] !== undefined && (have[at] === undefined || want[at] < have[at]);
  const difference = lost ? `would lose the occurrence on ${show(want[at])}` : `would gain one on ${show(have[at])}`;
  const rule = master.getFirstProperty('rrule');
  const suggestion = rule
    ? suggestedRule(rule.getFirstValue() as ICAL.Recur, move.toWall, move.to.form !== 'date')
    : null;
  throw new Error(`Moving DTSTART (${from} to ${to}) does not move the whole series: ` +
    `${rule ? rule.toICALString() : 'its rule'} keeps it on its old days or times, so the series ${difference}. ` +
    `Give RRULE in the same call to fit the new start${suggestion ? ` (e.g. RRULE "${suggestion}")` : ''}; ` +
    'to start the series later without moving it, give RRULE, UNTIL and EXDATE explicitly, or rewrite the whole ' +
    'iCalendar object');
}
