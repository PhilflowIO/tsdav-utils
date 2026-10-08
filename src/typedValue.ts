import ICAL from 'ical.js';
import type { AbsoluteTime, FloatingTime } from './types';
import { fieldsOf, unknownZone, wallOf, zoneOf } from './zone';
import { UpdateFieldsError, wrapped } from './errors';
import type { UpdateFieldsErrorCode } from './errors';

/**
 * Typed writes for date and date-time properties.
 *
 * ical.js' updatePropertyWithValue(name, string) stores the string as the
 * jCal value and leaves type and parameters alone. For a date-time property
 * that is wrong in three ways:
 *
 *  - jCal only knows the extended form "2026-10-26T18:00:00Z". The basic iCal
 *    form "20261026T180000Z" fails to serialize ("invalid date-time value").
 *  - Any other zone designator ("+02:00", "-04:00", ".000Z") is dropped on
 *    serialize, which leaves a floating time that is hours off for a reader
 *    in another zone.
 *  - A TZID or VALUE=DATE on the existing property survives, so the result is
 *    "DUE;TZID=Europe/Berlin:...Z" or "DUE;VALUE=DATE:...T180000Z", both of
 *    which RFC 5545 forbids.
 *
 * So the value is parsed here, brought into the one form jCal serializes
 * faithfully (UTC with "Z", or floating, or a DATE), and the property type
 * and TZID are reset to match.
 */

/**
 * Property types this module takes over. "date-and-or-time" (vCard 4 BDAY,
 * ANNIVERSARY) is deliberately absent: it allows partial dates like "--0501"
 * that a strict parser would reject, and ical.js already writes it verbatim.
 */
const TYPED = new Set(['date-time', 'date', 'timestamp']);

/**
 * RFC 5545 requires these to be UTC date-times (3.8.2.1 COMPLETED, 3.8.7.1
 * CREATED, 3.8.7.2 DTSTAMP, 3.8.7.3 LAST-MODIFIED). The design sets do not
 * record that, so it is spelled out here.
 */
const UTC_ONLY = new Set(['completed', 'created', 'dtstamp', 'last-modified']);

/** A refusal of a value the caller gave: correcting it is the remedy */
const refuse = (code: UpdateFieldsErrorCode, message: string, property?: string) =>
  new UpdateFieldsError(code, message, { remedy: 'fix-value', property });

const DATE_TIME_FORMS =
  '"2026-10-26T18:00:00Z", "2026-10-26T14:00:00-04:00", "20261026T180000Z" ' +
  'or "2026-10-26T18:00:00" (no zone; seconds optional)';
const ACCEPTED_FORMS = `Accepted forms: ${DATE_TIME_FORMS}, or a date "2026-10-26" / "20261026"`;

/**
 * One parsed value, in the jCal form ("2026-10-26", "2026-10-26T18:00:00Z",
 * "2026-10-26T18:00:00"). "floating" is a wall-clock time without a zone; what
 * it becomes on write depends on where it lands (see setDateValue), and
 * `local` is the instant it names when read in the host timezone.
 */
export type DateValue =
  | { kind: 'date'; jcal: string }
  | { kind: 'utc'; jcal: string }
  | { kind: 'floating'; jcal: string; local: Date };
type ParsedValue = DateValue;

const DATE_EXTENDED = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_BASIC = /^(\d{4})(\d{2})(\d{2})$/;
const ZONE = '(Z|[+-]\\d{2}(?::?\\d{2})?)';
const DATE_TIME_EXTENDED = new RegExp(
  `^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2})(?::(\\d{2})(?:\\.\\d+)?)?${ZONE}?$`, 'i');
const DATE_TIME_BASIC = new RegExp(
  `^(\\d{4})(\\d{2})(\\d{2})T(\\d{2})(\\d{2})(\\d{2})${ZONE}?$`, 'i');

export const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/**
 * Milliseconds since the epoch of a UTC wall-clock time. Date.UTC maps years
 * 0-99 onto 1900-1999, so the year is set separately.
 */
