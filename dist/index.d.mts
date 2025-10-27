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
 * Update arbitrary fields on a calendar/todo/vcard object
 *
 * This function uses a field-agnostic approach - it accepts any iCal property name
 * (standard or custom) and updates it without validation or semantic understanding.
 *
 * @param calendarObject - iCal string or tsdav DAVCalendarObject with 'data' field
 * @param fields - Key-value pairs of iCal properties to update (e.g., {'SUMMARY': 'New Title'})
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
declare function updateFields(calendarObject: CalendarObjectInput, fields: FieldUpdates): string;

export { type CalendarObjectInput, type FieldUpdates, updateFields };
