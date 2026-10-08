import { describe, expect, it } from 'vitest';
import { isUpdateFieldsError, updateFields } from '../src/index';

/*
 * EXDATE and RDATE are lists of dates, which an object may spread over several
 * lines (RFC 5545 3.8.5.1, 3.8.5.2). A plain write gives the whole list; with
 * options.append the values join the ones the object holds (issue #28).
 */

const calendar = (...lines: string[]) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...lines, 'END:VCALENDAR', ''].join('\r\n');
const event = (...lines: string[]) => ['BEGIN:VEVENT', 'UID:e', 'DTSTAMP:20260101T000000Z', ...lines, 'END:VEVENT'];
/** A weekly series on Thursdays 09:00 UTC, from 3 December 2026 */
const weekly = (...extra: string[]) =>
  calendar(...event('DTSTART:20261203T090000Z', 'RRULE:FREQ=WEEKLY;COUNT=10', ...extra));
const berlin = (...extra: string[]) =>
  calendar(...event('DTSTART;TZID=Europe/Berlin:20261203T100000', 'RRULE:FREQ=WEEKLY;COUNT=10', ...extra));
const allDay = (...extra: string[]) =>
  calendar(...event('DTSTART;VALUE=DATE:20261203', 'RRULE:FREQ=WEEKLY;COUNT=10', ...extra));

/** The unfolded lines of a property in the output */
const lines = (ics: string, name: string) =>
  ics.replace(/\r\n[ \t]/g, '').split('\r\n').filter((line) => new RegExp(`^${name}[;:]`).test(line));

const thrown = (call: () => unknown): unknown => {
  try {
    call();
  } catch (error) {
    return error;
  }
  throw new Error('did not throw');
};

describe('a plain EXDATE write gives the whole list', () => {
  it('replaces one line', () => {
    const out = updateFields(weekly('EXDATE:20261224T090000Z'), { EXDATE: '2026-12-31T09:00:00Z' });
    expect(lines(out, 'EXDATE')).toEqual(['EXDATE:20261231T090000Z']);
  });

  it('replaces every line, not only the first', () => {
    const out = updateFields(weekly('EXDATE:20261224T090000Z', 'EXDATE:20261210T090000Z'),
      { EXDATE: '2026-12-31T09:00:00Z' });
    expect(lines(out, 'EXDATE')).toEqual(['EXDATE:20261231T090000Z']);
  });

  it('replaces a comma list with the comma list given', () => {
    const out = updateFields(weekly('EXDATE:20261224T090000Z,20261210T090000Z'),
      { EXDATE: '2026-12-31T09:00:00Z,2027-01-07T09:00:00Z' });
    expect(lines(out, 'EXDATE')).toEqual(['EXDATE:20261231T090000Z,20270107T090000Z']);
  });

  it('replaces lines in different zones, a wall-clock value read in the first line\'s zone', () => {
    const out = updateFields(berlin('EXDATE;TZID=Europe/Berlin:20261210T100000', 'EXDATE:20261217T090000Z'),
      { EXDATE: '2026-12-24T10:00:00' });
    expect(lines(out, 'EXDATE')).toEqual(['EXDATE;TZID=Europe/Berlin:20261224T100000']);
  });

  it('writes dates on an all-day series, over every line', () => {
    const out = updateFields(allDay('EXDATE;VALUE=DATE:20261210', 'EXDATE;VALUE=DATE:20261217'),
      { EXDATE: '2026-12-24,2026-12-31' });
    expect(lines(out, 'EXDATE')).toEqual(['EXDATE;VALUE=DATE:20261224,20261231']);
  });

  it('applies to RDATE the same way', () => {
    const out = updateFields(weekly('RDATE:20261205T090000Z', 'RDATE;VALUE=PERIOD:20261206T090000Z/PT1H'),
      { RDATE: '2026-12-26T09:00:00Z' });
    expect(lines(out, 'RDATE')).toEqual(['RDATE:20261226T090000Z']);
  });
});

