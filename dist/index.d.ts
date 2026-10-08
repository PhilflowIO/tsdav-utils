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
declare const CODES: readonly ["INVALID_INPUT", "INVALID_ICALENDAR", "INVALID_TYPE", "INVALID_FLOATING_TIME", "INVALID_ABSOLUTE_TIME", "COMPONENT_NOT_FOUND", "WRONG_OBJECT_KIND", "NO_MASTER", "INVALID_VALUE", "VALUE_TYPE_MISMATCH", "ZONE_MISMATCH", "UNKNOWN_TZID", "UNSUPPORTED_VTIMEZONE", "UNKNOWN_RULE_PART", "DUPLICATE_RULE_PART", "INVALID_RULE", "END_BEFORE_START", "RECURRENCE_ID_ON_MASTER", "SERIES_MOVE_REFUSED", "ORPHANED_EXCEPTIONS", "DST_AMBIGUOUS", "CHECK_LIMIT_EXCEEDED", "SERIES_UNVERIFIABLE"];
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

/** The range of years a generated VTIMEZONE is asked to cover */
interface VtimezoneRange {
    /** the earliest year a value lies in; the VTIMEZONE starts on 1 January of the year before */
    from: number;
    /** the latest year a value lies in (default `from`); the zone's current rule covers every year after */
    to?: number;
}
/**
 * A VTIMEZONE for an IANA zone, as iCalendar text (CRLF, no trailing line
 * break), covering the years given and every year after: the same text
 * updateFields adds with `zone`. Deterministic for a given runtime (the time
 * zone data is Intl's).
 *
 * @throws {UpdateFieldsError} UNKNOWN_TZID for a name that is no IANA zone,
 *   INVALID_INPUT for a range that is no pair of integer years,
 *   UNSUPPORTED_VTIMEZONE for years on local mean time
 */
declare function generateVtimezone(tzid: string, range: VtimezoneRange): string;

/** A wall-clock time without zone, as "YYYY-MM-DDTHH:MM:SS" */
type WallTime = string;
/** Conversions between UTC and the wall clock of one zone */
interface ZoneConverter {
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
type ZoneSource = string | ICAL.Component;
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
declare function resolveZone(tzid: string, source?: ZoneSource): ZoneConverter | null;
/**
 * The conversions of the zone a date-time property is written in (its TZID),
 * read against the object the property belongs to; null when it has no TZID
 * (UTC, floating, a date) or the TZID is unknown.
 */
declare function resolvePropertyZone(property: ICAL.Property): ZoneConverter | null;

/**
 * Work left for rule expansion, in the units of WORK_BUDGET. Spent as ical.js
 * tests candidates; one object can be shared by several expansions, so a
 * caller bounds all of them together.
 */
interface RecurrenceBudget {
    remaining: number;
}

/**
 * A budget for expandOccurrences, in work units (about a microsecond of
 * ical.js work each; the default is what one updateFields series check may
 * spend). Pass the same object to several calls to bound them together.
 */
declare function createRecurrenceBudget(units?: number): RecurrenceBudget;
/** One start or end of an occurrence */
interface OccurrenceTime {
    /**
     * The value as written in the object's form: a date "2026-10-05", a UTC
     * date-time "2026-10-05T07:00:00Z", or a wall-clock time "2026-10-05T09:00:00"
     * (in `tzid`, or floating when there is none)
     */
    value: string;
    /** the TZID the wall-clock time is in, or null */
    tzid: string | null;
    /** the instant as ISO 8601 UTC, or null for a date or a floating time (no zone to place it) */
    instant: string | null;
}
interface Occurrence {
    /** the occurrence's original start, as a RECURRENCE-ID names it */
    recurrenceId: OccurrenceTime;
    /** where it starts: the override's DTSTART for an overridden occurrence */
    start: OccurrenceTime;
    /** where it ends (DTEND, DUE, or DTSTART plus DURATION), or null when the component gives no end */
    end: OccurrenceTime | null;
    /** whether an override component (same UID, this RECURRENCE-ID) replaces it */
    overridden: boolean;
}
interface ExpansionResult {
    /** the occurrences found, by original start */
    occurrences: Occurrence[];
    /** whether every occurrence in the range is in the list */
    complete: boolean;
    /**
     * Why the list stops early: "budget" — the budget ran out (with several
     * RRULEs an earlier occurrence of a later rule may be missing too); "limit"
     * — `limit` occurrences were found. Null when complete.
     */
    stoppedBy: 'budget' | 'limit' | null;
}
interface ExpandOptions {
    /** the work budget to spend (see createRecurrenceBudget); shared across calls if the same object is passed */
    budget: RecurrenceBudget;
    /** the end of the range, exclusive: occurrences whose original start lies at or after this are not returned */
    until: Date | string;
    /** occurrences whose original start lies before this are skipped (default: all from DTSTART) */
    from?: Date | string;
    /** at most this many occurrences (default 1000) */
    limit?: number;
    /** the component type, as for updateFields */
    type?: ComponentType;
}
/**
 * The occurrences of a recurring event, todo or journal in a range, bounded
 * by a work budget: DTSTART, RRULE and RDATE, without EXDATEs, with overrides
 * (same UID, RECURRENCE-ID) applied. Occurrences are selected by their
 * original start; an override moved into the range from outside it is not
 * found. Times are read with the object's VTIMEZONEs (IANA data as fallback),
 * on the series' wall clock, so a weekly 09:00 Berlin series stays at 09:00.
 *
 * Never loops: every candidate ical.js tests is charged to `budget`, and when
 * it runs out the result says so (complete false, stoppedBy "budget") — fail
 * closed: an incomplete list must not be taken for the whole series.
 *
 * @throws {UpdateFieldsError} for an object that does not parse or holds no
 *   such component (as updateFields), a range bound that does not parse, a
 *   zone that cannot be read, or a value or rule in the object that cannot be
 *   read; a plain Error for a failure of the library
 */
declare function expandOccurrences(calendarObject: CalendarObjectInput | ICAL.Component, options: ExpandOptions): ExpansionResult;

export { type AbsoluteTime, type CalendarObjectInput, type ComponentType, type DateValue, type ExpandOptions, type ExpansionResult, type FieldUpdates, type FloatingTime, type Occurrence, type OccurrenceTime, type RecurrenceBudget, UPDATE_FIELDS_ERROR_CODES, UpdateFieldsError, type UpdateFieldsErrorCode, type UpdateFieldsErrorDetails, type UpdateFieldsOptions, type UpdateFieldsRemedy, type VtimezoneRange, type WallTime, type ZoneConverter, type ZoneSource, createRecurrenceBudget, expandOccurrences, generateVtimezone, isUpdateFieldsError, parseDateValue, resolvePropertyZone, resolveZone, seriesMaster, updateFields };
