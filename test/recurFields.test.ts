import { describe, it, expect } from 'vitest';
import ICAL from 'ical.js';
import { updateFields } from '../src/updateFields';

// As in dateFields.test.ts the assertions look at the serialized lines: the
// defect (a rule string serialized as "0=F;1=R;2=E;...") only shows in the
// bytes.

const BERLIN = [
  'BEGIN:VTIMEZONE', 'TZID:Europe/Berlin',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST',
  'DTSTART:19700329T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET',
  'DTSTART:19701025T030000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
  'END:VTIMEZONE',
];

const vevent = (dtstart: string, { vtimezone = false, props = [] as string[] } = {}) => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//tsdav-utils//Test//EN',
  ...(vtimezone ? BERLIN : []),
  'BEGIN:VEVENT', 'UID:event-1', 'DTSTAMP:20260101T000000Z', 'SUMMARY:e',
  dtstart, ...props,
  'END:VEVENT', 'END:VCALENDAR', '',
].join('\r\n');

const utcEvent = vevent('DTSTART:20260101T100000Z');

/** the unfolded RRULE lines of the event or todo (not of a VTIMEZONE) */
const rrule = (ical: string) => {
  const unfolded = ical.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  return unfolded.slice(unfolded.findIndex((l) => /^BEGIN:V(EVENT|TODO)$/.test(l)))
    .filter((l) => /^RRULE[:;]/.test(l));
};

describe('a rule string is written as a typed RECUR value', () => {
  it('writes FREQ=DAILY;COUNT=5 as the rule, not character by character', () => {
    expect(rrule(updateFields(utcEvent, { RRULE: 'FREQ=DAILY;COUNT=5' })))
      .toEqual(['RRULE:FREQ=DAILY;COUNT=5']);
  });

  it('replaces an existing rule instead of adding a second line', () => {
    const out = updateFields(vevent('DTSTART:20260101T100000Z', { props: ['RRULE:FREQ=YEARLY'] }),
      { RRULE: 'FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=2' });
    // ical.js writes INTERVAL before the BYxxx parts; the order carries no meaning
    expect(rrule(out)).toEqual(['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE']);
  });

  it('accepts lower case, surrounding blanks and a trailing semicolon', () => {
    expect(rrule(updateFields(utcEvent, { RRULE: ' freq=monthly;byday=-1fr; ' })))
      .toEqual(['RRULE:FREQ=MONTHLY;BYDAY=-1FR']);
  });

  it('writes a rule the parser reads back with its parts intact', () => {
    const out = updateFields(utcEvent, { RRULE: 'FREQ=MONTHLY;BYDAY=MO;BYSETPOS=-1;COUNT=3' });
    const event = new ICAL.Component(ICAL.parse(out)).getFirstSubcomponent('vevent')!;
    const recur = event.getFirstPropertyValue('rrule') as ICAL.Recur;
    expect(recur.freq).toBe('MONTHLY');
    expect(recur.count).toBe(3);
    expect(recur.parts).toEqual({ BYDAY: ['MO'], BYSETPOS: [-1] });
  });

  it('treats EXRULE, the other RECUR property, the same way', () => {
    const out = updateFields(utcEvent, { EXRULE: 'FREQ=WEEKLY;COUNT=2' });
    expect(out).toContain('EXRULE:FREQ=WEEKLY;COUNT=2');
  });

  it('works on a todo', () => {
    const todo = vevent('DTSTART:20260101T100000Z').replace(/VEVENT/g, 'VTODO');
    expect(rrule(updateFields(todo, { RRULE: 'FREQ=DAILY;COUNT=5' }))).toEqual(['RRULE:FREQ=DAILY;COUNT=5']);
  });
});

