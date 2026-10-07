import { describe, it, expect } from 'vitest';
import { updateFields } from '../src/updateFields';

// The assertions look at the serialized lines on purpose: the defects these
// tests pin down (a lost offset, a stale TZID, a stale VALUE=DATE) are only
// visible in the bytes, and ical.js re-parses several of them without error.

const vtodo = (...props: string[]) => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//tsdav-utils//Test//EN',
  'BEGIN:VTODO', 'UID:todo-1', 'DTSTAMP:20260101T000000Z', 'SUMMARY:t',
  ...props,
  'END:VTODO', 'END:VCALENDAR', '',
].join('\r\n');

const vevent = (...props: string[]) => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//tsdav-utils//Test//EN',
  'BEGIN:VEVENT', 'UID:event-1', 'DTSTAMP:20260101T000000Z',
  'DTSTART:20260101T100000Z', 'DTEND:20260101T110000Z',
  ...props,
  'END:VEVENT', 'END:VCALENDAR', '',
].join('\r\n');

const vcard = (version: string, ...props: string[]) => [
  'BEGIN:VCARD', `VERSION:${version}`, 'UID:card-1', 'FN:X', ...props, 'END:VCARD', '',
].join('\r\n');

/** every line of the output for one property, parameters included */
const lines = (ical: string, name: string) =>
  ical.split(/\r?\n/).filter((l) => l.startsWith(`${name}:`) || l.startsWith(`${name};`));

describe('date-time values are written as the instant the caller gave', () => {
  it.each([
    ['2026-10-26T18:00:00Z', 'DUE:20261026T180000Z'],
    ['20261026T180000Z', 'DUE:20261026T180000Z'],
    ['2026-10-26T18:00:00+00:00', 'DUE:20261026T180000Z'],
    ['2026-10-26T14:00:00-04:00', 'DUE:20261026T180000Z'],
    ['2026-10-26T20:00:00+0200', 'DUE:20261026T180000Z'],
    ['2026-10-26T18:00:00.000Z', 'DUE:20261026T180000Z'],
    ['2026-10-26T18:00Z', 'DUE:20261026T180000Z'],
    // an offset can move the instant across midnight
    ['2026-10-26T23:30:00-04:00', 'DUE:20261027T033000Z'],
  ])('DUE %s -> %s', (value, expected) => {
    expect(lines(updateFields(vtodo('DUE:20260101T000000Z'), { DUE: value }), 'DUE')).toEqual([expected]);
  });

  it.each(['DTSTART', 'COMPLETED'])('%s gets the same treatment as DUE', (name) => {
    const out = updateFields(vtodo(), { [name]: '2026-10-26T14:00:00-04:00' });
    expect(lines(out, name)).toEqual([`${name}:20261026T180000Z`]);
  });

  it('RECURRENCE-ID and LAST-MODIFIED on an event keep their instant', () => {
    const out = updateFields(vevent(), {
      'RECURRENCE-ID': '2026-10-26T20:00:00+02:00',
      'LAST-MODIFIED': '2026-10-26T20:00:00+02:00',
    });
    expect(lines(out, 'RECURRENCE-ID')).toEqual(['RECURRENCE-ID:20261026T180000Z']);
    expect(lines(out, 'LAST-MODIFIED')).toEqual(['LAST-MODIFIED:20261026T180000Z']);
  });
});

describe('parameters of the old value do not survive', () => {
  it('drops a TZID, which RFC 5545 3.2.19 forbids on a UTC value', () => {
    const out = updateFields(vtodo('DUE;TZID=Europe/Berlin:20260101T100000'), { DUE: '2026-10-26T18:00:00Z' });
    expect(lines(out, 'DUE')).toEqual(['DUE:20261026T180000Z']);
  });

  it('drops VALUE=DATE when a date becomes a date-time', () => {
    const out = updateFields(vtodo('DUE;VALUE=DATE:20260101'), { DUE: '2026-10-26T18:00:00Z' });
    expect(lines(out, 'DUE')).toEqual(['DUE:20261026T180000Z']);
  });

  it('keeps parameters that still apply, such as RANGE on RECURRENCE-ID', () => {
    const out = updateFields(
      vevent('RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=Europe/Berlin:20260101T100000'),
      { 'RECURRENCE-ID': '2026-10-26T18:00:00Z' },
    );
    expect(lines(out, 'RECURRENCE-ID')).toEqual(['RECURRENCE-ID;RANGE=THISANDFUTURE:20261026T180000Z']);
  });

  it('writes one line, never a second copy of the property', () => {
    const out = updateFields(vtodo('DUE:20260101T000000Z'), { DUE: '2026-10-26' });
    expect(lines(out, 'DUE')).toHaveLength(1);
  });
});

