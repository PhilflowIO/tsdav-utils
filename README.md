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
npm install @philflow/tsdav-utils
```

Code that imports `tsdav-utils` keeps its imports and installs the package under an alias:

```bash
npm install tsdav-utils@npm:@philflow/tsdav-utils
```

Releases are published to npm from this repository's release workflow, with a provenance attestation. Installing from git (`github:PhilflowIO/tsdav-utils#<tag>`) is not supported: npm 12 refuses git dependencies by default.

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

// Todo/Task (VTODO) — name the type when you know what you are editing
const updatedTodo = updateFields(todo.data, {
  'SUMMARY': 'Finish documentation',
  'STATUS': 'IN-PROCESS',
  'PRIORITY': '1',
}, { type: 'vtodo' });

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

- **options.absoluteTime**: `'as-given' | 'keep-zone'` (default `'as-given'`)
  - How a date-time with `Z` or an offset is written where the property or its
    DTSTART has a `TZID`: as UTC, or converted into that `TZID`, which stays (see
    [Keeping the zone](#keeping-the-zone-absolutetime))

- **options.zone**: an IANA time zone name, e.g. `'Europe/Berlin'` (optional)
  - Writes the call's date-times as wall-clock times in that zone, with `TZID`,
    and adds a `VTIMEZONE` for it when the `VCALENDAR` has none (see
    [Writing in a named zone](#writing-in-a-named-zone-zone)). Replaces
    `floatingTime` and `absoluteTime`

- **options.type**: `'vevent' | 'vtodo' | 'vjournal'` (optional)
  - The component type to write into. Without it the first type present is taken
    (`VEVENT`, then `VTODO`, then `VJOURNAL`, see [Recurring events and todos](#recurring-events-and-todos))
  - Throws if the object holds no component of that type (`COMPONENT_NOT_FOUND`; the
    message names the types it does hold), if the value is not one of the three
    (`INVALID_TYPE`), or if the object is a bare component of another type or a
    vCard (`WRONG_OBJECT_KIND`)
  - Name it when you know what you are editing: on an object that holds a `VEVENT`
    and a `VTODO` (which RFC 4791 4.1 forbids, but servers do store),
    `updateFields(todo.data, { DUE: '...' }, { type: 'vtodo' })` writes into the todo
    instead of the event

#### Returns

- `string`: Updated iCal string ready for `tsdav.updateCalendarObject()`

#### Throws

- `UpdateFieldsError` with a stable `code` when the call asks for something the
  object cannot take; nothing is written. See [Errors](#errors).

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

- A value with `Z` or an offset is converted to UTC; any `TZID` on the old value is
  removed — unless `{ absoluteTime: 'keep-zone' }` or `{ zone: '<IANA name>' }`
  is given (see below). For anything that recurs, or that people read in local
  time, write it in a named zone: a UTC series moves by an hour in local time
  at every DST change.
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

### Keeping the zone: `absoluteTime`

By default (`absoluteTime: 'as-given'`) an instant is written as the caller gave
it, in UTC. On a series in a zone that is often not what was meant: an LLM that
moves a weekly 09:00 Europe/Berlin series with `2026-10-06T08:00:00Z` turns the
whole series into UTC, and after the DST change every occurrence sits an hour
earlier in Berlin. With `{ absoluteTime: 'keep-zone' }` the instant is written as
its wall-clock time in the zone that applies, and the `TZID` stays:

```typescript
// DTSTART;TZID=Europe/Berlin:20261005T090000 + RRULE:FREQ=WEEKLY
updateFields(event, { DTSTART: '2026-10-06T08:00:00Z' });
// DTSTART:20261006T080000Z — 10:00 in October, 09:00 in Berlin from 25 October on
updateFields(event, { DTSTART: '2026-10-06T08:00:00Z' }, { absoluteTime: 'keep-zone' });
// DTSTART;TZID=Europe/Berlin:20261006T100000 — 10:00 in Berlin, every week
```

- The zone that applies is the one a value without a zone would be read in: the
  property's own `TZID`, else (for DTEND, DUE, EXDATE, RDATE, RECURRENCE-ID) the
  `TZID` of DTSTART. The zone's rules come from the object's `VTIMEZONE`, else the
  IANA zone of that name; a `TZID` that is neither throws (`UNKNOWN_TZID`)
  instead of falling back to UTC.
- An instant in the second pass of the hour a DST change shows twice has no wall
  clock of its own there (that wall-clock time reads as the first pass, RFC 5545
  3.3.5), so it throws (`DST_AMBIGUOUS`). The first pass is written as is; no
  instant falls in a skipped hour.
- Where no zone applies — a value with no `TZID` of its own next to a UTC or
  floating DTSTART or no DTSTART at all (a `DUE` with its own `TZID` is
  converted, DTSTART or not), the UTC-only `COMPLETED`/`CREATED`/`DTSTAMP`/`LAST-MODIFIED` — the instant is written
  as UTC, as by default. All-day rules are unchanged: a date-time next to an
  all-day DTSTART still throws.
- Values without a zone, and dates, are not affected; `floatingTime` governs those.
- The rest of a series follows a moved DTSTART as always (see
  [Recurring events and todos](#recurring-events-and-todos)); kept in its zone,
  the move is measured on that zone's wall clock.

### Writing in a named zone: `zone`

`absoluteTime: 'keep-zone'` keeps a `TZID` that is already there; `zone` brings
one in. With `{ zone: 'Europe/Berlin' }` every date-time the call writes is a
wall-clock time in Berlin and is written with `TZID=Europe/Berlin`, and the
`VCALENDAR` gets a `VTIMEZONE` for it if it has none (RFC 5545 3.6.5 requires
one per `TZID`). A weekly meeting created this way stays at 09:00 in Berlin
across every DST change:

```typescript
updateFields(skeleton, {
  DTSTART: '2026-10-05T09:00:00', DTEND: '2026-10-05T10:00:00', RRULE: 'FREQ=WEEKLY',
}, { zone: 'Europe/Berlin' });
// BEGIN:VTIMEZONE ... TZID:Europe/Berlin ... END:VTIMEZONE
// DTSTART;TZID=Europe/Berlin:20261005T090000
// DTEND;TZID=Europe/Berlin:20261005T100000

updateFields(skeleton, { DTSTART: '2026-10-05T07:00:00Z' }, { zone: 'Europe/Berlin' });
// DTSTART;TZID=Europe/Berlin:20261005T090000 — the instant, as Berlin wall clock
```

- **A value without a zone** is wall clock in the zone. One the zone's DST
  change skips (02:30 on the last Sunday of March in Berlin) is written as given
  and reads as the time as far past the gap (03:30), one it shows twice as the
  first pass (RFC 5545 3.3.5).
- **A value with `Z` or an offset** is written as the wall-clock time of that
  instant in the zone. An instant in the second pass of the repeated hour has
  no wall-clock time of its own there, so it throws (`DST_AMBIGUOUS`).
- **Dates** (`VALUE=DATE`, all-day) have no zone and are written as dates.
- **`COMPLETED`, `CREATED`, `DTSTAMP`, `LAST-MODIFIED`** must stay UTC: a value
  without a zone is read in the zone and written as UTC. The same for a vCard,
  which has no `TZID`.
- **DTEND, DUE, EXDATE, RDATE, RECURRENCE-ID and `UNTIL` follow DTSTART**, as
  always: written in the same call as DTSTART, they are written in the zone
  too, whatever the key order. Without DTSTART in the call they can only be
  written in the zone if DTSTART is already in it (or the component has none,
  like a todo with only `DUE`); next to a DTSTART in UTC, floating or another
  zone they throw `ZONE_MISMATCH` (`remedy: 'same-call'`) — give DTSTART in the
  same call, which moves the event into the zone. A property's own `TZID` (an
  end in another zone than its start) is replaced by the zone.
- **Moving an existing series into a zone** is a DTSTART write like any other
  (see [Recurring events and todos](#recurring-events-and-todos)): each
  occurrence, `EXDATE`, `RDATE`, `UNTIL` and override keeps its place in the
  series — its distance from DTSTART on the old wall clock — and lands at that
  distance from the new DTSTART on the zone's wall clock. A weekly 09:00 New
  York series written with `DTSTART` 15:00 and `zone: 'Europe/Berlin'` becomes a
  weekly 15:00 Berlin series with every exclusion and override on its week; a
  weekly `07:00Z` series written with `DTSTART: '...T07:00:00Z'` becomes 09:00
  Berlin every week, so the occurrences after the October change are 08:00Z,
  where they were 07:00Z — that is the change asked for. The instants of the old
  series are not kept: a series in a zone keeps local time, and that is what
  differs. What a move refuses (a rule that pins the old time, an `UNTIL` at a
  DST change, ...) is refused here too.
- **Precedence:** `zone` decides how every date-time is read and written.
  `floatingTime` (either value) and `absoluteTime: 'as-given'` say something
  else, so giving them with `zone` throws (`INVALID_FLOATING_TIME`,
  `INVALID_ABSOLUTE_TIME`); `absoluteTime: 'keep-zone'` agrees and may be given.
- **The name** is an IANA zone the runtime's time zone data knows
  (`Europe/Berlin`, `America/New_York`, `Asia/Kolkata`, `UTC`), spelled as the
  data spells it (`europe/berlin` is written `Europe/Berlin`; an alias like
  `Asia/Kolkata` is kept, not replaced by the name the runtime links it to), or a
  zone the object defines in a `VTIMEZONE` of that `TZID`. Anything else —
  `Mars/Olympus`, `CEST`, `+01:00` — throws `UNKNOWN_TZID`.

**The generated `VTIMEZONE`.** A `VTIMEZONE` the object already has for the
`TZID` is kept as it is and the values are converted with it: it is what every
other reader of the object goes by. Otherwise one is generated from the
runtime's IANA data (Intl) and placed before the components:

- It starts on 1 January 1970 (or the year before the earliest value in the
  zone, if that is earlier), with an observance that only states the offset
  then. ical.js reads every time before a `VTIMEZONE`'s first observance with
  offset 0, so a later write that moves the event back in time stays covered.
- Every run of three or more years in which the zone changes by one yearly rule
  is a `DAYLIGHT`/`STANDARD` pair with an `RRULE` (`BYDAY=-1SU`, `BYDAY=2SU`, or
  "the first Friday on or after the 23rd" as `BYMONTHDAY=23,...,29;BYDAY=FR`),
  ended by `UNTIL` where the rule ended. The zone's current rule has no `UNTIL`,
  so an unbounded series is covered for good — the form Google and Thunderbird
  write, with the rules the zone actually had since 1970 before it.
- Every other change — a one-year decree, a change of standard time like
  `Europe/Moscow` 2014 or the end of DST in `America/Sao_Paulo` 2019 — is listed
  by date (`RDATE`). A zone whose DST follows no yearly rule (`Africa/Casablanca`
  pauses it for Ramadan) is listed until the time zone data stops changing it.
  A zone that never changes has a single `STANDARD` observance.
- Before it is used, the `VTIMEZONE` is read back and compared with Intl at every
  instant the generator looked at; the tests compare it, read with this
  library's reader and with ical.js, with Intl for 16 zones (and every zone with
  `VTIMEZONE_ALL_ZONES=1`).
- The same input gives the same text, and a second write finds the `VTIMEZONE`
  and adds no other.
- It is only added to a `VCALENDAR`: a bare `VEVENT`/`VTODO` gets the `TZID`, and
  the `VTIMEZONE` comes with the `VCALENDAR` you wrap it in. A `VTIMEZONE` that
  no value uses any more (after a series moved into another zone) is left in
  place.
- A zone on local mean time at the dates given (before standard time, e.g.
  `Africa/Monrovia` until 1972) had an offset in seconds, which ical.js and other
  readers cannot hold: such a value throws `UNSUPPORTED_VTIMEZONE`.

To validate input before calling `updateFields`, use the same grammar:
`parseDateValue(value)` returns `{ kind: 'date' | 'utc' | 'floating', jcal }` or
throws naming the accepted forms.

Apart from following DTSTART, each value is encoded on its own. Keeping related
properties consistent — DUE vs. DURATION, say — is the caller's job; an RRULE
`UNTIL` follows DTSTART (see [Recurrence rules](#recurrence-rules)). Like every other property, only the first
`EXDATE`/`RDATE` line is replaced.

## Recurrence rules

`RRULE` (and the deprecated `EXRULE`, the other RECUR-typed property) is parsed
too: written verbatim, ical.js serializes the string character by character
(`RRULE:0=F;1=R;2=E;...`) and servers reject the object. The rule is checked
against RFC 5545 3.3.10 and written as a typed value:

```typescript
updateFields(event, { RRULE: 'FREQ=DAILY;COUNT=5' });          // RRULE:FREQ=DAILY;COUNT=5
updateFields(event, { RRULE: 'freq=monthly;byday=-1fr' });     // RRULE:FREQ=MONTHLY;BYDAY=-1FR
updateFields(event, { RRULE: 'FREQ=DAILY;UNTIL=2026-10-26T14:00:00-04:00' });
                                                                // RRULE:FREQ=DAILY;UNTIL=20261026T180000Z
```

- `FREQ` is required; only the parts RFC 5545 defines are accepted (`FREQ`,
  `UNTIL`, `COUNT`, `INTERVAL`, `BYSECOND` ... `BYSETPOS`, `WKST`), each once,
  with values in range. Names and values are case-insensitive; an empty part
  (a trailing `;`) is ignored. Give the value only (`FREQ=DAILY`, not
  `RRULE:FREQ=DAILY`). The RFC 7529 parts `RSCALE` and `SKIP` are refused:
  ical.js cannot write them without losing them.
- Combinations the RFC rules out throw: `COUNT` with `UNTIL`, `BYWEEKNO` without
  `FREQ=YEARLY`, `BYYEARDAY` with `DAILY`/`WEEKLY`/`MONTHLY`, `BYMONTHDAY` with
  `WEEKLY`, an ordinal `BYDAY` (`1MO`) outside `MONTHLY`/`YEARLY` or with
  `BYWEEKNO`, `BYSETPOS` without another `BYxxx` part.
- ical.js itself would silently drop unknown parts, a zero `COUNT` or `INTERVAL`,
  and accept a rule without `FREQ`; here each of these throws, naming the
  property and what is wrong.
- `UNTIL` takes the same input forms as the date properties above
  (`parseDateValue`) and is written in the form RFC 5545 3.3.10 ties to DTSTART:
  - all-day DTSTART: a date (`UNTIL=20261026`); a date-time throws;
  - UTC DTSTART: UTC. A value with `Z` or an offset is converted; one without a
    zone throws under the default and is read in the host timezone with
    `{ floatingTime: 'local' }`, as for DTEND;
  - DTSTART with a `TZID`: UTC. A value without a zone is wall clock in that
    zone and is converted with the `VTIMEZONE` in the document, or, when the
    document has none, with the IANA zone of that name (`Europe/Berlin`) from the
    runtime's time zone data. **For a `TZID` that is neither (`W. Europe Standard
    Time`), it throws and asks for a UTC or offset value** — the zone's offset
    rules are unknown, and guessing one could end the series hours early or late.
    A `VTIMEZONE` is read from its own observances (`DTSTART`, `RDATE`, `RRULE`
    with `UNTIL`), not with ical.js' `convertToZone`, which is off by an hour for
    up to five hours around each DST change ([ical.js#847](https://github.com/kewisch/ical.js/issues/847)).
    Observance rules other than `YEARLY` or `MONTHLY`, which no real zone has,
    are refused.
    A wall-clock time a change makes ambiguous is its first occurrence, and one
    that does not exist lies past the gap by as much as it was into it (02:30 on
    the spring-forward night is 03:30), as RFC 5545 3.3.5 reads them;
  - floating DTSTART: floating; a value with a zone throws;
  - a date next to a timed DTSTART throws;
  - with no DTSTART, `UNTIL` is written in the form given.
  DTSTART is written first, so `UNTIL` follows the new DTSTART whatever the key
  order.
- Writing DTSTART also moves an existing `UNTIL` (of an RRULE/EXRULE not
  written in the same call) with the series — see
  [Recurring events and todos](#recurring-events-and-todos). A `COUNT` rule, or
  an event without a rule, is left as it is.

## Recurring events and todos

A recurring event or todo can hold, next to its master, override components for
single instances: same `UID`, plus a `RECURRENCE-ID` (RFC 5545 3.8.4.4). Servers
store them in any order. `updateFields` always edits the **master**, the
`VEVENT`/`VTODO`/`VJOURNAL` without `RECURRENCE-ID`, so a series-level change
(`SUMMARY`, `EXDATE`, `RRULE`, `DTSTART`, ...) reaches the series, and date-times
follow the master's `DTSTART` (see above).

- **A new `SUMMARY` on the master does not rename an override.** Each override
  is an independent instance; to change one, edit it with ical.js directly.
- **An object with only overrides** (a detached instance stored without its
  master): a single component is edited as it is; with several there is no
  telling which one is meant, so `updateFields` throws.
- **Writing the master's `DTSTART` moves the whole series.** The rule: the
  occurrences after the call are the occurrences before, each moved by the
  distance DTSTART moved, and each override sits on its moved occurrence at its
  own time moved by the same distance. So every `RECURRENCE-ID`, `EXDATE`, `RDATE`
  and `UNTIL` the call does not write itself moves along, and so do each
  override's own `DTSTART`/`DTEND`/`DUE` — a rescheduled instance and one that
  only changed its title alike. Thunderbird moves a series the same way.
  - The distance is measured on the series' wall clock, so a 09:00 Berlin series
    moved to 10:00 keeps landing on 10:00 across a DST change; moved values are
    written in the new DTSTART's form (its `TZID`, UTC, floating, or a date).
    Moving a series into a named zone (`zone`) is such a move, onto that zone's
    wall clock (see [Writing in a named zone](#writing-in-a-named-zone-zone)).
  - An override's own times move on that same wall clock and keep their own
    form: an instance rescheduled to Monday 09:00 Berlin stays at 09:00 when the
    series moves a week across a DST change — also when it is written in UTC,
    whose value then changes by the hour the offset changed.
  - Across an all-day/timed switch the distance counts in days: an occurrence
    keeps its day and becomes a date or takes the new DTSTART's time of day; an
    override keeps its own time on its day.
  - When the call gives no `RRULE`, the move is accepted only where the rule
    provably moves with it, decided from the rule itself (nothing is expanded).
    The move splits into a change of date and a change of time of day:

    | The rule has | it follows |
    |---|---|
    | no `BY` part, `FREQ` up to `WEEKLY` | any move |
    | no `BY` part, `MONTHLY` | a new time, or a new date in the same month between the 1st and 28th |
    | no `BY` part, `YEARLY` | a new time, or a new date every year has (not 29 February), the same number of days away in every year (not across the end of February) |
    | `BYHOUR`, `BYMINUTE`, `BYSECOND` | a new date, at the same time of day |
    | `BYDAY` with `DAILY`/`WEEKLY` | a new time, or a move by whole weeks |
    | `BYDAY` with `MONTHLY`/`YEARLY`; `BYMONTH`, `BYMONTHDAY`, `BYYEARDAY`, `BYWEEKNO`, `BYSETPOS` | a new time, on the same date |
    | a date-picking part with `HOURLY`/`MINUTELY`/`SECONDLY` | no move |

    An all-day/timed switch counts as a new time. A part that only restates
    DTSTART, as Google and Outlook write rules — a single `BYDAY` equal to its
    weekday in a `WEEKLY` rule, a single `BYMONTHDAY` equal to its day in a
    `MONTHLY` rule, a single `BYMONTH` equal to its month in a `YEARLY` rule (and
    with it a single `BYMONTHDAY` equal to its day) — follows the move: the rule
    is judged without it, and the part is rewritten to the new start
    (`FREQ=WEEKLY;BYDAY=MO` moved from Monday to Tuesday becomes `BYDAY=TU`).
    Only that token changes, in the rule as the object wrote it: part names keep
    their case, the parts their order, every other byte stays (the same for a
    moved `UNTIL`). A rule that gives a part twice, which RFC 5545 does not
    allow and clients read differently, is refused. Anything else throws and
    says why. Where a single `BYDAY`, `BYMONTHDAY`, `BYMONTH`, `BYHOUR` or `BYMINUTE`
    value pins the old start, the error suggests the rule with the new start's
    value, e.g. `RRULE "FREQ=WEEKLY;COUNT=3;BYDAY=TU"` for a Monday series moved to
    Tuesday; otherwise it says to give `RRULE` in the same call. Weekly by weekday
    at a new time, daily, and monthly by a date up to the 28th are always accepted.
  - When the call gives `RRULE` or `RDATE`, the series is expanded up to the
    furthest override or `EXDATE` to check they still name occurrences. That work
    is bounded (also for a large `INTERVAL`). Where the check cannot be made — a
    rule too sparse or an override too far ahead to check within the bound, a
    zone that cannot be read, a rule ical.js cannot expand — it fails closed:
    it throws, says why, and asks for a rewrite of the object (see
    [Errors](#errors); ical.js failing to expand a rule is a plain `Error`,
    a failure of the library, not of the call).
  - **To start a series later without moving it** (drop its first weeks), give
    `RRULE`, `UNTIL` and `EXDATE` explicitly in the same call, or replace the
    object: a bare `DTSTART` write moves every occurrence.
  - **A value that cannot be moved with its meaning kept is refused**, never
    moved approximately. The error says why and what to give instead:
    - a UTC value next to a `TZID` that is neither in a `VTIMEZONE` nor an IANA
      zone, a UTC value in a floating series, an `RDATE` of periods;
    - an `UNTIL` of the other value type than DTSTART (a date next to a timed
      DTSTART), and an `UNTIL` at a DST change — in the repeated hour, just past
      a skipped hour, or moved into one — where the wall clock and the order of
      instants part, so it could let one occurrence too many or too few through;
    - an `RDATE` or `EXDATE` of a whole day next to a timed series on a move that
      changes the time of day (on a move by whole days it stays a date);
    - a rule with parts RFC 5545 does not define (`X-…`, `BYEASTER`, RFC 7529
      `RSCALE`/`SKIP`), which writing the rule again would lose;
    - an `EXDATE`, `RECURRENCE-ID` or `RDATE` that shares its instant with an
      occurrence on a wall-clock time a DST change skips (read past the gap,
      RFC 5545 3.3.5), in whatever zone it is written — UTC, another zone, or
      the series' own zone as the first time after the gap (`03:30` for a
      skipped `02:30`). Clients match it to that occurrence by instant, the move
      by wall clock, so which one it names cannot be told. Checked before and
      after a write that changes the occurrences (a DTSTART move, a new `RRULE`
      or `RDATE`), where the series has such an occurrence;
    - an override's own `DTSTART`/`DTEND`/`DUE` in another zone than the series
      that, moved, would fall in the second pass of that zone's repeated hour,
      where its wall clock reads as the first;
    - on a switch from timed to all-day, a `RECURRENCE-ID`, `EXDATE` or `RDATE`
      at another time of day than the series (or a date already): as a date it
      could name an occurrence it never named, or fall together with another.

  ```typescript
  // weekly at 09:00Z, override RECURRENCE-ID:20261012T090000Z moved to 13:00
  updateFields(event, { DTSTART: '20261005T100000Z' });
  // master DTSTART:20261005T100000Z, override RECURRENCE-ID:20261012T100000Z,
  // DTSTART:20261012T140000Z — the whole series, moved instance included, an hour later
  ```
- **When the call gives `RRULE` or `RDATE`, the occurrences are the caller's** —
  values the call writes are never moved — but every override and `EXDATE` that
  named an occurrence before must still name one. If one would not, `updateFields`
  throws, naming each: give an `RRULE` that keeps those occurrences and `EXDATE`
  with the exclusions the new series should have, or rewrite the whole object to
  move or remove the override. An override that was already stale before the
  call does not block it.
- **`RECURRENCE-ID` is not written on a master** (or a plain event): it would turn
  the series into an override of a single instance. It throws; a lone detached
  instance, which has one already, can still be given a new one. An override
  edited on its own is not a master, and none of the above applies to it.
- All of this holds for a bare `VEVENT`/`VTODO` too, without a `VCALENDAR` around it.
- **Reading the same component yourself:** `seriesMaster(calendar, type?)` returns
  the component `updateFields` edits, for a parsed `ICAL.Component` VCALENDAR —
  use it to check what was written (e.g. DTEND against DTSTART) instead of
  `getFirstSubcomponent`.
- The component type is chosen first (`VEVENT`, then `VTODO`, then `VJOURNAL`),
  since a CalDAV object holds one type (RFC 4791 4.1). Name it explicitly with
  `updateFields(obj, fields, { type: 'vtodo' })` or `seriesMaster(calendar, 'vtodo')`.

## Errors

Every refusal of `updateFields`, `seriesMaster` and `parseDateValue` throws an
`UpdateFieldsError`, and nothing is written. It is an `Error` (so `instanceof
Error` holds) with:

- `code` — the stable reason (table below);
- `remedy` — what the caller can do, as the message says it: `'fix-value'`
  (correct a value or option given), `'same-call'` (give the properties the
  message names — RRULE, UNTIL, EXDATE, RDATE — in the same `updateFields` call),
  `'rewrite-object'` (the change cannot be made as field writes, or the object
  itself is broken: replace the whole object), `'none'` (nothing in this call
  helps, e.g. a vCard handed to an iCalendar write);
- `property` — the property it is about, where there is one (upper-cased:
  `"DTEND"`, `"RRULE"`);
- `suggestion` — a value that would be accepted, where the library can tell: for
  `SERIES_MOVE_REFUSED`, the rule to give with the new start;
- `cause` — when a refusal is reported with a longer message (`DTEND: ...`,
  `DTSTART changed, and ...`), the refusal it reports; for `INVALID_ICALENDAR`,
  the ical.js parse error.

Branch on `code` and `remedy`, not on the message: the messages explain and may
be reworded. **Anything else thrown is a plain `Error`**: a failure of the library
(or of ical.js) rather than of the call, never to be handed back to the caller
as a mistake to correct.

```typescript
import { updateFields, isUpdateFieldsError } from '@philflow/tsdav-utils';

function move(data: string, start: string) {
  try {
    return { ok: true, data: updateFields(data, { DTSTART: start }) };
  } catch (error) {
    if (!isUpdateFieldsError(error)) throw error;  // a library failure, not the caller's mistake
    return { ok: false, ...error.toJSON() };       // code, remedy, message, property, suggestion
  }
}
```

`isUpdateFieldsError(error, code?)` checks the name and code rather than the
class, so it also holds when both the ESM and the CommonJS build are loaded;
given a code, it narrows `error.code` to it. It needs the error as thrown: a copy
made by `structuredClone` or `postMessage` keeps only message and stack, so
send `error.toJSON()` across such a boundary instead. `UPDATE_FIELDS_ERROR_CODES`
lists every code (frozen); `UpdateFieldsErrorCode` and `UpdateFieldsRemedy` are
the union types.

A value already in the object that cannot be read (`EXDATE:garbage`,
`RRULE:...;UNTIL=garbage`) is refused with the same code whichever check finds
it — `INVALID_VALUE` or `INVALID_RULE`, `property` naming it — but only when the
write needs it: a SUMMARY write next to a broken RRULE goes through. A rule the
call does not write goes back byte for byte as the object spells it, broken or
not; where its line cannot be found in the text, ical.js writes it, and an
unreadable one is refused (`INVALID_RULE`) rather than rewritten.

| Code | When | Remedy |
|---|---|---|
| `INVALID_INPUT` | an argument has the wrong type: `calendarObject` not a string or `{ data: string }`, `fields` or `options` not an object, `options.zone` not a non-empty string, a non-string to `parseDateValue`, several top-level components in one text | `fix-value` |
| `INVALID_ICALENDAR` | the iCalendar or vCard text does not parse (`cause`: the ical.js error) | `rewrite-object` |
| `INVALID_TYPE` | `options.type` (or `seriesMaster`'s type) is not `vevent`, `vtodo` or `vjournal` | `fix-value` |
| `INVALID_FLOATING_TIME` | `options.floatingTime` is not `keep` or `local`, or is given together with `zone` | `fix-value` |
| `INVALID_ABSOLUTE_TIME` | `options.absoluteTime` is not `as-given` or `keep-zone`, or is `as-given` together with `zone` | `fix-value` |
| `COMPONENT_NOT_FOUND` | the VCALENDAR holds no component of the type asked for (the message names what it holds) | `fix-value` |
| `WRONG_OBJECT_KIND` | `type` given for a vCard, or for a bare component of another type | `none` (vCard), `fix-value` (bare component) |
| `NO_MASTER` | several instances with `RECURRENCE-ID` and no master, so which one is meant cannot be told | `rewrite-object` |
| `INVALID_VALUE` | a date or date-time value (also a rule's `UNTIL`) does not parse, names no real date, time or offset, or is no string; or such a value already in the object | `fix-value`; `rewrite-object` or `same-call` for a value in the object, as the message says |
| `VALUE_TYPE_MISMATCH` | a date where a date-time is needed or the other way round: next to DTSTART, on a property that takes no date, or mixed in one list | `fix-value` |
| `ZONE_MISMATCH` | a value lacks the zone it needs (next to a UTC DTSTART, on `DTSTAMP`/`CREATED`/...), has one it must not have (`UNTIL` of a floating series), or a list mixes both; or, under `zone`, a value that follows DTSTART (DTEND, DUE, EXDATE, RDATE, `UNTIL`) while DTSTART is in UTC, floating or another zone and not in the call | `fix-value`; `same-call` under `zone` (give DTSTART too); for a value in the object `same-call` where a DTSTART move would carry it, else `rewrite-object` |
| `UNKNOWN_TZID` | a TZID whose rules are needed (a time converted to or from it, `absoluteTime: 'keep-zone'`) has no `VTIMEZONE` in the object and is no IANA zone — the same code whether a move or a new rule needs it; or `options.zone` is neither | `fix-value` for a value or `zone` given; for a zone in the object `same-call` where a DTSTART move would carry the value, else `rewrite-object` |
| `UNSUPPORTED_VTIMEZONE` | a `VTIMEZONE` in the object repeats more often than monthly, or its rule cannot be read; or under `zone` a value falls in the zone's local mean time, whose offset in seconds no `VTIMEZONE` can hold | `rewrite-object`; `fix-value` under `zone` |
| `UNKNOWN_RULE_PART` | a rule given has a part RFC 5545 3.3.10 does not define, `RSCALE`/`SKIP`, or an `RRULE:` prefix | `fix-value` |
| `DUPLICATE_RULE_PART` | a rule given names a part twice | `fix-value` |
| `INVALID_RULE` | a rule given is otherwise invalid: no `FREQ`, a value out of range, `COUNT` with `UNTIL`, another combination RFC 5545 rules out; or a rule in the object cannot be read | `fix-value`; `rewrite-object` for a rule in the object |
| `RECURRENCE_ID_ON_MASTER` | `RECURRENCE-ID` written on the series master | `rewrite-object` |
| `SERIES_MOVE_REFUSED` | a DTSTART move the series cannot follow exactly: the rule pins the old start (`suggestion` holds the rule to give, when there is one), or an existing `UNTIL`, `EXDATE` or `RDATE` cannot move with it; or an override cannot, or the switch to all-day would change what a value names | `same-call`; `rewrite-object` for an override or the switch to all-day |
| `ORPHANED_EXCEPTIONS` | a new `RRULE` or `RDATE` leaves an override or `EXDATE` naming no occurrence | `same-call` |
| `DST_AMBIGUOUS` | a value of the series sits at a DST change, where the wall clock does not name one instant; or, under `absoluteTime: 'keep-zone'` or `zone`, an instant falls in the second pass of the repeated hour | `same-call` for `UNTIL`; `rewrite-object` for a value sharing its instant with a skipped occurrence, or an override; `fix-value` under `keep-zone` and `zone` |
| `CHECK_LIMIT_EXCEEDED` | the series is too sparse, or the override or `EXDATE` furthest ahead too far, to check within the work limit | `rewrite-object` on a new rule; `same-call` on a move |
| `SERIES_UNVERIFIABLE` | whether the overrides and `EXDATE`s still name occurrences cannot be checked: the series has no DTSTART | `rewrite-object` |

A refusal reported inside another keeps its code: an `UNTIL` in the repeated
hour of a DST change is `DST_AMBIGUOUS`, a zone that cannot be resolved
`UNKNOWN_TZID`, not `SERIES_MOVE_REFUSED`; the remedy follows the outer message.

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

3. **Time zones** ([#4](https://github.com/PhilflowIO/tsdav-utils/issues/4))
   - Date-times are written in a named zone with `TZID` and a generated
     `VTIMEZONE` (`zone`, see [Writing in a named zone](#writing-in-a-named-zone-zone));
     by default a value with a zone is still written as UTC, so pass `zone` for
     anything recurring or read in local time
   - The time zone data is the runtime's (Intl): a generated `VTIMEZONE` follows
     the tz database version Node ships, and an older runtime writes an older rule
   - A `VTIMEZONE` already in the object is used as it is, even where it disagrees
     with the IANA data or does not cover a value; it is never rewritten

4. **Recurrence expansion**
   - An `RRULE` is validated and written (see [Recurrence rules](#recurrence-rules)),
     but occurrences are not expanded
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
- You need to convert between zones for display, or to compute with time zones
  outside an iCalendar object → Use a datetime library
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

  // Update with field-agnostic approach, aimed at the VEVENT
  const updated = updateFields(event.data, updates, { type: 'vevent' });

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
- [npm Package](https://www.npmjs.com/package/@philflow/tsdav-utils)
- [tsdav](https://github.com/natelindev/tsdav)
- [ical.js](https://github.com/kewisch/ical.js)
- [RFC 5545 (iCalendar)](https://datatracker.ietf.org/doc/html/rfc5545)
- [RFC 6350 (vCard)](https://datatracker.ietf.org/doc/html/rfc6350)
