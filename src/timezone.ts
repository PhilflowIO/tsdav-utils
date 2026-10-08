import ICAL from 'ical.js';
import { UpdateFieldsError } from './errors';
import { parseDateValue } from './typedValue';
import { fieldsOf, ianaZone, ianaZoneName, vtimezoneIn, vtimezoneZone, wallOf } from './zone';
import type { Zone } from './zone';

/*
 * Time zone conversion for consumers: the conversion updateFields itself uses,
 * which reads a VTIMEZONE from its own transitions in UTC (ical.js 2.2's
 * convertToZone is up to an hour off near DST changes, ical.js#847) and maps a
 * wall clock to UTC as RFC 5545 3.3.5 does at a DST change.
 */

/** A wall-clock time without zone, as "YYYY-MM-DDTHH:MM:SS" */
export type WallTime = string;

/** Conversions between UTC and the wall clock of one zone */
export interface ZoneConverter {
  /** the TZID */
  readonly tzid: string;
  /** where the rules come from: the object's VTIMEZONE, or the runtime's IANA data */
  readonly source: 'vtimezone' | 'iana';
  /** the zone's UTC offset at an instant, in seconds east of UTC */
  offsetAt(instant: Date | string): number;
  /** the wall-clock time of an instant in the zone */
  toWallTime(instant: Date | string): WallTime;
  /**
   * The instant of a wall-clock time, as RFC 5545 3.3.5 reads it: a time a DST
   * change shows twice is its first occurrence, one it skips is read with the
   * offset before the change (02:30 in a 02:00-03:00 gap is 03:30)
   */
  toInstant(wallTime: WallTime): Date;
  /** whether a DST change skips the wall-clock time ("gap") or shows it twice ("overlap") */
  ambiguity(wallTime: WallTime): 'gap' | 'overlap' | null;
}

/** Anything that holds the object: its text, or any ICAL.Component of it */
export type ZoneSource = string | ICAL.Component;

const invalid = (message: string) => new UpdateFieldsError('INVALID_VALUE', message, { remedy: 'fix-value' });

/** An instant in seconds, from a Date or a string with Z or an offset */
function instantOf(instant: Date | string): number {
  if (instant instanceof Date) {
    if (Number.isNaN(instant.getTime())) {
      throw invalid('the instant is an invalid Date');
    }
    return Math.floor(instant.getTime() / 1000);
  }
  const value = parseDateValue(instant);
  if (value.kind !== 'utc') {
    throw invalid(`"${instant}" names no instant: give it with Z or an offset, e.g. "2026-10-26T18:00:00Z"`);
  }
  // the fields of a UTC value read as a naive wall clock are its instant
  const [y, mo, d, h, mi, sec] = value.jcal.match(/\d+/g)!.map(Number);
  return wallOf(y, mo, d, h, mi, sec);
}

/** A wall clock in naive seconds, from "YYYY-MM-DDTHH:MM:SS" (or the basic form, seconds optional) */
function wallOfText(wallTime: WallTime): number {
  const value = parseDateValue(wallTime);
  if (value.kind !== 'floating') {
    throw invalid(`"${wallTime}" is no wall-clock time: give it without a zone, e.g. "2026-10-26T18:00:00"`);
  }
  const [y, mo, d, h, mi, s] = value.jcal.match(/\d+/g)!.map(Number);
  return wallOf(y, mo, d, h, mi, s);
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');
const wallText = (wall: number): WallTime => {
  const f = fieldsOf(wall);
  return `${pad(f.year, 4)}-${pad(f.month)}-${pad(f.day)}T${pad(f.hour)}:${pad(f.minute)}:${pad(f.second)}`;
};

/**
 * The object as this module's own ical.js reads it: a text is parsed, a
 * component (possibly from another copy of ical.js) is read through its jCal.
 */
function rootOf(source: ZoneSource): ICAL.Component {
  if (typeof source === 'string') {
    try {
      return new ICAL.Component(ICAL.parse(source));
    } catch (error) {
      throw new UpdateFieldsError('INVALID_ICALENDAR', `Failed to parse iCal data: ${(error as Error).message}`,
        { remedy: 'rewrite-object', cause: error });
    }
  }
  let root = source;
  while (root.parent) {
    root = root.parent;
  }
  return new ICAL.Component(root.toJSON());
}

function converter(tzid: string, zone: Zone, source: 'vtimezone' | 'iana'): ZoneConverter {
  return {
    tzid, source,
    offsetAt: (instant) => zone.offsetAt(instantOf(instant)),
    toWallTime: (instant) => wallText(zone.fromUtc(instantOf(instant))),
    toInstant: (wallTime) => new Date(zone.toUtc(wallOfText(wallTime)) * 1000),
    ambiguity: (wallTime) => zone.ambiguity(wallOfText(wallTime)),
  };
}

/**
 * The conversions of a TZID: by the object's VTIMEZONE of that TZID when
 * `source` (the object's text, or any component of it, or a VTIMEZONE) has
 * one, else by the IANA zone of that name, whose `tzid` is then spelled as
 * updateFields writes it ("europe/berlin" is "Europe/Berlin"). Null when it
 * is neither.
 *
 * @throws {UpdateFieldsError} INVALID_ICALENDAR for a text that does not parse;
 *   UNSUPPORTED_VTIMEZONE (on a conversion) for a VTIMEZONE whose rules
 *   cannot be read; INVALID_VALUE for an instant or wall-clock time that does
 *   not parse
 */
export function resolveZone(tzid: string, source?: ZoneSource): ZoneConverter | null {
  if (typeof tzid !== 'string' || !tzid) {
    return null;
  }
  if (source !== undefined) {
    const root = rootOf(source);
    const vtimezone = root.name === 'vtimezone'
      ? (root.getFirstPropertyValue('tzid') === tzid ? root : null)
      : vtimezoneIn(root, tzid);
    if (vtimezone) {
      return converter(tzid, vtimezoneZone(vtimezone), 'vtimezone');
    }
  }
  // spelled as updateFields writes it ("europe/berlin" is "Europe/Berlin")
  const name = ianaZoneName(tzid);
  const zone = name ? ianaZone(name) : null;
  return zone ? converter(name!, zone, 'iana') : null;
}

/**
 * The conversions of the zone a date-time property is written in (its TZID),
 * read against the object the property belongs to; null when it has no TZID
 * (UTC, floating, a date) or the TZID is unknown.
 */
export function resolvePropertyZone(property: ICAL.Property): ZoneConverter | null {
  const tzid = property.getParameter('tzid');
  if (typeof tzid !== 'string' || !tzid) {
    return null;
  }
  return resolveZone(tzid, property.parent ?? undefined);
}