describe('dates', () => {
  it.each(['2026-10-26', '20261026'])('%s becomes an all-day DATE', (value) => {
    const out = updateFields(vtodo('DUE:20260101T000000Z'), { DUE: value });
    expect(lines(out, 'DUE')).toEqual(['DUE;VALUE=DATE:20261026']);
  });

  it('a date-time over an existing DATE drops the DATE type', () => {
    const out = updateFields(vevent(), { DTSTART: '2026-10-26' });
    expect(lines(out, 'DTSTART')).toEqual(['DTSTART;VALUE=DATE:20261026']);
    const back = updateFields(out, { DTSTART: '2026-10-26T09:00:00Z' });
    expect(lines(back, 'DTSTART')).toEqual(['DTSTART:20261026T090000Z']);
  });

  it('rejects a date where only a date-time is allowed', () => {
    expect(() => updateFields(vtodo(), { COMPLETED: '2026-10-26' })).toThrow(/COMPLETED needs a date-time/);
  });

  it('rejects a date that does not exist instead of rolling it over', () => {
    expect(() => updateFields(vtodo(), { DUE: '2026-02-30' })).toThrow(/not a valid date/);
    expect(() => updateFields(vtodo(), { DUE: '2026-10-26T25:00:00Z' })).toThrow(/not a valid date/);
  });
});

describe('date-times without a zone', () => {
  it('stay floating when the property has no zone (RFC 5545 3.3.5 form #1)', () => {
    const out = updateFields(vtodo('DUE:20260101T000000Z'), { DUE: '2026-10-26T18:00:00' });
    expect(lines(out, 'DUE')).toEqual(['DUE:20261026T180000']);
  });

  it('are read in the zone the property already has, which keeps its TZID', () => {
    const out = updateFields(vtodo('DUE;TZID=Europe/Berlin:20260101T100000'), { DUE: '2026-10-26T18:00:00' });
    expect(lines(out, 'DUE')).toEqual(['DUE;TZID=Europe/Berlin:20261026T180000']);
  });

  it('prefer the existing TZID over floatingTime "local"', () => {
    const out = updateFields(
      vevent('RECURRENCE-ID;TZID=Europe/Berlin:20260101T100000'),
      { 'RECURRENCE-ID': '2026-10-26T18:00:00' },
      { floatingTime: 'local' },
    );
    expect(lines(out, 'RECURRENCE-ID')).toEqual(['RECURRENCE-ID;TZID=Europe/Berlin:20261026T180000']);
  });

  it('are read in the host timezone with floatingTime "local"', () => {
    const out = updateFields(vtodo(), { DUE: '2026-10-26T18:00:00' }, { floatingTime: 'local' });
    const utc = new Date(2026, 9, 26, 18, 0, 0).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    expect(lines(out, 'DUE')).toEqual([`DUE:${utc}`]);
  });

  it.each(['COMPLETED', 'DTSTAMP', 'CREATED', 'LAST-MODIFIED'])('are rejected for %s, which must be UTC', (name) => {
    expect(() => updateFields(vtodo(), { [name]: '2026-10-26T18:00:00' })).toThrow(/must be in UTC/);
  });

  it('are accepted for a UTC-only property with floatingTime "local"', () => {
    const out = updateFields(vtodo(), { COMPLETED: '2026-10-26T18:00:00' }, { floatingTime: 'local' });
    expect(lines(out, 'COMPLETED')[0]).toMatch(/^COMPLETED:\d{8}T\d{6}Z$/);
  });

  it('cannot be mixed with zoned values on a zoned property', () => {
    expect(() => updateFields(
      vevent('EXDATE;TZID=Europe/Berlin:20260101T100000'),
      { EXDATE: '2026-10-26T18:00:00,2026-10-27T18:00:00Z' },
    )).toThrow(/with and without a zone/);
  });
});

