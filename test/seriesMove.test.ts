import { describe, it, expect } from 'vitest';
import ICAL from 'ical.js';
import { updateFields } from '../src/updateFields';

// A series moves as a whole (issue #16): when the master's DTSTART moves, the
// overrides' RECURRENCE-IDs, EXDATE and RDATE move by the same distance, and a
// rule change that would orphan an override or EXDATE is refused. The checks
// read both the serialized lines and the ical.js expansion, which is what a
// client shows.

const BERLIN = [
  'BEGIN:VTIMEZONE', 'TZID:Europe/Berlin',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST',
  'DTSTART:19700329T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET',
  'DTSTART:19701025T030000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
  'END:VTIMEZONE',
];

const master = (dtstart: string, ...props: string[]) => [
  'BEGIN:VEVENT', 'UID:series-1', 'DTSTAMP:20260101T000000Z', 'SUMMARY:Weekly',
  dtstart, ...props, 'END:VEVENT',
];
const override = (rid: string, dtstart: string, summary = 'Moved instance') => [
  'BEGIN:VEVENT', 'UID:series-1', 'DTSTAMP:20260101T000000Z',
  rid, dtstart, `SUMMARY:${summary}`, 'END:VEVENT',
];
const calendar = (...components: string[][]) => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//tsdav-utils//Test//EN',
  ...components.flat(), 'END:VCALENDAR', '',
].join('\r\n');

/** the lines of every component of a type, in document order */
const components = (ical: string, type: string): string[][] => {
  const out: string[][] = [];
  let current: string[] | null = null;
  for (const line of ical.replace(/\r?\n[ \t]/g, '').split(/\r?\n/)) {
    if (line === `BEGIN:${type}`) current = [];
    else if (line === `END:${type}`) { out.push(current!); current = null; }
    else if (current) current.push(line);
  }
  return out;
};
const isOverride = (lines: string[]) => lines.some((l) => /^RECURRENCE-ID[:;]/.test(l));
const prop = (lines: string[], name: string) =>
  lines.filter((l) => l.startsWith(`${name}:`) || l.startsWith(`${name};`));
const masterOf = (ical: string, type = 'VEVENT') => components(ical, type).find((c) => !isOverride(c))!;
const overridesOf = (ical: string, type = 'VEVENT') => components(ical, type).filter(isOverride);

/** "start summary" of every occurrence ical.js expands, overrides applied, in UTC */
const expand = (ical: string, limit = 20): string[] => {
  const vcal = new ICAL.Component(ICAL.parse(ical));
  for (const tz of vcal.getAllSubcomponents('vtimezone')) {
    ICAL.TimezoneService.register(tz);
  }
  const all = vcal.getAllSubcomponents('vevent');
  const event = new ICAL.Event(all.find((c) => !c.hasProperty('recurrence-id'))!);
  for (const ex of all.filter((c) => c.hasProperty('recurrence-id'))) {
    event.relateException(new ICAL.Event(ex));
  }
  const it = event.iterator();
  const out: string[] = [];
  let next: ICAL.Time | null;
  while ((next = it.next()) && out.length < limit) {
    const details = event.getOccurrenceDetails(next);
    const start = details.startDate;
    const when = start.isDate ? start.toString() : start.convertToZone(ICAL.Timezone.utcTimezone).toString();
    out.push(`${when} ${details.item.summary}`);
  }
  return out;
};

