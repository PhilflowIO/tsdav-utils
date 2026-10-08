import ICAL from 'ical.js';

/**
 * Generic field update map
 * Any iCal property name → any string value
 */
interface FieldUpdates {
    [key: string]: string;
}
/**
 * Calendar object input (flexible)
 * Accepts tsdav output format or raw iCal string
 */
type CalendarObjectInput = string | {
    data: string;
    [key: string]: any;
};
/**
 * How a date-time without a zone ("2026-10-26T18:00:00") is written.
 * - "keep": as a floating time, which RFC 5545 3.3.5 allows (default)
 * - "local": read in the host timezone and written as UTC
 */
type FloatingTime = 'keep' | 'local';
/**
 * How a date-time with a zone ("2026-10-06T10:00:00Z", "...+02:00") is
 * written where the property, or the DTSTART it follows, has a TZID.
 * - "as-given": as UTC, dropping the TZID (default)
 * - "keep-zone": as the wall-clock time of that instant in the TZID, which
 *   stays, so a series keeps its local time across DST changes
 */
type AbsoluteTime = 'as-given' | 'keep-zone';
/**
 * The iCalendar component types a write can be aimed at, in the order
 * updateFields tries them when no type is named.
 */
declare const COMPONENT_TYPES: readonly ["vevent", "vtodo", "vjournal"];
/**
 * An iCalendar component type a write can be aimed at.
 */
type ComponentType = typeof COMPONENT_TYPES[number];
interface UpdateFieldsOptions {
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
}

/**
 * The component a series-level write belongs to.
 *
 * A recurring event or todo may carry, next to its master, override
 * components for single instances — same UID, plus a RECURRENCE-ID (RFC 5545
 * 3.8.4.4) — in any order. A write without a named instance (SUMMARY, EXDATE,
 * RRULE, DTSTART ...) belongs to the master, the one without RECURRENCE-ID;
 * DTSTART-anchored date-times are anchored to the master's DTSTART for the
 * same reason. Overrides are independent instances; they move only when the
 * master's DTSTART moves the whole series (see beginSeriesEdit).
 *
 * The type is chosen first, VEVENT before VTODO before VJOURNAL: a CalDAV
 * object holds one component type (RFC 4791 4.1). Within it, the first
 * component without RECURRENCE-ID wins. A server may store a detached
 * instance with no master; a single such component is edited as it is, but
 * between several there is nothing to tell which one is meant, so it throws.
 *
 * Exported so a caller that reads or edits the object itself (to check
 * DTEND against DTSTART, say) looks at the same component updateFields
 * wrote, instead of re-deriving the rule.
 *
 * @param calendar - the parsed VCALENDAR
 * @param type - restrict to one component type ("vevent", "vtodo",
 *   "vjournal"); by default the first type present, in that order. Checked
 *   at runtime as well, for JavaScript callers: upper case is accepted, any
 *   other value throws.
 */
declare function seriesMaster(calendar: ICAL.Component, type?: ComponentType): ICAL.Component;
/**
 * Update arbitrary fields on a calendar/todo/vcard object
 *
 * This function uses a field-agnostic approach - it accepts any iCal property name
 * (standard or custom) and updates it without validation or semantic understanding.
 * In a recurring event or todo it edits the master, never an override (see
 * "Recurring events and todos" in the README).
 *
 * @param calendarObject - iCal string or tsdav DAVCalendarObject with 'data' field
 * @param fields - Key-value pairs of iCal properties to update (e.g., {'SUMMARY': 'New Title'})
 * @param options.floatingTime - how a date-time without a zone is written:
 *   "keep" (floating, the default) or "local" (host timezone, written as UTC)
 * @param options.absoluteTime - how a date-time with a zone is written where
 *   the property or its DTSTART has a TZID: as UTC ("as-given", the default) or
 *   converted into that TZID, which stays ("keep-zone")
 * @param options.zone - an IANA zone ("Europe/Berlin") to write the call's
 *   date-times in, with that TZID, adding a VTIMEZONE when the VCALENDAR has
 *   none; replaces floatingTime and absoluteTime (see the README)
 * @param options.type - the component type to write into ("vevent", "vtodo",
 *   "vjournal"); by default the first type present, in that order. Throws if
 *   the object holds no component of that type, or is a vCard
 * @returns Updated iCal string ready for tsdav.updateCalendarObject()
 *
 * @example
 * ```typescript
 * const updated = updateFields(event.data, {
 *   'SUMMARY': 'Team Meeting',
 *   'LOCATION': 'Conference Room A',
 *   'X-CUSTOM-FIELD': 'custom value'
 * });
 * ```
 */
