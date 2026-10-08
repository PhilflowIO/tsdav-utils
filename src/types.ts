/**
 * Generic field update map
 * Any iCal property name → any string value
 */
export interface FieldUpdates {
  [key: string]: string;
}

/**
 * Calendar object input (flexible)
 * Accepts tsdav output format or raw iCal string
 */
export type CalendarObjectInput = string | {
  data: string;
  [key: string]: any; // Allow other tsdav properties
};

/**
 * How a date-time without a zone ("2026-10-26T18:00:00") is written.
 * - "keep": as a floating time, which RFC 5545 3.3.5 allows (default)
 * - "local": read in the host timezone and written as UTC
 */
export type FloatingTime = 'keep' | 'local';

/**
 * How a date-time with a zone ("2026-10-06T10:00:00Z", "...+02:00") is
 * written where the property, or the DTSTART it follows, has a TZID.
 * - "as-given": as UTC, dropping the TZID (default)
 * - "keep-zone": as the wall-clock time of that instant in the TZID, which
 *   stays, so a series keeps its local time across DST changes
 */
export type AbsoluteTime = 'as-given' | 'keep-zone';

/**
 * The iCalendar component types a write can be aimed at, in the order
 * updateFields tries them when no type is named.
 */
export const COMPONENT_TYPES = ['vevent', 'vtodo', 'vjournal'] as const;

/**
 * An iCalendar component type a write can be aimed at.
 */
export type ComponentType = typeof COMPONENT_TYPES[number];

/**
 * The properties whose values a write can add to instead of replacing: the
 * lists of dates, which may be spread over several lines.
 */
export type AppendableProperty = 'EXDATE' | 'RDATE';

export interface UpdateFieldsOptions {
  floatingTime?: FloatingTime;
  /**
   * How a date-time with a zone is written where a TZID applies: as UTC
   * ("as-given", the default) or converted into that TZID ("keep-zone").
   */
  absoluteTime?: AbsoluteTime;
  /**
   * The component type to write into. Without it the first type present is
   * taken, VEVENT before VTODO before VJOURNAL (see seriesMaster).
   */
  type?: ComponentType;
  /**
   * EXDATE and RDATE named here are added to: the values given join the ones
   * the object holds, and a value already there (the same instant, or the same
   * date) is not written twice. Without it a write of EXDATE or RDATE gives
   * the complete list and replaces every line of it. An EXDATE added this way
   * has to name an occurrence of the series, or the call is refused
   * (UNMATCHED_EXDATE). Names are case-insensitive.
   */
  append?: readonly AppendableProperty[];
}
