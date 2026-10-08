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
 * by that distance. Whether a move keeps it is decided from the rule itself,
 * not by expanding it (see moveBreaksRule): a part that pins days or times
 * (BYDAY=MO, BYMONTHDAY=5, BYHOUR=9) does not move with DTSTART, so a move it
 * does not follow throws and suggests the rule to give. When the caller does
 * give RRULE or RDATE, the occurrences are theirs to choose, but an override or
 * EXDATE that named an occurrence before must still name one; that is checked
 * by expanding the series up to the furthest of them.
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
  if (own === target) {
    return stamp.wall;
  }
  const utc = own === null ? stamp.wall : zone(component, own).toUtc(stamp.wall);
  if (target === null) {
    return utc;
  }
  return zone(component, target).fromUtc(utc);
}

/**
 * Where a value shares its instant with another wall clock of the series: an
 * occurrence on a wall clock a DST change skips is read past the gap (RFC 5545
 * 3.3.5), at the same instant as the first wall clock after it, and clients
 * match RECURRENCE-ID, EXDATE and RDATE by instant. Returns the value's own
 * wall clock in the series' frame and the other one, or null when the instant
 * has no such twin. Whatever zone the value is written in.
 */
function gapTwin(component: ICAL.Component, stamp: Stamp, frame: Anchor): { wall: number; other: number } | null {
  if (frame.form !== 'tzid' || stamp.kind === 'date') {
    return null;
  }
  const series = zone(component, frame.tzid);
  const inSeries = stamp.kind === 'floating' || (stamp.kind === 'tzid' && stamp.tzid === frame.tzid);
  const utc = stamp.kind === 'utc' ? stamp.wall
    : inSeries ? series.toUtc(stamp.wall)
    : zone(component, stamp.tzid!).toUtc(stamp.wall);
  const skipped = series.gapAlias(utc);
  if (skipped === null) {
    return null;
  }
  const real = series.fromUtc(utc);
  const wall = inSeries ? stamp.wall : real;
  return { wall, other: wall === skipped ? real : skipped };
}

/**
 * Throw where a RECURRENCE-ID, EXDATE or RDATE shares its instant with an
 * occurrence on another wall clock of the series (gapTwin): it then names
 * that occurrence for a client, but another one on the wall clock this module
 * moves by, so which one it names cannot be told. Only where the series does
 * have an occurrence on the twin wall clock; checked before and after a move.
 */