describe('options.append adds to the list', () => {
  it('keeps the exclusions the object holds (the case of issue #28)', () => {
    const out = updateFields(weekly('EXDATE:20261224T090000Z'), { EXDATE: '2026-12-31T09:00:00Z' },
      { append: ['EXDATE'] });
    expect(lines(out, 'EXDATE')).toEqual(['EXDATE:20261224T090000Z', 'EXDATE:20261231T090000Z']);
  });

  it('keeps several lines and comma lists alike', () => {
    const out = updateFields(weekly('EXDATE:20261210T090000Z,20261217T090000Z', 'EXDATE:20261224T090000Z'),
      { EXDATE: '2026-12-31T09:00:00Z' }, { append: ['exdate'] });
    expect(lines(out, 'EXDATE')).toEqual(
      ['EXDATE:20261210T090000Z,20261217T090000Z', 'EXDATE:20261224T090000Z', 'EXDATE:20261231T090000Z']);
  });

  it('drops a value the list already holds, by instant whatever its zone, and repeats within the call', () => {
    const out = updateFields(berlin('EXDATE;TZID=Europe/Berlin:20261224T100000'),
      { EXDATE: '2026-12-24T09:00:00Z,2026-12-31T10:00:00+01:00,2026-12-31T09:00:00Z' }, { append: ['EXDATE'] });
    expect(lines(out, 'EXDATE')).toEqual(
      ['EXDATE;TZID=Europe/Berlin:20261224T100000', 'EXDATE:20261231T090000Z']);
  });

  it('writes nothing new when every value is already there', () => {
    const input = weekly('EXDATE:20261224T090000Z');
    const out = updateFields(input, { EXDATE: '2026-12-24T09:00:00Z' }, { append: ['EXDATE'] });
    expect(lines(out, 'EXDATE')).toEqual(['EXDATE:20261224T090000Z']);
  });

  it('reads a wall-clock value in DTSTART\'s zone', () => {
    const out = updateFields(berlin('EXDATE;TZID=Europe/Berlin:20261224T100000'), { EXDATE: '2026-12-31T10:00:00' },
      { append: ['EXDATE'] });
    expect(lines(out, 'EXDATE')).toEqual(
      ['EXDATE;TZID=Europe/Berlin:20261224T100000', 'EXDATE;TZID=Europe/Berlin:20261231T100000']);
  });

  it('adds dates on an all-day series, and refuses a date-time there', () => {
    const out = updateFields(allDay('EXDATE;VALUE=DATE:20261224'), { EXDATE: '2026-12-31,2026-12-24' },
      { append: ['EXDATE'] });
    expect(lines(out, 'EXDATE')).toEqual(['EXDATE;VALUE=DATE:20261224', 'EXDATE;VALUE=DATE:20261231']);
    expect(() => updateFields(allDay(), { EXDATE: '2026-12-31T09:00:00Z' }, { append: ['EXDATE'] }))
      .toThrow(/must be a date/);
  });

  it('adds to RDATE, keeping periods, and an added RDATE is no exclusion to check', () => {
    const out = updateFields(weekly('RDATE;VALUE=PERIOD:20261206T090000Z/PT1H'),
      { RDATE: '2026-12-05T09:00:00Z,2026-12-06T09:00:00Z' }, { append: ['RDATE'] });
    expect(lines(out, 'RDATE')).toEqual(['RDATE;VALUE=PERIOD:20261206T090000Z/PT1H', 'RDATE:20261205T090000Z']);
  });

  it('adds only to the properties it names', () => {
    const out = updateFields(weekly('EXDATE:20261224T090000Z', 'RDATE:20261205T090000Z'),
      { EXDATE: '2026-12-31T09:00:00Z', RDATE: '2026-12-26T09:00:00Z' }, { append: ['RDATE'] });
    expect(lines(out, 'EXDATE')).toEqual(['EXDATE:20261231T090000Z']);
    expect(lines(out, 'RDATE')).toEqual(['RDATE:20261205T090000Z', 'RDATE:20261226T090000Z']);
  });

  it('may name a property the call does not write', () => {
    const out = updateFields(weekly('EXDATE:20261224T090000Z'), { SUMMARY: 'x' }, { append: ['EXDATE', 'RDATE'] });
    expect(lines(out, 'EXDATE')).toEqual(['EXDATE:20261224T090000Z']);
  });

  it('adds an EXDATE for an occurrence an RDATE added in the same call', () => {
    const out = updateFields(weekly(), { RDATE: '2026-12-05T09:00:00Z', EXDATE: '2026-12-05T09:00:00Z' },
      { append: ['EXDATE', 'RDATE'] });
    expect(lines(out, 'EXDATE')).toEqual(['EXDATE:20261205T090000Z']);
  });
});