declare function updateFields(calendarObject: CalendarObjectInput, fields: FieldUpdates, options?: UpdateFieldsOptions): string;

/**
 * One parsed value, in the jCal form ("2026-10-26", "2026-10-26T18:00:00Z",
 * "2026-10-26T18:00:00"). "floating" is a wall-clock time without a zone; what
 * it becomes on write depends on where it lands (see setDateValue), and
 * `local` is the instant it names when read in the host timezone.
 */
type DateValue = {
    kind: 'date';
    jcal: string;
} | {
    kind: 'utc';
    jcal: string;
} | {
    kind: 'floating';
    jcal: string;
    local: Date;
};
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
declare function parseDateValue(raw: string): DateValue;

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
declare const CODES: readonly ["INVALID_INPUT", "INVALID_ICALENDAR", "INVALID_TYPE", "INVALID_FLOATING_TIME", "INVALID_ABSOLUTE_TIME", "COMPONENT_NOT_FOUND", "WRONG_OBJECT_KIND", "NO_MASTER", "INVALID_VALUE", "VALUE_TYPE_MISMATCH", "ZONE_MISMATCH", "UNKNOWN_TZID", "UNSUPPORTED_VTIMEZONE", "UNKNOWN_RULE_PART", "DUPLICATE_RULE_PART", "INVALID_RULE", "RECURRENCE_ID_ON_MASTER", "SERIES_MOVE_REFUSED", "ORPHANED_EXCEPTIONS", "DST_AMBIGUOUS", "CHECK_LIMIT_EXCEEDED", "SERIES_UNVERIFIABLE"];
/** Every code, frozen */
declare const UPDATE_FIELDS_ERROR_CODES: typeof CODES;
/** A stable reason for a refusal; see UPDATE_FIELDS_ERROR_CODES */
type UpdateFieldsErrorCode = typeof CODES[number];
/**
 * What the caller can do about a refusal, as the message says it:
 * - "fix-value": a value or option given is malformed or does not fit; correct it
 * - "same-call": give the named properties (RRULE, UNTIL, EXDATE, RDATE, ...)
 *   in the same updateFields call
 * - "rewrite-object": the change cannot be made as field writes (or the object
 *   itself is broken); replace the whole iCalendar object
 * - "none": nothing in this call helps (a vCard handed to an iCalendar write)
 */
type UpdateFieldsRemedy = 'fix-value' | 'same-call' | 'rewrite-object' | 'none';
interface UpdateFieldsErrorDetails {
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
declare class UpdateFieldsError extends Error {
    readonly code: UpdateFieldsErrorCode;
    readonly remedy: UpdateFieldsRemedy;
    readonly property?: string;
    readonly suggestion?: string;
    readonly cause?: unknown;
    constructor(code: UpdateFieldsErrorCode, message: string, details: UpdateFieldsErrorDetails);
    /**
     * The refusal as plain data, for a log or a response body (JSON.stringify
     * of an Error otherwise drops the message).
     */
    toJSON(): {
        name: string;
        code: UpdateFieldsErrorCode;
        message: string;
        remedy: UpdateFieldsRemedy;
        property?: string;
        suggestion?: string;
    };
}
/**
 * Whether an error is an UpdateFieldsError, optionally with one code (and then
 * typed with that code). Checked by name and code rather than instanceof, so it
 * also holds when the ESM and the CommonJS build of this package are both
 * loaded. It needs the error as thrown: a copy made by structuredClone or
 * postMessage keeps only message and stack, not name and code.
 */
declare function isUpdateFieldsError<C extends UpdateFieldsErrorCode = UpdateFieldsErrorCode>(error: unknown, code?: C): error is UpdateFieldsError & {
    code: C;
};

export { type AbsoluteTime, type CalendarObjectInput, type ComponentType, type DateValue, type FieldUpdates, type FloatingTime, UPDATE_FIELDS_ERROR_CODES, UpdateFieldsError, type UpdateFieldsErrorCode, type UpdateFieldsErrorDetails, type UpdateFieldsOptions, type UpdateFieldsRemedy, isUpdateFieldsError, parseDateValue, seriesMaster, updateFields };
