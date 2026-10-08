import ICAL from 'ical.js';
import { UpdateFieldsError } from './errors';

/*
 * Wall clocks and time zones.
 *
 * A wall clock is held as seconds of a naive calendar (the fields read as if
 * they were UTC), so arithmetic on it is plain addition and does not depend
 * on the host timezone.
 */

const DAY = 86400;

/** Seconds of a naive calendar; years 0-99 are not mapped onto 1900-1999 */
export function wallOf(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number {
  const t = new Date(Date.UTC(2000, mo - 1, d, h, mi, s));
  t.setUTCFullYear(y, mo - 1, d);
  return t.getTime() / 1000;
}

/** The calendar fields of a wall clock, in the shape ICAL.Time.fromData takes */
export function fieldsOf(wall: number) {
  const t = new Date(wall * 1000);
  return {
    year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate(),
    hour: t.getUTCHours(), minute: t.getUTCMinutes(), second: t.getUTCSeconds(),
  };
}

const wallOfTime = (t: ICAL.Time) => wallOf(t.year, t.month, t.day, t.hour, t.minute, t.second);

/** Converts between a zone's wall clock and UTC (both as naive seconds) */
export interface Zone {
  /** the zone's UTC offset in seconds at a UTC instant */
  offsetAt(utc: number): number;
  fromUtc(utc: number): number;
  /**
   * The UTC instant of a wall clock, as RFC 5545 3.3.5 reads one a DST change
   * makes ambiguous or nonexistent: an ambiguous time (fall back) is its first
   * occurrence, and a nonexistent one (spring forward) is read with the offset
   * before the gap, so it lands as far past the gap as it was into it
   * (02:30 in a 02:00-03:00 gap is 03:30).
   */
  toUtc(wall: number): number;
  /** whether a DST change skips this wall clock ('gap') or shows it twice ('overlap') */
  ambiguity(wall: number): 'gap' | 'overlap' | null;
  /**
   * The wall clock a DST change skips that toUtc maps onto this instant, or
   * null: in a 02:00-03:00 gap, 01:30Z is 03:30 CEST, but 02:30 (which does
   * not exist) is read as 01:30Z too, so a value given in UTC cannot tell which
   * of the two it names.
   */
  gapAlias(utc: number): number | null;
}

/**
 * A Zone from its offset function; at most one change in any four days is
 * assumed.
 *
 * Local to UTC is done here rather than with ical.js' Time.convertToZone: in
 * ical.js 2.2.1 Timezone.utcOffset resolves an ambiguous fall-back hour to the
 * later instant (`want_daylight = false; // TODO` in lib/ical/timezone.js),
 * where RFC 5545 3.3.5 wants the first. Once a fixed ical.js release is the
 * minimum version, this can go back to convertToZone.
 */
function zoneFrom(offsetAt: (utc: number) => number): Zone {
  /** the UTC instants this zone shows as the wall clock: none in a gap, two in an overlap */
  const fits = (wall: number) => [...new Set([wall - offsetAt(wall - 2 * DAY), wall - offsetAt(wall + 2 * DAY)])]
    .filter((utc) => utc + offsetAt(utc) === wall);
  const toUtc = (wall: number) => {
    const found = fits(wall);
    return found.length ? Math.min(...found) : wall - offsetAt(wall - 2 * DAY);
  };
  return {
    offsetAt,
    fromUtc: (utc) => utc + offsetAt(utc),
    toUtc,
    ambiguity: (wall) => {
      const found = fits(wall).length;
      return found === 0 ? 'gap' : found > 1 ? 'overlap' : null;
    },
    gapAlias: (utc) => {
      // a gap is shorter than four hours in every zone
      const alias = utc + offsetAt(utc - 4 * 3600);
      return alias !== utc + offsetAt(utc) && fits(alias).length === 0 && toUtc(alias) === utc ? alias : null;
    },
  };
}

/** The VTIMEZONE a TZID refers to, from the document the component is in, or null */
function vtimezoneOf(component: ICAL.Component, tzid: string): ICAL.Component | null {
  let root = component;
  while (root.parent) {
    root = root.parent;
  }
  return root.getAllSubcomponents('vtimezone').find((tz) => tz.getFirstPropertyValue('tzid') === tzid) ?? null;
}

/** One change of offset: from `at` (a UTC instant) on, the offset is `to` */
interface Transition {
  at: number;
  from: number;
  to: number;
}

const offsetSeconds = (value: unknown) =>
  value && typeof (value as ICAL.UtcOffset).toSeconds === 'function' ? (value as ICAL.UtcOffset).toSeconds() : 0;

/** Onsets per rule expanded before the expansion of a VTIMEZONE observance stops */
const ONSET_LIMIT = 10000;

/**
 * The transitions of a VTIMEZONE up to a UTC instant, ascending. Each STANDARD
 * or DAYLIGHT observance starts at its DTSTART and at each RDATE and RRULE
 * instance — local times on the clock that runs before it, so the instant is
 * the onset minus TZOFFSETFROM. RRULE's UNTIL is UTC (RFC 5545 3.6.5). Only
 * YEARLY and MONTHLY observance rules are read; any other throws.
 */
function transitionsOf(vtimezone: ICAL.Component, horizon: number): Transition[] {
  const list: Transition[] = [];
  for (const observance of vtimezone.getAllSubcomponents()) {
    if (observance.name !== 'standard' && observance.name !== 'daylight') {
      continue;
    }
    const from = offsetSeconds(observance.getFirstPropertyValue('tzoffsetfrom'));
    const to = offsetSeconds(observance.getFirstPropertyValue('tzoffsetto'));
    const start = observance.getFirstPropertyValue('dtstart') as ICAL.Time | null;
    if (!start) {
      continue;
    }
    const onsets = new Set([wallOfTime(start)]);
    for (const rdate of observance.getAllProperties('rdate')) {
      for (const value of rdate.getValues() as (ICAL.Time | ICAL.Period)[]) {
        const t = value instanceof ICAL.Period ? value.start : value;
        onsets.add(wallOfTime(t));
      }
    }
    for (const property of observance.getAllProperties('rrule')) {
      let recur: ICAL.Recur;
      try {
        recur = (property.getFirstValue() as ICAL.Recur).clone();
      } catch (error) {
        throw new UpdateFieldsError('UNSUPPORTED_VTIMEZONE', `the VTIMEZONE "${vtimezone.getFirstPropertyValue('tzid')}" ` +
          `has an observance rule that cannot be read: ${(error as Error).message}`, { remedy: 'rewrite-object' });
      }
      // Real zones change yearly; ical.js gives up on a YEARLY or MONTHLY rule
      // that matches nothing, but would search a finer one without end
      if (recur.freq !== 'YEARLY' && recur.freq !== 'MONTHLY') {
        throw new UpdateFieldsError('UNSUPPORTED_VTIMEZONE', `the VTIMEZONE "${vtimezone.getFirstPropertyValue('tzid')}" has an observance repeating ` +
          `${recur.freq}, which no time zone does, so it is not read`, { remedy: 'rewrite-object' });
      }
      if (recur.until) {
        const until = wallOfTime(recur.until) + (recur.until.zone === ICAL.Timezone.utcTimezone ? from : 0);
        recur.until = ICAL.Time.fromData({ ...fieldsOf(until), isDate: recur.until.isDate });
      }
      const iterator = recur.iterator(ICAL.Time.fromData(fieldsOf(wallOfTime(start))));
      for (let i = 0; i < ONSET_LIMIT; i++) {
        const next = iterator.next();
        if (!next || wallOfTime(next) - from > horizon) {
          break;
        }
        onsets.add(wallOfTime(next));
      }
    }
    for (const onset of onsets) {
      list.push({ at: onset - from, from, to });
    }
  }
  return list.sort((a, b) => a.at - b.at);
}

const transitionCache = new WeakMap<ICAL.Component, { horizon: number; list: Transition[] }>();

/**
 * A zone from a VTIMEZONE's own observances, read in UTC.
 *
 * UTC to local is done here rather than with ical.js' Time.convertToZone: in
 * ical.js 2.2.1 Timezone.convert_time looks up the offset with the time already
 * in UTC as if it were local, so it is an hour off for |offset| hours around
 * every change (https://github.com/kewisch/ical.js/issues/847). Once a fixed
 * ical.js release is the minimum version, this can go back to convertToZone.
 */
export function vtimezoneZone(vtimezone: ICAL.Component): Zone {
  const transitions = (utc: number) => {
    let cached = transitionCache.get(vtimezone);
    if (!cached || cached.horizon < utc + DAY * 400) {
      const horizon = utc + DAY * 366 * 10;
      cached = { horizon, list: transitionsOf(vtimezone, horizon) };
      transitionCache.set(vtimezone, cached);
    }
    return cached.list;
  };
  return zoneFrom((utc) => {
    const list = transitions(utc);
    if (!list.length) {
      return 0;
    }
    // the last transition at or before the instant; before the first, the
    // offset the first one changes from
    let lo = 0;
    let hi = list.length - 1;
    if (list[0].at > utc) {
      return list[0].from;
    }
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (list[mid].at <= utc) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return list[lo].to;
  });
}

/** A zone from the runtime's IANA time zone data, or null for an unknown name */
export function ianaZone(tzid: string): Zone | null {
  // Intl also takes a UTC offset ("+01:00") as a time zone; that is no TZID
  if (/^[+-]/.test(tzid.trim())) {
    return null;
  }
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: tzid, hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric', era: 'short',
    });
  } catch {
    return null;
  }
  return zoneFrom((utc) => {
    const parts = Object.fromEntries(format.formatToParts(new Date(utc * 1000)).map((p) => [p.type, p.value]));
    const year = parts.era === 'BC' || parts.era === 'B' ? 1 - Number(parts.year) : Number(parts.year);
    return wallOf(year, Number(parts.month), Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second)) - utc;
  });
}

