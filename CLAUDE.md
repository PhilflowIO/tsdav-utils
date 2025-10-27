# tsdav-utils - Claude Development Guide

## Project Overview

**tsdav-utils** is a field-agnostic utility library for manipulating CalDAV/CardDAV/VTODO objects.

### Architecture
```
User/LLM
    ↓
tsdav-utils (field manipulation) ← YOU BUILD THIS
    ↓
tsdav (network transport) + ical.js (parsing)
    ↓
CalDAV/CardDAV Server
```

### Core Philosophy

**"Parse anything, write anything"**
- Zero business logic
- No "supported fields" lists
- No validation
- Maximum flexibility
- Custom extensions welcome (RFC 5545 compliant)

This library is **dumb glue code** - all intelligence lives in the user/MCP layer.

---

## Project Setup

### Package Configuration
- **Name:** `tsdav-utils`
- **Description:** Field-agnostic utility layer for tsdav CalDAV/CardDAV operations
- **Target:** ESM + CJS (Node.js + Browser)
- **Language:** TypeScript
- **Build:** Same tooling as tsdav (esbuild/tsup)
- **Tests:** Vitest

### Dependencies
```json
{
  "peerDependencies": {
    "tsdav": "^2.x.x"
  },
  "dependencies": {
    "ical.js": "^1.x.x"
  },
  "devDependencies": {
    "typescript": "^5.x.x",
    "vitest": "^1.x.x"
  }
}
```

### File Structure
```
tsdav-utils/
├── src/
│   ├── index.ts          # Public API exports
│   ├── updateFields.ts   # Core logic
│   └── types.ts          # TypeScript types
├── test/
│   ├── updateFields.test.ts
│   └── fixtures/         # Real iCal test data
├── CLAUDE.md             # This file
├── GIT_WORKFLOW.md       # Git/GitHub rules
├── README.md             # User documentation
├── package.json
└── tsconfig.json
```

---

## Core Functionality

### Primary API: updateFields()

**Single responsibility:** Take any calendar/todo/vcard object + key-value pairs → return updated object
```typescript
import { updateFields } from 'tsdav-utils';

// Works for ANY property - no hardcoded field list
const updated = updateFields(calendarObject, {
  'SUMMARY': 'New Title',
  'LOCATION': 'Berlin',
  'DTSTART': '20250128T100000Z',
  'X-CUSTOM-FIELD': 'anything',
  'X-ZOOM-LINK': 'https://zoom.us/j/123456789'
});
```

### Requirements

**Must support:**
- Accept **any** iCal property name (standard or custom)
- No type restrictions on values (strings, user handles formatting)
- Preserve all other fields unchanged
- Work with VEVENT, VTODO, VCARD components
- Return new object (immutable operations)

