import { describe, it, expect } from 'vitest';
import ICAL from 'ical.js';
import { updateFields } from '../src/updateFields';

// A series moves as a whole (issue #16): when the master's DTSTART moves, the
// overrides (RECURRENCE-ID and their own times), EXDATE, RDATE and UNTIL move
// by the same distance, so the occurrences after are the occurrences before,
// moved. A rule that does not fit the moved start, and a rule change that
// would orphan an override or EXDATE, are refused. The checks
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

  it('moves the whole series an hour later, the moved instance included', () => {
    expect(expand(weekly)).toEqual([
      '2026-10-05T09:00:00Z Weekly', '2026-10-12T13:00:00Z Moved instance', '2026-10-19T09:00:00Z Weekly',
    ]);
    const out = updateFields(weekly, { DTSTART: '20261005T100000Z' });
    expect(expand(out)).toEqual([
      '2026-10-05T10:00:00Z Weekly', '2026-10-12T14:00:00Z Moved instance', '2026-10-19T10:00:00Z Weekly',
    ]);
    const [moved] = overridesOf(out);
    expect(prop(moved, 'RECURRENCE-ID')).toEqual(['RECURRENCE-ID:20261012T100000Z']);
    expect(prop(moved, 'DTSTART')).toEqual(['DTSTART:20261012T140000Z']);
  });

  it('an override that only changed its content moves with its occurrence', () => {
    const renamed = calendar(
      master('DTSTART:20261005T090000Z', 'DTEND:20261005T100000Z', 'RRULE:FREQ=WEEKLY;COUNT=3'),
      [...override('RECURRENCE-ID:20261012T090000Z', 'DTSTART:20261012T090000Z', 'Renamed').slice(0, -1),
        'DTEND:20261012T100000Z', 'END:VEVENT'],
    );
    const out = updateFields(renamed, { DTSTART: '20261005T100000Z' });
    expect(expand(out)).toEqual([
      '2026-10-05T10:00:00Z Weekly', '2026-10-12T10:00:00Z Renamed', '2026-10-19T10:00:00Z Weekly',
    ]);
    expect(prop(overridesOf(out)[0], 'DTEND')).toEqual(['DTEND:20261012T110000Z']);
  });

  it('a start two weeks later moves every occurrence two weeks, without doubling one', () => {
    const later = calendar(
      master('DTSTART:20261005T090000Z', 'RRULE:FREQ=WEEKLY;UNTIL=20261116T090000Z', 'EXDATE:20261102T090000Z'),
      override('RECURRENCE-ID:20261026T090000Z', 'DTSTART:20261026T130000Z'),
    );
    const out = updateFields(later, { DTSTART: '2026-10-19T09:00:00Z' });
    expect(expand(out)).toEqual([
      '2026-10-19T09:00:00Z Weekly', '2026-10-26T09:00:00Z Weekly', '2026-11-02T09:00:00Z Weekly',
      '2026-11-09T13:00:00Z Moved instance', '2026-11-23T09:00:00Z Weekly', '2026-11-30T09:00:00Z Weekly',
    ]);
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
      .toEqual(['2026-10-08T08:30:00Z Renamed', '2026-10-10T14:30:00Z Moved instance']);
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
    // the override moves by the hour its occurrence moved: 14:00Z -> 15:00Z
    expect(expand(out)).toEqual([
      '2026-10-19T08:00:00Z Weekly', '2026-10-26T15:00:00Z Moved instance', '2026-11-02T09:00:00Z Weekly',
    ]);
  });

  it('an override rescheduled across a DST change keeps its wall-clock time', () => {
    // RID Sat 24 Oct 09:00 (CEST), rescheduled to Mon 26 Oct 09:00 (CET); a
    // week earlier is Mon 19 Oct 09:00, not 10:00 as a real-time shift gives
    for (const vtimezone of [true, false]) {
      const out = updateFields(calendar(...(vtimezone ? [BERLIN] : []),
        master('DTSTART;TZID=Europe/Berlin:20261017T090000', 'RRULE:FREQ=WEEKLY;COUNT=3'),
        override('RECURRENCE-ID;TZID=Europe/Berlin:20261024T090000', 'DTSTART;TZID=Europe/Berlin:20261026T090000'),
      ), { DTSTART: '2026-10-10T09:00:00' });
      expect(prop(overridesOf(out)[0], 'DTSTART')).toEqual(['DTSTART;TZID=Europe/Berlin:20261019T090000']);
    }
  });

  it('an override written in UTC follows the series\' wall clock as well', () => {
    // 26 Oct 09:00 CET = 08:00Z; a week earlier 09:00 CEST = 07:00Z
    const out = updateFields(calendar(BERLIN,
      master('DTSTART;TZID=Europe/Berlin:20261017T090000', 'RRULE:FREQ=WEEKLY;COUNT=3'),
      override('RECURRENCE-ID;TZID=Europe/Berlin:20261024T090000', 'DTSTART:20261026T080000Z'),
    ), { DTSTART: '2026-10-10T09:00:00' });
    expect(prop(overridesOf(out)[0], 'DTSTART')).toEqual(['DTSTART:20261019T070000Z']);
  });

  it('a TZID series without its VTIMEZONE moves a RECURRENCE-ID in the same zone', () => {
    const out = updateFields(calendar(
      master('DTSTART;TZID=Europe/Berlin:20261019T090000', 'RRULE:FREQ=WEEKLY;COUNT=3'),
      override('RECURRENCE-ID;TZID=Europe/Berlin:20261026T090000', 'DTSTART:20261026T140000Z'),
    ), { DTSTART: '2026-10-19T10:00:00' });
    expect(prop(overridesOf(out)[0], 'RECURRENCE-ID'))
      .toEqual(['RECURRENCE-ID;TZID=Europe/Berlin:20261026T100000']);
  });

  it('a TZID series without its VTIMEZONE reads the IANA zone of that name', () => {
    const out = updateFields(calendar(
      master('DTSTART;TZID=Europe/Berlin:20261019T090000', 'RRULE:FREQ=WEEKLY;COUNT=3'),
      override('RECURRENCE-ID:20261026T080000Z', 'DTSTART:20261026T140000Z'),
    ), { DTSTART: '2026-10-19T10:00:00' });
    expect(prop(overridesOf(out)[0], 'RECURRENCE-ID'))
      .toEqual(['RECURRENCE-ID;TZID=Europe/Berlin:20261026T100000']);
    expect(prop(overridesOf(out)[0], 'DTSTART')).toEqual(['DTSTART:20261026T150000Z']);
  });

  it('a UTC RECURRENCE-ID in a zone that is neither defined nor IANA throws and says what to do', () => {
    expect(() => updateFields(calendar(
      master('DTSTART;TZID=W. Europe Standard Time:20261019T090000', 'RRULE:FREQ=WEEKLY;COUNT=3'),
      override('RECURRENCE-ID:20261026T080000Z', 'DTSTART:20261026T140000Z'),
    ), { DTSTART: '2026-10-19T10:00:00' }))
      .toThrow(/DTSTART changed, and the override for RECURRENCE-ID:20261026T080000Z cannot follow it \(.*no IANA time zone\): rewrite the whole iCalendar object with the override moved/);
  });

  it('timed -> all-day: the RECURRENCE-ID becomes the date of its occurrence, the override keeps its time', () => {
    const out = updateFields(weekly, { DTSTART: '2026-10-05' });
    expect(prop(overridesOf(out)[0], 'RECURRENCE-ID')).toEqual(['RECURRENCE-ID;VALUE=DATE:20261012']);
    expect(prop(overridesOf(out)[0], 'DTSTART')).toEqual(['DTSTART:20261012T130000Z']);
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

});

