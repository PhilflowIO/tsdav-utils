import ICAL from 'ical.js';

/*
 * Wall clocks and time zones.
 *
 * A wall clock is held as seconds of a naive calendar (the fields read as if
 * they were UTC), so arithmetic on it is plain addition and does not depend
 * on the host timezone.
 */

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

/** Converts between a zone's wall clock and UTC (both as naive seconds) */
export interface Zone {
  toUtc(wall: number): number;
  fromUtc(utc: number): number;
}

/**
 * The VTIMEZONE a TZID refers to, from the document the component is in, or
 * null.
 */
export function timezoneOf(component: ICAL.Component, tzid: string): ICAL.Timezone | null {
  let root = component;
  while (root.parent) {
    root = root.parent;
  }
  const vtimezone = root.getAllSubcomponents('vtimezone')
    .find((tz) => tz.getFirstPropertyValue('tzid') === tzid);
  return vtimezone ? new ICAL.Timezone(vtimezone) : null;
}

function vtimezoneZone(tz: ICAL.Timezone): Zone {
  const convert = (wall: number, from: ICAL.Timezone, to: ICAL.Timezone) => {
    const t = ICAL.Time.fromData(fieldsOf(wall), from).convertToZone(to);
    return wallOf(t.year, t.month, t.day, t.hour, t.minute, t.second);
  };
  return {
    toUtc: (wall) => convert(wall, tz, ICAL.Timezone.utcTimezone),
    fromUtc: (utc) => convert(utc, ICAL.Timezone.utcTimezone, tz),
  };
}

function ianaZone(tzid: string): Zone | null {
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
  const fromUtc = (utc: number) => {
    const parts = Object.fromEntries(format.formatToParts(new Date(utc * 1000)).map((p) => [p.type, p.value]));
    const year = parts.era === 'BC' || parts.era === 'B' ? 1 - Number(parts.year) : Number(parts.year);
    return wallOf(year, Number(parts.month), Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second));
  };
  return {
    fromUtc,
    // The offset at the wall clock read as UTC, then once more at the guess:
    // exact outside a DST change, and in a gap or overlap one of its sides
    toUtc: (wall) => {
      const guess = wall - (fromUtc(wall) - wall);
      return wall - (fromUtc(guess) - guess);
    },
  };
}

/**
 * A TZID's offset rules: the document's VTIMEZONE when it has one (what a
 * server and every other client reads the TZID against), else the IANA zone of
 * that name from the runtime's time zone data (servers often omit the
 * VTIMEZONE of a well-known zone). Null for a name that is neither.
 */
export function zoneOf(component: ICAL.Component, tzid: string): Zone | null {
  const tz = timezoneOf(component, tzid);
  return tz ? vtimezoneZone(tz) : ianaZone(tzid);
}

/** The error for a TZID zoneOf cannot resolve */
export function unknownZone(tzid: string): string {
  return `the zone "${tzid}" has no VTIMEZONE in the document and is no IANA time zone`;
}
