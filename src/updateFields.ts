import type { CalendarObjectInput, FieldUpdates } from './types';

/**
 * Update arbitrary fields on a calendar object
 *
 * @param calendarObject - iCal string or parsed object from tsdav
 * @param fields - Key-value pairs of iCal properties to update
 * @returns Updated iCal string ready for tsdav.updateCalendarObject()
 */
export function updateFields(
  calendarObject: CalendarObjectInput,
  fields: FieldUpdates
): string {
  // TODO: Implementation will be added after research phase
  throw new Error('Not implemented yet');
}