describe('a rule that does not move with DTSTART is refused, naming the rule to give', () => {
  const mondays = (...extra: string[][]) => calendar(
    master('DTSTART:20261005T090000Z', 'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3'), ...extra);

  it('BYDAY=MO,WE and a start moved to Tuesday', () => {
    const twoDays = calendar(master('DTSTART:20261005T090000Z', 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6'));
    expect(() => updateFields(twoDays, { DTSTART: '2026-10-06T09:00:00Z' }))
      .toThrow('Moving DTSTART (DTSTART:20261005T090000Z to DTSTART:20261006T090000Z) does not move the whole ' +
        'series: RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6 has BYDAY, which pins weekdays: only a DAILY or WEEKLY rule ' +
        'follows a move, and only by whole weeks, so the moved series would not have the same occurrences, each ' +
        'moved. Give RRULE in the same call to fit the new start;');
  });

  it('a BYDAY that only restates DTSTART\'s weekday follows it, as clients write "every Monday"', () => {
    const withOverride = mondays(override('RECURRENCE-ID:20261012T090000Z', 'DTSTART:20261012T130000Z'));
    const out = updateFields(withOverride, { DTSTART: '2026-10-06T09:00:00Z' });
    expect(prop(masterOf(out), 'RRULE')).toEqual(['RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=3']);
    expect(expand(out)).toEqual([
      '2026-10-06T09:00:00Z Weekly', '2026-10-13T13:00:00Z Moved instance', '2026-10-20T09:00:00Z Weekly',
    ]);
    expect(prop(masterOf(updateFields(mondays(), { DTSTART: '2026-10-04T09:00:00Z' })), 'RRULE'))
      .toEqual(['RRULE:FREQ=WEEKLY;BYDAY=SU;COUNT=3']);
  });

  it('BYMONTHDAY and BYMONTH that restate DTSTART follow it, under the plain rule\'s limits', () => {
    const monthDay = calendar(master('DTSTART:20261005T090000Z', 'RRULE:FREQ=MONTHLY;BYMONTHDAY=5;COUNT=3'));
    expect(prop(masterOf(updateFields(monthDay, { DTSTART: '2026-10-06T09:00:00Z' })), 'RRULE'))
      .toEqual(['RRULE:FREQ=MONTHLY;BYMONTHDAY=6;COUNT=3']);
    const yearly = calendar(master('DTSTART:20260315T090000Z', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15'));
    expect(prop(masterOf(updateFields(yearly, { DTSTART: '2026-03-20T09:00:00Z' })), 'RRULE'))
      .toEqual(['RRULE:FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=20']);
    // into another month, or past the 28th, the plain YEARLY rule does not follow
    expect(() => updateFields(yearly, { DTSTART: '2026-04-15T09:00:00Z' })).toThrow(/does not move the whole series/);
    expect(() => updateFields(yearly, { DTSTART: '2026-03-30T09:00:00Z' })).toThrow(/does not move the whole series/);
    // BYMONTHDAY=5 in a YEARLY rule without BYMONTH is every 5th: not restating
    const fifths = calendar(master('DTSTART:20260305T090000Z', 'RRULE:FREQ=YEARLY;BYMONTHDAY=5'));
    expect(() => updateFields(fifths, { DTSTART: '2026-03-06T09:00:00Z' })).toThrow(/has BYMONTHDAY/);
    const monthEnd = calendar(master('DTSTART:20270131T090000Z', 'RRULE:FREQ=MONTHLY;COUNT=4'));
    expect(() => updateFields(monthEnd, { DTSTART: '2027-01-30T09:00:00Z' })).toThrow(/does not move the whole series/);
  });

  it('several occurrences a day cannot become all-day', () => {
    const twice = calendar(master('DTSTART:20261005T090000Z', 'RRULE:FREQ=DAILY;BYHOUR=9,15;COUNT=4'));
    expect(() => updateFields(twice, { DTSTART: '2026-10-05' })).toThrow(/does not move the whole series/);
  });

  it('RRULE given in the same call is the caller\'s; the overrides still move with the start', () => {
    const out = updateFields(mondays(override('RECURRENCE-ID:20261012T090000Z', 'DTSTART:20261012T130000Z')),
      { DTSTART: '2026-10-06T09:00:00Z', RRULE: 'FREQ=WEEKLY;BYDAY=TU;COUNT=3' });
    expect(expand(out)).toEqual([
      '2026-10-06T09:00:00Z Weekly', '2026-10-13T13:00:00Z Moved instance', '2026-10-20T09:00:00Z Weekly',
    ]);
  });
});

describe('UTC values near a DST change are read with the VTIMEZONE\'s own transitions', () => {
  // ical.js' convertToZone from UTC is off by an hour for up to five hours
  // around each change (ical.js#847); these instants fall in that window
  const NEW_YORK = [
    'BEGIN:VTIMEZONE', 'TZID:America/New_York',
    'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'TZNAME:EDT',
    'DTSTART:19700308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'TZNAME:EST',
    'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD',
    'END:VTIMEZONE',
  ];

  it('an UNTIL just after the fall-back change keeps the last occurrence', () => {
    // daily 23:15 New York; UNTIL is the 31 Oct occurrence (23:15 EDT = 03:15Z)
    const ny = calendar(NEW_YORK,
      master('DTSTART;TZID=America/New_York:20261025T231500', 'RRULE:FREQ=DAILY;UNTIL=20261101T031500Z'));
    const out = updateFields(ny, { DTSTART: '2026-10-18T23:15:00' });
    expect(prop(masterOf(out), 'RRULE')).toEqual(['RRULE:FREQ=DAILY;UNTIL=20261025T031500Z']);
  });

  it('a UTC override just after the spring-forward change moves on the Berlin wall clock', () => {
    // 29 Mar 01:15Z is 03:15 CEST; a week earlier 03:15 CET is 02:15Z
    const out = updateFields(calendar(BERLIN,
      master('DTSTART;TZID=Europe/Berlin:20260322T090000', 'RRULE:FREQ=WEEKLY;COUNT=3'),
      override('RECURRENCE-ID;TZID=Europe/Berlin:20260329T090000', 'DTSTART:20260329T011500Z'),
    ), { DTSTART: '2026-03-15T09:00:00' });
    expect(prop(overridesOf(out)[0], 'DTSTART')).toEqual(['DTSTART:20260322T021500Z']);
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

  it('to all-day: EXDATE and RDATE take the date, which RFC 5545 requires next to a DATE DTSTART', () => {
    const atNine = calendar(master('DTSTART:20261005T090000Z', 'RRULE:FREQ=WEEKLY;COUNT=4',
      'EXDATE:20261012T090000Z,20261019T090000Z', 'RDATE:20261008T090000Z'));
    const out = updateFields(atNine, { DTSTART: '2026-10-05' });
    expect(prop(masterOf(out), 'EXDATE')).toEqual(['EXDATE;VALUE=DATE:20261012,20261019']);
    expect(prop(masterOf(out), 'RDATE')).toEqual(['RDATE;VALUE=DATE:20261008']);
  });

  it('to all-day: a value at another time of day than the series is refused', () => {
    // the 15:00 RDATE would become 8 Oct, a date it shares with nothing now,
    // but an EXDATE at 15:00 could fall together with an occurrence it never named
    expect(() => updateFields(weekly, { DTSTART: '2026-10-05' }))
      .toThrow(/DTSTART changed to a date, and RDATE:20261008T150000Z is not at the series' time of day/);
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
      '2026-10-05T10:00:00Z Weekly', '2026-10-12T10:00:00Z Weekly', '2026-10-19T14:00:00Z Moved instance',
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
      .toThrow(/Give RRULE \(or RDATE\) in the same call .* EXDATE in the same call .*; or rewrite the whole iCalendar object/);
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

describe('a bare component (no VCALENDAR) gets the same series handling', () => {
  const bare = (...props: string[]) => master('DTSTART:20261001T100000Z', ...props).join('\r\n') + '\r\n';
  const lines = (ical: string, name: string) => prop(ical.replace(/\r?\n[ \t]/g, '').split(/\r?\n/), name);

  it('UNTIL, EXDATE and RDATE follow DTSTART', () => {
    const out = updateFields(bare('RRULE:FREQ=DAILY;UNTIL=20261020T100000Z', 'EXDATE:20261005T100000Z',
      'RDATE:20261025T100000Z'), { DTSTART: '2026-10-01' });
    expect(lines(out, 'RRULE')).toEqual(['RRULE:FREQ=DAILY;UNTIL=20261020']);
    expect(lines(out, 'EXDATE')).toEqual(['EXDATE;VALUE=DATE:20261005']);
    expect(lines(out, 'RDATE')).toEqual(['RDATE;VALUE=DATE:20261025']);
  });

  it('RECURRENCE-ID is refused on it as on a master in a VCALENDAR', () => {
    expect(() => updateFields(bare(), { 'RECURRENCE-ID': '20261001T100000Z' }))
      .toThrow(/RECURRENCE-ID cannot be written on the series master/);
  });
});

describe('a value that cannot move with its meaning kept is refused (adversarial review of #22)', () => {
  it('a date UNTIL next to a timed DTSTART', () => {
    expect(() => updateFields(calendar(BERLIN,
      master('DTSTART;TZID=Europe/Berlin:20260105T090000', 'RRULE:FREQ=DAILY;UNTIL=20260110')),
    { DTSTART: '2026-01-06T09:00:00' }))
      .toThrow(/RRULE UNTIL=20260110 cannot follow it \(UNTIL is a date next to a date-time DTSTART/);
  });

  it.each([
    ['moved into the spring gap', 'DTSTART;TZID=Europe/Berlin:20260301T030000', 'RRULE:FREQ=DAILY;UNTIL=20260315T013000Z', '2026-03-15T03:00:00'],
    ['in the repeated autumn hour', 'DTSTART;TZID=Europe/Berlin:20261020T024500', 'RRULE:FREQ=DAILY;UNTIL=20261025T013000Z', '2026-10-21T02:45:00'],
  ])('an UNTIL %s, where wall clock and instants part', (_, dtstart, rule, to) => {
    expect(() => updateFields(calendar(BERLIN, master(dtstart, rule)), { DTSTART: to }))
      .toThrow(/cannot follow it \((moved, it would be .* at the DST change|it lies at the DST change)/);
  });

  it('an UNTIL just past a gap, which a skipped occurrence lies after (Sydney)', () => {
    // 3 Oct 2027 Sydney skips 02:00-03:00; the 02:30 occurrence is 16:30Z,
    // after UNTIL 16:00Z, but before it on the wall clock
    expect(() => updateFields(calendar(
      master('DTSTART;TZID=Australia/Sydney:20270328T023000', 'RRULE:FREQ=WEEKLY;UNTIL=20271002T160000Z')),
    { DTSTART: '2027-03-27T02:30:00' })).toThrow(/it lies at the DST change in "Australia\/Sydney"/);
  });

  it('a date RDATE next to a timed series: kept a date on a move by days, refused on a new time', () => {
    const series = calendar(BERLIN, master('DTSTART;TZID=Europe/Berlin:20260105T090000', 'RRULE:FREQ=WEEKLY;COUNT=5',
      'RDATE;VALUE=DATE:20260301'));
    expect(prop(masterOf(updateFields(series, { DTSTART: '2026-01-12T09:00:00' })), 'RDATE'))
      .toEqual(['RDATE;VALUE=DATE:20260308']);
    expect(() => updateFields(series, { DTSTART: '2026-01-05T10:00:00' }))
      .toThrow(/RDATE;VALUE=DATE:20260301 cannot follow it \(it is a date, a whole day, which cannot move by the time of day/);
  });

  it.each([
    ['X-FOO=1', 'FREQ=DAILY;UNTIL=20260301T000000Z;X-FOO=1'],
    ['RSCALE and SKIP', 'FREQ=MONTHLY;UNTIL=20270101T000000Z;RSCALE=GREGORIAN;SKIP=FORWARD'],
    ['BYEASTER', 'FREQ=YEARLY;BYEASTER=0'],
  ])('a rule with %s, which writing it again would lose', (_, rule) => {
    expect(() => updateFields(calendar(master('DTSTART:20260105T090000Z', `RRULE:${rule}`)), { DTSTART: '2026-01-06T09:00:00Z' }))
      .toThrow(/(has (X-FOO|RSCALE, SKIP|BYEASTER), whose effect on a move updateFields cannot tell)|(which updateFields would lose rewriting it)/);
  });

  it('timed to all-day with a stale override at another time of day', () => {
    expect(() => updateFields(calendar(
      master('DTSTART;TZID=America/New_York:20271031T023000', 'RRULE:FREQ=WEEKLY'),
      override('RECURRENCE-ID;TZID=America/New_York:20271114T030000', 'DTSTART:20271114T090000Z'),
    ), { DTSTART: '2027-11-07' })).toThrow(/DTSTART changed to a date, and RECURRENCE-ID;TZID=America\/New_York:20271114T030000 is not at the series' time of day/);
  });

  it('timed to all-day with an RDATE and an EXDATE that would fall on one date', () => {
    expect(() => updateFields(calendar(master('DTSTART:20261005T090000Z', 'RRULE:FREQ=YEARLY',
      'RDATE:20261210T210000Z', 'EXDATE:20261210T200000Z')), { DTSTART: '2026-10-05' }))
      .toThrow(/DTSTART changed to a date, and (EXDATE|RDATE):20261210T2[01]0000Z is not at the series' time of day/);
  });

  it.each([
    ['an EXDATE', ['EXDATE:20260329T013000Z'], [], '2026-03-22T03:30:00'],
    ['an override', [], [['BEGIN:VEVENT', 'UID:series-1', 'DTSTAMP:20260101T000000Z', 'RECURRENCE-ID:20260329T013000Z',
      'DTSTART:20260329T100000Z', 'END:VEVENT']], '2026-03-23T02:30:00'],
  ])('%s given in UTC for the occurrence in the spring gap', (_, props, extra, to) => {
    expect(() => updateFields(calendar(master('DTSTART;TZID=Europe/Berlin:20260322T023000', 'RRULE:FREQ=WEEKLY;COUNT=4',
      ...(props as string[])), ...(extra as string[][])), { DTSTART: to }))
      .toThrow(/(EXDATE|RECURRENCE-ID):20260329T013000Z names the same instant as the occurrence at 20260329T023000 in "Europe\/Berlin", a wall-clock time the DST change skips, so which occurrence it names cannot be told/);
  });

  it('the check of a new rule fails closed when a zone cannot be read', () => {
    expect(() => updateFields(calendar(
      master('DTSTART;TZID=Mars/Olympus:20260105T090000', 'RRULE:FREQ=DAILY;UNTIL=20260120T090000Z'),
      override('RECURRENCE-ID;TZID=Mars/Olympus:20260110T090000', 'DTSTART;TZID=Mars/Olympus:20260110T100000'),
    ), { RRULE: 'FREQ=DAILY;COUNT=2' }))
      .toThrow(/^Cannot check that the overrides and EXDATEs still name occurrences of the series: .*Mars\/Olympus/);
  });

  it('BYDAY past the fifth weekday of a month is refused when written', () => {
    expect(() => updateFields(calendar(master('DTSTART:20260105T090000Z', 'RRULE:FREQ=DAILY')), { RRULE: 'FREQ=MONTHLY;BYDAY=6MO' }))
      .toThrow(/BYDAY: "6MO" counts past the fifth weekday of a month/);
  });

  it('a dense rule with an override far ahead says so, not "too sparse"', () => {
    expect(() => updateFields(calendar(master('DTSTART:20260101T090000Z', 'RRULE:FREQ=DAILY'),
      override('RECURRENCE-ID:21250101T090000Z', 'DTSTART:21250101T100000Z')), { RRULE: 'FREQ=WEEKLY' }))
      .toThrow(/the override or EXDATE furthest ahead \(21250101T090000Z\) lies too far ahead to check within the work limit/);
  });
});

describe('a value in the series\' own zone that shares its instant with a skipped occurrence (re-verify of #22)', () => {
  it('CX-A: EXDATE at 03:30 on the spring day is the instant of the skipped 02:30 occurrence', () => {
    expect(() => updateFields(calendar(BERLIN, master('DTSTART;TZID=Europe/Berlin:20260315T023000', 'RRULE:FREQ=WEEKLY;COUNT=4',
      'EXDATE;TZID=Europe/Berlin:20260329T033000')), { DTSTART: '2026-03-16T02:30:00' }))
      .toThrow(/EXDATE;TZID=Europe\/Berlin:20260329T033000 names the same instant as the occurrence at 20260329T023000/);
  });

  it('CX-B: a move that puts an occurrence into the gap, next to an EXDATE that then shares its instant', () => {
    expect(() => updateFields(calendar(BERLIN, master('DTSTART;TZID=Europe/Berlin:20260404T010000', 'RRULE:FREQ=HOURLY;COUNT=5',
      'EXDATE;TZID=Europe/Berlin:20260404T030000')), { DTSTART: '2026-03-29T01:00:00' }))
      .toThrow(/moved, EXDATE;TZID=Europe\/Berlin:20260329T030000 would name the same instant as the occurrence at 20260329T020000/);
  });

  it('CX-C: an override with RECURRENCE-ID 03:30 for the skipped 02:30 occurrence', () => {
    expect(() => updateFields(calendar(BERLIN, master('DTSTART;TZID=Europe/Berlin:20260315T023000', 'RRULE:FREQ=WEEKLY;COUNT=4'),
      override('RECURRENCE-ID;TZID=Europe/Berlin:20260329T033000', 'DTSTART;TZID=Europe/Berlin:20260329T100000')),
    { DTSTART: '2026-03-16T02:30:00' })).toThrow(/RECURRENCE-ID;TZID=Europe\/Berlin:20260329T033000 names the same instant/);
  });

  it('a 03:30 EXDATE where the series has no 02:30 occurrence names 03:30 and moves', () => {
    const out = updateFields(calendar(BERLIN, master('DTSTART;TZID=Europe/Berlin:20260325T033000', 'RRULE:FREQ=DAILY;COUNT=7',
      'EXDATE;TZID=Europe/Berlin:20260329T033000')), { DTSTART: '2026-03-25T04:30:00' });
    expect(prop(masterOf(out), 'EXDATE')).toEqual(['EXDATE;TZID=Europe/Berlin:20260329T043000']);
  });
});
