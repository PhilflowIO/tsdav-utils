import { describe, expect, it } from 'vitest';
import ICAL from 'ical.js';
import { UpdateFieldsError, seriesMaster, updateFields } from '../src/index';

const calendar = (...lines: string[]) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...lines, 'END:VCALENDAR', ''].join('\r\n');
const event = (...lines: string[]) => ['BEGIN:VEVENT', 'UID:e', 'DTSTAMP:20260101T000000Z', ...lines, 'END:VEVENT'];

/** Berlin's rules under another name, so only the VTIMEZONE can resolve it */
const OFFICE = ['BEGIN:VTIMEZONE', 'TZID:Office',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'DTSTART:19810329T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'DTSTART:19961027T030000',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD', 'END:VTIMEZONE'];

/** A weekly Monday 09:00-10:00 series in a zone, from 5 October 2026, across the 25 October DST change */
const weekly = (tzid: string, ...extra: string[]) => calendar(...extra, ...event(
  `DTSTART;TZID=${tzid}:20261005T090000`, `DTEND;TZID=${tzid}:20261005T100000`,
  'RRULE:FREQ=WEEKLY;COUNT=6', `EXDATE;TZID=${tzid}:20261019T090000`));

const lines = (ics: string) => ics.split('\r\n');
const master = (ics: string) => seriesMaster(new ICAL.Component(ICAL.parse(ics)));

/** The wall-clock times (in the series' zone) of its occurrences */
function occurrences(ics: string): string[] {
  const start = master(ics).getFirstPropertyValue('dtstart') as ICAL.Time;
  const iterator = (master(ics).getFirstPropertyValue('rrule') as ICAL.Recur).iterator(start);
  const out: string[] = [];
  for (let next = iterator.next(); next; next = iterator.next()) {
    out.push(next.toICALString());
  }
  return out;
}

const refusal = (call: () => unknown) => {
  try {
    call();
  } catch (error) {
    return error as UpdateFieldsError;
  }
  throw new Error('not refused');
};

