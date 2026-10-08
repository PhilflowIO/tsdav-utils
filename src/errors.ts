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
const CODES = [
  /** an argument has the wrong type: calendarObject, fields, options (or options.zone), or several top-level components */
  'INVALID_INPUT',
  /** the iCalendar or vCard text does not parse */
  'INVALID_ICALENDAR',
  /** options.type (or seriesMaster's type) is not "vevent", "vtodo" or "vjournal" */
  'INVALID_TYPE',
  /** options.floatingTime is not "keep" or "local", or is given together with options.zone */
  'INVALID_FLOATING_TIME',
  /** options.absoluteTime is not "as-given" or "keep-zone", or is "as-given" together with options.zone */
  'INVALID_ABSOLUTE_TIME',
  /** the VCALENDAR holds no component of the type asked for */
  'COMPONENT_NOT_FOUND',
  /** the object is not what the type asks for: a vCard, or a bare component of another type */
  'WRONG_OBJECT_KIND',
  /** several instances with RECURRENCE-ID and no master: which one is meant cannot be told */
  'NO_MASTER',
  /** a date or date-time value does not parse, names no real date, time or offset, or is no string */
  'INVALID_VALUE',
  /** a date where a date-time is needed, or the other way round */
  'VALUE_TYPE_MISMATCH',
  /** a value lacks the zone it needs, has one it must not have, mixes both, or follows a DTSTART in another zone than options.zone */
  'ZONE_MISMATCH',
  /** a TZID whose rules are needed (or options.zone) has no VTIMEZONE in the object and is no IANA zone */
  'UNKNOWN_TZID',
  /** a VTIMEZONE in the object repeats in a way no time zone does, so it is not read; or none can be generated for options.zone at the dates given (local mean time) */
  'UNSUPPORTED_VTIMEZONE',
  /** a rule given has a part RFC 5545 3.3.10 does not define (or RSCALE/SKIP, or an "RRULE:" prefix) */
  'UNKNOWN_RULE_PART',
  /** a rule given names a part twice */
  'DUPLICATE_RULE_PART',
  /** a rule is otherwise invalid: a bad value, no FREQ, a combination RFC 5545 rules out, or unreadable in the object */
  'INVALID_RULE',
  /** RECURRENCE-ID written on the series master */
  'RECURRENCE_ID_ON_MASTER',
  /** a DTSTART move the series (its rule, UNTIL, EXDATE, RDATE or overrides) cannot follow exactly */
  'SERIES_MOVE_REFUSED',
  /** a new RRULE or RDATE leaves an override or EXDATE naming no occurrence */
  'ORPHANED_EXCEPTIONS',
  /** a value sits at a DST change, where the wall clock does not name one instant */
  'DST_AMBIGUOUS',
  /** the series is too sparse, or what has to be checked too far ahead, to check within the work limit */
  'CHECK_LIMIT_EXCEEDED',
  /** whether the overrides and EXDATEs still name occurrences cannot be checked: the series has no DTSTART */
  'SERIES_UNVERIFIABLE',
] as const;

/** Every code, frozen */
export const UPDATE_FIELDS_ERROR_CODES: typeof CODES = Object.freeze(CODES);

/** A stable reason for a refusal; see UPDATE_FIELDS_ERROR_CODES */
export type UpdateFieldsErrorCode = typeof CODES[number];

/**
 * What the caller can do about a refusal, as the message says it:
 * - "fix-value": a value or option given is malformed or does not fit; correct it
 * - "same-call": give the named properties (RRULE, UNTIL, EXDATE, RDATE, ...)
 *   in the same updateFields call
 * - "rewrite-object": the change cannot be made as field writes (or the object
 *   itself is broken); replace the whole iCalendar object
 * - "none": nothing in this call helps (a vCard handed to an iCalendar write)
 */
export type UpdateFieldsRemedy = 'fix-value' | 'same-call' | 'rewrite-object' | 'none';

export interface UpdateFieldsErrorDetails {
  /** what the caller can do; see UpdateFieldsRemedy */
  remedy: UpdateFieldsRemedy;
  /** the property the refusal is about, upper-cased ("DTEND", "RRULE") */
  property?: string;
  /**
   * A value that would be accepted instead, where the library can tell: for
   * SERIES_MOVE_REFUSED the rule to give with the new start ("FREQ=WEEKLY;BYDAY=TU")
   */
  suggestion?: string;
  /** the refusal this one reports with a longer message */
  cause?: unknown;
}

/**
 * A refusal of updateFields, seriesMaster or parseDateValue: the call asked
 * for something the object cannot take, and nothing was written. Anything else
 * thrown is a plain Error and a failure of the library.
 */
export class UpdateFieldsError extends Error {
  readonly code: UpdateFieldsErrorCode;
  readonly remedy: UpdateFieldsRemedy;
  readonly property?: string;
  readonly suggestion?: string;
  readonly cause?: unknown;

  constructor(code: UpdateFieldsErrorCode, message: string, details: UpdateFieldsErrorDetails) {
    super(message);
    this.name = 'UpdateFieldsError';
    this.code = code;
    this.remedy = details.remedy;
    if (details.property !== undefined) {
      this.property = details.property;
    }
    if (details.suggestion !== undefined) {
      this.suggestion = details.suggestion;
    }
    if (details.cause !== undefined) {
      this.cause = details.cause;
    }
  }

  /**
   * The refusal as plain data, for a log or a response body (JSON.stringify
   * of an Error otherwise drops the message).
   */
  toJSON(): { name: string; code: UpdateFieldsErrorCode; message: string; remedy: UpdateFieldsRemedy;
    property?: string; suggestion?: string } {
    return {
      name: this.name, code: this.code, message: this.message, remedy: this.remedy,
      ...(this.property !== undefined ? { property: this.property } : {}),
      ...(this.suggestion !== undefined ? { suggestion: this.suggestion } : {}),
    };
  }
}

/**
 * Whether an error is an UpdateFieldsError, optionally with one code (and then
 * typed with that code). Checked by name and code rather than instanceof, so it
 * also holds when the ESM and the CommonJS build of this package are both
 * loaded. It needs the error as thrown: a copy made by structuredClone or
 * postMessage keeps only message and stack, not name and code.
 */
export function isUpdateFieldsError<C extends UpdateFieldsErrorCode = UpdateFieldsErrorCode>(
  error: unknown, code?: C): error is UpdateFieldsError & { code: C } {
  if (!(error instanceof Error) || error.name !== 'UpdateFieldsError') {
    return false;
  }
  const actual = (error as { code?: unknown }).code;
  return (CODES as readonly unknown[]).includes(actual) && (code === undefined || actual === code);
}

/**
 * The error to throw when a caught failure is reported with a longer message.
 * A refusal stays one, with its code, and its property and remedy unless the
 * new message names others; it becomes the cause. Anything else is a failure
 * of the library and stays a plain Error, whatever the message around it says.
 */
export function wrapped(error: unknown, message: string,
  details: Partial<Omit<UpdateFieldsErrorDetails, 'cause'>> = {}): Error {
  if (error instanceof UpdateFieldsError) {
    return new UpdateFieldsError(error.code, message, {
      remedy: details.remedy ?? error.remedy,
      property: details.property ?? error.property,
      suggestion: details.suggestion ?? error.suggestion,
      cause: error,
    });
  }
  const plain = new Error(message);
  (plain as { cause?: unknown }).cause = error;
  return plain;
}