describe('a rule RFC 5545 3.3.10 does not allow is refused, naming the property', () => {
  it.each([
    ['COUNT=5', /RRULE: FREQ is missing/],
    ['', /RRULE: FREQ is missing/],
    ['FREQ=FORTNIGHTLY', /RRULE: FREQ: "FORTNIGHTLY" is not one of SECONDLY/],
    ['FREQ=DAILY;FOO=1', /RRULE: "FOO=1" is not a rule part\. RFC 5545 defines FREQ, UNTIL/],
    ['RRULE:FREQ=DAILY', /RRULE: "RRULE:FREQ=DAILY" is not a rule part: drop the "RRULE:" prefix and give only the rule, e\.g\. "FREQ=DAILY"/],
    ['FREQ=YEARLY;RSCALE=GREGORIAN', /RRULE: RSCALE\/SKIP \(RFC 7529\) are not supported: ical\.js cannot write them without losing them/],
    ['FREQ=YEARLY;SKIP=FORWARD', /RRULE: RSCALE\/SKIP \(RFC 7529\) are not supported/],
    ['FREQ=DAILY;COUNT=2;COUNT=3', /RRULE: COUNT is given twice/],
    ['FREQ=DAILY;COUNT', /RRULE: COUNT has no value/],
    ['FREQ=DAILY;COUNT=0', /RRULE: COUNT: "0" is not a positive integer/],
    ['FREQ=DAILY;COUNT=-1', /RRULE: COUNT: "-1" is not a positive integer/],
    ['FREQ=DAILY;INTERVAL=0', /RRULE: INTERVAL: "0" is not a positive integer/],
    ['FREQ=DAILY;BYHOUR=24', /RRULE: BYHOUR: "24" is not in 0 to 23/],
    ['FREQ=DAILY;BYHOUR=1,,2', /RRULE: BYHOUR: "" is not in 0 to 23/],
    ['FREQ=MONTHLY;BYMONTHDAY=0', /RRULE: BYMONTHDAY: "0" is not in 1 to 31 or -31 to -1/],
    ['FREQ=YEARLY;BYYEARDAY=367', /RRULE: BYYEARDAY: "367" is not in 1 to 366/],
    ['FREQ=MONTHLY;BYDAY=MO;BYSETPOS=0', /RRULE: BYSETPOS: "0" is not in 1 to 366/],
    ['FREQ=WEEKLY;BYDAY=XX', /RRULE: BYDAY: "XX" is not a weekday/],
    ['FREQ=MONTHLY;BYDAY=0MO', /RRULE: BYDAY: "0MO" is not a weekday/],
    ['FREQ=WEEKLY;WKST=XX', /RRULE: WKST: "XX" is not a weekday/],
    ['FREQ=DAILY;COUNT=3;UNTIL=20261026T000000Z', /RRULE: COUNT and UNTIL cannot both be given/],
    ['FREQ=MONTHLY;BYWEEKNO=1', /RRULE: BYWEEKNO is only allowed with FREQ=YEARLY/],
    ['FREQ=MONTHLY;BYYEARDAY=1', /RRULE: BYYEARDAY is not allowed with FREQ=MONTHLY/],
    ['FREQ=WEEKLY;BYMONTHDAY=1', /RRULE: BYMONTHDAY is not allowed with FREQ=WEEKLY/],
    ['FREQ=WEEKLY;BYDAY=2MO', /RRULE: BYDAY with an ordinal .* only allowed with FREQ=MONTHLY or FREQ=YEARLY/],
    ['FREQ=YEARLY;BYWEEKNO=1;BYDAY=1MO', /RRULE: BYDAY with an ordinal .* not together with BYWEEKNO/],
    ['FREQ=MONTHLY;BYSETPOS=1', /RRULE: BYSETPOS needs another BYxxx part/],
  ])('%j', (rule, message) => {
    expect(() => updateFields(utcEvent, { RRULE: rule })).toThrow(message);
  });

  it('a bad rule fails the whole update, so nothing half-written is returned', () => {
    expect(() => updateFields(utcEvent, { SUMMARY: 'x', RRULE: 'FREQ=DAILY;FOO=1' })).toThrow();
  });
});