**Implementation constraints:**
- User provides values in iCal format (no datetime parsing/conversion)
- No validation of property names or values
- No semantic understanding of fields (library doesn't know DTSTART is a date)

---

## Implementation Strategy

### Phase 1: Research & Discovery

Before writing code, answer these questions:

1. **tsdav output format:**
   - Does `fetchCalendarObject()` return raw iCal string, or parsed object?
   - Check tsdav source code and types

2. **ical.js API:**
   - How to parse: `ICAL.Component.fromString()`?
   - How to set properties: `component.updatePropertyWithValue()`?
   - How to serialize: `component.toString()`?

3. **Property preservation:**
   - If I update SUMMARY, does ical.js automatically keep DTSTART/LOCATION/etc?
   - Test with sample iCal data

4. **Component types:**
   - Does ical.js differentiate VEVENT/VTODO/VCARD?
   - Can one function handle all three?

5. **Error handling:**
   - What happens with invalid iCal input?
   - Should we crash or fail gracefully?

**Document findings before implementation.**

### Phase 2: Core Implementation
```typescript
// src/updateFields.ts

/**
 * Update arbitrary fields on a calendar object
 * 
 * @param calendarObject - iCal string or parsed object from tsdav
 * @param fields - Key-value pairs of iCal properties to update
 * @returns Updated iCal string ready for tsdav.updateCalendarObject()
 */
export function updateFields(
  calendarObject: string | object,
  fields: Record<string, string>
): string {
  // 1. Parse to ical.js Component
  const component = parseToIcalComponent(calendarObject);
  
  // 2. Set properties (field-agnostic loop)
  for (const [key, value] of Object.entries(fields)) {
    // Use ical.js API to set property
    // Research exact method name
  }
  
  // 3. Serialize back to iCal string
  return component.toString();
}
```

### Phase 3: Testing

**Test matrix:**
```typescript
describe('updateFields', () => {
  describe('VEVENT (events)', () => {
    it('updates SUMMARY');
    it('updates LOCATION');
    it('updates DTSTART');
    it('updates multiple fields simultaneously');
    it('preserves unmodified fields');
    it('handles custom properties (X-ZOOM-LINK)');
  });

  describe('VTODO (todos)', () => {
    it('updates SUMMARY');
    it('updates STATUS');
    it('updates PRIORITY');
    it('updates DUE');
    it('preserves unmodified fields');
  });

  describe('VCARD (contacts)', () => {
    it('updates FN');
    it('updates EMAIL');
    it('updates TEL');
    it('preserves unmodified fields');
  });

  describe('Edge cases', () => {
    it('accepts unknown property names (typos)');
    it('handles empty fields object');
    it('returns immutable result (does not mutate input)');
  });
});
```

**Use real iCal fixtures** from tsdav or create minimal valid examples.

### Phase 4: Documentation

**README.md must include:**

1. **What this is:**
   - Field-agnostic utility for tsdav
   - Bridges gap between tsdav (transport) and user code

2. **What this is NOT:**
   - Not a validation layer
   - Not a high-level API
   - Not a replacement for tsdav

3. **Installation:**
```bash
   npm install tsdav tsdav-utils
```

4. **Usage example:**
```typescript
   import { createDAVClient } from 'tsdav';
   import { updateFields } from 'tsdav-utils';

   const client = await createDAVClient({...});
   
   // Fetch event
   const events = await client.fetchCalendarObjects({...});
   const event = events[0];
   
   // Update fields
   const updated = updateFields(event.data, {
     'LOCATION': 'Berlin Office',
     'X-MEETING-ROOM': 'Conference Room A'
   });
   
   // Save back
   await client.updateCalendarObject({
     calendarObject: {
       ...event,
       data: updated
     }
   });
```

5. **Known limitations** (link to GitHub issues):
   - Multi-value properties (ATTENDEE with multiple people)
   - Structured properties (VCARD.N components)
   - Timezone handling complexity
   - All-day vs timed events

6. **Philosophy:**
   - Users must understand iCal property names
   - Users must provide correctly formatted values
   - This library does NOT validate or transform

---

## Scope Boundaries

### ✅ In Scope (v1.0)

**Must implement:**
- Field updates for VEVENT (calendar events)
- Field updates for VTODO (tasks/todos)
- Field updates for VCARD (contacts)
- Accept any property name (standard + custom)
- Immutable operations (return new object, don't mutate)
- Basic error handling (invalid iCal input)

### ❌ Out of Scope

**Never implement:**
- High-level helpers (`rescheduleEvent()`, `markComplete()`)
- Validation (property names, value formats)
- Query/filter operations (`findTodosByStatus()`)
- Datetime parsing/conversion (user provides iCal format)
- Timezone conversions
- Multi-language field names (only iCal property names)

**Later (create GitHub issues):**
- Multi-value property handling (ATTENDEE with 3 people)
- Structured property handling (VCARD.N with 5 components)
- Advanced timezone support
- Recurrence rule parsing (RRULE complexity)

**Separate concern:**
- MCP integration (different layer entirely)
- LLM-friendly field mapping (MCP's job)
- Natural language to iCal translation (MCP's job)

---

## TypeScript Types

**Keep types minimal and generic:**
```typescript
// src/types.ts

/**
 * Generic field update map
 * Any iCal property name → any string value
 */
export interface FieldUpdates {
  [key: string]: string;
}

/**
 * Calendar object input (flexible)
 * Accepts tsdav output format
 */
export type CalendarObjectInput = string | {
  data: string;
  // other tsdav properties
};

/**
 * Update fields on a calendar object
 */
export function updateFields(
  calendarObject: CalendarObjectInput,
  fields: FieldUpdates
): string;
```

**No fancy types:**
- No union types for specific properties
- No enums for STATUS/PRIORITY values
- No TypeScript magic - keep it stupid simple

---

## Success Criteria

### Implementation Complete When:

- [ ] `updateFields()` works for VEVENT
- [ ] `updateFields()` works for VTODO
- [ ] `updateFields()` works for VCARD
- [ ] Can update any property (standard + custom)
- [ ] Tests pass for all component types
- [ ] Unmodified fields are preserved
- [ ] Immutable (original object unchanged)
- [ ] Works with real tsdav integration
- [ ] README has working example
- [ ] Published to npm

### Quality Checklist:

- [ ] No hardcoded field lists in code
- [ ] No business logic (zero semantic understanding)
- [ ] No validation beyond "is this valid iCal?"
- [ ] Code is <200 LOC (keep it simple)
- [ ] All tests use real iCal fixtures
- [ ] README clearly states limitations
- [ ] GitHub issues created for future work

---

## Development Workflow

### Step 1: Repository Setup
1. Initialize git repository
2. Configure git identity (see GIT_WORKFLOW.md)
3. Create GitHub repository
4. Setup npm package structure
5. Install dependencies

### Step 2: Research Phase
1. Study tsdav source code (understand input/output)
2. Study ical.js documentation (understand API)
3. Write minimal proof-of-concept (single field update)
4. Document findings

### Step 3: Implementation
1. Create feature branch
2. Implement `updateFields()` core logic
3. Add TypeScript types
4. Commit frequently (see GIT_WORKFLOW.md)

### Step 4: Testing
1. Create test fixtures (real iCal data)
2. Write comprehensive test suite
3. Ensure all tests pass
4. Test with actual tsdav integration

### Step 5: Documentation
1. Write README with usage examples
2. Document known limitations
3. Create GitHub issues for future work
4. Add JSDoc comments to functions

### Step 6: Release
1. Verify all success criteria met
2. Create pull request
3. Merge to main
4. Tag v1.0.0 release
5. Publish to npm

---

## Common Pitfalls to Avoid

**❌ Don't do this:**
- Adding field-specific logic (if property === 'DTSTART' then...)
- Creating enums for STATUS/PRIORITY values
- Validating datetime formats
- Converting between ISO 8601 and iCal formats
- Building helper functions for common operations
- Adding "convenience" APIs

**✅ Do this instead:**
- Generic key-value loop (for any property)
- Accept any string value (user's responsibility)
- Trust ical.js to handle formats
- Let user handle conversions
- Keep API surface minimal
- Document what user must do

---

## Questions & Debugging

### If ical.js doesn't preserve fields:
- Check if you're using correct Component type (VEVENT vs VCALENDAR)
- Verify you're updating properties, not replacing component
- Test with minimal iCal fixture

### If tsdav integration fails:
- Check input format from `fetchCalendarObject()`
- Verify output format matches `updateCalendarObject()` expectations
- Add logging to see actual iCal strings

### If tests fail:
- Use real iCal fixtures (not hand-written)
- Test with multiple CalDAV providers (Google, iCloud, Nextcloud)
- Check ical.js version compatibility

### If uncertain about design:
- Refer back to core philosophy: "Parse anything, write anything"
- Ask: "Does this add business logic?" If yes, remove it
- Keep it simple - when in doubt, do less

---

## Reference Links

- **tsdav:** https://github.com/natelindev/tsdav
- **ical.js:** https://github.com/kewisch/ical.js
- **RFC 5545 (iCalendar):** https://datatracker.ietf.org/doc/html/rfc5545
- **RFC 6350 (vCard):** https://datatracker.ietf.org/doc/html/rfc6350

---

## Notes for Future Maintainers

This library intentionally does **very little**. That's by design.

The goal is maximum flexibility with minimum code. If you're tempted to add features, ask:
1. Does this add business logic? (If yes, don't add it)
2. Could this be done in user code? (If yes, don't add it)
3. Does this restrict what properties can be used? (If yes, don't add it)

The only valid additions:
- Bug fixes (properties not being preserved, etc.)
- Performance improvements (faster parsing)
- Better error messages (clearer failures)

Everything else belongs in a separate library or the user's code.