export function utcMillis(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number {
  const t = new Date(Date.UTC(2000, mo - 1, d, h, mi, s));
  t.setUTCFullYear(y, mo - 1, d);
  return t.getTime();
}

/** The same for a wall-clock time in the host timezone. */
function localDate(y: number, mo: number, d: number, h: number, mi: number, s: number): Date {
  const t = new Date(2000, mo - 1, d, h, mi, s);
  t.setFullYear(y, mo - 1, d);
  return t;
}

/**
 * Check the fields actually name a calendar date and a wall-clock time.
 * Date.UTC would otherwise roll "2026-02-30" over into March without a word.
 */
function assertRealDateTime(raw: string, y: number, mo: number, d: number, h = 0, mi = 0, s = 0) {
  // seconds are checked on their own: a leap second (60) would roll the
  // probe over into the next day on the last second of a month
  const t = new Date(utcMillis(y, mo, d, h, mi, 0));
  if (
    t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d ||
    h > 23 || mi > 59 || s > 60
  ) {
    throw refuse('INVALID_VALUE', `"${raw}" is not a valid date or time`);
  }
}

function toUtcJcal(date: Date): string {
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}Z`;
}

/**
 * Parse one date or date-time value as a caller would write it — the grammar
 * updateFields accepts for every date-typed property, exported so a caller
 * can validate input with exactly the same rules.
 *
 * A zoned value is converted to UTC: the instant is what matters, and UTC is
 * the only zone that needs no VTIMEZONE. A value without a zone stays a
 * wall-clock time here; setDateValue decides what it means.
 *
 * @throws {UpdateFieldsError} INVALID_VALUE, naming the accepted forms, when the
 *   value is none of them; INVALID_INPUT when it is no string
 */
export function parseDateValue(raw: string): DateValue {
  if (typeof raw !== 'string') {
    throw refuse('INVALID_INPUT', `Invalid input: the value must be a string, not ${raw === null ? 'null' : typeof raw}`);
  }
  const value = raw.trim();
  let m: RegExpExecArray | null;

  if ((m = DATE_EXTENDED.exec(value)) || (m = DATE_BASIC.exec(value))) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    assertRealDateTime(raw, y, mo, d);
    return { kind: 'date', jcal: `${m[1]}-${m[2]}-${m[3]}` };
  }

  m = DATE_TIME_EXTENDED.exec(value) || DATE_TIME_BASIC.exec(value);
  if (!m) {
    throw refuse('INVALID_VALUE', `"${raw}" is not a date or date-time. ${ACCEPTED_FORMS}`);
  }

  const [y, mo, d, h, mi] = [1, 2, 3, 4, 5].map((i) => Number(m![i]));
  const s = Number(m[6] ?? 0);
  const zone = m[7];
  assertRealDateTime(raw, y, mo, d, h, mi, s);

  if (zone) {
    // UTC instant of the wall-clock fields, then shift by the offset. A leap
    // second ("60") rolls over into the next second.
    let ms = utcMillis(y, mo, d, h, mi, s);
    if (zone.toUpperCase() !== 'Z') {
      const sign = zone[0] === '-' ? -1 : 1;
      const digits = zone.slice(1).replace(':', '');
      const hours = Number(digits.slice(0, 2));
      const minutes = Number(digits.slice(2, 4) || 0);
      if (hours > 23 || minutes > 59) {
        throw refuse('INVALID_VALUE', `"${raw}" has an invalid UTC offset`);
      }
      ms -= sign * (hours * 60 + minutes) * 60000;
    }
    return { kind: 'utc', jcal: toUtcJcal(new Date(ms)) };
  }

  return {
    kind: 'floating',
    jcal: `${pad(y, 4)}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}`,
    local: localDate(y, mo, d, h, mi, s),
  };
}

/**
 * Design set the component was parsed with. vCard 3 and 4 type the same
 * properties differently (REV is date-time in 3.0, timestamp in 4.0).
 */
function designSetFor(component: ICAL.Component) {
  if (component.name === 'vcard') {
    const version = String(component.getFirstPropertyValue('version') ?? '').trim();
    return version === '3.0' ? ICAL.design.vcard3 : ICAL.design.vcard;
  }
  return ICAL.design.icalendar;
}

interface DateProperty {
  defaultType: string;
  allowedTypes: string[];
  multiValue: boolean;
}

/**
 * The date shape of a property, or null when the property is not a date
 * property this module handles (TEXT, X-*, DURATION-typed TRIGGER, ...).
 */
function dateProperty(component: ICAL.Component, name: string): DateProperty | null {
  const lower = name.toLowerCase();
  // BDAY and ANNIVERSARY are DATE-AND-OR-TIME in vCard 4 and allow partial
  // dates ("--0501"), which vCard 3 cards carry in practice too; ical.js
  // types them date-time in 3.0. Both versions write them as given.
  if (component.name === 'vcard' &&
      (ICAL.design.vcard.property as Record<string, any>)[lower]?.defaultType === 'date-and-or-time') {
    return null;
  }
  const design = (designSetFor(component).property as Record<string, any>)[lower];
  if (!design || !TYPED.has(design.defaultType)) {
    return null;
  }
  return {
    defaultType: design.defaultType,
    allowedTypes: design.allowedTypes ?? [design.defaultType],
    multiValue: Boolean(design.multiValue),
  };
}

/** Components whose date-times are anchored by DTSTART */
const ANCHORED = new Set(['vevent', 'vtodo', 'vjournal']);

/** How a DTSTART is written, which the other date-times have to follow */
export type Anchor =
  | { form: 'date' }
  | { form: 'utc' }
  | { form: 'floating' }
  | { form: 'tzid'; tzid: string };

/**
 * The form DTSTART gives the other date-times of an event, todo or journal
 * (DTEND, DUE, EXDATE, RDATE, RECURRENCE-ID, ...), or null when nothing
 * anchors the property: DTSTART itself, a UTC-only property, a vCard, or a
 * component without a DTSTART.
 *
 * Those properties name instants of the same schedule. RFC 5545 requires
 * DTEND, DUE and RECURRENCE-ID to have DTSTART's value type (3.8.2.2,
 * 3.8.2.3, 3.8.4.4), and an EXDATE only removes an occurrence it names in
 * the series' own form. So an end is read in the zone of its start, and a
 * time without a zone means the same wall clock DTSTART uses.
 */
function anchorOf(component: ICAL.Component, name: string): Anchor | null {
  if (name === 'dtstart' || UTC_ONLY.has(name) || !ANCHORED.has(component.name)) {
    return null;
  }
  return frameOf(component);
}

/**
 * The form of an event's, todo's or journal's DTSTART — date, UTC, floating
 * or wall clock in a TZID — or null when it has none.
 */
export function frameOf(component: ICAL.Component): Anchor | null {
  const dtstart = component.getFirstProperty('dtstart');
  if (!dtstart) {
    return null;
  }
  if (dtstart.type === 'date') {
    return { form: 'date' };
  }
  const tzid = dtstart.getParameter('tzid');
  if (typeof tzid === 'string' && tzid) {
    return { form: 'tzid', tzid };
  }
  const value = (dtstart.toJSON() as unknown[])[3];
  return typeof value === 'string' && /Z$/i.test(value) ? { form: 'utc' } : { form: 'floating' };
}

/**
 * A UTC value as the wall clock of its instant in a zone, for "keep-zone".
 * Refused when the zone's rules are unknown, or when the instant falls in the
 * second pass of the hour a DST change shows twice: that wall clock reads as
 * the first pass (RFC 5545 3.3.5), so the instant has none of its own there.
 * An instant always has a wall clock outside a gap, so none lands in one.
 */
function wallInZone(component: ICAL.Component, upper: string, tzid: string, value: DateValue): DateValue {
  const zone = zoneOf(component, tzid);
  if (!zone) {
    throw refuse('UNKNOWN_TZID', `${upper}: ${unknownZone(tzid)}, so the instant cannot be ` +
      'written as its wall-clock time there: give a time without a zone, or leave absoluteTime "as-given"', upper);
  }
  const m = /^(\d{4,})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/.exec(value.jcal)!;
  const utc = wallOf(...([1, 2, 3, 4, 5, 6].map((i) => Number(m[i])) as [number, number, number, number, number, number]));
  const wall = zone.fromUtc(utc);
  const f = fieldsOf(wall);
  const jcal = `${pad(f.year, 4)}-${pad(f.month)}-${pad(f.day)}T${pad(f.hour)}:${pad(f.minute)}:${pad(f.second)}`;
  if (zone.toUtc(wall) !== utc) {
    throw refuse('DST_AMBIGUOUS', `${upper}: ${value.jcal.replace(/[-:]/g, '')} is ` +
      `${jcal.replace(/[-:]/g, '')} in "${tzid}", in the second pass of the hour the DST change shows twice, ` +
      'where that wall-clock time reads as the first pass: give the time in UTC with absoluteTime "as-given", ' +
      'or another time', upper);
  }
  return { kind: 'floating', jcal, local: new Date(utc * 1000) };
}

/**
 * Write a date or date-time property from a caller-supplied string.
 *
 * Updates the first occurrence (creating it when missing), which is the same
 * occurrence updatePropertyWithValue would touch, so only the encoding changes
 * and not which line is written.
 *
 * A value without a zone is a wall-clock time. It is read in the property's
 * own TZID if it has one ("18:00" on DTEND;TZID=Europe/Berlin is 18:00 in
 * Berlin, and the TZID stays); otherwise in the form DTSTART anchors (see
 * anchorOf): DTSTART's TZID, floating next to a floating DTSTART, and next to
 * a UTC DTSTART only with floatingTime "local" — under "keep" there is no
 * zone to read it in, and a floating value there would match nothing, so it
 * throws. With no anchor at all it stays floating, or with "local" the host's
 * wall clock is written as UTC. A value that names its zone is written as UTC
 * and drops the TZID, which RFC 5545 3.2.19 forbids on a UTC value and which
 * a DATE cannot carry — unless absoluteTime is "keep-zone": then, where the
 * zone above applies (the property's TZID, else DTSTART's), the instant is
 * written as its wall clock in that zone and the TZID stays (see wallInZone). Other parameters (RANGE on RECURRENCE-ID, X-
 * parameters) survive.
 *
 * An anchored property also takes DTSTART's value type: a date next to an
 * all-day DTSTART, a date-time next to a timed one.
 *
 * @returns true when the property was handled here, false when it is not a
 *          date property and the caller should write it as before
 */
export function setDateValue(
  component: ICAL.Component,
  name: string,
  raw: string,
  floatingTime: FloatingTime = 'keep',
  absoluteTime: AbsoluteTime = 'as-given',
): boolean {
  const shape = dateProperty(component, name);
  if (!shape) {
    return false;
  }

  const upper = name.toUpperCase();
  const lower = name.toLowerCase();
  let parsed: ParsedValue[];
  try {
    // a trailing or doubled comma in a list is a typo, not a value
    const parts = shape.multiValue ? raw.split(',').filter((part) => part.trim() !== '') : [raw];
    parsed = (parts.length ? parts : [raw]).map(parseDateValue);
  } catch (error) {
    throw wrapped(error, `${upper}: ${(error as Error).message}`, { property: upper });
  }

  if (new Set(parsed.map((p) => p.kind === 'date')).size > 1) {
    throw refuse('VALUE_TYPE_MISMATCH', `${upper} mixes dates and date-times; all values must be one or the other`, upper);
  }
  const isDate = parsed[0].kind === 'date';
  if (isDate && !shape.allowedTypes.includes('date')) {
    throw refuse('VALUE_TYPE_MISMATCH', `${upper} needs a date-time, not a date. Accepted forms: ${DATE_TIME_FORMS}`, upper);
  }

  const existing = component.getFirstProperty(lower);
  const anchor = anchorOf(component, lower);
  // RFC 5545 requires it for DTEND, DUE and RECURRENCE-ID; for EXDATE and
  // RDATE a different type names no occurrence of the series
  const why = ['exdate', 'rdate'].includes(lower)
    ? 'otherwise it names no occurrence of the series'
    : 'RFC 5545 requires the same value type';
  if (anchor?.form === 'date' && !isDate) {
    throw refuse('VALUE_TYPE_MISMATCH', `${upper} must be a date: DTSTART is a date (all-day), and ${why}`, upper);
  }
  if (anchor && anchor.form !== 'date' && isDate) {
    throw refuse('VALUE_TYPE_MISMATCH', `${upper} needs a time: DTSTART has one, and ${why}`, upper);
  }

  // The zone a wall-clock value is read in: the property's own TZID, else
  // DTSTART's. UTC-only properties never take one.
  const own = existing?.getParameter('tzid');
  const zone = UTC_ONLY.has(lower) ? null
    : typeof own === 'string' && own ? own
    : anchor?.form === 'tzid' ? anchor.tzid
    : null;

  // Under "keep-zone" an instant is written as its wall clock in that zone, so
  // the TZID stays: a series keeps its local time across DST changes
  if (absoluteTime === 'keep-zone' && zone) {
    parsed = parsed.map((p) => p.kind === 'utc' ? wallInZone(component, upper, zone, p) : p);
  }

  const floating = parsed.some((p) => p.kind === 'floating');
  // Where a wall-clock value ends up: in a TZID, floating, or converted to UTC
  const wallClock: 'tzid' | 'floating' | 'utc' | null = !floating ? null
    : zone ? 'tzid'
    : anchor?.form === 'floating' ? 'floating'
    : floatingTime === 'local' ? 'utc'
    : anchor?.form === 'utc' || UTC_ONLY.has(lower) ? null
    : 'floating';

  if (floating && wallClock === null) {
    throw refuse('ZONE_MISMATCH', UTC_ONLY.has(lower)
      ? `${upper} must be in UTC (RFC 5545): give a zone, e.g. "2026-10-26T18:00:00Z"`
      : `${upper} has no zone, and DTSTART is in UTC: give it one, e.g. "2026-10-26T18:00:00Z" or "2026-10-26T14:00:00-04:00"`, upper);
  }
  // One line has one zone: wall-clock values that stay wall-clock (in a
  // TZID, or floating) cannot share it with UTC values
  if (floating && wallClock !== 'utc' && parsed.some((p) => p.kind === 'utc')) {
    throw refuse('ZONE_MISMATCH',
      `${upper} mixes values with and without a zone; give all of them a zone, or none`, upper);
  }

  const tzid = wallClock === 'tzid' ? zone : null;
  const values = parsed.map((p) =>
    p.kind === 'floating' && wallClock === 'utc' ? toUtcJcal(p.local) : p.jcal);

  let type = isDate ? 'date' : 'date-time';
  // vCard 4 REV is a TIMESTAMP; the parsed date-time is exactly that value.
  if (type === 'date-time' && shape.defaultType === 'timestamp') {
    type = 'timestamp';
  }

  let property = existing;
  if (!property) {
    property = new ICAL.Property(lower, component);
    component.addProperty(property);
  }
  if (tzid) {
    property.setParameter('tzid', tzid);
  } else {
    property.removeParameter('tzid');
  }
  // resetType rewrites the jCal type, which decides whether VALUE=DATE is
  // serialized; it also clears the old values
  property.resetType(type);
  if (shape.multiValue) {
    property.setValues(values);
  } else {
    property.setValue(values[0]);
  }
  return true;
}

/*
 * Typed writes for recurrence rules (RRULE, and the deprecated EXRULE).
 *
 * Written through updatePropertyWithValue, the rule string becomes the jCal
 * value of a RECUR property, which ical.js serializes character by character
 * ("RRULE:0=F;1=R;2=E;3=Q;4==;..."); a server rejects that. ICAL.Recur on its
 * own is no validator either: it drops unknown parts, a second COUNT, a zero
 * COUNT or INTERVAL without a word, accepts a rule without FREQ, COUNT
 * together with UNTIL, BYSETPOS=0, BYYEARDAY=0, and reads "UNTIL=2026-10-26"
 * as 2025-10-31. So the rule is checked against RFC 5545 3.3.10 here, and
 * ical.js only builds the value from a rule already known to be valid.
 */

const WEEKDAY = '(?:SU|MO|TU|WE|TH|FR|SA)';

/** One comma-separated list of integers in [min, max], signed or not */
function intList(min: number, max: number, signed: boolean) {
  const item = signed ? /^[+-]?\d{1,3}$/ : /^\d{1,2}$/;
  return (value: string): string | null => {
    for (const v of value.split(',')) {
      const n = Math.abs(Number(v));
      if (!item.test(v) || n < min || n > max) {
        const range = signed ? `${min} to ${max} or -${max} to -${min}` : `${min} to ${max}`;
        return `"${v}" is not in ${range}`;
      }
    }
    return null;
  };
}

/**
 * The rule parts RFC 5545 3.3.10 defines, each with a check of its value that
 * returns what is wrong, or null. UNTIL is checked by parseDateValue.
 */
const RULE_PARTS: Record<string, (value: string) => string | null> = {
  FREQ: (v) => /^(SECONDLY|MINUTELY|HOURLY|DAILY|WEEKLY|MONTHLY|YEARLY)$/.test(v) ? null
    : `"${v}" is not one of SECONDLY, MINUTELY, HOURLY, DAILY, WEEKLY, MONTHLY, YEARLY`,
  UNTIL: () => null,
  COUNT: (v) => /^\d+$/.test(v) && Number(v) >= 1 ? null : `"${v}" is not a positive integer`,
  INTERVAL: (v) => /^\d+$/.test(v) && Number(v) >= 1 ? null : `"${v}" is not a positive integer`,
  BYSECOND: intList(0, 60, false),
  BYMINUTE: intList(0, 59, false),
  BYHOUR: intList(0, 23, false),
  BYDAY: (value) => {
    for (const v of value.split(',')) {
      const m = new RegExp(`^([+-]?\\d{1,2})?${WEEKDAY}$`).exec(v);
      const n = m?.[1] === undefined ? 1 : Math.abs(Number(m[1]));
      if (!m || n < 1 || n > 53) {
        return `"${v}" is not a weekday (SU, MO, TU, WE, TH, FR, SA), optionally with an ordinal 1 to 53 or -53 to -1 ("1MO", "-1FR")`;
      }
    }
    return null;
  },
  BYMONTHDAY: intList(1, 31, true),
  BYYEARDAY: intList(1, 366, true),
  BYWEEKNO: intList(1, 53, true),
  BYMONTH: intList(1, 12, false),
  BYSETPOS: intList(1, 366, true),
  WKST: (v) => new RegExp(`^${WEEKDAY}$`).test(v) ? null
    : `"${v}" is not a weekday (SU, MO, TU, WE, TH, FR, SA)`,
};

/**
 * Split a rule into its parts and check each against RFC 5545 3.3.10:
 * known names, each at most once, FREQ present, values in range, and the
 * combinations the RFC rules out. Names and values are case-insensitive
 * (RFC 5545 2), so they come back upper-cased.
 *
 * @throws {UpdateFieldsError} saying what is wrong, without the property name
 */
function parseRuleParts(raw: string): Map<string, string> {
  const parts = new Map<string, string>();
  // an empty part (";;", a trailing ";") is a typo, not a part
  for (const part of raw.trim().split(';').filter((p) => p.trim() !== '')) {
    const eq = part.indexOf('=');
    const name = (eq < 0 ? part : part.slice(0, eq)).trim().toUpperCase();
    const value = eq < 0 ? '' : part.slice(eq + 1).trim().toUpperCase();
    const check = RULE_PARTS[name];
    if (!check) {
      if (name === 'RSCALE' || name === 'SKIP') {
        throw refuse('UNKNOWN_RULE_PART', 'RSCALE/SKIP (RFC 7529) are not supported: ical.js cannot write them without losing them');
      }
      const colon = name.indexOf(':');
      if (colon >= 0) {
        // "RRULE:FREQ=DAILY": the property line, not the value
        throw refuse('UNKNOWN_RULE_PART', `"${part.trim()}" is not a rule part: drop the "${name.slice(0, colon + 1)}" ` +
          `prefix and give only the rule, e.g. "${part.trim().slice(colon + 1)}"`);
      }
      throw refuse('UNKNOWN_RULE_PART', `"${part.trim()}" is not a rule part. ` +
        `RFC 5545 defines ${Object.keys(RULE_PARTS).join(', ')} (e.g. "FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10")`);
    }
    if (parts.has(name)) {
      throw refuse('DUPLICATE_RULE_PART', `${name} is given twice; each rule part may occur once`);
    }
    if (value === '') {
      throw refuse('INVALID_RULE', `${name} has no value`);
    }
    const wrong = check(value);
    if (wrong) {
      throw refuse('INVALID_RULE', `${name}: ${wrong}`);
    }
    parts.set(name, value);
  }

  const freq = parts.get('FREQ');
  if (!freq) {
    throw refuse('INVALID_RULE', 'FREQ is missing; every rule needs one (e.g. "FREQ=DAILY;COUNT=5")');
  }
  if (parts.has('COUNT') && parts.has('UNTIL')) {
    throw refuse('INVALID_RULE', 'COUNT and UNTIL cannot both be given (RFC 5545 3.3.10); use one of them');
  }
  if (parts.has('BYWEEKNO') && freq !== 'YEARLY') {
    throw refuse('INVALID_RULE', 'BYWEEKNO is only allowed with FREQ=YEARLY (RFC 5545 3.3.10)');
  }
  if (parts.has('BYYEARDAY') && ['DAILY', 'WEEKLY', 'MONTHLY'].includes(freq)) {
    throw refuse('INVALID_RULE', `BYYEARDAY is not allowed with FREQ=${freq} (RFC 5545 3.3.10)`);
  }
  if (parts.has('BYMONTHDAY') && freq === 'WEEKLY') {
    throw refuse('INVALID_RULE', 'BYMONTHDAY is not allowed with FREQ=WEEKLY (RFC 5545 3.3.10)');
  }
  const ordinalDay = (parts.get('BYDAY') ?? '').split(',').some((d) => /\d/.test(d));
  if (ordinalDay && (!['MONTHLY', 'YEARLY'].includes(freq) || parts.has('BYWEEKNO'))) {
    throw refuse('INVALID_RULE', 'BYDAY with an ordinal ("1MO", "-1FR") is only allowed with FREQ=MONTHLY or ' +
      'FREQ=YEARLY, and not together with BYWEEKNO (RFC 5545 3.3.10)');
  }
  // Within a month a weekday occurs at most five times (RFC 5545 3.3.10:
  // MONTHLY, or YEARLY with BYMONTH); ical.js refuses "6MO" only when it expands
  const tooFar = (parts.get('BYDAY') ?? '').split(',')
    .find((d) => Math.abs(Number(/^([+-]?\d+)/.exec(d)?.[1] ?? 0)) > 5);
  if (tooFar && (freq === 'MONTHLY' || parts.has('BYMONTH'))) {
    throw refuse('INVALID_RULE', `BYDAY: "${tooFar}" counts past the fifth weekday of a month; within a month the ordinal is ` +
      '1 to 5 or -5 to -1 (RFC 5545 3.3.10)');
  }
  if (parts.has('BYSETPOS') && ![...parts.keys()].some((k) => k.startsWith('BY') && k !== 'BYSETPOS')) {
    throw refuse('INVALID_RULE', 'BYSETPOS needs another BYxxx part to select from (RFC 5545 3.3.10)');
  }
  return parts;
}


/**
 * UNTIL in the form RFC 5545 3.3.10 ties to DTSTART: a DATE next to an
 * all-day DTSTART, local time next to a floating one, and UTC next to a UTC
 * DTSTART or one with a TZID. The value takes the same input forms as every
 * date property (parseDateValue) and is moved into that form where the
 * instant allows it:
 *
 *  - a time without a zone next to a TZID DTSTART is wall clock in that zone
 *    and is converted to UTC with the zone's rules (see zoneOf). For a zone
 *    with neither a VTIMEZONE nor an IANA name the rules are unknown, so it
 *    throws and asks for a UTC or offset value rather than guess an offset
 *    that may be hours off;
 *  - next to a UTC DTSTART a time without a zone follows floatingTime as for
 *    DTEND: refused under "keep", host-local converted to UTC under "local";
 *  - a value with a zone next to a floating DTSTART names an instant that a
 *    floating series has no fixed place for, so it is refused;
 *  - a date where a date-time is needed, or the other way round, is refused.
 *
 * With nothing to anchor it (no DTSTART) UNTIL is written in the form given,
 * a zoneless time following floatingTime like any unanchored date-time.
 */
function untilTime(
  component: ICAL.Component,
  ruleName: string,
  raw: string,
  floatingTime: FloatingTime,
): ICAL.Time {
  let parsed: DateValue;
  try {
    parsed = parseDateValue(raw);
  } catch (error) {
    throw wrapped(error, `${ruleName} UNTIL: ${(error as Error).message}`, { property: ruleName });
  }
  const anchor = anchorOf(component, ruleName.toLowerCase());
  const fail = (code: UpdateFieldsErrorCode, why: string) =>
    refuse(code, `${ruleName} UNTIL ${why}`, ruleName);

  if (anchor?.form === 'date' && parsed.kind !== 'date') {
    throw fail('VALUE_TYPE_MISMATCH', 'must be a date: DTSTART is a date (all-day), and RFC 5545 3.3.10 requires the same type, e.g. "2026-10-26"');
  }
  if (anchor && anchor.form !== 'date' && parsed.kind === 'date') {
    throw fail('VALUE_TYPE_MISMATCH', 'needs a time: DTSTART has one, and RFC 5545 3.3.10 requires the same type');
  }
  if (anchor?.form === 'floating' && parsed.kind === 'utc') {
    throw fail('ZONE_MISMATCH', 'must be a local time without a zone, like the floating DTSTART (RFC 5545 3.3.10), e.g. "2026-10-26T18:00:00"');
  }

  if (parsed.kind === 'floating') {
    if (anchor?.form === 'tzid') {
      const zone = zoneOf(component, anchor.tzid);
      if (!zone) {
        throw fail('UNKNOWN_TZID', `has no zone, and DTSTART's zone "${anchor.tzid}" has no VTIMEZONE in the document and is no ` +
          'IANA time zone to convert it to UTC with (RFC 5545 3.3.10 requires UTC here): give it a zone, ' +
          'e.g. "2026-10-26T18:00:00Z" or "2026-10-26T18:00:00+01:00"');
      }
      const wall = ICAL.Time.fromDateTimeString(parsed.jcal);
      const utc = fieldsOf(zone.toUtc(wallOf(wall.year, wall.month, wall.day, wall.hour, wall.minute, wall.second)));
      return ICAL.Time.fromData(utc, ICAL.Timezone.utcTimezone);
    }
    if (anchor?.form === 'floating') {
      return ICAL.Time.fromDateTimeString(parsed.jcal);
    }
    if (floatingTime === 'local') {
      return ICAL.Time.fromDateTimeString(toUtcJcal(parsed.local));
    }
    if (anchor?.form === 'utc') {
      throw fail('ZONE_MISMATCH', 'has no zone, and DTSTART is in UTC: give it one, e.g. "2026-10-26T18:00:00Z" or "2026-10-26T14:00:00-04:00"');
    }
    return ICAL.Time.fromDateTimeString(parsed.jcal);
  }
  return parsed.kind === 'date'
    ? ICAL.Time.fromDateString(parsed.jcal)
    : ICAL.Time.fromDateTimeString(parsed.jcal);
}