describe('UNTIL follows DTSTART (RFC 5545 3.3.10)', () => {
  it.each([
    ['2026-10-26T18:00:00Z', 'RRULE:FREQ=DAILY;UNTIL=20261026T180000Z'],
    ['20261026T180000Z', 'RRULE:FREQ=DAILY;UNTIL=20261026T180000Z'],
    ['2026-10-26T14:00:00-04:00', 'RRULE:FREQ=DAILY;UNTIL=20261026T180000Z'],
  ])('a UTC DTSTART takes UNTIL=%s in UTC', (until, expected) => {
    expect(rrule(updateFields(utcEvent, { RRULE: `FREQ=DAILY;UNTIL=${until}` }))).toEqual([expected]);
  });

  it('a UTC DTSTART refuses a zoneless UNTIL under "keep"', () => {
    expect(() => updateFields(utcEvent, { RRULE: 'FREQ=DAILY;UNTIL=2026-10-26T18:00:00' }))
      .toThrow(/RRULE UNTIL has no zone, and DTSTART is in UTC/);
  });

  it('a UTC DTSTART reads a zoneless UNTIL in the host zone under "local"', () => {
    const local = new Date(2026, 9, 26, 18, 0, 0);
    const expected = local.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    expect(rrule(updateFields(utcEvent, { RRULE: 'FREQ=DAILY;UNTIL=2026-10-26T18:00:00' }, { floatingTime: 'local' })))
      .toEqual([`RRULE:FREQ=DAILY;UNTIL=${expected}`]);
  });

  it('an all-day DTSTART takes a date, in either input form', () => {
    const allDay = vevent('DTSTART;VALUE=DATE:20260101');
    expect(rrule(updateFields(allDay, { RRULE: 'FREQ=DAILY;UNTIL=2026-10-26' })))
      .toEqual(['RRULE:FREQ=DAILY;UNTIL=20261026']);
    expect(rrule(updateFields(allDay, { RRULE: 'FREQ=DAILY;UNTIL=20261026' })))
      .toEqual(['RRULE:FREQ=DAILY;UNTIL=20261026']);
  });

  it('an all-day DTSTART refuses a date-time UNTIL, a timed one a date', () => {
    expect(() => updateFields(vevent('DTSTART;VALUE=DATE:20260101'), { RRULE: 'FREQ=DAILY;UNTIL=20261026T180000Z' }))
      .toThrow(/RRULE UNTIL must be a date: DTSTART is a date/);
    expect(() => updateFields(utcEvent, { RRULE: 'FREQ=DAILY;UNTIL=2026-10-26' }))
      .toThrow(/RRULE UNTIL needs a time: DTSTART has one/);
  });

  it('a floating DTSTART keeps UNTIL floating, even with "local"', () => {
    const floating = vevent('DTSTART:20260101T100000');
    expect(rrule(updateFields(floating, { RRULE: 'FREQ=DAILY;UNTIL=2026-10-26T18:00:00' }, { floatingTime: 'local' })))
      .toEqual(['RRULE:FREQ=DAILY;UNTIL=20261026T180000']);
  });

  it('a floating DTSTART refuses a UNTIL with a zone', () => {
    expect(() => updateFields(vevent('DTSTART:20260101T100000'), { RRULE: 'FREQ=DAILY;UNTIL=20261026T180000Z' }))
      .toThrow(/RRULE UNTIL must be a local time without a zone, like the floating DTSTART/);
  });

  it('a TZID DTSTART converts a zoneless UNTIL from that zone to UTC with the VTIMEZONE', () => {
    const berlin = vevent('DTSTART;TZID=Europe/Berlin:20260101T100000', { vtimezone: true });
    // 26 Oct 2026 is after the switch to CET (+01:00); 1 Jul is in CEST (+02:00)
    expect(rrule(updateFields(berlin, { RRULE: 'FREQ=DAILY;UNTIL=2026-10-26T18:00:00' })))
      .toEqual(['RRULE:FREQ=DAILY;UNTIL=20261026T170000Z']);
    expect(rrule(updateFields(berlin, { RRULE: 'FREQ=DAILY;UNTIL=20260701T180000' })))
      .toEqual(['RRULE:FREQ=DAILY;UNTIL=20260701T160000Z']);
  });

  it('a TZID DTSTART takes a UTC or offset UNTIL as it is', () => {
    const berlin = vevent('DTSTART;TZID=Europe/Berlin:20260101T100000');
    expect(rrule(updateFields(berlin, { RRULE: 'FREQ=DAILY;UNTIL=2026-10-26T18:00:00+01:00' })))
      .toEqual(['RRULE:FREQ=DAILY;UNTIL=20261026T170000Z']);
  });

  it('a TZID DTSTART without a VTIMEZONE refuses a zoneless UNTIL and asks for a zone', () => {
    const berlin = vevent('DTSTART;TZID=Europe/Berlin:20260101T100000');
    expect(() => updateFields(berlin, { RRULE: 'FREQ=DAILY;UNTIL=2026-10-26T18:00:00' }))
      .toThrow(/RRULE UNTIL has no zone, and DTSTART's zone "Europe\/Berlin" has no VTIMEZONE .* give it a zone/);
  });

  it('the key order does not matter: UNTIL follows the new DTSTART', () => {
    const out = updateFields(utcEvent, { RRULE: 'FREQ=DAILY;UNTIL=2026-10-26', DTSTART: '2026-01-01' });
    expect(rrule(out)).toEqual(['RRULE:FREQ=DAILY;UNTIL=20261026']);
  });

  it('without a DTSTART UNTIL is written in the form given', () => {
    const todo = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//tsdav-utils//Test//EN',
      'BEGIN:VTODO', 'UID:todo-1', 'DTSTAMP:20260101T000000Z', 'SUMMARY:t',
      'END:VTODO', 'END:VCALENDAR', '',
    ].join('\r\n');
    expect(rrule(updateFields(todo, { RRULE: 'FREQ=DAILY;UNTIL=2026-10-26T18:00:00' })))
      .toEqual(['RRULE:FREQ=DAILY;UNTIL=20261026T180000']);
  });

  it('an unparseable UNTIL names the rule and the accepted forms', () => {
    expect(() => updateFields(utcEvent, { RRULE: 'FREQ=DAILY;UNTIL=tomorrow' }))
      .toThrow(/RRULE UNTIL: "TOMORROW" is not a date or date-time\. Accepted forms/);
  });
});