describe('moving DTSTART moves the overrides with the series', () => {
  // the repro of issue #16
  const weekly = calendar(
    master('DTSTART:20261005T090000Z', 'DTEND:20261005T100000Z', 'RRULE:FREQ=WEEKLY;COUNT=3'),
    override('RECURRENCE-ID:20261012T090000Z', 'DTSTART:20261012T130000Z'),
  );

  it('keeps the moved instance when the series moves an hour later', () => {
    expect(expand(weekly)).toEqual([
      '2026-10-05T09:00:00Z Weekly', '2026-10-12T13:00:00Z Moved instance', '2026-10-19T09:00:00Z Weekly',
    ]);
    const out = updateFields(weekly, { DTSTART: '20261005T100000Z' });
    expect(expand(out)).toEqual([
      '2026-10-05T10:00:00Z Weekly', '2026-10-12T13:00:00Z Moved instance', '2026-10-19T10:00:00Z Weekly',
    ]);
    const [moved] = overridesOf(out);
    expect(prop(moved, 'RECURRENCE-ID')).toEqual(['RECURRENCE-ID:20261012T100000Z']);
    // the override's own times are instance data the caller set: they stay
    expect(prop(moved, 'DTSTART')).toEqual(['DTSTART:20261012T130000Z']);
  });

  it('moves every override, and by whole days too', () => {
    const two = calendar(
      master('DTSTART:20261005T090000Z', 'RRULE:FREQ=DAILY;COUNT=10'),
      override('RECURRENCE-ID:20261007T090000Z', 'DTSTART:20261007T090000Z', 'Renamed'),
      override('RECURRENCE-ID:20261009T090000Z', 'DTSTART:20261009T150000Z'),
    );
    const out = updateFields(two, { DTSTART: '2026-10-06T08:30:00Z' });
    expect(overridesOf(out).map((c) => prop(c, 'RECURRENCE-ID')[0]))
      .toEqual(['RECURRENCE-ID:20261008T083000Z', 'RECURRENCE-ID:20261010T083000Z']);
    expect(expand(out).filter((o) => !o.endsWith('Weekly')))
      .toEqual(['2026-10-07T09:00:00Z Renamed', '2026-10-09T15:00:00Z Moved instance']);
  });

  it('works the same on a todo series', () => {
    const todo = (lines: string[]) => lines.map((l) => l.replace(/^(BEGIN|END):VEVENT$/, '$1:VTODO'));
    const out = updateFields(calendar(
      todo(master('DTSTART:20261005T090000Z', 'RRULE:FREQ=WEEKLY;COUNT=3')),
      todo(override('RECURRENCE-ID:20261012T090000Z', 'DTSTART:20261012T130000Z')),
    ), { DTSTART: '20261005T100000Z' });
    expect(prop(overridesOf(out, 'VTODO')[0], 'RECURRENCE-ID')).toEqual(['RECURRENCE-ID:20261012T100000Z']);
  });

  it('a TZID series moves on its wall clock, across a DST change, in the series zone', () => {
    // 09:00 Berlin is 07:00Z in October (CEST) and 08:00Z in November (CET);
    // a client may write the RECURRENCE-ID in UTC
    const berlin = calendar(BERLIN,
      master('DTSTART;TZID=Europe/Berlin:20261019T090000', 'RRULE:FREQ=WEEKLY;COUNT=3'),
      override('RECURRENCE-ID:20261026T080000Z', 'DTSTART:20261026T140000Z'),
    );
    const out = updateFields(berlin, { DTSTART: '2026-10-19T10:00:00' });
    expect(prop(overridesOf(out)[0], 'RECURRENCE-ID'))
      .toEqual(['RECURRENCE-ID;TZID=Europe/Berlin:20261026T100000']);
    expect(expand(out)).toEqual([
      '2026-10-19T08:00:00Z Weekly', '2026-10-26T14:00:00Z Moved instance', '2026-11-02T09:00:00Z Weekly',
    ]);
  });

  it('a TZID series without its VTIMEZONE moves a RECURRENCE-ID in the same zone', () => {
    const out = updateFields(calendar(
      master('DTSTART;TZID=Europe/Berlin:20261019T090000', 'RRULE:FREQ=WEEKLY;COUNT=3'),
      override('RECURRENCE-ID;TZID=Europe/Berlin:20261026T090000', 'DTSTART:20261026T140000Z'),
    ), { DTSTART: '2026-10-19T10:00:00' });
    expect(prop(overridesOf(out)[0], 'RECURRENCE-ID'))
      .toEqual(['RECURRENCE-ID;TZID=Europe/Berlin:20261026T100000']);
  });

  it('a UTC RECURRENCE-ID it cannot read in the zone throws and says what to do', () => {
    expect(() => updateFields(calendar(
      master('DTSTART;TZID=Europe/Berlin:20261019T090000', 'RRULE:FREQ=WEEKLY;COUNT=3'),
      override('RECURRENCE-ID:20261026T080000Z', 'DTSTART:20261026T140000Z'),
    ), { DTSTART: '2026-10-19T10:00:00' }))
      .toThrow(/DTSTART changed, and the override for RECURRENCE-ID:20261026T080000Z cannot follow it \(.*no VTIMEZONE.*\): move the override by rewriting the whole iCalendar object/);
  });

  it('timed -> all-day: the RECURRENCE-ID becomes the date of its occurrence', () => {
    const out = updateFields(weekly, { DTSTART: '2026-10-05' });
    expect(prop(overridesOf(out)[0], 'RECURRENCE-ID')).toEqual(['RECURRENCE-ID;VALUE=DATE:20261012']);
  });

  it('all-day -> timed: the RECURRENCE-ID takes the new time of day', () => {
    const allDay = calendar(
      master('DTSTART;VALUE=DATE:20261005', 'RRULE:FREQ=WEEKLY;COUNT=3', 'EXDATE;VALUE=DATE:20261019'),
      override('RECURRENCE-ID;VALUE=DATE:20261012', 'DTSTART;VALUE=DATE:20261013'),
    );
    const out = updateFields(allDay, { DTSTART: '2026-10-05T09:00:00Z' });
    expect(prop(overridesOf(out)[0], 'RECURRENCE-ID')).toEqual(['RECURRENCE-ID:20261012T090000Z']);
    expect(prop(masterOf(out), 'EXDATE')).toEqual(['EXDATE:20261019T090000Z']);
  });

  it('writing the same DTSTART again changes nothing', () => {
    const utcRid = calendar(BERLIN,
      master('DTSTART;TZID=Europe/Berlin:20261019T090000', 'RRULE:FREQ=WEEKLY;COUNT=3'),
      override('RECURRENCE-ID:20261026T080000Z', 'DTSTART:20261026T140000Z'),
    );
    const out = updateFields(utcRid, { DTSTART: '2026-10-19T09:00:00', SUMMARY: 'x' });
    expect(prop(overridesOf(out)[0], 'RECURRENCE-ID')).toEqual(['RECURRENCE-ID:20261026T080000Z']);
  });

  it('a move that lands an override off the rule is refused', () => {
    // BYDAY=MO keeps the series on Mondays; one day later the moved
    // RECURRENCE-ID would be a Tuesday, which no occurrence falls on
    const mondays = calendar(
      master('DTSTART:20261005T090000Z', 'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3'),
      override('RECURRENCE-ID:20261012T090000Z', 'DTSTART:20261012T130000Z'),
    );
    expect(() => updateFields(mondays, { DTSTART: '2026-10-06T09:00:00Z' }))
      .toThrow(/The new DTSTART leaves the override for RECURRENCE-ID:20261012T090000Z naming no occurrence of the series/);
  });
});

