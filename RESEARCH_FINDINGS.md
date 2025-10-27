# Research Findings - tsdav and ical.js APIs

## Date: 2025-10-27

## 1. tsdav Output Format

### Key Findings:

**fetchCalendarObjects() Return Type:**
```typescript
Promise<DAVCalendarObject[]>
```

**DAVCalendarObject Structure:**
```typescript
type DAVCalendarObject = {
  data?: any;        // This contains the raw iCal string!
  etag?: string;
  url: string;
};
```

**Answer to CLAUDE.md Question 1:**
- ✅ `fetchCalendarObjects()` returns an array of `DAVCalendarObject`
- ✅ The `data` property contains the raw iCal string (not parsed)
- ✅ The object also includes `etag` and `url` for tracking

**updateCalendarObject() Input:**
```typescript
updateCalendarObject(params: {
  calendarObject: DAVCalendarObject;  // Full object with data, etag, url
  headers?: Record<string, string>;
  headersToExclude?: string[];
  fetchOptions?: RequestInit;
}) => Promise<Response>
```

**Answer:** updateCalendarObject expects the full `DAVCalendarObject` with updated `data` field.

---

## 2. ical.js API

### Component Class Methods:

**Parsing:**
```typescript
Component.fromString(str: string): Component
```
- Static method to create Component from iCal string
- Returns a Component instance with the parsed data

**Property Updates:**
```typescript
updatePropertyWithValue(name: string, value: string | number | any): Property
```
- ✅ This is the KEY method for our use case!
- Updates existing property or creates new one if not found
- Returns the Property instance
- Handles both standard and custom properties (X-*)

**Serialization:**
```typescript
toString(): string
```
- Converts Component back to iCal string format
- This is what we'll return from updateFields()

### Property Preservation:

**Answer to CLAUDE.md Question 3:**
- ✅ YES! ical.js automatically preserves all unmodified properties
- The Component wraps jCal data structure
- Only explicitly updated properties are changed
- All other properties remain intact in the internal jCal array

---

## 3. Component Types

### VEVENT, VTODO, VCARD Support:

**Answer to CLAUDE.md Question 4:**
- ✅ ical.js uses a design set system
- Component class handles VEVENT (icalendar design)
- Component class handles VCARD (vcard design)
- Component class handles VTODO (icalendar design)
- All use the same Component class with different design sets
- **One function can handle all three!**

The Component has a private `_designSet` property that automatically
detects whether it's working with iCalendar or vCard format.

---

## 4. Error Handling

### Invalid iCal Input:

**Answer to CLAUDE.md Question 5:**
- `Component.fromString()` will throw an error for invalid iCal
- We should catch this and provide a clear error message
- Recommendation: **Fail gracefully with descriptive error**

Example error handling strategy:
```typescript
try {
  const component = ICAL.Component.fromString(icalString);
  // proceed with updates
} catch (error) {
  throw new Error(`Invalid iCal format: ${error.message}`);
}
```

---

## 5. Implementation Strategy

### Core Algorithm:

```typescript
export function updateFields(
  calendarObject: CalendarObjectInput,
  fields: FieldUpdates
): string {
  // 1. Extract iCal string
  const icalString = typeof calendarObject === 'string'
    ? calendarObject
    : calendarObject.data;

  // 2. Parse with ical.js
  const jcalData = ICAL.parse(icalString);
  const component = new ICAL.Component(jcalData);

  // 3. Find the actual component (VEVENT/VTODO/VCARD)
  //    The parsed data is usually wrapped in VCALENDAR for events/todos
  const actualComponent = component.name === 'VCALENDAR'
    ? component.getFirstSubcomponent()  // Get VEVENT or VTODO
    : component;  // Already the right component (VCARD)

  // 4. Update properties (field-agnostic loop)
  for (const [key, value] of Object.entries(fields)) {
    actualComponent.updatePropertyWithValue(key, value);
  }

  // 5. Serialize back to iCal string
  return component.toString();
}
```

### Key Insights:

1. **VCALENDAR Wrapper:** VEVENT and VTODO are wrapped in VCALENDAR component
2. **VCARD is standalone:** VCARD components are not wrapped
3. **getFirstSubcomponent():** Gets the actual event/todo inside VCALENDAR
4. **updatePropertyWithValue():** Perfect for our field-agnostic approach
5. **Immutability:** We parse, modify, and return new string (no mutation)

---

## 6. Test Strategy

### Test Fixtures Needed:

1. **VEVENT (Calendar Event):**
```ics
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:test-event-123
DTSTART:20250128T100000Z
DTEND:20250128T110000Z
SUMMARY:Original Event
LOCATION:Office
END:VEVENT
END:VCALENDAR
```

2. **VTODO (Todo/Task):**
```ics
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VTODO
UID:test-todo-123
SUMMARY:Original Todo
STATUS:NEEDS-ACTION
PRIORITY:5
DUE:20250130T170000Z
END:VTODO
END:VCALENDAR
```

3. **VCARD (Contact):**
```vcf
BEGIN:VCARD
VERSION:3.0
UID:test-vcard-123
FN:John Doe
EMAIL:john@example.com
TEL:+1234567890
END:VCARD
```

---

## 7. Potential Issues & Solutions

### Issue 1: VCALENDAR Wrapper
**Problem:** Need to detect if component is wrapped
**Solution:** Check `component.name` and use getFirstSubcomponent() if needed

### Issue 2: Multiple Components
**Problem:** VCALENDAR might contain multiple VEVENT/VTODO
**Solution:** v1.0 only updates the first component (document this limitation)
           Create GitHub issue for multi-component support

### Issue 3: Custom Properties
**Problem:** X-* properties might need special handling
**Solution:** ical.js handles them automatically, no special code needed

### Issue 4: Multi-value Properties
**Problem:** ATTENDEE, CATEGORIES can have multiple values
**Solution:** v1.0 treats as string (user handles format)
           Create GitHub issue for array support

---

## 8. Dependencies Confirmed

### ical.js
- Version: ^2.0.1 ✅ Installed
- Import: `import ICAL from 'ical.js'`
- Types: Included in package ✅

### tsdav
- Version: ^2.1.5 ✅ Installed (devDependencies)
- Peer Dependency: ^2.0.0 ✅ Configured
- Types: Included in package ✅

---

## 9. Next Steps

1. ✅ Research complete
2. ⏭️ Create feature branch
3. ⏭️ Implement updateFields() with findings above
4. ⏭️ Create test fixtures
5. ⏭️ Write comprehensive tests
6. ⏭️ Document limitations as GitHub issues

---

## 10. Questions Answered

| Question | Answer |
|----------|--------|
| Does fetchCalendarObject() return raw iCal string? | ✅ Yes, in `data` property |
| How to parse with ical.js? | `Component.fromString(str)` |
| How to set properties? | `updatePropertyWithValue(name, value)` |
| How to serialize? | `component.toString()` |
| Do properties preserve? | ✅ Yes, automatically |
| Can one function handle all types? | ✅ Yes, Component class handles all |
| What happens with invalid iCal? | Throws error, catch and handle gracefully |

---

## Confidence Level: HIGH ✅

All critical questions answered. Implementation strategy is clear. Ready to proceed with coding phase.