/**
 * A TZID's offset rules: the document's VTIMEZONE when it has one (what a
 * server and every other client reads the TZID against), else the IANA zone of
 * that name from the runtime's time zone data (servers often omit the
 * VTIMEZONE of a well-known zone). Null for a name that is neither.
 *
 * A VTIMEZONE is read from its own transitions, in UTC, not with ical.js'
 * Time.convertToZone, which gets the offset wrong for up to five hours around
 * each change when converting from UTC.
 */
export function zoneOf(component: ICAL.Component, tzid: string): Zone | null {
  const vtimezone = vtimezoneOf(component, tzid);
  return vtimezone ? vtimezoneZone(vtimezone) : ianaZone(tzid);
}

/** The VTIMEZONE a TZID refers to in the document, or null */
export function vtimezoneIn(component: ICAL.Component, tzid: string): ICAL.Component | null {
  return vtimezoneOf(component, tzid);
}

let lowerNames: Map<string, string> | null = null;

/**
 * An IANA zone name as the time zone data spells it, or null when the runtime
 * does not know it. Intl reads names case-insensitively, but other readers of
 * a TZID may not, so "europe/berlin" comes back as "Europe/Berlin". A name is
 * not replaced by the one Intl links it to ("Asia/Kolkata" stays, although
 * some runtimes report it as "Asia/Calcutta"): the caller's name is kept.
 */
export function ianaZoneName(name: string): string | null {
  if (!ianaZone(name)) {
    return null;
  }
  if (!lowerNames) {
    const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
    lowerNames = new Map(supported.map((n) => [n.toLowerCase(), n]));
  }
  const listed = lowerNames.get(name.toLowerCase());
  if (listed) {
    return listed;
  }
  const resolved = new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone;
  return resolved.toLowerCase() === name.toLowerCase() ? resolved : name;
}

/** The error for a TZID zoneOf cannot resolve */
export function unknownZone(tzid: string): string {
  return `the zone "${tzid}" has no VTIMEZONE in the document and is no IANA time zone`;
}
