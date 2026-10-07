import ICAL from 'ical.js';
import type { CalendarObjectInput, FieldUpdates, UpdateFieldsOptions } from './types';
import { realignUntils, setDateValue, setRecurValue, untilsFollowingDtstart } from './typedValue';

/**
 * The component a series-level write belongs to.
 *
 * A recurring event or todo may carry, next to its master, override
 * components for single instances — same UID, plus a RECURRENCE-ID (RFC 5545
 * 3.8.4.4) — in any order. A write without a named instance (SUMMARY, EXDATE,
 * RRULE, DTSTART ...) belongs to the master, the one without RECURRENCE-ID;
 * DTSTART-anchored date-times are anchored to the master's DTSTART for the
 * same reason. Overrides are independent instances and are left untouched.
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
 *   "vjournal"); by default the first type present, in that order
 */
export function seriesMaster(calendar: ICAL.Component, type?: string): ICAL.Component {
  const types = type ? [type.toLowerCase()] : ['vevent', 'vtodo', 'vjournal'];
  for (const type of types) {
    const all = calendar.getAllSubcomponents(type);
    if (all.length === 0) {
      continue;
    }
    const master = all.find((c) => !c.hasProperty('recurrence-id'));
    if (master) {
      return master;
    }
    if (all.length === 1) {
      return all[0];
    }
    throw new Error(
      `This object holds ${all.length} ${type.toUpperCase()} instances (each with a ` +
      'RECURRENCE-ID) and no master, so a field update cannot tell which one is meant. ' +
      'Edit the instance by rewriting the whole iCalendar object instead');
  }
  throw new Error(`No ${types.map((t) => t.toUpperCase()).join(', ')} found in VCALENDAR`);
}

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

  // 3. Find the component to update: the master of a VCALENDAR (see
  //    seriesMaster), or the VCARD itself, which stands alone.
  //    Note: component.name returns lowercase
  const actualComponent = component.name === 'vcalendar'
    ? seriesMaster(component)
    : component;

  // 4. Update properties using field-agnostic loop
  //    Date and date-time properties and recurrence rules are parsed and
  //    written typed (see typedValue); everything else goes through
  //    updatePropertyWithValue(), which handles both updates and creates if
  //    missing. ical.js expects lowercase names.
  //    DTSTART goes first: the other date-times and RRULE's UNTIL take their
  //    zone and value type from it, so they must see the new one, whatever
  //    the key order.
  //    An RRULE/EXRULE UNTIL the call does not write itself is re-derived
  //    against the new DTSTART afterwards (see realignUntils), so a DTSTART
  //    write never leaves an UNTIL of the old form behind.
  const entries = Object.entries(fields).sort(
    ([a], [b]) => Number(b.toLowerCase() === 'dtstart') - Number(a.toLowerCase() === 'dtstart'));
  const written = new Set(entries.map(([key]) => key.toLowerCase()));
  const untils = written.has('dtstart') ? untilsFollowingDtstart(actualComponent, written) : [];
  for (const [key, value] of entries) {
    if (!setDateValue(actualComponent, key, value, floatingTime) &&
        !setRecurValue(actualComponent, key, value, floatingTime)) {
      actualComponent.updatePropertyWithValue(key.toLowerCase(), value);
    }
  }
  realignUntils(actualComponent, untils, floatingTime);

  // 5. Serialize back to iCal string
  //    All unmodified properties are automatically preserved by ical.js
  return component.toString();
}
