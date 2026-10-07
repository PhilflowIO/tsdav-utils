import ICAL from 'ical.js';
import type { CalendarObjectInput, FieldUpdates, UpdateFieldsOptions } from './types';
import { setDateValue } from './typedValue';

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
export function updateFields(
  calendarObject: CalendarObjectInput,
  fields: FieldUpdates,
  options: UpdateFieldsOptions = {}
): string {
  // 1. Extract iCal string from input
  const icalString = typeof calendarObject === 'string'
    ? calendarObject
    : calendarObject.data;

  if (!icalString) {
    throw new Error('Invalid input: calendarObject must be a string or object with "data" field');
  }

  const floatingTime = options.floatingTime ?? 'keep';
  if (floatingTime !== 'keep' && floatingTime !== 'local') {
    throw new Error(`Invalid floatingTime "${floatingTime}": use "keep" or "local"`);
  }

  // 2. Parse iCal string to Component
  let jcalData: any;
  let component: any;

  try {
    jcalData = ICAL.parse(icalString);
    component = new ICAL.Component(jcalData);
  } catch (error: any) {
    throw new Error(`Failed to parse iCal data: ${error.message}`);
  }

  // 3. Find the actual component to update
  //    VEVENT and VTODO are wrapped in VCALENDAR
  //    VCARD is standalone
  //    Note: component.name returns lowercase
  let actualComponent;

  if (component.name === 'vcalendar') {
    // Try to find VEVENT, VTODO, or other subcomponents
    actualComponent = component.getFirstSubcomponent('vevent') ||
                      component.getFirstSubcomponent('vtodo') ||
                      component.getFirstSubcomponent('vjournal');

    if (!actualComponent) {
      throw new Error('No VEVENT, VTODO, or VJOURNAL found in VCALENDAR');
    }
  } else {
    // Standalone component (VCARD)
    actualComponent = component;
  }

  // 4. Update properties using field-agnostic loop
  //    Date and date-time properties are parsed and re-typed (see typedValue);
  //    everything else goes through updatePropertyWithValue(), which handles
  //    both updates and creates if missing. ical.js expects lowercase names.
  //    DTSTART goes first: the other date-times take their zone and value
  //    type from it, so they must see the new one, whatever the key order.
  const entries = Object.entries(fields).sort(
    ([a], [b]) => Number(b.toLowerCase() === 'dtstart') - Number(a.toLowerCase() === 'dtstart'));
  for (const [key, value] of entries) {
    if (!setDateValue(actualComponent, key, value, floatingTime)) {
      actualComponent.updatePropertyWithValue(key.toLowerCase(), value);
    }
  }

  // 5. Serialize back to iCal string
  //    All unmodified properties are automatically preserved by ical.js
  return component.toString();
}
