import ICAL from 'ical.js';
import type { FloatingTime } from './types';

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

const ACCEPTED_FORMS =
  'Accepted forms: "2026-10-26T18:00:00Z", "2026-10-26T14:00:00-04:00", ' +
  '"20261026T180000Z", "2026-10-26T18:00:00" (no zone), or a date "2026-10-26" / "20261026"';

interface ParsedValue {
  type: 'date-time' | 'date';
  /** jCal value: "YYYY-MM-DD", "YYYY-MM-DDTHH:MM:SS" or the same with "Z" */
  jcal: string;
  floating: boolean;
}

const DATE_EXTENDED = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_BASIC = /^(\d{4})(\d{2})(\d{2})$/;
const DATE_TIME_EXTENDED =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i;
const DATE_TIME_BASIC = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/i;

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/**
 * Check the fields actually name a calendar date and a wall-clock time.
 * Date.UTC would otherwise roll "2026-02-30" over into March without a word.
 */
function assertRealDateTime(raw: string, y: number, mo: number, d: number, h = 0, mi = 0, s = 0) {
  // seconds are checked on their own: a leap second (60) would roll the
  // probe over into the next day on the last second of a month
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi, 0));
  if (
    t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d ||
    h > 23 || mi > 59 || s > 60
  ) {
    throw new Error(`"${raw}" is not a valid date or time`);
  }
}

function toUtcJcal(date: Date): string {
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}Z`;
}

/**
 * Parse one date or date-time value as a caller would write it.
 *
 * A zoned value is converted to UTC: the instant is what matters, and UTC is
 * the only zone that needs no VTIMEZONE. A value without a zone is floating
 * (RFC 5545 3.3.5 form #1) unless floatingTime is "local", in which case it is
 * read in the host timezone and written as UTC.
 */
export function parseDateValue(raw: string, floatingTime: FloatingTime = 'keep'): ParsedValue {
  const value = raw.trim();
  let m: RegExpExecArray | null;

  if ((m = DATE_EXTENDED.exec(value)) || (m = DATE_BASIC.exec(value))) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    assertRealDateTime(raw, y, mo, d);
    return { type: 'date', jcal: `${m[1]}-${m[2]}-${m[3]}`, floating: false };
  }

  m = DATE_TIME_EXTENDED.exec(value) || DATE_TIME_BASIC.exec(value);
  if (!m) {
    throw new Error(`"${raw}" is not a date or date-time. ${ACCEPTED_FORMS}`);
  }

  const [y, mo, d, h, mi] = [1, 2, 3, 4, 5].map((i) => Number(m![i]));
  const s = Number(m[6] ?? 0);
  const zone = m[7];
  assertRealDateTime(raw, y, mo, d, h, mi, s);

  if (zone) {
    // UTC instant of the wall-clock fields, then shift by the offset. Leap
    // seconds are clamped the way RFC 5545 3.3.5 allows ("60" -> next second).
    let ms = Date.UTC(y, mo - 1, d, h, mi, s);
    if (zone.toUpperCase() !== 'Z') {
      const sign = zone[0] === '-' ? -1 : 1;
      const digits = zone.slice(1).replace(':', '');
      const offsetMinutes = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4));
      if (Number(digits.slice(0, 2)) > 23 || Number(digits.slice(2, 4)) > 59) {
        throw new Error(`"${raw}" has an invalid UTC offset`);
      }
      ms -= sign * offsetMinutes * 60000;
    }
    return { type: 'date-time', jcal: toUtcJcal(new Date(ms)), floating: false };
  }

  if (floatingTime === 'local') {
    return { type: 'date-time', jcal: toUtcJcal(new Date(y, mo - 1, d, h, mi, s)), floating: false };
  }
  return {
    type: 'date-time',
    jcal: `${pad(y, 4)}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}`,
    floating: true,
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
export function dateProperty(component: ICAL.Component, name: string): DateProperty | null {
  const design = (designSetFor(component).property as Record<string, any>)[name.toLowerCase()];
  if (!design || !TYPED.has(design.defaultType)) {
    return null;
  }
  return {
    defaultType: design.defaultType,
    allowedTypes: design.allowedTypes ?? [design.defaultType],
    multiValue: Boolean(design.multiValue),
  };
}

/**
 * Write a date or date-time property from a caller-supplied string.
 *
 * Updates the first occurrence (creating it when missing), which is the same
 * occurrence updatePropertyWithValue would touch, so only the encoding changes
 * and not which line is written. Parameters other than TZID survive: RANGE on
 * RECURRENCE-ID or an X- parameter still means what it meant.
 *
 * @returns true when the property was handled here, false when it is not a
 *          date property and the caller should write it as before
 */
export function setDateValue(
  component: ICAL.Component,
  name: string,
  raw: string,
  floatingTime: FloatingTime = 'keep',
): boolean {
  const shape = dateProperty(component, name);
  if (!shape) {
    return false;
  }

  const lower = name.toLowerCase();
  const parts = shape.multiValue ? raw.split(',') : [raw];
  const parsed = parts.map((part) => parseDateValue(part, floatingTime));

  const kinds = new Set(parsed.map((p) => p.type));
  if (kinds.size > 1) {
    throw new Error(`${name.toUpperCase()} mixes dates and date-times; all values must be one or the other`);
  }
  let type: string = parsed[0].type;

  if (type === 'date' && !shape.allowedTypes.includes('date')) {
    throw new Error(`${name.toUpperCase()} needs a date-time, not a date. ${ACCEPTED_FORMS}`);
  }
  if (UTC_ONLY.has(lower) && parsed.some((p) => p.floating)) {
    throw new Error(`${name.toUpperCase()} must be in UTC (RFC 5545): give a zone, e.g. "2026-10-26T18:00:00Z"`);
  }
  // vCard 4 REV is a TIMESTAMP; the parsed date-time is exactly that value.
  if (type === 'date-time' && shape.defaultType === 'timestamp') {
    type = 'timestamp';
  }

  let property = component.getFirstProperty(lower);
  if (!property) {
    property = new ICAL.Property(lower, component);
    component.addProperty(property);
  }
  // A UTC or floating value carries no TZID (RFC 5545 3.2.19), and a DATE
  // carries none either. resetType rewrites the jCal type, which is what
  // decides whether VALUE=DATE is serialized.
  property.removeParameter('tzid');
  property.resetType(type);
  if (shape.multiValue) {
    property.setValues(parsed.map((p) => p.jcal));
  } else {
    property.setValue(parsed[0].jcal);
  }
  return true;
}