describe('an added EXDATE has to name an occurrence', () => {
  it('refuses one at a time the series has none, with what to give instead', () => {
    const error = thrown(() => updateFields(berlin(), { EXDATE: '2026-12-24T10:00:00Z' }, { append: ['EXDATE'] }));
    expect(isUpdateFieldsError(error, 'UNMATCHED_EXDATE')).toBe(true);
    expect(error).toMatchObject({ remedy: 'fix-value', property: 'EXDATE' });
    expect((error as Error).message).toMatch(
      /^EXDATE 20261224T100000Z names no occurrence of the series \(DTSTART;TZID=Europe\/Berlin:20261203T100000, RRULE:FREQ=WEEKLY;COUNT=10\)/);
  });

  it('refuses one past the end of the series', () => {
    expect(() => updateFields(weekly(), { EXDATE: '2027-02-11T09:00:00Z' }, { append: ['EXDATE'] }))
      .toThrow(/EXDATE 20270211T090000Z names no occurrence/);
  });

  it('checks against the series as the call leaves it: moved, or with a new rule', () => {
    // moved to 10:00, the occurrences are at 10:00
    expect(lines(updateFields(weekly('EXDATE:20261210T090000Z'),
      { DTSTART: '2026-12-03T10:00:00Z', EXDATE: '2026-12-24T10:00:00Z' }, { append: ['EXDATE'] }), 'EXDATE'))
      .toEqual(['EXDATE:20261210T100000Z', 'EXDATE:20261224T100000Z']);
    expect(() => updateFields(weekly(), { DTSTART: '2026-12-03T10:00:00Z', EXDATE: '2026-12-24T09:00:00Z' },
      { append: ['EXDATE'] })).toThrow(/names no occurrence/);
    expect(lines(updateFields(weekly(), { RRULE: 'FREQ=DAILY;COUNT=10', EXDATE: '2026-12-05T09:00:00Z' },
      { append: ['EXDATE'] }), 'EXDATE')).toEqual(['EXDATE:20261205T090000Z']);
  });

  it('accepts a duplicate the series no longer has, as nothing is added', () => {
    const out = updateFields(weekly('EXDATE:20261224T100000Z'), { EXDATE: '2026-12-24T10:00:00Z' },
      { append: ['EXDATE'] });
    expect(lines(out, 'EXDATE')).toEqual(['EXDATE:20261224T100000Z']);
  });

  it('is not checked on a plain write, which states the list as given', () => {
    const out = updateFields(weekly(), { EXDATE: '2026-12-24T10:00:00Z' });
    expect(lines(out, 'EXDATE')).toEqual(['EXDATE:20261224T100000Z']);
  });

  it('fails closed where the series cannot be checked', () => {
    const todo = calendar('BEGIN:VTODO', 'UID:t', 'DTSTAMP:20260101T000000Z', 'SUMMARY:x', 'END:VTODO');
    const error = thrown(() => updateFields(todo, { EXDATE: '2026-12-24T10:00:00Z' }, { append: ['EXDATE'] }));
    expect(isUpdateFieldsError(error, 'SERIES_UNVERIFIABLE')).toBe(true);
  });
});

describe('options.append is checked', () => {
  it.each([
    ['a string', 'EXDATE'],
    ['a list with a property that is no list of dates', ['DTSTART']],
    ['a list with a non-string', [5]],
  ])('refuses %s', (_, append) => {
    const error = thrown(() => updateFields(weekly(), { EXDATE: '2026-12-24T09:00:00Z' }, { append: append as never }));
    expect(isUpdateFieldsError(error, 'INVALID_INPUT')).toBe(true);
    expect(error).toMatchObject({ remedy: 'fix-value' });
  });
});