describe.each([
  ['an IANA zone without VTIMEZONE', 'Europe/Berlin', [] as string[]],
  ['a zone only its VTIMEZONE defines', 'Office', OFFICE],
])('absoluteTime "keep-zone" in %s', (_, tzid, vtimezone) => {
  const ics = weekly(tzid, ...vtimezone);

  it('moves the series with a UTC DTSTART and keeps the zone, so occurrences after the DST change keep 10:00', () => {
    // 08:00Z on Tuesday 6 October is 10:00 summer time
    const out = updateFields(ics, { DTSTART: '2026-10-06T08:00:00Z' }, { absoluteTime: 'keep-zone' });
    expect(lines(out)).toContain(`DTSTART;TZID=${tzid}:20261006T100000`);
    // the EXDATE moves on the wall clock, in the zone it had
    expect(lines(out)).toContain(`EXDATE;TZID=${tzid}:20261020T100000`);
    expect(occurrences(out)).toEqual(['20261006T100000', '20261013T100000', '20261020T100000',
      '20261027T100000', '20261103T100000', '20261110T100000']);
  });

  it('by default writes the instant as UTC, so occurrences after the DST change drift an hour', () => {
    const out = updateFields(ics, { DTSTART: '2026-10-06T08:00:00Z' });
    expect(lines(out)).toContain('DTSTART:20261006T080000Z');
    // 08:00Z is 10:00 in summer, 09:00 in winter
    expect(occurrences(out)).toContain('20261027T080000Z');
  });

  it('converts a numeric offset the same way', () => {
    const out = updateFields(ics, { DTSTART: '2026-10-06T04:00:00-04:00' }, { absoluteTime: 'keep-zone' });
    expect(lines(out)).toContain(`DTSTART;TZID=${tzid}:20261006T100000`);
  });

  it('writes DTEND in the zone too, across the DST change', () => {
    // 10:30Z on 26 October is 11:30 winter time
    const out = updateFields(calendar(...vtimezone, ...event(
      `DTSTART;TZID=${tzid}:20261026T090000`, `DTEND;TZID=${tzid}:20261026T100000`)),
    { DTEND: '2026-10-26T10:30:00Z' }, { absoluteTime: 'keep-zone' });
    expect(lines(out)).toContain(`DTEND;TZID=${tzid}:20261026T113000`);
  });

  it('writes a DTEND without a TZID in the zone of DTSTART', () => {
    const out = updateFields(calendar(...vtimezone, ...event(`DTSTART;TZID=${tzid}:20261026T090000`)),
      { DTEND: '2026-10-26T09:00:00Z' }, { absoluteTime: 'keep-zone' });
    expect(lines(out)).toContain(`DTEND;TZID=${tzid}:20261026T100000`);
  });

  it('leaves a value without a zone in the same call as it is: wall clock in the zone', () => {
    const out = updateFields(ics, { DTSTART: '2026-10-06T08:00:00Z', DTEND: '2026-10-06T12:00:00' },
      { absoluteTime: 'keep-zone' });
    expect(lines(out)).toContain(`DTSTART;TZID=${tzid}:20261006T100000`);
    expect(lines(out)).toContain(`DTEND;TZID=${tzid}:20261006T120000`);
  });

  it('accepts the first pass of the repeated hour and refuses the second', () => {
    const single = calendar(...vtimezone, ...event(`DTSTART;TZID=${tzid}:20261024T090000`));
    // 00:30Z on 25 October is 02:30 summer time, the first 02:30 of that night
    expect(lines(updateFields(single, { DTSTART: '2026-10-25T00:30:00Z' }, { absoluteTime: 'keep-zone' })))
      .toContain(`DTSTART;TZID=${tzid}:20261025T023000`);
    // 01:30Z is 02:30 winter time, which reads as the first pass
    const error = refusal(() => updateFields(single, { DTSTART: '2026-10-25T01:30:00Z' }, { absoluteTime: 'keep-zone' }));
    expect(error).toBeInstanceOf(UpdateFieldsError);
    expect(error.code).toBe('DST_AMBIGUOUS');
    expect(error.property).toBe('DTSTART');
  });
});

describe('absoluteTime "keep-zone" where no zone applies', () => {
  it('writes UTC next to a UTC or floating DTSTART, as by default', () => {
    for (const dtstart of ['DTSTART:20261005T090000Z', 'DTSTART:20261005T090000']) {
      const ics = calendar(...event(dtstart));
      expect(updateFields(ics, { DTSTART: '2026-10-06T08:00:00Z' }, { absoluteTime: 'keep-zone' }))
        .toBe(updateFields(ics, { DTSTART: '2026-10-06T08:00:00Z' }));
    }
  });

  it('leaves all-day rules as they are: a date-time next to an all-day DTSTART is refused', () => {
    const ics = calendar(...event('DTSTART;VALUE=DATE:20261005'));
    expect(refusal(() => updateFields(ics, { DTEND: '2026-10-06T08:00:00Z' }, { absoluteTime: 'keep-zone' })).code)
      .toBe('VALUE_TYPE_MISMATCH');
  });

  it('refuses a TZID whose rules are unknown instead of writing UTC', () => {
    const error = refusal(() => updateFields(calendar(...event('DTSTART;TZID=Nowhere/Zone:20261005T090000')),
      { DTSTART: '2026-10-06T08:00:00Z' }, { absoluteTime: 'keep-zone' }));
    expect(error.code).toBe('UNKNOWN_TZID');
  });

  it('keeps UTC-only properties in UTC', () => {
    const out = updateFields(weekly('Europe/Berlin'), { DTSTAMP: '2026-10-06T08:00:00Z' }, { absoluteTime: 'keep-zone' });
    expect(lines(out)).toContain('DTSTAMP:20261006T080000Z');
  });
});