/** the DTSTART and unfolded RRULE/EXRULE lines of the event */
const series = (ical: string) => {
  const unfolded = ical.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  return unfolded.slice(unfolded.findIndex((l) => l === 'BEGIN:VEVENT'))
    .filter((l) => /^(DTSTART|RRULE|EXRULE)[:;]/.test(l));
};

describe('writing DTSTART carries an existing UNTIL into the new form', () => {
  const timed = vevent('DTSTART:20261001T100000Z', { props: ['RRULE:FREQ=DAILY;UNTIL=20261020T100000Z'] });

  it('timed -> all-day: the UNTIL date in the old DTSTART\'s frame', () => {
    expect(series(updateFields(timed, { DTSTART: '2026-10-01' })))
      .toEqual(['DTSTART;VALUE=DATE:20261001', 'RRULE:FREQ=DAILY;UNTIL=20261020']);
  });

  it('a TZID -> all-day UNTIL takes the date in the old zone, read with the VTIMEZONE', () => {
    // 23:00Z on 20 Oct is 01:00 on 21 Oct in Berlin (CEST)
    const berlin = vevent('DTSTART;TZID=Europe/Berlin:20261001T100000',
      { vtimezone: true, props: ['RRULE:FREQ=DAILY;UNTIL=20261020T230000Z'] });
    expect(series(updateFields(berlin, { DTSTART: '2026-10-01' })))
      .toEqual(['DTSTART;VALUE=DATE:20261001', 'RRULE:FREQ=DAILY;UNTIL=20261021']);
  });

  it('a TZID -> all-day UNTIL without the VTIMEZONE throws and asks for the rule', () => {
    const berlin = vevent('DTSTART;TZID=Europe/Berlin:20261001T100000',
      { props: ['RRULE:FREQ=DAILY;UNTIL=20261020T230000Z'] });
    expect(() => updateFields(berlin, { DTSTART: '2026-10-01' }))
      .toThrow(/DTSTART changed, and the existing RRULE UNTIL=20261020T230000Z cannot follow it \(.*no VTIMEZONE.*\): give RRULE, with UNTIL, in the same call/);
  });

  it('all-day -> timed (UTC): the end of the UNTIL day, in UTC', () => {
    const allDay = vevent('DTSTART;VALUE=DATE:20261001', { props: ['RRULE:FREQ=DAILY;UNTIL=20261020'] });
    expect(series(updateFields(allDay, { DTSTART: '2026-10-01T10:00:00Z' })))
      .toEqual(['DTSTART:20261001T100000Z', 'RRULE:FREQ=DAILY;UNTIL=20261020T235959Z']);
  });

  it('all-day -> floating: the end of the UNTIL day as floating wall clock', () => {
    const allDay = vevent('DTSTART;VALUE=DATE:20261001', { props: ['RRULE:FREQ=DAILY;UNTIL=20261020'] });
    expect(series(updateFields(allDay, { DTSTART: '2026-10-01T10:00:00' })))
      .toEqual(['DTSTART:20261001T100000', 'RRULE:FREQ=DAILY;UNTIL=20261020T235959']);
  });

  // A UTC DTSTART has no TZID that a new value could keep, so updateFields
  // only reaches a TZID DTSTART from one that already has the TZID. The
  // conversion into it is shown with an UNTIL another client left floating.
  it('into a TZID DTSTART a floating UNTIL is converted to UTC with the VTIMEZONE', () => {
    const berlin = vevent('DTSTART;TZID=Europe/Berlin:20261001T100000',
      { vtimezone: true, props: ['RRULE:FREQ=DAILY;UNTIL=20261020T180000'] });
    expect(series(updateFields(berlin, { DTSTART: '2026-10-02T09:00:00' })))
      .toEqual(['DTSTART;TZID=Europe/Berlin:20261002T090000', 'RRULE:FREQ=DAILY;UNTIL=20261020T160000Z']);
  });

  it('into a TZID DTSTART without the VTIMEZONE a floating UNTIL throws and asks for the rule', () => {
    const berlin = vevent('DTSTART;TZID=Europe/Berlin:20261001T100000',
      { props: ['RRULE:FREQ=DAILY;UNTIL=20261020T180000'] });
    expect(() => updateFields(berlin, { DTSTART: '2026-10-02T09:00:00' }))
      .toThrow(/existing RRULE UNTIL=20261020T180000 cannot follow it .*: give RRULE, with UNTIL, in the same call/);
  });

  it('TZID -> UTC keeps a UTC UNTIL as it is', () => {
    const berlin = vevent('DTSTART;TZID=Europe/Berlin:20261001T100000',
      { props: ['RRULE:FREQ=DAILY;UNTIL=20261020T080000Z'] });
    expect(series(updateFields(berlin, { DTSTART: '2026-10-01T08:00:00Z' })))
      .toEqual(['DTSTART:20261001T080000Z', 'RRULE:FREQ=DAILY;UNTIL=20261020T080000Z']);
  });

  it('floating -> UTC throws under "keep": the wall clock names no instant', () => {
    const floating = vevent('DTSTART:20261001T100000', { props: ['RRULE:FREQ=DAILY;UNTIL=20261020T100000'] });
    expect(() => updateFields(floating, { DTSTART: '2026-10-01T10:00:00Z' }))
      .toThrow(/existing RRULE UNTIL=20261020T100000 cannot follow it \(RRULE UNTIL has no zone, and DTSTART is in UTC.*\): give RRULE, with UNTIL, in the same call/);
  });

  it('floating -> UTC reads the UNTIL in the host zone under "local"', () => {
    const floating = vevent('DTSTART:20261001T100000', { props: ['RRULE:FREQ=DAILY;UNTIL=20261020T100000'] });
    const expected = new Date(2026, 9, 20, 10, 0, 0).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    expect(series(updateFields(floating, { DTSTART: '2026-10-01T10:00:00Z' }, { floatingTime: 'local' })))
      .toEqual(['DTSTART:20261001T100000Z', `RRULE:FREQ=DAILY;UNTIL=${expected}`]);
  });

  it('UTC -> floating throws: a UTC UNTIL has no wall clock without a zone', () => {
    expect(() => updateFields(timed, { DTSTART: '2026-10-01T10:00:00' }))
      .toThrow(/existing RRULE UNTIL=20261020T100000Z cannot follow it \(it is in UTC and the new DTSTART is floating.*\): give RRULE, with UNTIL, in the same call/);
  });

  it('an EXRULE UNTIL follows too', () => {
    const both = vevent('DTSTART:20261001T100000Z',
      { props: ['RRULE:FREQ=DAILY;COUNT=30', 'EXRULE:FREQ=WEEKLY;UNTIL=20261020T100000Z'] });
    expect(series(updateFields(both, { DTSTART: '2026-10-01' })))
      .toEqual(['DTSTART;VALUE=DATE:20261001', 'RRULE:FREQ=DAILY;COUNT=30', 'EXRULE:FREQ=WEEKLY;UNTIL=20261020']);
  });

  it('a COUNT rule is untouched', () => {
    const counted = vevent('DTSTART:20261001T100000Z', { props: ['RRULE:FREQ=WEEKLY;COUNT=5;BYDAY=MO'] });
    expect(series(updateFields(counted, { DTSTART: '2026-10-01' })))
      .toEqual(['DTSTART;VALUE=DATE:20261001', 'RRULE:FREQ=WEEKLY;COUNT=5;BYDAY=MO']);
  });

  it('an event without a rule is untouched', () => {
    expect(series(updateFields(utcEvent, { DTSTART: '2026-10-01' }))).toEqual(['DTSTART;VALUE=DATE:20261001']);
  });

  it('an RRULE given in the same call wins and is not re-derived', () => {
    expect(series(updateFields(timed, { DTSTART: '2026-10-01', RRULE: 'FREQ=DAILY;UNTIL=2026-10-25' })))
      .toEqual(['DTSTART;VALUE=DATE:20261001', 'RRULE:FREQ=DAILY;UNTIL=20261025']);
  });

  it('a call that does not write DTSTART leaves the rule alone', () => {
    expect(series(updateFields(timed, { SUMMARY: 'x' })))
      .toEqual(['DTSTART:20261001T100000Z', 'RRULE:FREQ=DAILY;UNTIL=20261020T100000Z']);
  });
});