describe('moving DTSTART moves EXDATE and RDATE with the series', () => {
  const weekly = calendar(master('DTSTART:20261005T090000Z', 'RRULE:FREQ=WEEKLY;COUNT=4',
    'EXDATE:20261012T090000Z,20261019T090000Z', 'RDATE:20261008T150000Z'));

  it('an EXDATE keeps excluding, an RDATE keeps its place in the series', () => {
    const out = updateFields(weekly, { DTSTART: '20261005T100000Z' });
    expect(prop(masterOf(out), 'EXDATE')).toEqual(['EXDATE:20261012T100000Z,20261019T100000Z']);
    expect(prop(masterOf(out), 'RDATE')).toEqual(['RDATE:20261008T160000Z']);
    expect(expand(out)).toEqual([
      '2026-10-05T10:00:00Z Weekly', '2026-10-08T16:00:00Z Weekly', '2026-10-26T10:00:00Z Weekly',
    ]);
  });

  it('to all-day: EXDATE takes the date, which RFC 5545 requires next to a DATE DTSTART', () => {
    const out = updateFields(weekly, { DTSTART: '2026-10-05' });
    expect(prop(masterOf(out), 'EXDATE')).toEqual(['EXDATE;VALUE=DATE:20261012,20261019']);
    expect(prop(masterOf(out), 'RDATE')).toEqual(['RDATE;VALUE=DATE:20261008']);
  });

  it('an EXDATE given in the same call is the caller\'s and is not moved', () => {
    const out = updateFields(weekly, { DTSTART: '20261005T100000Z', EXDATE: '20261026T100000Z' });
    expect(prop(masterOf(out), 'EXDATE')).toEqual(['EXDATE:20261026T100000Z']);
  });

  it('only the EXDATE line the call replaces is left alone, the others move', () => {
    const lines = calendar(master('DTSTART:20261005T090000Z', 'RRULE:FREQ=WEEKLY;COUNT=4',
      'EXDATE:20261012T090000Z', 'EXDATE:20261019T090000Z'));
    const out = updateFields(lines, { DTSTART: '20261005T100000Z', EXDATE: '20261026T100000Z' });
    expect(prop(masterOf(out), 'EXDATE')).toEqual(['EXDATE:20261026T100000Z', 'EXDATE:20261019T100000Z']);
  });

  it('an RDATE of periods is not moved: it throws and asks for RDATE', () => {
    const periods = calendar(master('DTSTART:20261005T090000Z', 'RRULE:FREQ=WEEKLY;COUNT=4',
      'RDATE;VALUE=PERIOD:20261008T150000Z/PT1H'));
    expect(() => updateFields(periods, { DTSTART: '20261005T100000Z' }))
      .toThrow(/existing RDATE;VALUE=PERIOD:20261008T150000Z\/PT1H cannot follow it \(it holds periods.*\): give RDATE in the same call/);
  });

  it('UNTIL on the last occurrence moves along, so an override there is kept', () => {
    const until = calendar(
      master('DTSTART:20261005T090000Z', 'RRULE:FREQ=WEEKLY;UNTIL=20261019T090000Z'),
      override('RECURRENCE-ID:20261019T090000Z', 'DTSTART:20261019T130000Z'),
    );
    const out = updateFields(until, { DTSTART: '20261005T100000Z' });
    expect(expand(out)).toEqual([
      '2026-10-05T10:00:00Z Weekly', '2026-10-12T10:00:00Z Weekly', '2026-10-19T13:00:00Z Moved instance',
    ]);
  });
});

