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
 * The lists of dates, which an object may spread over several lines: a write
 * replaces, adds to or removes from them (see ListMode).
 */
export type DateListProperty = 'EXDATE' | 'RDATE';

/**
 * What a write does with a list of dates (EXDATE, RDATE), matching values by
 * instant (by date in an all-day series), whatever zone each is written in:
 * - "replace": the values given are the whole list (default). Values already
 *   there and among them stay as written; the others go
 * - "add": the values join the list; one already there is not written twice
 * - "remove": the values leave the list; one the list does not hold is refused
 */
export type ListMode = 'replace' | 'add' | 'remove';

export interface UpdateFieldsOptions {
  floatingTime?: FloatingTime;
  /**
   * How a date-time with a zone is written where a TZID applies: as UTC
   * ("as-given", the default) or converted into that TZID ("keep-zone").
   */
  absoluteTime?: AbsoluteTime;
  /**
   * An IANA time zone ("Europe/Berlin") to write the call's date-times in:
   * a value with Z or an offset becomes its wall-clock time there, one without
   * a zone is read as wall clock there, and both are written with that TZID;
   * the VCALENDAR gets a VTIMEZONE for it if it has none. Replaces
   * floatingTime and absoluteTime ("keep-zone" may be given, it agrees). See
   * "Writing in a named zone" in the README.
   */
  zone?: string;
  /**
   * The component type to write into. Without it the first type present is
   * taken, VEVENT before VTODO before VJOURNAL (see seriesMaster).
   */
  type?: ComponentType;
  /**
   * The mode for each list of dates the call writes ("replace" when not
   * named; see ListMode), e.g. { EXDATE: 'add' }. An EXDATE added has to name
   * an occurrence of the series (UNMATCHED_EXDATE); a value removed has to be
   * in the list (NOT_IN_LIST). Names are case-insensitive. To cancel or
   * restore occurrences, cancelOccurrences and restoreOccurrences say it
   * more directly.
   */
  lists?: Partial<Record<DateListProperty, ListMode>>;
}