/** Whether a property is RECUR-typed in the component's design set */
export function isRecurProperty(component: ICAL.Component, name: string): boolean {
  return (designSetFor(component).property as Record<string, any>)[name.toLowerCase()]?.defaultType === 'recur';
}

/**
 * Write a recurrence rule property (RECUR-typed in the design set: RRULE,
 * EXRULE) from a caller-supplied rule string such as "FREQ=DAILY;COUNT=5".
 *
 * The rule is checked against RFC 5545 3.3.10 (see parseRuleParts), UNTIL is
 * brought into the form DTSTART requires (see untilTime), and the result is
 * written as a typed ICAL.Recur on the first occurrence of the property,
 * creating it when missing.
 *
 * @returns true when the property was handled here, false when it is not
 *          RECUR-typed and the caller should write it as before
 * @throws {UpdateFieldsError} naming the property and what is wrong with the rule
 */
export function setRecurValue(
  component: ICAL.Component,
  name: string,
  raw: string,
  floatingTime: FloatingTime = 'keep',
): boolean {
  const lower = name.toLowerCase();
  if (!isRecurProperty(component, lower)) {
    return false;
  }

  const upper = name.toUpperCase();
  let parts: Map<string, string>;
  try {
    parts = parseRuleParts(raw);
  } catch (error) {
    throw wrapped(error, `${upper}: ${(error as Error).message}`, { property: upper });
  }

  const until = parts.get('UNTIL');
  parts.delete('UNTIL');
  const recur = ICAL.Recur.fromString([...parts].map(([k, v]) => `${k}=${v}`).join(';'));
  if (until !== undefined) {
    recur.until = untilTime(component, upper, until, floatingTime);
  }

  let property = component.getFirstProperty(lower);
  if (!property) {
    property = new ICAL.Property(lower, component);
    component.addProperty(property);
  }
  property.resetType('recur');
  property.setValue(recur);
  return true;
}
