# tsdav-utils

Field-agnostic utility layer for [tsdav](https://github.com/natelindev/tsdav) CalDAV/CardDAV operations.

## What is this?

`tsdav-utils` is a **dumb glue library** that bridges the gap between tsdav (network transport) and your application logic. It provides a single, field-agnostic function to update any property on calendar events, todos, or contacts without business logic, validation, or opinions.

### Architecture

```
Your Application / MCP Server
       ↓
  tsdav-utils (field manipulation) ← This library
       ↓
  tsdav (transport) + ical.js (parsing)
       ↓
CalDAV/CardDAV Server
```

### Philosophy: "Parse anything, write anything"

- **Zero business logic** - No semantic understanding of fields
- **Zero validation** - Accepts any property name and value
- **Maximum flexibility** - Works with standard and custom (X-*) properties
- **No hardcoded field lists** - Truly field-agnostic

This is intentional. All intelligence belongs in your application layer or MCP server.

## Installation

```bash
npm install tsdav tsdav-utils
```

`tsdav-utils` does not depend on tsdav: it only takes and returns iCal/vCard strings, so it declares no `tsdav` peer dependency. Use it with any tsdav version, including forks and builds with a non-standard version string.

## Usage

### Basic Example

```typescript
import { createDAVClient } from 'tsdav';
import { updateFields } from 'tsdav-utils';

// 1. Create tsdav client
const client = await createDAVClient({
  serverUrl: 'https://caldav.example.com',
  credentials: {
    username: 'user',
    password: 'password',
  },
  authMethod: 'Basic',
  defaultAccountType: 'caldav',
});

// 2. Fetch event
const calendars = await client.fetchCalendars();
const events = await client.fetchCalendarObjects({
  calendar: calendars[0],
});
const event = events[0];

// 3. Update any fields
const updated = updateFields(event.data, {
  'SUMMARY': 'Updated Meeting Title',
  'LOCATION': 'Berlin Office',
  'X-ZOOM-LINK': 'https://zoom.us/j/123456789',
});

// 4. Save back to server
await client.updateCalendarObject({
  calendarObject: {
    ...event,
    data: updated,
  },
});
```

### Update Multiple Properties

```typescript
const updated = updateFields(event.data, {
  'SUMMARY': 'Team Standup',
  'LOCATION': 'Conference Room A',
  'DESCRIPTION': 'Daily team sync',
  'STATUS': 'CONFIRMED',
  'X-MEETING-ROOM': 'BLDG-A-301',
});
```

### Works with VEVENT, VTODO, and VCARD

```typescript
// Calendar Event (VEVENT)
const updatedEvent = updateFields(event.data, {
  'SUMMARY': 'New Event Title',
  'LOCATION': 'Office',
});

// Todo/Task (VTODO)
const updatedTodo = updateFields(todo.data, {
  'SUMMARY': 'Finish documentation',
  'STATUS': 'IN-PROCESS',
  'PRIORITY': '1',
});

// Contact (VCARD)
const updatedContact = updateFields(vcard.data, {
  'FN': 'Jane Doe',
  'EMAIL': 'jane@example.com',
  'TEL': '+1234567890',
});
```

### Custom Properties (X-* Extensions)

```typescript
// Add custom fields for integration with other systems
const updated = updateFields(event.data, {
  'SUMMARY': 'Client Meeting',
  'X-CRM-ID': 'SF-12345',
  'X-PROJECT-CODE': 'PROJ-2025-001',
  'X-ZOOM-LINK': 'https://zoom.us/j/987654321',
  'X-SLACK-CHANNEL': '#project-alpha',
});
```

## API Reference

### `updateFields(calendarObject, fields, options?)`

Updates arbitrary properties on a calendar/todo/contact object.

#### Parameters

- **calendarObject**: `string | { data: string }`
  - Raw iCal string, OR
  - tsdav `DAVCalendarObject` with `data` field

- **fields**: `Record<string, string>`
  - Key-value pairs of iCal properties to update
  - Keys: iCal property names (e.g., `'SUMMARY'`, `'LOCATION'`, `'X-CUSTOM'`)
  - Values: Property values as strings; date-typed values are parsed (see [Date and date-time values](#date-and-date-time-values))

- **options.floatingTime**: `'keep' | 'local'` (default `'keep'`)
  - How a date-time without a zone is written: floating, or host timezone converted to UTC

#### Returns

- `string`: Updated iCal string ready for `tsdav.updateCalendarObject()`

#### Example

```typescript
const updated: string = updateFields(calendarObject, {
  'SUMMARY': 'New Title',
  'X-CUSTOM-FIELD': 'custom value',
});
```

## Date and date-time values

Date-typed properties (`DTSTART`, `DTEND`, `DUE`, `COMPLETED`, `RECURRENCE-ID`,
`EXDATE`, `RDATE`, `LAST-MODIFIED`, `DTSTAMP`, `CREATED`, vCard `REV`, ...) are the
one place where a plain string is not enough: written verbatim, ical.js drops
UTC offsets and keeps a stale `TZID` or `VALUE=DATE` from the old value. So
`updateFields` parses these values and writes them typed:

```typescript
updateFields(todo, { DUE: '2026-10-26T14:00:00-04:00' }); // DUE:20261026T180000Z
updateFields(todo, { DUE: '20261026T180000Z' });          // DUE:20261026T180000Z
updateFields(todo, { DUE: '2026-10-26' });                // DUE;VALUE=DATE:20261026
updateFields(todo, { DUE: '2026-10-26T18:00:00' });       // DUE:20261026T180000 (floating)
updateFields(event, { EXDATE: '2026-10-26T18:00:00Z,2026-11-02T18:00:00Z' });
```

- A value with `Z` or an offset is converted to UTC; any `TZID` on the old value is removed.
- A date (`YYYY-MM-DD` or `YYYYMMDD`) becomes `VALUE=DATE`, and back again.
- A value without a zone is a wall-clock time. On a property that already has a
  `TZID` it is read in that zone and the `TZID` stays
  (`DTSTART;TZID=Europe/Berlin:...` + `2026-10-26T18:00:00` is 18:00 in Berlin).
- The other date-times of an event, todo or journal (DTEND, DUE, EXDATE, RDATE,
  RECURRENCE-ID) follow DTSTART — an end belongs to the zone of its start, and an
  EXDATE only removes an occurrence it names in the series' own form:
  - without a `TZID` of their own they take DTSTART's `TZID`, or stay floating
    next to a floating DTSTART;
  - next to a UTC DTSTART a value without a zone needs `{ floatingTime: 'local' }`
    (host timezone, written as UTC); under the default it throws rather than
    write a floating value that matches nothing;
  - they take DTSTART's value type: dates next to an all-day DTSTART, date-times
    next to a timed one (RFC 5545 3.8.2.2, 3.8.2.3, 3.8.4.4).
  DTSTART is written first, so this holds whatever the key order.
- With no zone to go by (DTSTART itself, a todo without DTSTART) a value without a
  zone stays floating, or with `{ floatingTime: 'local' }` is read in the host
  timezone and written as UTC.
- `COMPLETED`, `CREATED`, `DTSTAMP` and `LAST-MODIFIED` must be UTC (RFC 5545) and
  reject a floating value; properties that only allow a date-time reject a date.
- Anything else (`tomorrow`, `26.10.2026`) throws, naming the accepted forms.
- vCard `BDAY`/`ANNIVERSARY` (DATE-AND-OR-TIME in vCard 4, which allows `--0501`) are written as given.

To validate input before calling `updateFields`, use the same grammar:
`parseDateValue(value)` returns `{ kind: 'date' | 'utc' | 'floating', jcal }` or
throws naming the accepted forms.

Apart from following DTSTART, each value is encoded on its own. Keeping related properties consistent — DTEND
the same type as DTSTART, an RRULE `UNTIL` matching DTSTART, DUE vs. DURATION —
is the caller's job. Like every other property, only the first `EXDATE`/`RDATE`
line is replaced.

## Recurring events and todos

A recurring event or todo can hold, next to its master, override components for
single instances: same `UID`, plus a `RECURRENCE-ID` (RFC 5545 3.8.4.4). Servers
store them in any order. `updateFields` always edits the **master**, the
`VEVENT`/`VTODO`/`VJOURNAL` without `RECURRENCE-ID`, so a series-level change
(`SUMMARY`, `EXDATE`, `RRULE`, `DTSTART`, ...) reaches the series, and date-times
follow the master's `DTSTART` (see above).

- **Overrides are not touched.** Each override is an independent instance; a new
  `SUMMARY` on the master does not rename an instance that was renamed on its own.
  To change an override as well, edit it with ical.js directly.
- **An object with only overrides** (a detached instance stored without its
  master): a single component is edited as it is; with several there is no
  telling which one is meant, so `updateFields` throws.
- **Moving a master's `DTSTART` or changing its `RRULE`** does not move the
  overrides' `RECURRENCE-ID`s yet, so an override can stop matching an occurrence
  ([#16](https://github.com/PhilflowIO/tsdav-utils/issues/16)).
- **Reading the same component yourself:** `seriesMaster(calendar, type?)` returns
  the component `updateFields` edits, for a parsed `ICAL.Component` VCALENDAR —
  use it to check what was written (e.g. DTEND against DTSTART) instead of
  `getFirstSubcomponent`.
- The component type is chosen first (`VEVENT`, then `VTODO`, then `VJOURNAL`),
  since a CalDAV object holds one type (RFC 4791 4.1).

## What This Library Does NOT Do

### ❌ Not a High-Level API

```typescript
// ❌ We don't provide convenience methods
rescheduleEvent(event, newDate);  // Doesn't exist
markComplete(todo);                // Doesn't exist
findMeetingsByAttendee(email);    // Doesn't exist
```

### ❌ Not a Validation Layer

```typescript
// ❌ We don't validate property names
updateFields(event, {
  'SUMMMARY': 'Typo in field name',  // ✅ Accepted (user's responsibility)
});

// Date-typed values are the exception: they are parsed (see below)
updateFields(event, {
  'DTSTART': 'invalid-date',  // ❌ Throws, naming the accepted forms
});
```

## Known Limitations

These limitations are intentional and documented in GitHub issues:

1. **Multi-value properties** ([#2](https://github.com/PhilflowIO/tsdav-utils/issues))
   - `ATTENDEE` with multiple people
   - `CATEGORIES` with multiple values
   - Current: Treats as string (first value only)

2. **Structured properties** ([#3](https://github.com/PhilflowIO/tsdav-utils/issues))
   - `VCARD.N` has 5 components (Family;Given;Additional;Prefix;Suffix)
   - `VCARD.ADR` has 7 components
   - Current: May not handle component structure correctly

3. **Timezone handling** ([#4](https://github.com/PhilflowIO/tsdav-utils/issues))
   - Zoned values are written as UTC; named zones (`TZID` + `VTIMEZONE`) are not produced
   - Workaround: build a TZID-based property with ical.js directly

4. **Recurrence rules (RRULE)** ([#5](https://github.com/PhilflowIO/tsdav-utils/issues))
   - Complex recurrence patterns
   - Expanding recurring events
   - Workaround: Use ical.js directly for recurrence logic

## When Should I Use This?

### ✅ Good Use Cases

- Building an MCP server for calendar/contact management
- Syncing calendar data between systems
- Bulk updating calendar properties
- Adding custom X-* fields for integration
- Simple CRUD operations on calendar data

### ⚠️ Consider Alternatives If...

- You need high-level scheduling logic → Use a full calendar library
- You need complex timezone handling → Use a datetime library + ical.js
- You need recurrence expansion → Use ical.js directly
- You need validation → Add validation in your application layer

## Examples

### MCP Server Integration

```typescript
// MCP tool to update calendar event
async function updateEvent(eventId: string, updates: Record<string, string>) {
  const client = await createDAVClient(config);
  const calendars = await client.fetchCalendars();
  const events = await client.fetchCalendarObjects({ calendar: calendars[0] });

  const event = events.find(e => e.url.includes(eventId));
  if (!event) throw new Error('Event not found');

  // Update with field-agnostic approach
  const updated = updateFields(event.data, updates);

  await client.updateCalendarObject({
    calendarObject: { ...event, data: updated },
  });

  return { success: true, updated: updates };
}
```

### LLM-Friendly Field Mapping

```typescript
// Your MCP server handles the mapping
function llmToIcalFields(llmUpdate: any): Record<string, string> {
  return {
    'SUMMARY': llmUpdate.title || llmUpdate.summary,
    'LOCATION': llmUpdate.location || llmUpdate.where,
    'DESCRIPTION': llmUpdate.description || llmUpdate.notes,
    'STATUS': llmUpdate.status?.toUpperCase(),
  };
}

const icalFields = llmToIcalFields(llmResponse);
const updated = updateFields(event.data, icalFields);
```

## Testing

```bash
npm test                  # Run all tests
npm run test:watch        # Watch mode
npm run test:coverage     # Coverage report
```

## Contributing

This library intentionally does very little. Before adding features, ask:

1. Does this add business logic? → **Don't add it**
2. Could this be done in user code? → **Don't add it**
3. Does this restrict property usage? → **Don't add it**

Valid contributions:
- Bug fixes (properties not preserved, etc.)
- Performance improvements
- Better error messages

## License

MIT

## Links

- [GitHub Repository](https://github.com/PhilflowIO/tsdav-utils)
- [npm Package](https://www.npmjs.com/package/tsdav-utils)
- [tsdav](https://github.com/natelindev/tsdav)
- [ical.js](https://github.com/kewisch/ical.js)
- [RFC 5545 (iCalendar)](https://datatracker.ietf.org/doc/html/rfc5545)
- [RFC 6350 (vCard)](https://datatracker.ietf.org/doc/html/rfc6350)