function checkGapTwins(master: ICAL.Component, properties: ICAL.Property[], after: boolean) {
  const frame = frameOf(master);
  // a zone with no known rules (no VTIMEZONE, no IANA name) has no known gap;
  // a value that needs it converted is refused where it is moved
  if (!frame || frame.form !== 'tzid' || !zoneOf(master, frame.tzid)) {
    return;
  }
  const twins = properties.filter((property) => property.type !== 'period').flatMap((property) =>
    propertyStamps(property).flatMap((stamp) => {
      const twin = gapTwin(master, stamp, frame);
      return twin ? [{ property, twin }] : [];
    }));
  if (!twins.length) {
    return;
  }
  const walls = expand(master, Math.max(...twins.map(({ twin }) => twin.other)));
  const clash = twins.find(({ twin }) => walls.has(twin.other));
  if (clash) {
    const line = clash.property.toICALString();
    throw new Error(`DTSTART changed, and ${after ? 'moved, ' : ''}${line} ${after ? 'would name' : 'names'} the same ` +
      `instant as the occurrence at ${icalForm(jcalOf(clash.twin.other, 'floating'))} in "${frame.form === 'tzid' ? frame.tzid : ''}", ` +
      'a wall-clock time the DST change skips, so which occurrence it names cannot be told: rewrite the whole ' +
      'iCalendar object with the values it should have');
  }
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
  const stamps = propertyStamps(property);
  if (property.type === 'date' && move.from.form !== 'date' && move.to.form !== 'date') {
    // A date next to a timed series (an RDATE or EXDATE of a whole day) stays
    // a date, moved by the days the series moved; a whole day cannot move by
    // a time of day
    const shift = dayOf(move.toWall) - dayOf(move.fromWall);
    if (move.toWall - move.fromWall !== shift) {
      throw new Error('it is a date, a whole day, which cannot move by the time of day DTSTART moved');
    }
    writeInstants(property, stamps.map((stamp) => stamp.wall + shift), { form: 'date' });
    return;
  }
  writeInstants(property, stamps.map((stamp) => moved(stamp, move)), move.to);
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

/** The rule parts RFC 5545 3.3.10 defines, as ical.js keys them */
const RULE_KEYS = new Set(['freq', 'until', 'count', 'interval', 'wkst', 'bysecond', 'byminute', 'byhour',
  'byday', 'bymonthday', 'byyearday', 'byweekno', 'bymonth', 'bysetpos']);

/**
 * The parts of a RECUR property RFC 5545 3.3.10 does not define (X-names,
 * BYEASTER, RFC 7529 RSCALE and SKIP), read from the property as parsed:
 * ical.js keeps them there, but drops them once the rule is written again.
 */
function unknownRuleParts(property: ICAL.Property): string[] {
  const raw = (property.toJSON() as unknown[])[3];
  return raw && typeof raw === 'object'
    ? Object.keys(raw).filter((key) => !RULE_KEYS.has(key.toLowerCase())).map((key) => key.toUpperCase())
    : [];
}

/**
 * Replace parts of a RECUR property by rewriting only those tokens of the rule
 * as parsed, in place: the other parts keep their text and order, and the
 * property keeps its place among the component's properties.
 */
function rewriteRule(component: ICAL.Component, property: ICAL.Property, changes: Record<string, unknown>): ICAL.Property {
  const [name, params, type, value] = property.toJSON() as [string, object, string, Record<string, unknown>];
  const next = new ICAL.Property([name, params, type, { ...value, ...changes }], component);
  const all = [...component.getAllProperties()];
  component.removeAllProperties();
  for (const each of all) {
    component.addProperty(each === property ? next : each);
  }
  return next;
}

/**
 * Move a rule's UNTIL. UNTIL is a date next to an all-day DTSTART, local time
 * next to a floating one and UTC otherwise (RFC 5545 3.3.10), so a wall clock
 * in a TZID is converted to UTC with the zone's rules.
 */
function moveUntil(property: ICAL.Property, move: Move) {
  const unknown = unknownRuleParts(property);
  if (unknown.length) {
    // ical.js keeps them only as long as the rule is not written again
    throw new Error(`the rule has ${unknown.join(', ')}, which updateFields would lose rewriting it`);
  }
  const recur = property.getFirstValue() as ICAL.Recur;
  const until = stampOf(recur.until!.toString());
  if (move.from.form === 'tzid' && until.kind === 'utc') {
    // Near a DST change wall-clock order and the order of instants part: an
    // occurrence on a skipped wall clock (read past the gap) can lie after an
    // UNTIL that is later on the wall clock, and an UNTIL in the repeated hour
    // can lie after an occurrence later on the wall clock. Moved on the wall
    // clock, such an UNTIL would let one occurrence too many or too few through.
    const old = zone(move.component, move.from.tzid);
    if (old.gapAlias(until.wall) !== null || old.ambiguity(old.fromUtc(until.wall))) {
      throw new Error(`it lies at the DST change in "${move.from.tzid}", where the wall clock and the order of ` +
        'instants part, so moved on the wall clock it could let one occurrence too many or too few through');
    }
  }
  if ((until.kind === 'date') !== (move.from.form === 'date')) {
    // RFC 5545 3.3.10 ties UNTIL's type to DTSTART's; a date UNTIL next to a
    // timed DTSTART ends at a time of day each client reads differently
    throw new Error(`UNTIL is a ${until.kind === 'date' ? 'date' : 'date-time'} next to a ` +
      `${move.from.form === 'date' ? 'date' : 'date-time'} DTSTART, so where it ends the series is not defined`);
  }
  // Timed to all-day: the day of the last occurrence UNTIL lets through, which
  // is the day before UNTIL's when UNTIL falls earlier in the day than DTSTART
  const wall = move.from.form !== 'date' && move.to.form === 'date'
    ? dayOf(move.toWall) + Math.floor((wallIn(move.component, until, move.from) - move.fromWall) / DAY) * DAY
    : moved(until, move);
  let untilValue: string;
  if (move.to.form === 'date') {
    untilValue = jcalOf(wall, move.to);
  } else if (move.to.form === 'tzid') {
    const target = zone(move.component, move.to.tzid);
    const ambiguity = target.ambiguity(wall) ?? (target.gapAlias(target.toUtc(wall)) !== null ? 'gap' : null);
    if (ambiguity) {
      // in a gap or an overlap the wall clock names no single instant, so the
      // moved UNTIL could let one occurrence too many or too few through
      throw new Error(`moved, it would be ${icalForm(jcalOf(wall, 'floating'))} in "${move.to.tzid}", at the DST ` +
        `change, where ${ambiguity === 'gap' ? 'the wall clock skips times' : 'the wall clock shows an hour twice'} ` +
        'and its order and the order of instants part');
    }
    untilValue = jcalOf(convert(move.component, wall, move.to.tzid, null), 'utc');
  } else {
    untilValue = jcalOf(wall, move.to);
  }
  rewriteRule(move.component, property, { until: untilValue });
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

/**
 * The work ical.js may do expanding the rules of a series once, in units of
 * about a microsecond. A sparse rule (FREQ=MINUTELY;BYMONTH=12;BYMONTHDAY=31)
 * makes it test every minute of the year to find the next occurrence; this
 * caps that work deterministically. A write expands at most twice, so the
 * worst case stays well under a second even on a loaded machine.
 */
const WORK_BUDGET = 150000;

/**
 * What testing one candidate costs, in the units of WORK_BUDGET (measured with
 * ical.js 2.2): per FREQ, and for DAILY and WEEKLY also per day the iterator
 * steps over, which it does one by one, so INTERVAL=5000 costs 5000 times more.
 */
function stepCost(recur: ICAL.Recur): number {
  const interval = Math.max(1, recur.interval || 1);
  switch (recur.freq) {
    case 'SECONDLY': case 'MINUTELY': return 3;
    case 'HOURLY': return 10;
    case 'DAILY': return 5 + Math.ceil(interval * 0.15);
    case 'WEEKLY': return 15 + Math.ceil(interval * 7 * 0.15);
    default: return 45;
  }
}

/** Candidates tested since the module loaded, so a test can see the budget is charged */
export const expansionWork = { steps: 0 };

/** An expansion that ran out of WORK_BUDGET: the check cannot be made, so it fails closed */
class SeriesTooSparse extends Error {}

/** The iterator has passed the furthest wall clock the expansion needs */
class HorizonReached extends Error {}

/** A check that cannot be made (a rule ical.js cannot expand, a zone that cannot be read): it fails closed */
class SeriesUnverifiable extends Error {}

/**
 * Bound a RecurIterator. next() has no bound of its own; every candidate it
 * tests passes check_contracting_rules once, so that is where the work is
 * charged against the budget, and where a search past `horizon` (a wall
 * clock) is cut short: nothing beyond it is needed.
 */
function bounded(iterator: ICAL.RecurIterator, budget: { left: number }, recur: ICAL.Recur, horizon: number): ICAL.RecurIterator {
  const cost = stepCost(recur);
  const it = iterator as unknown as {
    check_contracting_rules?: (...args: unknown[]) => unknown;
    last?: ICAL.Time;
  };
  const check = it.check_contracting_rules;
  if (typeof check !== 'function') {
    throw new SeriesTooSparse('ical.js no longer exposes the step a rule expansion can be bounded at');
  }
  it.check_contracting_rules = function (this: typeof it, ...args: unknown[]) {
    expansionWork.steps++;
    if ((budget.left -= cost) < 0) {
      throw new SeriesTooSparse('the rule is too sparse to expand within the work limit');
    }
    const last = this.last;
    if (last && wallOf(last.year, last.month, last.day, last.hour, last.minute, last.second) > horizon) {
      throw new HorizonReached();
    }
    return check.apply(this, args);
  };
  return iterator;
}

/**
 * The occurrences of the series as it stands up to `until` (a wall clock of the
 * series' frame) — DTSTART, the instances of each RRULE and the RDATEs (EXDATE
 * does not count: an override of an excluded instance still names it), on the
 * series' wall clock with UNTIL read on it too. Throws SeriesTooSparse when
 * the budget runs out first, and SeriesUnverifiable when it cannot be told at
 * all (a rule ical.js cannot expand, a zone that cannot be read).
 */
function expand(master: ICAL.Component, until: number): Set<number> {
  const start = startOf(master);
  if (!start) {
    throw new SeriesUnverifiable('the series has no DTSTART');
  }
  const { frame } = start;
  const day = frame.form === 'date';
  const norm = (wall: number) => day ? dayOf(wall) : wall;
  const timeOf = (wall: number) => day
    ? ICAL.Time.fromDateString(jcalOf(wall, frame))
    : ICAL.Time.fromDateTimeString(jcalOf(wall, 'floating'));
  const walls = new Set([norm(start.wall)]);
  const budget = { left: WORK_BUDGET };
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
      // a date series compares days; its last candidate day starts at `until`
      const iterator = bounded(recur.iterator(timeOf(start.wall)), budget, recur, day ? until + DAY - 1 : until);
      try {
        for (let next = iterator.next(); next; next = iterator.next()) {
          const wall = norm(wallOf(next.year, next.month, next.day, next.hour, next.minute, next.second));
          if (wall > until) {
            break;
          }
          walls.add(wall);
        }
      } catch (error) {
        if (!(error instanceof HorizonReached)) {
          throw error;
        }
      }
    }
  } catch (error) {
    if (error instanceof SeriesTooSparse) {
      // a dense rule that runs out reaches far: the reason is the distance
      throw new SeriesTooSparse(walls.size > 200
        ? `the override or EXDATE furthest ahead (${icalForm(jcalOf(until, frame))}) lies too far ahead to check ` +
          'within the work limit'
        : error.message);
    }
    throw new SeriesUnverifiable((error as Error).message);
  }
  return walls;
}

