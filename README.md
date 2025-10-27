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

### `updateFields(calendarObject, fields)`

Updates arbitrary properties on a calendar/todo/contact object.

#### Parameters

- **calendarObject**: `string | { data: string }`
  - Raw iCal string, OR
  - tsdav `DAVCalendarObject` with `data` field

- **fields**: `Record<string, string>`
  - Key-value pairs of iCal properties to update
  - Keys: iCal property names (e.g., `'SUMMARY'`, `'LOCATION'`, `'X-CUSTOM'`)
  - Values: Property values as strings

#### Returns

- `string`: Updated iCal string ready for `tsdav.updateCalendarObject()`

#### Example

```typescript
const updated: string = updateFields(calendarObject, {
  'SUMMARY': 'New Title',
  'X-CUSTOM-FIELD': 'custom value',
});
```

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

// ❌ We don't validate values
updateFields(event, {
  'DTSTART': 'invalid-date',  // ✅ Accepted (ical.js may throw later)
});
```

### ❌ Not a Type Converter

```typescript
// ❌ We don't convert datetime formats
updateFields(event, {
  'DTSTART': '2025-01-28',  // ❌ Wrong format - user must provide iCal format
});

// ✅ User provides correctly formatted iCal datetime
updateFields(event, {
  'DTSTART': '20250128T100000Z',  // ✅ Correct iCal format
});
```

## Known Limitations

These limitations are intentional and documented in GitHub issues:

1. **Datetime properties** ([#1](https://github.com/PhilflowIO/tsdav-utils/issues))
   - ical.js validates datetime values
   - Complex datetime handling requires special consideration
   - Workaround: Update other properties, handle datetimes separately

2. **Multi-value properties** ([#2](https://github.com/PhilflowIO/tsdav-utils/issues))
   - `ATTENDEE` with multiple people
   - `CATEGORIES` with multiple values
   - Current: Treats as string (first value only)

3. **Structured properties** ([#3](https://github.com/PhilflowIO/tsdav-utils/issues))
   - `VCARD.N` has 5 components (Family;Given;Additional;Prefix;Suffix)
   - `VCARD.ADR` has 7 components
   - Current: May not handle component structure correctly

4. **Timezone handling** ([#4](https://github.com/PhilflowIO/tsdav-utils/issues))
   - Complex timezone conversions
   - All-day vs timed events
   - Workaround: Store in UTC, handle conversion in application layer

5. **Recurrence rules (RRULE)** ([#5](https://github.com/PhilflowIO/tsdav-utils/issues))
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
