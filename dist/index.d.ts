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
interface UpdateFieldsOptions {
    floatingTime?: FloatingTime;
}

/**
 * Update arbitrary fields on a calendar/todo/vcard object
 *
 * This function uses a field-agnostic approach - it accepts any iCal property name
 * (standard or custom) and updates it without validation or semantic understanding.
 *
 * @param calendarObject - iCal string or tsdav DAVCalendarObject with 'data' field
 * @param fields - Key-value pairs of iCal properties to update (e.g., {'SUMMARY': 'New Title'})
 * @param options.floatingTime - how a date-time without a zone is written:
 *   "keep" (floating, the default) or "local" (host timezone, written as UTC)
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
 * @throws {Error} naming the accepted forms when the value is none of them
 */
declare function parseDateValue(raw: string): DateValue;

export { type CalendarObjectInput, type DateValue, type FieldUpdates, type FloatingTime, type UpdateFieldsOptions, parseDateValue, updateFields };