/**
 * Which stamps name an occurrence of the series. Where that cannot be told the
 * check fails closed: SeriesUnverifiable, with the reason.
 */
function occurrences(master: ICAL.Component, stamps: Stamp[], labels: string[]): boolean[] {
  const frame = frameOf(master);
  if (!frame) {
    throw new SeriesUnverifiable('the series has no DTSTART');
  }
  const targets = stamps.map((stamp, i) => {
    try {
      const wall = wallIn(master, stamp, frame);
      return frame.form === 'date' ? dayOf(wall) : wall;
    } catch (error) {
      throw new SeriesUnverifiable(`${labels[i]}: ${(error as Error).message}`);
    }
  });
  // no override or EXDATE lies beyond the furthest one, so nothing past it is needed
  const walls = expand(master, Math.max(...targets));
  return targets.map((t) => walls.has(t));
}

/** An override or exclusion that has to keep naming an occurrence */
interface Reference {
  property: ICAL.Property;
  index: number;
  /** as it was before the write, for the error */
  label: string;
}

function referenceStamps(refs: Reference[]): Stamp[] {
  return refs.map((ref) => {
    try {
      return propertyStamps(ref.property)[ref.index];
    } catch (error) {
      throw new SeriesUnverifiable(`${ref.label}: ${(error as Error).message}`);
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
  // A check that cannot be completed fails closed, with what the caller can do
  const failClosed = (error: unknown) => {
    if (error instanceof SeriesUnverifiable) {
      return new Error(`Cannot check that the overrides and EXDATEs still name occurrences of the series: ` +
        `${error.message}. Rewrite the whole iCalendar object instead`);
    }
    if (!(error instanceof SeriesTooSparse)) {
      return error;
    }
    const rule = master.getFirstProperty('rrule')?.toICALString() ?? 'The rule';
    return written.has('rrule') || written.has('rdate')
      ? new Error(`Cannot check that the overrides and EXDATEs still name occurrences of the series: ${rule}: ` +
        `${error.message}. Rewrite the whole iCalendar object instead`)
      : new Error(`Cannot check that moving DTSTART keeps the series' occurrences: ${rule}: ${error.message}. ` +
        'Give RRULE, UNTIL and EXDATE explicitly in the same call, or rewrite the whole iCalendar object');
  };
  try {
    const edit = startSeriesEdit(calendar, master, written);
    return {
      finish() {
        try {
          edit.finish();
        } catch (error) {
          throw failClosed(error);
        }
      },
    };
  } catch (error) {
    throw failClosed(error);
  }
}

function startSeriesEdit(calendar: ICAL.Component | null, master: ICAL.Component, written: Set<string>) {
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
  // A move alone keeps every occurrence or is refused (checkMove); only a new
  // rule can leave an override or EXDATE without its occurrence
  const ruleWritten = written.has('rrule') || written.has('rdate');
  // Only what names an occurrence now has to keep naming one; an override that
  // was already stale is not this call's doing
  const before = ruleWritten && references.length
    ? occurrences(master, referenceStamps(references), references.map((ref) => ref.label)) : [];
  const watched = references.filter((_, i) => before[i] === true);
  const start = written.has('dtstart') ? startOf(master) : null;
  // Without a new rule the series has to come out the same, moved
  const keepsRule = !['rrule', 'exrule', 'rdate'].some((name) => written.has(name));
  const named = () => [...master.getAllProperties('exdate'), ...master.getAllProperties('rdate'),
    ...overrides.map((c) => c.getFirstProperty('recurrence-id')!)];
  if (start || ruleWritten) {
    checkGapTwins(master, named(), false);
  }

  return {
    finish() {
      const now = start && startOf(master);
      if (start && now && start.text !== now.text) {
        const move: Move = { component: master, from: start.frame, fromWall: start.wall, to: now.frame, toWall: now.wall };
        if (move.from.form !== 'date' && move.to.form === 'date') {
          checkDatesOnly(master, move, [...exdates, ...rdates,
            ...overrides.map((c) => c.getFirstProperty('recurrence-id')!)]);
        }
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
        if (keepsRule) {
          checkMove(master, move, start.text, now.text);
        }
      }
      if (start || ruleWritten) {
        checkGapTwins(master, named(), true);
      }

      if (!watched.length) {
        return;
      }
      const after = occurrences(master, referenceStamps(watched), watched.map((ref) => ref.label));
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

const SUB_DAILY = new Set(['SECONDLY', 'MINUTELY', 'HOURLY']);
const FREQS = new Set([...SUB_DAILY, 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);
/** Parts that pick dates; BYDAY is handled on its own */
const DATE_PARTS = ['BYMONTH', 'BYMONTHDAY', 'BYYEARDAY', 'BYWEEKNO', 'BYSETPOS'];
const TIME_PARTS = ['BYHOUR', 'BYMINUTE', 'BYSECOND'];
const KNOWN_PARTS = new Set([...DATE_PARTS, ...TIME_PARTS, 'BYDAY']);

/**
 * Why moving a series by `move` would change which occurrences a rule gives,
 * beyond moving each by the same distance — or null when it provably does
 * not. Decided from the rule alone, never by expanding it: a move splits into
 * a change of date (whole days) and of time of day, and
 *
 *  - a rule without BY parts is a grid from DTSTART (every n seconds ... weeks)
 *    and moves with it, except that MONTHLY and YEARLY land on DTSTART's day of
 *    the month, which only shifts uniformly within the same month between the
 *    1st and the 28th (every month has those days; a move across a month end
 *    meets months of different lengths);
 *  - BYHOUR, BYMINUTE and BYSECOND pin times of day: no change of time;
 *  - more than daily, any date-picking part (BYDAY, BYMONTH, ...) cuts the grid
 *    at day boundaries, which the moved grid crosses elsewhere: no move at all;
 *  - BYMONTH, BYMONTHDAY, BYYEARDAY, BYWEEKNO and BYSETPOS pin dates: no change
 *    of date; BYDAY pins weekdays, which a DAILY or WEEKLY rule keeps under a
 *    move by whole weeks (whatever INTERVAL and WKST), and no other rule does;
 *  - a switch between all-day and timed changes the time of day.
 *
 * Anything else — an unknown FREQ or part — is not proven, so it counts as a
 * change too.
 */
function moveBreaksRule(recur: ICAL.Recur, move: Move): string | null {
  const parts = Object.entries((recur.parts ?? {}) as Record<string, unknown[]>)
    .filter(([, values]) => Array.isArray(values) && values.length).map(([name]) => name);
  const unknown = parts.find((name) => !KNOWN_PARTS.has(name));
  if (!FREQS.has(recur.freq)) {
    return `has FREQ=${recur.freq}, whose occurrences updateFields cannot tell`;
  }
  if (unknown) {
    return `has ${unknown}, whose effect on a move updateFields cannot tell`;
  }
  const switched = (move.from.form === 'date') !== (move.to.form === 'date');
  const days = Math.round((dayOf(move.toWall) - dayOf(move.fromWall)) / DAY);
  const timeChanged = switched || (move.toWall - dayOf(move.toWall)) !== (move.fromWall - dayOf(move.fromWall));
  const has = (names: string[]) => parts.filter((name) => names.includes(name));

  if (SUB_DAILY.has(recur.freq)) {
    if (switched) {
      return `repeats more often than daily, which an all-day series cannot`;
    }
    const dateParts = has([...DATE_PARTS, 'BYDAY']);
    if (dateParts.length && (days !== 0 || timeChanged)) {
      return `repeats more often than daily within ${dateParts.join(' and ')}, whose limits the moved times cross elsewhere`;
    }
  }
  const timeParts = has(TIME_PARTS);
  if (timeParts.length && timeChanged) {
    return `has ${timeParts.join(' and ')}, which ${timeParts.length > 1 ? 'pin' : 'pins'} the time of day the move changes`;
  }
  if (days === 0) {
    return null;
  }
  const dateParts = has(DATE_PARTS);
  if (dateParts.length) {
    return `has ${dateParts.join(' and ')}, which ${dateParts.length > 1 ? 'pin' : 'pins'} the dates the move changes`;
  }
  if (parts.includes('BYDAY') && !(['DAILY', 'WEEKLY'].includes(recur.freq) && days % 7 === 0)) {
    return 'has BYDAY, which pins weekdays: only a DAILY or WEEKLY rule follows a move, and only by whole weeks';
  }
  if (recur.freq === 'MONTHLY' || recur.freq === 'YEARLY') {
    const from = fieldsOf(move.fromWall);
    const to = fieldsOf(move.toWall);
    if (from.year !== to.year || from.month !== to.month || from.day > 28 || to.day > 28) {
      return `repeats on DTSTART's day of the month, which only follows a move within the same month ` +
        'between the 1st and the 28th';
    }
  }
  return null;
}

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const weekdayOf = (wall: number) => WEEKDAYS[new Date(wall * 1000).getUTCDay()];

/**
 * The parts of a rule that only restate DTSTART, as many clients write them
 * (Google, Outlook): a single BYDAY equal to DTSTART's weekday in a WEEKLY
 * rule, a single BYMONTH equal to its month in a YEARLY rule, a single
 * BYMONTHDAY equal to its day in a MONTHLY rule, or in a YEARLY one whose
 * BYMONTH restates too. Such a rule gives the same occurrences as without
 * them, so they are derived from DTSTART, not pinned: returned with the new
 * DTSTART's values (in the rule's own key spelling), to be written on a move.
 * Anything else — several values, an ordinal, a value DTSTART does not have —
 * is not restating.
 */
function restatedParts(property: ICAL.Property, recur: ICAL.Recur, move: Move): Record<string, unknown> {
  const raw = (property.toJSON() as unknown[])[3] as Record<string, unknown>;
  const single = (value: unknown) => Array.isArray(value) ? (value.length === 1 ? value[0] : undefined) : value;
  const from = fieldsOf(move.fromWall);
  const to = fieldsOf(move.toWall);
  const out: Record<string, unknown> = {};
  if (recur.freq === 'WEEKLY' && String(single(raw.byday) ?? '').toUpperCase() === weekdayOf(move.fromWall)) {
    out.byday = weekdayOf(move.toWall);
  }
  if (recur.freq === 'YEARLY' && Number(single(raw.bymonth)) === from.month) {
    out.bymonth = to.month;
  }
  if (Number(single(raw.bymonthday)) === from.day && (recur.freq === 'MONTHLY' || 'bymonth' in out)) {
    out.bymonthday = to.day;
  }
  return out;
}

/**
 * Throw when a move would change the occurrences of a rule (RRULE or EXRULE)
 * the call does not write, naming why and suggesting the rule to give. Parts
 * that only restate DTSTART (restatedParts) are written with the new start's
 * values instead, where the rule without them follows the move.
 */
function checkMove(master: ICAL.Component, move: Move, from: string, to: string) {
  for (const property of [...master.getAllProperties()]) {
    if (!isRecurProperty(master, property.name)) {
      continue;
    }
    const recur = property.getFirstValue() as ICAL.Recur;
    const unknown = unknownRuleParts(property);
    // Parts that only restate DTSTART follow it: judge the rule without them
    const restating = unknown.length ? {} : restatedParts(property, recur, move);
    const plain = recur.clone();
    for (const name of Object.keys(restating)) {
      delete (plain.parts as Record<string, unknown>)[name.toUpperCase()];
    }
    const why = unknown.length
      ? `has ${unknown.join(', ')}, whose effect on a move updateFields cannot tell`
      : moveBreaksRule(plain, move);
    if (!why) {
      if (Object.keys(restating).length) {
        rewriteRule(master, property, restating);
      }
      continue;
    }
    const upper = property.name.toUpperCase();
    const suggestion = suggestedRule(recur, move.toWall, move.to.form !== 'date');
    throw new Error(`Moving DTSTART (${from} to ${to}) does not move the whole series: ${property.toICALString()} ` +
      `${why}, so the moved series would not have the same occurrences, each moved. Give ${upper} in the same ` +
      `call to fit the new start${suggestion ? ` (e.g. ${upper} "${suggestion}")` : ''}; to start the series ` +
      'later without moving it, give RRULE, UNTIL and EXDATE explicitly, or rewrite the whole iCalendar object');
  }
}

/**
 * Before a timed series becomes all-day: each RECURRENCE-ID, EXDATE and RDATE
 * becomes the date it falls on, which only keeps its meaning where it sits at
 * the series' time of day. One at another time (a stale override, an extra
 * RDATE in the evening) or a date already would become the date of an
 * occurrence it never named, or fall together with another value; so that
 * throws.
 */
function checkDatesOnly(master: ICAL.Component, move: Move, properties: ICAL.Property[]) {
  const timeOfDay = move.fromWall - dayOf(move.fromWall);
  for (const property of properties) {
    for (const stamp of propertyStamps(property)) {
      const wall = stamp.kind === 'date' ? null : wallIn(master, stamp, move.from);
      if (wall === null || wall - dayOf(wall) !== timeOfDay) {
        const line = property.toICALString();
        throw new Error(`DTSTART changed to a date, and ${line} is ${wall === null ? 'a date already' : 'not at the ' +
          "series' time of day"}, so as a date it could name an occurrence it did not name before: give ` +
          `${property.name === 'recurrence-id' ? 'the override' : property.name.toUpperCase()} as dates ` +
          'by rewriting the whole iCalendar object');
      }
    }
  }
}
