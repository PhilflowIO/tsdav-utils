import ICAL from 'ical.js';
import { COMPONENT_TYPES } from './types';
import type { CalendarObjectInput, ComponentType, FieldUpdates, UpdateFieldsOptions } from './types';
import { beginSeriesEdit } from './series';
import { UpdateFieldsError } from './errors';
import { setDateValue, setRecurValue } from './typedValue';

/**
 * The component type a caller named, lower-cased, or an error listing the
 * accepted ones: a misspelt type must not fall back to whatever type the
 * object happens to hold.
 */
function componentType(type: unknown): ComponentType {
  const name = typeof type === 'string' ? type.toLowerCase() : '';
  if (!(COMPONENT_TYPES as readonly string[]).includes(name)) {
    throw new UpdateFieldsError('INVALID_TYPE', `Invalid type "${String(type)}": use "vevent", "vtodo" or "vjournal"`);
  }
  return name as ComponentType;
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
export function seriesMaster(calendar: ICAL.Component, type?: ComponentType): ICAL.Component {
  const types: readonly ComponentType[] = type === undefined ? COMPONENT_TYPES : [componentType(type)];
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
    throw new UpdateFieldsError('NO_MASTER',
      `This object holds ${all.length} ${type.toUpperCase()} instances (each with a ` +
      'RECURRENCE-ID) and no master, so a field update cannot tell which one is meant. ' +
      'Edit the instance by rewriting the whole iCalendar object instead');
  }
  // Name what the object does hold, so a caller (an LLM tool call, say)
  // can correct the type it asked for.
  const held = [...new Set(calendar.getAllSubcomponents().map((c) => String(c.name).toUpperCase()))];
  throw new UpdateFieldsError('COMPONENT_NOT_FOUND', `No ${types.map((t) => t.toUpperCase()).join(', ')} found in VCALENDAR ` +
    (held.length ? `(it holds: ${held.join(', ')})` : '(it holds no components)'));
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
 * @param options.absoluteTime - how a date-time with a zone is written where
 *   the property or its DTSTART has a TZID: as UTC ("as-given", the default) or
 *   converted into that TZID, which stays ("keep-zone")
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
    throw new UpdateFieldsError('INVALID_INPUT', 'Invalid input: calendarObject must be a string or object with "data" field');
  }

  const floatingTime = options.floatingTime ?? 'keep';
  if (floatingTime !== 'keep' && floatingTime !== 'local') {
    throw new UpdateFieldsError('INVALID_FLOATING_TIME', `Invalid floatingTime "${floatingTime}": use "keep" or "local"`);
  }
  const absoluteTime = options.absoluteTime ?? 'as-given';
  if (absoluteTime !== 'as-given' && absoluteTime !== 'keep-zone') {
    throw new UpdateFieldsError('INVALID_ABSOLUTE_TIME',
      `Invalid absoluteTime "${absoluteTime}": use "as-given" or "keep-zone"`);
  }
  const type = options.type === undefined ? undefined : componentType(options.type);

  // 2. Parse iCal string to Component
  let jcalData: any;
  let component: any;

  try {
    jcalData = ICAL.parse(icalString);
    component = new ICAL.Component(jcalData);
  } catch (error: any) {
    throw new UpdateFieldsError('INVALID_ICALENDAR', `Failed to parse iCal data: ${error.message}`);
  }

  // 3. Find the component to update: the master of a VCALENDAR (see
  //    seriesMaster), or a component that stands alone (a VCARD, or a bare
  //    VEVENT/VTODO/VJOURNAL without its VCALENDAR wrapper).
  //    Note: component.name returns lowercase
  //    A named type must match a bare component; a mismatch, or a type on a
  //    vCard, can only be a caller's mistake, so it is refused, not ignored.
  if (type && component.name !== 'vcalendar' && component.name !== type) {
    const name = String(component.name).toUpperCase();
    throw new UpdateFieldsError('COMPONENT_NOT_FOUND', component.name === 'vcard'
      ? `type "${type}" applies to an iCalendar object, but this is a VCARD`
      : `type "${type}" asks for a ${type.toUpperCase()}, but this object is a bare ${name}`);
  }
  const actualComponent = component.name === 'vcalendar'
    ? seriesMaster(component, type)
    : component;

  // 4. Update properties using field-agnostic loop
  //    Date and date-time properties and recurrence rules are parsed and
  //    written typed (see typedValue); everything else goes through
  //    updatePropertyWithValue(), which handles both updates and creates if
  //    missing. ical.js expects lowercase names.
  //    DTSTART goes first: the other date-times and RRULE's UNTIL take their
  //    zone and value type from it, so they must see the new one, whatever
  //    the key order.
  //    A DTSTART write moves the whole series — overrides, EXDATE, RDATE and
  //    UNTIL the call does not write itself — and a write that would change
  //    the series otherwise, or orphan an override or EXDATE, is refused (see
  //    beginSeriesEdit).
  const entries = Object.entries(fields).sort(
    ([a], [b]) => Number(b.toLowerCase() === 'dtstart') - Number(a.toLowerCase() === 'dtstart'));
  const written = new Set(entries.map(([key]) => key.toLowerCase()));
  const series = beginSeriesEdit(component.name === 'vcalendar' ? component : null, actualComponent, written,
    icalString);
  for (const [key, value] of entries) {
    if (!setDateValue(actualComponent, key, value, floatingTime, absoluteTime) &&
        !setRecurValue(actualComponent, key, value, floatingTime)) {
      actualComponent.updatePropertyWithValue(key.toLowerCase(), value);
    }
  }
  series.finish();

  // 5. Serialize back to iCal string
  //    All unmodified properties are automatically preserved by ical.js
  //    A rule the series edit rewrote part by part goes back as written,
  //    with only those parts changed (see RuleTexts)
  return series.render(component.toString());
}