describe('a rule change that would orphan an override or EXDATE is refused', () => {
  const weekly = calendar(
    master('DTSTART:20261005T090000Z', 'RRULE:FREQ=WEEKLY;COUNT=4', 'EXDATE:20261026T090000Z'),
    override('RECURRENCE-ID:20261012T090000Z', 'DTSTART:20261012T130000Z'),
  );

  it('names what would be orphaned and how to proceed', () => {
    expect(() => updateFields(weekly, { RRULE: 'FREQ=DAILY;INTERVAL=2;COUNT=20' }))
      .toThrow('The new RRULE leaves the override for RECURRENCE-ID:20261012T090000Z, EXDATE 20261026T090000Z ' +
        'naming no occurrence of the series, so they would silently stop applying');
    expect(() => updateFields(weekly, { RRULE: 'FREQ=DAILY;INTERVAL=2;COUNT=20' }))
      .toThrow(/give EXDATE in the same call .* rewriting the whole iCalendar object/);
  });

  it('a shorter series that drops the override\'s occurrence is refused too', () => {
    expect(() => updateFields(weekly, { RRULE: 'FREQ=WEEKLY;COUNT=1' }))
      .toThrow(/leaves the override for RECURRENCE-ID:20261012T090000Z, EXDATE 20261026T090000Z naming no occurrence/);
  });

  it('a rule that keeps every occurrence is accepted', () => {
    const out = updateFields(weekly, { RRULE: 'FREQ=WEEKLY;COUNT=10' });
    expect(prop(masterOf(out), 'RRULE')).toEqual(['RRULE:FREQ=WEEKLY;COUNT=10']);
    expect(expand(out)).toContain('2026-10-12T13:00:00Z Moved instance');
  });

  it('an EXDATE given in the same call replaces the old one and is the caller\'s', () => {
    const out = updateFields(weekly, { RRULE: 'FREQ=DAILY;COUNT=14', EXDATE: '20261013T090000Z' });
    expect(prop(masterOf(out), 'EXDATE')).toEqual(['EXDATE:20261013T090000Z']);
  });

  it('removing an RDATE an override belongs to is refused', () => {
    const rdate = calendar(
      master('DTSTART:20261005T090000Z', 'RRULE:FREQ=WEEKLY;COUNT=2', 'RDATE:20261008T150000Z'),
      override('RECURRENCE-ID:20261008T150000Z', 'DTSTART:20261008T160000Z'),
    );
    expect(() => updateFields(rdate, { RDATE: '20261009T150000Z' }))
      .toThrow(/The new RDATE leaves the override for RECURRENCE-ID:20261008T150000Z naming no occurrence/);
  });

  it('an override that was already stale does not block an unrelated rule change', () => {
    const stale = calendar(
      master('DTSTART:20261005T090000Z', 'RRULE:FREQ=WEEKLY;COUNT=4'),
      override('RECURRENCE-ID:20261013T090000Z', 'DTSTART:20261013T130000Z'),
    );
    expect(() => updateFields(stale, { RRULE: 'FREQ=WEEKLY;COUNT=8' })).not.toThrow();
  });

  it('a rule with UNTIL is expanded on the series\' wall clock', () => {
    // UNTIL is UTC, DTSTART Berlin wall clock; the last occurrence (26 Oct
    // 09:00 CET = 08:00Z) is exactly UNTIL and still names the override
    const berlin = calendar(BERLIN,
      master('DTSTART;TZID=Europe/Berlin:20261019T090000', 'RRULE:FREQ=WEEKLY;COUNT=2'),
      override('RECURRENCE-ID;TZID=Europe/Berlin:20261026T090000', 'DTSTART:20261026T140000Z'),
    );
    expect(() => updateFields(berlin, { RRULE: 'FREQ=WEEKLY;UNTIL=20261026T080000Z' })).not.toThrow();
    expect(() => updateFields(berlin, { RRULE: 'FREQ=WEEKLY;UNTIL=20261026T075959Z' }))
      .toThrow(/naming no occurrence/);
  });

  it('a call that does not touch the series shape is not checked', () => {
    const stale = calendar(
      master('DTSTART:20261005T090000Z', 'RRULE:FREQ=WEEKLY;COUNT=1'),
      override('RECURRENCE-ID:20261012T090000Z', 'DTSTART:20261012T130000Z'),
    );
    expect(() => updateFields(stale, { SUMMARY: 'x' })).not.toThrow();
  });
});

describe('RECURRENCE-ID on the master', () => {
  it('is refused: it would turn the series into a single override', () => {
    const weekly = calendar(master('DTSTART:20261005T090000Z', 'RRULE:FREQ=WEEKLY;COUNT=3'));
    expect(() => updateFields(weekly, { 'recurrence-id': '20261012T090000Z' }))
      .toThrow(/RECURRENCE-ID cannot be written on the series master.*rewriting the whole iCalendar object/);
  });

  it('is refused on a plain event as well, which is a master of itself', () => {
    expect(() => updateFields(calendar(master('DTSTART:20261005T090000Z')), { 'RECURRENCE-ID': '20261005T090000Z' }))
      .toThrow(/RECURRENCE-ID cannot be written on the series master/);
  });
});
