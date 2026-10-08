/**
 * Why updateFields (or seriesMaster, or parseDateValue) refused a call.
 *
 * Every code names a mistake in what the caller gave — the arguments, the
 * object, or a write the object cannot take as asked — so a consumer can tell
 * a refusal it should hand back to its own caller from a failure of the
 * library, and branch on it without matching message texts. The codes are
 * stable; the messages explain and may be reworded.
 *
 * See "Errors" in the README for when each code occurs.
 */
export const UPDATE_FIELDS_ERROR_CODES = [
  /** calendarObject is neither an iCalendar string nor an object with a "data" string */
  'INVALID_INPUT',
  /** the iCalendar or vCard text does not parse */
  'INVALID_ICALENDAR',
  /** options.type (or seriesMaster's type) is not "vevent", "vtodo" or "vjournal" */
  'INVALID_TYPE',
  /** options.floatingTime is not "keep" or "local" */
  'INVALID_FLOATING_TIME',
  /** options.absoluteTime is not "as-given" or "keep-zone" */
  'INVALID_ABSOLUTE_TIME',
  /** the object holds no component of the type asked for (or is a vCard) */
  'COMPONENT_NOT_FOUND',
  /** several instances with RECURRENCE-ID and no master: which one is meant cannot be told */
  'NO_MASTER',
  /** a date or date-time value does not parse, or names no real date, time or offset */
  'INVALID_VALUE',
  /** a date where a date-time is needed, or the other way round */
  'VALUE_TYPE_MISMATCH',
  /** a value lacks the zone it needs, has one it must not have, or mixes both */
  'ZONE_MISMATCH',
  /** a TZID whose rules are needed has no VTIMEZONE in the object and is no IANA zone */
  'UNKNOWN_TZID',
  /** a VTIMEZONE in the object repeats in a way no time zone does, so it is not read */
  'UNSUPPORTED_VTIMEZONE',
  /** a rule given has a part RFC 5545 3.3.10 does not define (or RSCALE/SKIP, or an "RRULE:" prefix) */
  'UNKNOWN_RULE_PART',
  /** a rule given names a part twice */
  'DUPLICATE_RULE_PART',
  /** a rule given is otherwise invalid: a bad value, no FREQ, a combination RFC 5545 rules out */
  'INVALID_RULE',
  /** RECURRENCE-ID written on the series master */
  'RECURRENCE_ID_ON_MASTER',
  /** a DTSTART move the series (its rule, UNTIL, EXDATE, RDATE or overrides) cannot follow exactly */
  'SERIES_MOVE_REFUSED',
  /** a new RRULE or RDATE leaves an override or EXDATE naming no occurrence */
  'ORPHANS_OVERRIDES',
  /** a value sits at a DST change, where the wall clock does not name one instant */
  'DST_AMBIGUOUS',
  /** the series is too sparse, or what has to be checked too far ahead, to check within the work limit */
  'CHECK_LIMIT_EXCEEDED',
  /** whether the overrides and EXDATEs still name occurrences cannot be checked at all */
  'SERIES_UNVERIFIABLE',
] as const;

/** A stable reason for a refusal; see UPDATE_FIELDS_ERROR_CODES */
export type UpdateFieldsErrorCode = typeof UPDATE_FIELDS_ERROR_CODES[number];

export interface UpdateFieldsErrorDetails {
  /** the property the refusal is about, upper-cased ("DTEND", "RRULE") */
  property?: string;
  /**
   * A value that would be accepted instead, where the library can tell: for
   * SERIES_MOVE_REFUSED the rule to give with the new start ("FREQ=WEEKLY;BYDAY=TU")
   */
  suggestion?: string;
}

/**
 * A refusal of updateFields, seriesMaster or parseDateValue: the call asked
 * for something the object cannot take, and nothing was written. Anything else
 * thrown is a plain Error and a failure of the library.
 */
export class UpdateFieldsError extends Error {
  readonly code: UpdateFieldsErrorCode;
  readonly property?: string;
  readonly suggestion?: string;

  constructor(code: UpdateFieldsErrorCode, message: string, details: UpdateFieldsErrorDetails = {}) {
    super(message);
    this.name = 'UpdateFieldsError';
    this.code = code;
    if (details.property !== undefined) {
      this.property = details.property;
    }
    if (details.suggestion !== undefined) {
      this.suggestion = details.suggestion;
    }
  }
}

/**
 * Whether an error is an UpdateFieldsError, optionally with one code. Checked
 * by name and code rather than instanceof, so it also holds when the ESM and
 * the CommonJS build of this package are both loaded.
 */
export function isUpdateFieldsError(error: unknown, code?: UpdateFieldsErrorCode): error is UpdateFieldsError {
  if (!(error instanceof Error) || error.name !== 'UpdateFieldsError') {
    return false;
  }
  const actual = (error as { code?: unknown }).code;
  return (UPDATE_FIELDS_ERROR_CODES as readonly unknown[]).includes(actual) && (code === undefined || actual === code);
}

/**
 * The error to throw when a caught failure is reported with a new message: a
 * refusal keeps its code (the reason did not change, only the message grew),
 * anything else becomes `fallback`, or stays a plain Error when there is none.
 */
export function wrapped(error: unknown, fallback: UpdateFieldsErrorCode | null, message: string,
  details: UpdateFieldsErrorDetails = {}): Error {
  const code = error instanceof UpdateFieldsError ? error.code : fallback;
  return code ? new UpdateFieldsError(code, message, details) : new Error(message);
}