describe('input forms', () => {
  it.each([
    ['2026-10-26T20:00:00+02', 'DUE:20261026T180000Z'],
    ['20261026T200000+0200', 'DUE:20261026T180000Z'],
    ['2026-10-26t18:00:00z', 'DUE:20261026T180000Z'],
  ])('%s -> %s', (value, expected) => {
    expect(lines(updateFields(vtodo(), { DUE: value }), 'DUE')).toEqual([expected]);
  });

  it('handles years before 100, which Date.UTC would move into the 1900s', () => {
    const out = updateFields(vtodo(), { DUE: '0099-01-01' });
    expect(lines(out, 'DUE')).toEqual(['DUE;VALUE=DATE:00990101']);
  });

  it('names the property in a parse error', () => {
    expect(() => updateFields(vtodo(), { DUE: 'tomorrow' })).toThrow(/^DUE: "tomorrow"/);
  });

  it('rejects an unknown floatingTime option', () => {
    expect(() => updateFields(vtodo(), { DUE: '2026-10-26' }, { floatingTime: 'utc' as any })).toThrow(/floatingTime/);
  });
});

describe('multi-valued properties', () => {
  it('encodes every EXDATE value and replaces a stale TZID', () => {
    const out = updateFields(
      vevent('EXDATE;TZID=Europe/Berlin:20260101T100000'),
      { EXDATE: '2026-10-26T20:00:00+02:00,20261102T180000Z' },
    );
    expect(lines(out, 'EXDATE')).toEqual(['EXDATE:20261026T180000Z,20261102T180000Z']);
  });

  it('ignores a trailing comma', () => {
    const out = updateFields(vevent(), { EXDATE: '2026-10-26T18:00:00Z,' });
    expect(lines(out, 'EXDATE')).toEqual(['EXDATE:20261026T180000Z']);
  });

  it('rejects a mix of dates and date-times', () => {
    expect(() => updateFields(vevent(), { EXDATE: '2026-10-26,2026-10-27T10:00:00Z' })).toThrow(/mixes dates and date-times/);
  });
});

describe('unparseable values fail loudly and name the accepted forms', () => {
  it.each(['tomorrow', '26.10.2026', '2026-10-26 18:00', ''])('%j', (value) => {
    expect(() => updateFields(vtodo(), { DUE: value })).toThrow(/Accepted forms/);
  });
});

describe('vCard', () => {
  it('vCard 4 REV (TIMESTAMP) keeps its instant', () => {
    const out = updateFields(vcard('4.0', 'REV:20200101T000000Z'), { REV: '2026-10-26T20:00:00+02:00' });
    expect(lines(out, 'REV')).toEqual(['REV:20261026T180000Z']);
  });

  // vCard 4 types BDAY as DATE-AND-OR-TIME, which allows "--0501"; vCard 3
  // cards carry the same in practice, so neither version parses it
  it.each(['3.0', '4.0'])('vCard %s BDAY keeps a partial date', (version) => {
    const out = updateFields(vcard(version), { BDAY: '--0501' });
    expect(lines(out, 'BDAY')).toEqual(['BDAY:--0501']);
  });

  it('vCard 3 REV (DATE-TIME) keeps its instant', () => {
    const out = updateFields(vcard('3.0', 'REV:20200101T000000Z'), { REV: '2026-10-26T20:00:00+02:00' });
    expect(lines(out, 'REV')).toEqual(['REV:20261026T180000Z']);
  });

  it.each([
    ['1990-05-01', 'BDAY:19900501'],
    ['--0501', 'BDAY:--0501'],
  ])('vCard 4 BDAY %s is written as before (DATE-AND-OR-TIME allows partial dates)', (value, expected) => {
    const out = updateFields(vcard('4.0', 'BDAY:19800101'), { BDAY: value });
    expect(lines(out, 'BDAY')).toEqual([expected]);
  });
});

describe('everything that is not a date is untouched', () => {
  it('TEXT and X- properties are written as before', () => {
    const out = updateFields(vtodo(), { SUMMARY: '2026-10-26T18:00:00+02:00', 'X-DUE': '20261026T180000Z' });
    expect(lines(out, 'SUMMARY')).toEqual(['SUMMARY:2026-10-26T18:00:00+02:00']);
    expect(lines(out, 'X-DUE')).toEqual(['X-DUE:20261026T180000Z']);
  });

  it('a DURATION-typed TRIGGER is not parsed as a date', () => {
    const out = updateFields(vtodo(), { TRIGGER: '-PT15M' });
    expect(lines(out, 'TRIGGER')).toEqual(['TRIGGER:-PT15M']);
  });
});
