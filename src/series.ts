import ICAL from 'ical.js';
import { frameOf, isDateListProperty, isRecurProperty, pad } from './typedValue';
import type { Anchor } from './typedValue';
import { fieldsOf, unknownZone, wallOf, zoneOf } from './zone';
import { UpdateFieldsError, wrapped } from './errors';

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

function stampOf(jcal: string, tzid: unknown, name: string): Stamp {
  const m = JCAL.exec(jcal);
  if (!m) {
    // only a value already in the object can be malformed here: the call's
    // own values were parsed when written
    throw new UpdateFieldsError('INVALID_VALUE', `the object's ${name} value "${jcal}" is not a date or date-time`,
      { remedy: 'rewrite-object', property: name });
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
  return valuesOf(property).map((v) => stampOf(String(Array.isArray(v) ? v[0] : v), tzid, property.name.toUpperCase()));
};

/**
 * A rule (RRULE, EXRULE) as ical.js reads it from the object. ical.js decodes
 * a rule only when it is first read, so a malformed one (UNTIL=garbage) throws
 * here, whichever check reads it first; it is reported the same way each time.
 */
function recurOf(property: ICAL.Property): ICAL.Recur {
  const name = property.name.toUpperCase();
  let recur: unknown;
  try {
    recur = property.getFirstValue();
  } catch (error) {
    throw new UpdateFieldsError('INVALID_RULE', `the object's ${name} cannot be read: ${(error as Error).message}`,
      { remedy: 'rewrite-object', property: name });
  }
  if (!(recur instanceof ICAL.Recur)) {
    throw new UpdateFieldsError('INVALID_RULE', `the object's ${name} cannot be read as a rule`,
      { remedy: 'rewrite-object', property: name });
  }
  return recur;
}

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
    throw new UpdateFieldsError('UNKNOWN_TZID', unknownZone(tzid), { remedy: 'rewrite-object' });
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
      throw new UpdateFieldsError('ZONE_MISMATCH', 'it is in UTC, and a floating series has no zone to read it in',
        { remedy: 'rewrite-object' });
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
 * A RECURRENCE-ID, EXDATE or RDATE that shares its instant with an occurrence
 * on another wall clock of the series (gapTwin): it then names that
 * occurrence for a client, but another one on the wall clock this module
 * moves by, so which one it names cannot be told. Only where the series does
 * have an occurrence on the twin wall clock. Returns the clash to report, or
 * null.
 */
function findGapTwin(master: ICAL.Component, properties: ICAL.Property[]): string | null {
  const frame = frameOf(master);
  // a zone with no known rules (no VTIMEZONE, no IANA name) has no known gap;
  // a value that needs it converted is refused where it is moved
  if (!frame || frame.form !== 'tzid' || !zoneOf(master, frame.tzid)) {
    return null;
  }
  const twins = properties.filter((property) => property.type !== 'period').flatMap((property) =>
    propertyStamps(property).flatMap((stamp) => {
      const twin = gapTwin(master, stamp, frame);
      return twin ? [{ property, twin }] : [];
    }));
  if (!twins.length) {
    return null;
  }
  const walls = expand(master, Math.max(...twins.map(({ twin }) => twin.other)));
  const clash = twins.find(({ twin }) => walls.has(twin.other));
  return clash ? `${clash.property.toICALString()} %NAMES% the same instant as the occurrence at ` +
    `${icalForm(jcalOf(clash.twin.other, 'floating'))} in "${frame.tzid}", a wall-clock time the DST change skips, ` +
    'so which occurrence it names cannot be told' : null;
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
    throw new UpdateFieldsError('SERIES_MOVE_REFUSED', 'it holds periods, which updateFields does not move',
      { remedy: 'same-call' });
  }
  const stamps = propertyStamps(property);
  if (property.type === 'date' && move.from.form !== 'date' && move.to.form !== 'date') {
    // A date next to a timed series (an RDATE or EXDATE of a whole day) stays
    // a date, moved by the days the series moved; a whole day cannot move by
    // a time of day
    const shift = dayOf(move.toWall) - dayOf(move.fromWall);
    if (move.toWall - move.fromWall !== shift) {
      throw new UpdateFieldsError('SERIES_MOVE_REFUSED',
        'it is a date, a whole day, which cannot move by the time of day DTSTART moved', { remedy: 'same-call' });
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
  if (from === to) {
    return wall;
  }
  const utc = from === null ? wall : zone(component, from).toUtc(wall);
  if (to === null) {
    return utc;
  }
  // In the hour a DST change shows twice, a wall clock is read as its first
  // occurrence (RFC 5545 3.3.5); an instant in the second pass has no wall
  // clock of its own in that zone
  const own2 = zone(component, to);
  const out = own2.fromUtc(utc);
  if (own2.toUtc(out) !== utc) {
    throw new UpdateFieldsError('DST_AMBIGUOUS', `moved, it would be ${icalForm(jcalOf(utc, 'utc'))}, which in "${to}" falls in the second pass ` +
      `of the hour the DST change shows twice, where ${icalForm(jcalOf(out, 'floating'))} reads as the first`,
    { remedy: 'rewrite-object' });
  }
  return out;
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

/** A rule's line as written in the object: everything before the value, and the value's parts */
interface RuleText {
  head: string;
  parts: string[];
}

/**
 * The RRULE and EXRULE lines of a component as the object spells them, so a
 * move can change one part (UNTIL, a restated BYDAY) and leave every other
 * byte as it was: ical.js parses a rule into a normalised value and writes it
 * back upper-cased and reordered, with a part given twice merged into one.
 */
class RuleTexts {
  private readonly texts = new Map<ICAL.Property, RuleText>();
  private readonly changed = new Map<ICAL.Property, RuleText>();

  constructor(source: string | null, calendar: ICAL.Component | null, master: ICAL.Component) {
    if (source === null) {
      return;
    }
    // the lines of the master's own block: the n-th component of its type
    // inside the VCALENDAR, or the bare component itself
    const lines = source.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
    const type = master.name.toUpperCase();
    const index = calendar ? calendar.getAllSubcomponents(master.name).indexOf(master) : 0;
    const level = calendar ? 2 : 1;
    const own: string[] = [];
    let depth = 0;
    let seen = -1;
    let inside = false;
    for (const line of lines) {
      const boundary = /^(BEGIN|END):(.+)$/i.exec(line.trim());
      if (boundary && boundary[1].toUpperCase() === 'BEGIN') {
        depth++;
        if (!inside && depth === level && boundary[2].trim().toUpperCase() === type && ++seen === index) {
          inside = true;
        }
      } else if (boundary) {
        if (inside && depth === level) {
          break;
        }
        depth--;
      } else if (inside && depth === level) {
        own.push(line);
      }
    }
    for (const name of ['rrule', 'exrule']) {
      const written = own.filter((line) => new RegExp(`^${name}[;:]`, 'i').test(line));
      const properties = master.getAllProperties(name);
      if (written.length !== properties.length) {
        continue;
      }
      properties.forEach((property, i) => {
        const colon = colonOf(written[i]);
        this.texts.set(property, { head: written[i].slice(0, colon), parts: written[i].slice(colon + 1).split(';') });
      });
    }
  }

  /** The rule part names given more than once (RFC 5545 3.3.10 allows each once) */
  repeated(property: ICAL.Property): string[] {
    const names = (this.texts.get(property)?.parts ?? []).map((part) => part.split('=')[0].trim().toUpperCase());
    return [...new Set(names.filter((name, i) => names.indexOf(name) !== i))];
  }

  /**
   * Change rule parts: in the rule as parsed (so the rest of the write sees
   * it), and in the rule as written, token by token, the part names matched
   * case-insensitively and everything else kept as it was.
   */
  rewrite(component: ICAL.Component, property: ICAL.Property, parsed: Record<string, unknown>,
    written: Record<string, string>): ICAL.Property {
    const text = this.texts.get(property);
    if (!text) {
      throw new Error('its text could not be found in the object, so it cannot be rewritten part by part');
    }
    const parts = text.parts.map((part) => {
      const eq = part.indexOf('=');
      const name = eq < 0 ? part : part.slice(0, eq);
      const value = written[name.trim().toUpperCase()];
      return value === undefined ? part : `${name}=${value}`;
    });
    const next = rewriteRule(component, property, parsed);
    const line = { head: text.head, parts };
    this.texts.delete(property);
    this.changed.delete(property);
    this.texts.set(next, line);
    this.changed.set(next, line);
    return next;
  }

  /**
   * Keep a rule the call does not change as the object spells it: ical.js
   * writes a rule back normalised, and one it cannot read (UNTIL=garbage)
   * mangled. False when its text could not be found.
   */
  keep(property: ICAL.Property): boolean {
    if (this.changed.has(property)) {
      return true;
    }
    const text = this.texts.get(property);
    if (!text) {
      return false;
    }
    this.changed.set(property, text);
    return true;
  }

  /** Before serialising: tag each rewritten or kept rule so render() can find its line */
  mark() {
    [...this.changed.keys()].forEach((property, i) => property.setParameter('x-tsdav-utils-rule', String(i)));
  }

  /** After serialising: put each tagged rule back as written, with only its changed parts */
  render(text: string): string {
    if (!this.changed.size) {
      return text;
    }
    const lines = [...this.changed.values()];
    const physical = text.split('\r\n');
    const out: string[] = [];
    for (let i = 0; i < physical.length;) {
      let j = i + 1;
      while (j < physical.length && /^[ \t]/.test(physical[j])) {
        j++;
      }
      const logical = physical[i] + physical.slice(i + 1, j).map((l) => l.slice(1)).join('');
      const tag = /;X-TSDAV-UTILS-RULE=(\d+)/i.exec(logical.slice(0, colonOf(logical)));
      if (tag) {
        const line = lines[Number(tag[1])];
        out.push(ICAL.helpers.foldline(`${line.head}:${line.parts.join(';')}`));
      } else {
        out.push(...physical.slice(i, j));
      }
      i = j;
    }
    return out.join('\r\n');
  }
}

/** The position of the colon that ends a content line's name and parameters (not one in a quoted value) */
function colonOf(line: string): number {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') {
      quoted = !quoted;
    } else if (line[i] === ':' && !quoted) {
      return i;
    }
  }
  return line.length;
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
function moveUntil(property: ICAL.Property, move: Move, texts: RuleTexts) {
  const repeated = texts.repeated(property);
  if (repeated.length) {
    throw new UpdateFieldsError('SERIES_MOVE_REFUSED', `the rule gives ${repeated.join(', ')} more than once, which ` +
      'RFC 5545 3.3.10 does not allow and clients read differently', { remedy: 'same-call' });
  }
  const unknown = unknownRuleParts(property);
  if (unknown.length) {
    // ical.js keeps them only as long as the rule is not written again
    throw new UpdateFieldsError('SERIES_MOVE_REFUSED', `the rule has ${unknown.join(', ')}, which updateFields would ` +
      'lose rewriting it', { remedy: 'same-call' });
  }
  const recur = recurOf(property);
  const until = stampOf(recur.until!.toString(), undefined, property.name.toUpperCase());
  if (move.from.form === 'tzid' && until.kind === 'utc') {
    // Near a DST change wall-clock order and the order of instants part: an
    // occurrence on a skipped wall clock (read past the gap) can lie after an
    // UNTIL that is later on the wall clock, and an UNTIL in the repeated hour
    // can lie after an occurrence later on the wall clock. Moved on the wall
    // clock, such an UNTIL would let one occurrence too many or too few through.
    const old = zone(move.component, move.from.tzid);
    if (old.gapAlias(until.wall) !== null || old.ambiguity(old.fromUtc(until.wall))) {
      throw new UpdateFieldsError('DST_AMBIGUOUS', `it lies at the DST change in "${move.from.tzid}", where the wall clock and the order of ` +
        'instants part, so moved on the wall clock it could let one occurrence too many or too few through',
      { remedy: 'same-call' });
    }
  }
  if ((until.kind === 'date') !== (move.from.form === 'date')) {
    // RFC 5545 3.3.10 ties UNTIL's type to DTSTART's; a date UNTIL next to a
    // timed DTSTART ends at a time of day each client reads differently
    throw new UpdateFieldsError('SERIES_MOVE_REFUSED', `UNTIL is a ${until.kind === 'date' ? 'date' : 'date-time'} ` +
      `next to a ${move.from.form === 'date' ? 'date' : 'date-time'} DTSTART, so where it ends the series is not defined`,
    { remedy: 'same-call' });
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
      throw new UpdateFieldsError('DST_AMBIGUOUS', `moved, it would be ${icalForm(jcalOf(wall, 'floating'))} in "${move.to.tzid}", at the DST ` +
        `change, where ${ambiguity === 'gap' ? 'the wall clock skips times' : 'the wall clock shows an hour twice'} ` +
        'and its order and the order of instants part', { remedy: 'same-call' });
    }
    untilValue = jcalOf(convert(move.component, wall, move.to.tzid, null), 'utc');
  } else {
    untilValue = jcalOf(wall, move.to);
  }
  texts.rewrite(move.component, property, { until: untilValue }, { UNTIL: untilValue.replace(/[-:]/g, '') });
}

/** The DTSTART of a series as frame and wall clock, or null without one */
function startOf(master: ICAL.Component): { frame: Anchor; wall: number; text: string } | null {
  const frame = frameOf(master);
  const dtstart = master.getFirstProperty('dtstart');
  if (!frame || !dtstart) {
    return null;
  }
  return { frame, wall: propertyStamps(dtstart)[0].wall, text: dtstart.toICALString() };
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

/**
 * The installed ical.js lacks the step the work limit hooks into: a failure of
 * the library, not of the call, so it stays a plain Error and is never turned
 * into a refusal (CI's install smoke test catches it against a fresh ical.js).
 */
class BoundUnavailable extends Error {}

/** The iterator has passed the furthest wall clock the expansion needs */
class HorizonReached extends Error {}

/**
 * A check that cannot be made: it fails closed. `source` is what stopped it —
 * null when the series itself gives no way to check (no DTSTART), a refusal
 * (a zone that cannot be read, a malformed value) whose code is kept, or any
 * other error, which is a failure of the library and stays a plain Error.
 */
class SeriesUnverifiable extends Error {
  constructor(message: string, readonly source: unknown = null) {
    super(message);
  }
}

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
    throw new BoundUnavailable('ical.js no longer exposes the step a rule expansion can be bounded at');
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
      const recur = recurOf(property).clone();
      if (recur.until) {
        recur.until = timeOf(norm(wallIn(master, stampOf(recur.until.toString(), undefined, property.name.toUpperCase()),
          frame)));
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
    if (error instanceof BoundUnavailable) {
      throw error;
    }
    if (error instanceof SeriesTooSparse) {
      // a dense rule that runs out reaches far: the reason is the distance
      throw new SeriesTooSparse(walls.size > 200
        ? `the override or EXDATE furthest ahead (${icalForm(jcalOf(until, frame))}) lies too far ahead to check ` +
          'within the work limit'
        : error.message);
    }
    throw new SeriesUnverifiable((error as Error).message, error);
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
      throw new SeriesUnverifiable(`${labels[i]}: ${(error as Error).message}`, error);
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
      throw new SeriesUnverifiable(`${ref.label}: ${(error as Error).message}`, error);
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

/**
 * The lines a call added to an EXDATE or RDATE list (options.append): the ones
 * of those names the component did not hold before the write.
 */
function addedLines(master: ICAL.Component, added: Set<string>, before: Set<ICAL.Property>): ICAL.Property[] {
  return [...added].flatMap((name) => master.getAllProperties(name).filter((property) => !before.has(property)));
}

/**
 * Drop from each added line the values its list already holds, and repeats
 * within the line: the same instant (the same date, in an all-day series),
 * read in the series' frame, whatever zone each is written in. Where an
 * instant cannot be read there (no DTSTART, a zone without rules) values are
 * compared as written. A line left without values goes. Values already in the
 * object that do not parse are left to the checks that read them.
 */
function dropDuplicates(master: ICAL.Component, lines: ICAL.Property[]) {
  const frame = frameOf(master);
  const keyOf = (stamp: Stamp): string => {
    if (frame) {
      try {
        const wall = wallIn(master, stamp, frame);
        // a whole day next to a timed series is not its midnight occurrence
        const day = stamp.kind === 'date' && frame.form !== 'date' ? 'day ' : '';
        return `${day}${frame.form === 'date' ? dayOf(wall) : wall}`;
      } catch {
        // its instant cannot be told in the series' frame: compared as written
      }
    }
    return `${stamp.kind} ${stamp.tzid ?? ''} ${stamp.wall}`;
  };
  const keysOf = (property: ICAL.Property): string[] => {
    try {
      return propertyStamps(property).map(keyOf);
    } catch {
      return [];
    }
  };
  for (const line of lines) {
    const seen = new Set(master.getAllProperties(line.name).filter((p) => p !== line).flatMap(keysOf));
    const values = valuesOf(line);
    const keys = keysOf(line);
    const kept = values.filter((_, i) => !seen.has(keys[i]) && Boolean(seen.add(keys[i])));
    if (!kept.length) {
      master.removeProperty(line);
    } else if (kept.length < values.length) {
      line.setValues(kept);
    }
  }
}

/**
 * Each EXDATE value a call added has to name an occurrence of the series as it
 * comes out of the write: one that names none excludes nothing, and the
 * occurrence the caller meant to cancel would silently stay (most often a
 * time given in the wrong zone). An EXDATE that replaces the whole list is the
 * caller's to state, as any value written, and is not checked.
 */
function checkAddedExdates(master: ICAL.Component, lines: ICAL.Property[]) {
  const exdates = lines.filter((line) => line.name === 'exdate' && master.getAllProperties('exdate').includes(line));
  const labels = exdates.flatMap((line) => valuesOf(line).map((v) => `EXDATE ${icalForm(String(v))}`));
  if (!labels.length) {
    return;
  }
  let found: boolean[];
  try {
    found = occurrences(master, exdates.flatMap(propertyStamps), labels);
  } catch (error) {
    if (!(error instanceof SeriesTooSparse)) {
      throw error;
    }
    throw new UpdateFieldsError('CHECK_LIMIT_EXCEEDED', 'Cannot check that the EXDATE added names an occurrence of the ' +
      `series: ${error.message}. Give the complete EXDATE list without append instead`,
    { remedy: 'fix-value', property: 'EXDATE' });
  }
  const lost = labels.filter((_, i) => !found[i]);
  if (lost.length) {
    const series = ['dtstart', 'rrule', 'rdate'].flatMap((name) => master.getAllProperties(name))
      .map((property) => property.toICALString()).join(', ');
    throw new UpdateFieldsError('UNMATCHED_EXDATE', `${lost.join(', ')} names no occurrence of the series ` +
      `(${series}), so it would exclude nothing. Give the start of the occurrence to cancel, at the time the ` +
      'series has it: in the zone of DTSTART, or in UTC', { remedy: 'fix-value', property: 'EXDATE' });
  }
}

/** A write on something that is no series master: an added line is only deduplicated */
function noSeries(master: ICAL.Component, added: Set<string>) {
  const held = new Set(master.getAllProperties());
  return {
    finish: () => dropDuplicates(master, addedLines(master, added, held)),
    render: (text: string) => text,
  };
}

/**
 * Start a write on an event, todo or journal: reject what would corrupt the
 * series, and capture what has to follow it. Call before the fields are
 * written, and finish() after. Anything else (a vCard, a detached instance
 * that carries its own RECURRENCE-ID) is left to the plain write.
 *
 * @param calendar - the VCALENDAR, to find the overrides in; null for a bare
 *   component, which has none
 * @param master - the component updateFields writes (see seriesMaster)
 * @param written - the lower-case property names the call writes, replacing them
 * @param added - the lower-case names of the lists the call adds to (EXDATE,
 *   RDATE with options.append): their values join the series' after it has
 *   moved, without the ones it holds already, and an added EXDATE has to name
 *   an occurrence (see checkAddedExdates)
 */
export function beginSeriesEdit(calendar: ICAL.Component | null, master: ICAL.Component, written: Set<string>,
  source: string | null = null, added: Set<string> = new Set()) {
  // A check that cannot be completed fails closed, with what the caller can do
  const failClosed = (error: unknown) => {
    if (error instanceof SeriesUnverifiable) {
      const message = 'Cannot check that the overrides and EXDATEs still name occurrences of the series: ' +
        `${error.message}. Rewrite the whole iCalendar object instead`;
      if (error.source === null) {
        return new UpdateFieldsError('SERIES_UNVERIFIABLE', message, { remedy: 'rewrite-object' });
      }
      return wrapped(error.source, message, { remedy: 'rewrite-object' });
    }
    if (error instanceof BoundUnavailable) {
      // a failure of the library, not of the call: a plain Error, with context
      const plain = new Error(`Cannot check the series: ${error.message}`);
      (plain as { cause?: unknown }).cause = error;
      return plain;
    }
    if (!(error instanceof SeriesTooSparse)) {
      return error;
    }
    const rule = master.getFirstProperty('rrule')?.toICALString() ?? 'The rule';
    return written.has('rrule') || written.has('rdate')
      ? new UpdateFieldsError('CHECK_LIMIT_EXCEEDED', `Cannot check that the overrides and EXDATEs still name occurrences of the series: ${rule}: ` +
        `${error.message}. Rewrite the whole iCalendar object instead`, { remedy: 'rewrite-object' })
      : new UpdateFieldsError('CHECK_LIMIT_EXCEEDED', `Cannot check that moving DTSTART keeps the series' occurrences: ${rule}: ${error.message}. ` +
        'Give RRULE, UNTIL and EXDATE explicitly in the same call, or rewrite the whole iCalendar object',
      { remedy: 'same-call' });
  };
  try {
    const edit = startSeriesEdit(calendar, master, written, source, added);
    return {
      finish() {
        try {
          edit.finish();
        } catch (error) {
          throw failClosed(error);
        }
      },
      render: (text: string) => edit.render(text),
    };
  } catch (error) {
    throw failClosed(error);
  }
}

function startSeriesEdit(calendar: ICAL.Component | null, master: ICAL.Component, written: Set<string>,
  source: string | null, added: Set<string>) {
  if (!['vevent', 'vtodo', 'vjournal'].includes(master.name) || master.hasProperty('recurrence-id')) {
    return noSeries(master, added);
  }
  if (written.has('recurrence-id')) {
    throw new UpdateFieldsError('RECURRENCE_ID_ON_MASTER', 'RECURRENCE-ID cannot be written on the series master: it would turn the master into an ' +
      'override of a single instance (RFC 5545 3.8.4.4). updateFields edits the series; to change one ' +
      'instance, add or edit an override component (same UID, with RECURRENCE-ID) by rewriting the whole ' +
      'iCalendar object', { remedy: 'rewrite-object', property: 'RECURRENCE-ID' });
  }

  // A property the call writes itself is the caller's, for the new series: the
  // first line of its name is the one replaced, or every line of a list of
  // dates (see setDateValue/setRecurValue)
  const replaced = new Set([...written].flatMap((name) => isDateListProperty(master, name)
    ? master.getAllProperties(name) : [master.getFirstProperty(name)]).filter(Boolean));
  const held = new Set(master.getAllProperties());
  const own = (name: string) => master.getAllProperties(name).filter((p) => !replaced.has(p));

  const uid = master.getFirstPropertyValue('uid');
  const overrides = (calendar?.getAllSubcomponents(master.name) ?? [])
    .filter((c) => c !== master && c.hasProperty('recurrence-id') && c.getFirstPropertyValue('uid') === uid);
  const exdates = own('exdate');
  const rdates = own('rdate');
  // read only when DTSTART moves: a rule is decoded when first read, and one
  // the object holds malformed must not refuse a write that does not need it
  const kept = master.getAllProperties().filter((p) => isRecurProperty(master, p.name) && !replaced.has(p));
  const rules = () => kept.filter((p) => recurOf(p).until);

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
  const texts = new RuleTexts(source, calendar, master);
  const named = () => [...master.getAllProperties('exdate'), ...master.getAllProperties('rdate'),
    ...overrides.map((c) => c.getFirstProperty('recurrence-id')!)];
  // Found now, on the series as it was, but reported only if the write does
  // change its occurrences (a DTSTART written with the same value does not)
  let twinBefore: string | null = null;
  let twinError: unknown = null;
  if (start || ruleWritten) {
    try {
      twinBefore = findGapTwin(master, named());
    } catch (error) {
      twinError = error;
    }
  }

  return {
    render: (text: string) => texts.render(text),
    finish() {
      const now = start && startOf(master);
      if (start && now && start.text !== now.text) {
        const move: Move = { component: master, from: start.frame, fromWall: start.wall, to: now.frame, toWall: now.wall };
        if (move.from.form !== 'date' && move.to.form === 'date') {
          checkDatesOnly(master, move, [...exdates, ...rdates,
            ...overrides.map((c) => c.getFirstProperty('recurrence-id')!)]);
        }
        for (const property of rules()) {
          const upper = property.name.toUpperCase();
          const until = recurOf(property).until!.toICALString();
          try {
            moveUntil(property, move, texts);
          } catch (error) {
            throw wrapped(error, `DTSTART changed, and the existing ${upper} UNTIL=${until} ` +
              `cannot follow it (${(error as Error).message}): give ${upper}, with UNTIL, in the same call`,
            { remedy: 'same-call', property: upper });
          }
        }
        for (const property of [...exdates, ...rdates]) {
          const line = property.toICALString();
          try {
            moveInstants(property, move);
          } catch (error) {
            throw wrapped(error, `DTSTART changed, and the existing ${line} cannot follow it ` +
              `(${(error as Error).message}): give ${property.name.toUpperCase()} in the same call`,
            { remedy: 'same-call', property: property.name.toUpperCase() });
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
            throw wrapped(error, `DTSTART changed, and the override for ${line} cannot follow it ` +
              `(${(error as Error).message}): rewrite the whole iCalendar object with the override moved`,
            { remedy: 'rewrite-object', property: 'RECURRENCE-ID' });
          }
        }
        if (keepsRule) {
          checkMove(master, move, start.text, now.text, texts);
        }
      }
      // Added values are the new series': compared with the moved ones
      const appended = addedLines(master, added, held);
      dropDuplicates(master, appended);
      checkAddedExdates(master, appended);
      const moving = Boolean(start && now && start.text !== now.text);
      if (moving || ruleWritten) {
        const cause = moving ? 'Moving DTSTART' : `Writing ${shaping.filter((n) => n !== 'dtstart')
          .map((n) => n.toUpperCase()).join(' and ')}`;
        if (twinError) {
          throw twinError;
        }
        const after = twinBefore ? null : findGapTwin(master, named());
        const twin = twinBefore ?? after;
        if (twin) {
          const verb = twinBefore ? 'names' : moving ? 'would name, moved,' : 'would name';
          throw new UpdateFieldsError('DST_AMBIGUOUS', `${cause} is refused: ${twin.replace('%NAMES%', verb)}. ` +
            'Rewrite the whole iCalendar object with the values it should have', { remedy: 'rewrite-object' });
        }
      }
      // A rule the call leaves alone goes back byte for byte; one whose text
      // cannot be found is written by ical.js, which only a readable rule
      // survives unchanged in meaning, so an unreadable one is refused
      for (const property of master.getAllProperties()) {
        if (kept.includes(property) && !texts.keep(property)) {
          recurOf(property);
        }
      }
      texts.mark();

      if (!watched.length) {
        return;
      }
      const after = occurrences(master, referenceStamps(watched), watched.map((ref) => ref.label));
      const lost = watched.filter((_, i) => after[i] === false);
      if (lost.length) {
        const what = shaping.map((n) => n.toUpperCase()).join(' and ');
        throw new UpdateFieldsError('ORPHANED_EXCEPTIONS', `The new ${what} leaves ${lost.map((ref) => ref.label).join(', ')} naming no ` +
          `occurrence of the series, so ${lost.length > 1 ? 'they' : 'it'} would silently stop applying ` +
          '(RFC 5545 3.8.4.4, 3.8.5.1). Give RRULE (or RDATE) in the same call so the series still has ' +
          `${lost.length > 1 ? 'these occurrences' : 'this occurrence'}, and EXDATE in the same call with the ` +
          'exclusions the new series should have; or rewrite the whole iCalendar object to move or remove ' +
          'the override', { remedy: 'same-call', property: written.has('rrule') ? 'RRULE' : 'RDATE' });
      }
    },
  };
}

/**
 * Whether a YEARLY rule without BY parts follows a move of its date: both
 * dates exist in every year (not 29 February), and the distance between them
 * is the same in every year, which it is unless it spans the end of February.
 * Checked over a leap year and the years around it, which covers every case:
 * only 29 February makes years differ.
 */
function yearlyFollows(from: ReturnType<typeof fieldsOf>, to: ReturnType<typeof fieldsOf>): boolean {
  const everyYear = (month: number, day: number) => day <= new Date(Date.UTC(2025, month, 0)).getUTCDate();
  if (!everyYear(from.month, from.day) || !everyYear(to.month, to.day)) {
    return false;
  }
  const years = to.year - from.year;
  const distances = [2023, 2024, 2025, 2026].map((y) =>
    Date.UTC(y + years, to.month - 1, to.day) - Date.UTC(y, from.month - 1, from.day));
  return distances.every((d) => d === distances[0]);
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
  const from = fieldsOf(move.fromWall);
  const to = fieldsOf(move.toWall);
  if (recur.freq === 'MONTHLY' &&
      (from.year !== to.year || from.month !== to.month || from.day > 28 || to.day > 28)) {
    return `repeats on DTSTART's day of the month, which only follows a move within the same month ` +
      'between the 1st and the 28th';
  }
  if (recur.freq === 'YEARLY' && !yearlyFollows(from, to)) {
    return `repeats on DTSTART's month and day, which only follows a move to a date every year has, by the same ` +
      'number of days in every year (not across the end of February)';
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
function checkMove(master: ICAL.Component, move: Move, from: string, to: string, texts: RuleTexts) {
  for (const property of [...master.getAllProperties()]) {
    if (!isRecurProperty(master, property.name)) {
      continue;
    }
    const recur = recurOf(property);
    const unknown = unknownRuleParts(property);
    // Parts that only restate DTSTART follow it: judge the rule without them
    const restating = unknown.length ? {} : restatedParts(property, recur, move);
    const plain = recur.clone();
    for (const name of Object.keys(restating)) {
      delete (plain.parts as Record<string, unknown>)[name.toUpperCase()];
    }
    const repeated = texts.repeated(property);
    const why = repeated.length
      ? `gives ${repeated.join(', ')} more than once, which RFC 5545 3.3.10 does not allow and clients read differently`
      : unknown.length
        ? `has ${unknown.join(', ')}, whose effect on a move updateFields cannot tell`
        : moveBreaksRule(plain, move);
    if (!why) {
      if (Object.keys(restating).length) {
        texts.rewrite(master, property, restating,
          Object.fromEntries(Object.entries(restating).map(([k, v]) => [k.toUpperCase(), String(v)])));
      }
      continue;
    }
    const upper = property.name.toUpperCase();
    const suggestion = suggestedRule(recur, move.toWall, move.to.form !== 'date');
    throw new UpdateFieldsError('SERIES_MOVE_REFUSED', `Moving DTSTART (${from} to ${to}) does not move the whole series: ${property.toICALString()} ` +
      `${why}, so the moved series would not have the same occurrences, each moved. Give ${upper} in the same ` +
      `call to fit the new start${suggestion ? ` (e.g. ${upper} "${suggestion}")` : ''}; to start the series ` +
      'later without moving it, give RRULE, UNTIL and EXDATE explicitly, or rewrite the whole iCalendar object',
    { remedy: 'same-call', property: upper, ...(suggestion ? { suggestion } : {}) });
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
        throw new UpdateFieldsError('SERIES_MOVE_REFUSED', `DTSTART changed to a date, and ${line} is ${wall === null ? 'a date already' : 'not at the ' +
          "series' time of day"}, so as a date it could name an occurrence it did not name before: give ` +
          `${property.name === 'recurrence-id' ? 'the override' : property.name.toUpperCase()} as dates ` +
          'by rewriting the whole iCalendar object', { remedy: 'rewrite-object', property: property.name.toUpperCase() });
      }
    }
  }
}
