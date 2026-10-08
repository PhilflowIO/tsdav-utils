import { describe, expect, it } from 'vitest';
import {
  cancelOccurrences,
  createRecurrenceBudget,
  expandOccurrences,
  isUpdateFieldsError,
  restoreOccurrences,
  updateFields,
} from '../src/index';
import type { ListMode } from '../src/index';

/*
 * EXDATE and RDATE are lists of dates, which an object may spread over several
 * lines (RFC 5545 3.8.5.1, 3.8.5.2). A write replaces, adds to or removes from
 * the list (options.lists), matching values by instant; cancelOccurrences and
 * restoreOccurrences do the same by occurrence (issue #28).
 */

const calendar = (...lines: string[]) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...lines, 'END:VCALENDAR', ''].join('\r\n');
const event = (...lines: string[]) => ['BEGIN:VEVENT', 'UID:e', 'DTSTAMP:20260101T000000Z', ...lines, 'END:VEVENT'];
/** A weekly series on Thursdays 09:00 UTC, from 3 December 2026 */
const weekly = (...extra: string[]) =>
  calendar(...event('DTSTART:20261203T090000Z', 'RRULE:FREQ=WEEKLY;COUNT=10', ...extra));
/** The same instants as a Berlin series at 10:00 (winter, no DST change in range) */
const berlin = (...extra: string[]) =>
  calendar(...event('DTSTART;TZID=Europe/Berlin:20261203T100000', 'RRULE:FREQ=WEEKLY;COUNT=10', ...extra));
const allDay = (...extra: string[]) =>
  calendar(...event('DTSTART;VALUE=DATE:20261203', 'RRULE:FREQ=WEEKLY;COUNT=10', ...extra));
const floating = (...extra: string[]) =>
  calendar(...event('DTSTART:20261203T100000', 'RRULE:FREQ=WEEKLY;COUNT=10', ...extra));
/** A Berlin series with an override for 17 December */
const overridden = (...extra: string[]) => calendar(
  ...event('DTSTART;TZID=Europe/Berlin:20261203T100000', 'RRULE:FREQ=WEEKLY;COUNT=10', ...extra),
  ...event('RECURRENCE-ID;TZID=Europe/Berlin:20261217T100000', 'DTSTART;TZID=Europe/Berlin:20261217T150000',
    'SUMMARY:moved'));

/** The unfolded lines of a property in the output */
const lines = (ics: string, name: string) =>
  ics.replace(/\r\n[ \t]/g, '').split('\r\n').filter((line) => new RegExp(`^${name}[;:]`).test(line));

const thrown = (call: () => unknown): Error => {
  try {
    call();
  } catch (error) {
    return error as Error;
  }
  throw new Error('did not throw');
};

/** The original starts of the occurrences the series still has */
const starts = (ics: string) => expandOccurrences(ics, { budget: createRecurrenceBudget(),
  until: '2027-03-01T00:00:00Z' }).occurrences.map((o) => o.recurrenceId.value);

describe('list mode "replace" (the default) gives the whole list, as a minimal change', () => {
  it('replaces one line', () => {
    const out = updateFields(weekly('EXDATE:20261224T090000Z'), { EXDATE: '2026-12-31T09:00:00Z' });
    expect(lines(out, 'EXDATE')).toEqual(['EXDATE:20261231T090000Z']);
  });

  it('replaces several lines and comma lists', () => {
    const out = updateFields(weekly('EXDATE:20261210T090000Z,20261217T090000Z', 'EXDATE:20261224T090000Z'),
      { EXDATE: '2026-12-31T09:00:00Z,2027-01-07T09:00:00Z' });
    expect(lines(out, 'EXDATE')).toEqual(['EXDATE:20261231T090000Z,20270107T090000Z']);
  });

  it('keeps the values it is given again where they are, with their line, zone and parameters', () => {
    const input = berlin('EXDATE;TZID=America/New_York;X-FOO=bar:20261210T040000,20261217T040000',
      'EXDATE:20261224T090000Z');
    const out = updateFields(input, { EXDATE: '2026-12-10T10:00:00,2026-12-24T10:00:00,2026-12-31T10:00:00' });
    expect(lines(out, 'EXDATE')).toEqual(['EXDATE;TZID=America/New_York;X-FOO=bar:20261210T040000',
      'EXDATE:20261224T090000Z', 'EXDATE;TZID=Europe/Berlin:20261231T100000']);
  });

  it('restating the list changes nothing, byte for byte', () => {
    const input = berlin('EXDATE;TZID=America/New_York;X-FOO=bar:20261210T040000,20261217T040000',
      'EXDATE:20261224T090000Z');
    expect(updateFields(input, { EXDATE: '2026-12-10T09:00:00Z,2026-12-17T10:00:00,2026-12-24T10:00:00' }))
      .toBe(updateFields(input, {}));
  });

  it('reads a wall-clock value in DTSTART\'s zone, never in the zone of a line the list holds', () => {
    // a list whose first line is in New York, on a Berlin series: 10:00 is Berlin's
    const out = updateFields(berlin('EXDATE;TZID=America/New_York;X-FOO=bar:20261210T040000'),
      { EXDATE: '2026-12-10T10:00:00,2026-12-17T10:00:00' });
    expect(lines(out, 'EXDATE')).toEqual(['EXDATE;TZID=America/New_York;X-FOO=bar:20261210T040000',
      'EXDATE;TZID=Europe/Berlin:20261217T100000']);
    expect(starts(out)).not.toContain('2026-12-10T10:00:00');
    expect(starts(out)).not.toContain('2026-12-17T10:00:00');
  });

  it('writes dates on an all-day series', () => {
    const out = updateFields(allDay('EXDATE;VALUE=DATE:20261210', 'EXDATE;VALUE=DATE:20261217'),
      { EXDATE: '2026-12-17,2026-12-24' });
    expect(lines(out, 'EXDATE')).toEqual(['EXDATE;VALUE=DATE:20261217', 'EXDATE;VALUE=DATE:20261224']);
  });

  it('applies to RDATE the same way, periods matched by their start', () => {
    const out = updateFields(weekly('RDATE:20261205T090000Z', 'RDATE;VALUE=PERIOD:20261206T090000Z/PT1H'),
      { RDATE: '2026-12-06T09:00:00Z,2026-12-26T09:00:00Z' });
    expect(lines(out, 'RDATE')).toEqual(['RDATE;VALUE=PERIOD:20261206T090000Z/PT1H', 'RDATE:20261226T090000Z']);
  });

  it('is not moved with DTSTART: the values given are the new series\'', () => {
    const out = updateFields(weekly('EXDATE:20261210T090000Z', 'EXDATE:20261217T090000Z'),
      { DTSTART: '2026-12-03T10:00:00Z', EXDATE: '2026-12-24T10:00:00Z' });
    expect(lines(out, 'EXDATE')).toEqual(['EXDATE:20261224T100000Z']);
  });
});

describe('list mode "add"', () => {
  it('keeps the exclusions the object holds (the case of issue #28)', () => {
    const out = updateFields(weekly('EXDATE:20261224T090000Z'), { EXDATE: '2026-12-31T09:00:00Z' },
      { lists: { EXDATE: 'add' } });
    expect(lines(out, 'EXDATE')).toEqual(['EXDATE:20261224T090000Z', 'EXDATE:20261231T090000Z']);
  });

  it('drops a value the list holds, by instant whatever its zone, and repeats within the call', () => {
    const out = updateFields(berlin('EXDATE;TZID=Europe/Berlin:20261224T100000'),
      { EXDATE: '2026-12-24T09:00:00Z,2026-12-31T10:00:00+01:00,2026-12-31T09:00:00Z' }, { lists: { exdate: 'add' } as never });
    expect(lines(out, 'EXDATE')).toEqual(
      ['EXDATE;TZID=Europe/Berlin:20261224T100000', 'EXDATE:20261231T090000Z']);
  });

  it('writes nothing when every value is there already', () => {
    const input = weekly('EXDATE:20261224T090000Z');
    expect(updateFields(input, { EXDATE: '2026-12-24T09:00:00Z' }, { lists: { EXDATE: 'add' } }))
      .toBe(updateFields(input, {}));
  });

  it('adds dates on an all-day series, and refuses a date-time there', () => {
    const out = updateFields(allDay('EXDATE;VALUE=DATE:20261224'), { EXDATE: '2026-12-31,2026-12-24' },
      { lists: { EXDATE: 'add' } });
    expect(lines(out, 'EXDATE')).toEqual(['EXDATE;VALUE=DATE:20261224', 'EXDATE;VALUE=DATE:20261231']);
    expect(() => updateFields(allDay(), { EXDATE: '2026-12-31T09:00:00Z' }, { lists: { EXDATE: 'add' } }))
      .toThrow(/must be a date/);
  });

  it('meets the moved series: the lines there move, the values added are the new start\'s', () => {
    const out = updateFields(weekly('EXDATE:20261210T090000Z'),
      { DTSTART: '2026-12-03T10:00:00Z', EXDATE: '2026-12-24T10:00:00Z,2026-12-10T10:00:00Z' }, { lists: { EXDATE: 'add' } });
    expect(lines(out, 'EXDATE')).toEqual(['EXDATE:20261210T100000Z', 'EXDATE:20261224T100000Z']);
    expect(() => updateFields(weekly(), { DTSTART: '2026-12-03T10:00:00Z', EXDATE: '2026-12-24T09:00:00Z' },
      { lists: { EXDATE: 'add' } })).toThrow(/names no occurrence/);
  });

  it('adds to RDATE, keeping periods; an RDATE added is no exclusion to check', () => {
    const out = updateFields(weekly('RDATE;VALUE=PERIOD:20261206T090000Z/PT1H'),
      { RDATE: '2026-12-05T09:00:00Z,2026-12-06T09:00:00Z' }, { lists: { RDATE: 'add' } });
    expect(lines(out, 'RDATE')).toEqual(['RDATE;VALUE=PERIOD:20261206T090000Z/PT1H', 'RDATE:20261205T090000Z']);
  });

  it('adds an EXDATE for an occurrence an RDATE adds in the same call', () => {
    const out = updateFields(weekly(), { RDATE: '2026-12-05T09:00:00Z', EXDATE: '2026-12-05T09:00:00Z' },
      { lists: { EXDATE: 'add', RDATE: 'add' } });
    expect(lines(out, 'EXDATE')).toEqual(['EXDATE:20261205T090000Z']);
  });

  it('adds in the named zone', () => {
    const out = updateFields(berlin('EXDATE;TZID=Europe/Berlin:20261210T100000'), { EXDATE: '2026-12-24T10:00:00' },
      { zone: 'Europe/Berlin', lists: { EXDATE: 'add' } });
    expect(lines(out, 'EXDATE')).toEqual(
      ['EXDATE;TZID=Europe/Berlin:20261210T100000', 'EXDATE;TZID=Europe/Berlin:20261224T100000']);
  });
});

describe('an added EXDATE has to name an occurrence', () => {
  const message = (ics: string, value: string) =>
    thrown(() => updateFields(ics, { EXDATE: value }, { lists: { EXDATE: 'add' } }));

  it('refuses one the series does not have, typed, naming the occurrence that day', () => {
    const error = message(berlin(), '2026-12-24T10:00:00Z');
    expect(isUpdateFieldsError(error, 'UNMATCHED_EXDATE')).toBe(true);
    expect(error).toMatchObject({ remedy: 'fix-value', property: 'EXDATE' });
    expect(error.message).toMatch(/^EXDATE 20261224T100000Z names no occurrence of the series \(DTSTART;TZID=Europe\/Berlin:20261203T100000, RRULE:FREQ=WEEKLY;COUNT=10\); that day it has one at 20261224T100000/);
  });

  it('says how to name an occurrence in the series\' own form', () => {
    expect(message(berlin(), '2026-12-24T10:00:00Z').message)
      .toMatch(/wall-clock time in "Europe\/Berlin", like DTSTART \(e\.g\. "2026-12-24T10:00:00"\), or the instant with "Z" or an offset/);
    expect(message(weekly(), '2026-12-24T10:00:00Z').message).toMatch(/time in UTC with "Z", like DTSTART \(e\.g\. "2026-12-24T09:00:00Z"\)/);
    expect(message(floating(), '2026-12-24T11:00:00').message).toMatch(/local time without a zone, like DTSTART \(e\.g\. "2026-12-24T10:00:00"\)/);
    expect(message(allDay(), '2026-12-25').message).toMatch(/the date, like DTSTART \(e\.g\. "2026-12-03"\)/);
  });

  it('refuses one with a zone on a floating series as fix-value: drop the zone', () => {
    const error = message(floating(), '2026-12-24T10:00:00Z');
    expect(isUpdateFieldsError(error, 'ZONE_MISMATCH')).toBe(true);
    expect(error).toMatchObject({ remedy: 'fix-value' });
  });

  it('is not checked in mode "replace", which states the list as given', () => {
    expect(lines(updateFields(weekly(), { EXDATE: '2026-12-24T10:00:00Z' }), 'EXDATE')).toEqual(['EXDATE:20261224T100000Z']);
  });

  it('fails closed where the series cannot be checked', () => {
    const todo = calendar('BEGIN:VTODO', 'UID:t', 'DTSTAMP:20260101T000000Z', 'SUMMARY:x', 'END:VTODO');
    expect(isUpdateFieldsError(message(todo, '2026-12-24T10:00:00Z'), 'SERIES_UNVERIFIABLE')).toBe(true);
  });
});

describe('values are matched by instant, not by wall clock', () => {
  // daily at 02:30 Berlin; on 25 October 2026 02:30 shows twice, and names the
  // first pass, 00:30Z (RFC 5545 3.3.5); 01:30Z is the second pass
  const fold = (...extra: string[]) =>
    calendar(...event('DTSTART;TZID=Europe/Berlin:20261020T023000', 'RRULE:FREQ=DAILY;COUNT=10', ...extra));
  const range = (ics: string) => expandOccurrences(ics, { budget: createRecurrenceBudget(),
    until: '2026-11-01T00:00:00Z' }).occurrences.map((o) => o.recurrenceId.value);

  it('adds the first pass next to a stored second pass, which excluded nothing', () => {
    const input = fold('EXDATE:20261025T013000Z');
    expect(range(input)).toContain('2026-10-25T02:30:00');
    const out = updateFields(input, { EXDATE: '2026-10-25T00:30:00Z' }, { lists: { EXDATE: 'add' } });
    expect(lines(out, 'EXDATE')).toEqual(['EXDATE:20261025T013000Z', 'EXDATE:20261025T003000Z']);
    expect(range(out)).not.toContain('2026-10-25T02:30:00');
  });

  it('refuses to add the second pass, which names no occurrence', () => {
    expect(isUpdateFieldsError(thrown(() => updateFields(fold(), { EXDATE: '2026-10-25T01:30:00Z' },
      { lists: { EXDATE: 'add' } })), 'UNMATCHED_EXDATE')).toBe(true);
    const error = thrown(() => cancelOccurrences(fold(), ['2026-10-25T01:30:00Z']));
    expect(isUpdateFieldsError(error, 'UNKNOWN_OCCURRENCE')).toBe(true);
    expect(error.message).toMatch(/that day it has one at 20261025T023000/);
  });

  it('removes only the pass given', () => {
    const input = fold('EXDATE:20261025T003000Z,20261025T013000Z');
    expect(lines(updateFields(input, { EXDATE: '2026-10-25T01:30:00Z' }, { lists: { EXDATE: 'remove' } }), 'EXDATE'))
      .toEqual(['EXDATE:20261025T003000Z']);
    expect(lines(restoreOccurrences(input, ['2026-10-25T02:30:00']), 'EXDATE')).toEqual(['EXDATE:20261025T013000Z']);
  });

  it('a floating EXDATE in a zoned series names no instant: it matches nothing and is left as it is', () => {
    const input = berlin('EXDATE:20261210T100000');
    const out = updateFields(input, { EXDATE: '2026-12-10T10:00:00' }, { lists: { EXDATE: 'add' } });
    expect(lines(out, 'EXDATE')).toEqual(['EXDATE:20261210T100000', 'EXDATE;TZID=Europe/Berlin:20261210T100000']);
    expect(starts(out)).not.toContain('2026-12-10T10:00:00');
    expect(isUpdateFieldsError(thrown(() => restoreOccurrences(input, ['2026-12-10T10:00:00'])), 'NOT_IN_LIST')).toBe(true);
  });

  it('an RDATE in UTC on a floating series, which nothing floating can name, stops no check', () => {
    const input = floating('RDATE:20261206T090000Z', 'EXDATE:20261217T100000');
    expect(lines(updateFields(input, { EXDATE: '2026-12-10T10:00:00' }, { lists: { EXDATE: 'add' } }), 'EXDATE'))
      .toEqual(['EXDATE:20261217T100000', 'EXDATE:20261210T100000']);
    expect(lines(updateFields(input, { RRULE: 'FREQ=WEEKLY;COUNT=5' }), 'RRULE')).toEqual(['RRULE:FREQ=WEEKLY;COUNT=5']);
    // a value the call writes in UTC is refused, naming it
    expect(() => updateFields(input, { RDATE: '2026-12-26T10:00:00Z' }, { lists: { RDATE: 'add' } }))
      .toThrow(/^RDATE: DTSTART is a local time without a zone \(floating\).*"2026-12-26T10:00:00"/);
  });
});

describe('a value at a wall clock the DST change skips', () => {
  // daily at 02:30 Berlin; on 29 March 2026 02:30 does not exist and is read
  // as 01:30Z (RFC 5545 3.3.5), the same instant as 03:30 that day
  const gap = (...extra: string[]) =>
    calendar(...event('DTSTART;TZID=Europe/Berlin:20260325T023000', 'RRULE:FREQ=DAILY;COUNT=10', ...extra));
  const day = (ics: string) => expandOccurrences(ics, { budget: createRecurrenceBudget(), until: '2026-04-10T00:00:00Z' })
    .occurrences.map((o) => o.recurrenceId.value).filter((v) => v.startsWith('2026-03-29'));

  it.each([
    ['cancel by UTC', (ics: string) => cancelOccurrences(ics, ['2026-03-29T01:30:00Z'])],
    ['cancel by offset', (ics: string) => cancelOccurrences(ics, ['2026-03-29T03:30:00+02:00'])],
    ['add the twin wall clock', (ics: string) => updateFields(ics, { EXDATE: '2026-03-29T03:30:00' }, { lists: { EXDATE: 'add' } })],
    ['replace with the twin wall clock', (ics: string) => updateFields(ics, { EXDATE: '2026-03-29T03:30:00' })],
  ])('an EXDATE (%s) is written as the occurrence\'s own wall clock', (_, write) => {
    const out = write(gap());
    expect(lines(out, 'EXDATE')).toEqual(['EXDATE;TZID=Europe/Berlin:20260329T023000']);
    expect(day(out)).toEqual([]);
    // later edits read it without a doubt
    expect(lines(updateFields(out, { DTSTART: '2026-03-25T04:30:00' }), 'EXDATE')).toEqual(['EXDATE;TZID=Europe/Berlin:20260329T043000']);
  });

  it.each([
    ['add', { lists: { RDATE: 'add' as ListMode } }],
    ['replace', {}],
  ])('an RDATE that would repeat the occurrence under the twin is refused (%s)', (_, options) => {
    const error = thrown(() => updateFields(gap(), { RDATE: '2026-03-29T03:30:00' }, options));
    expect(isUpdateFieldsError(error, 'DST_AMBIGUOUS')).toBe(true);
    expect(error).toMatchObject({ remedy: 'fix-value', property: 'RDATE' });
  });
});

describe('remove and restore match the values held directly', () => {
  const fold = (...extra: string[]) =>
    calendar(...event('DTSTART;TZID=Europe/Berlin:20261020T023000', 'RRULE:FREQ=DAILY;COUNT=10', ...extra));

  it('cancel writes an instant as the series\' wall clock; the second pass of a repeated hour is no occurrence', () => {
    // an hourly series steps on the wall clock: 02:00 occurs once, at its first pass (00:00Z)
    const hourly = calendar(...event('DTSTART;TZID=Europe/Berlin:20261025T000000', 'RRULE:FREQ=HOURLY;COUNT=6'));
    expect(lines(cancelOccurrences(hourly, ['2026-10-25T00:00:00Z']), 'EXDATE'))
      .toEqual(['EXDATE;TZID=Europe/Berlin:20261025T020000']);
    const error = thrown(() => cancelOccurrences(hourly, ['2026-10-25T01:00:00Z']));
    expect(isUpdateFieldsError(error, 'UNKNOWN_OCCURRENCE')).toBe(true);
    expect(error).toMatchObject({ remedy: 'fix-value' });
  });

  it('remove takes away an EXDATE in the second pass of a repeated hour by its UTC value; restore refuses it, as it names no occurrence', () => {
    const input = fold('EXDATE:20261025T013000Z', 'EXDATE:20261024T003000Z');
    expect(lines(updateFields(input, { EXDATE: '2026-10-25T01:30:00Z' }, { lists: { EXDATE: 'remove' } }), 'EXDATE'))
      .toEqual(['EXDATE:20261024T003000Z']);
    expect(isUpdateFieldsError(thrown(() => restoreOccurrences(input, ['2026-10-25T01:30:00Z'])), 'UNKNOWN_OCCURRENCE')).toBe(true);
  });

  it('a floating EXDATE in a zoned series names nothing: it blocks no rule change, and is kept', () => {
    const input = calendar(...event('DTSTART;TZID=Europe/Berlin:20260913T010000', 'RRULE:FREQ=MONTHLY;COUNT=3',
      'RDATE;TZID=Europe/Berlin:20260915T040000', 'EXDATE:20260915T040000'));
    expect(lines(updateFields(input, { RDATE: '2026-10-20T04:00:00' }), 'EXDATE')).toEqual(['EXDATE:20260915T040000']);
    expect(lines(updateFields(input, { RDATE: '2026-09-15T04:00:00' }, { lists: { RDATE: 'remove' } }), 'RDATE')).toEqual([]);
    expect(starts(input)).toContain('2026-09-15T04:00:00');
  });

  it('refuses an unreadable value in the list in every mode, as the write needs to read it', () => {
    for (const mode of ['replace', 'add', 'remove'] as ListMode[]) {
      const error = thrown(() => updateFields(berlin('EXDATE:garbage', 'EXDATE:20261210T090000Z'),
        { EXDATE: '2026-12-10T10:00:00' }, { lists: { EXDATE: mode } }));
      expect(isUpdateFieldsError(error, 'INVALID_VALUE')).toBe(true);
      expect(error).toMatchObject({ remedy: 'rewrite-object', property: 'EXDATE' });
    }
  });
});

describe('a date in the list of a timed series holds every occurrence that day (as ical.js reads it)', () => {
  const dated = berlin('EXDATE;VALUE=DATE:20261210');

  it('expandOccurrences leaves the day out', () => {
    expect(starts(dated)).not.toContain('2026-12-10T10:00:00');
  });

  it('a time that day added or cancelled is held already; restore by the time removes the date', () => {
    expect(updateFields(dated, { EXDATE: '2026-12-10T10:00:00' }, { lists: { EXDATE: 'add' } })).toBe(updateFields(dated, {}));
    expect(lines(cancelOccurrences(dated, ['2026-12-10T10:00:00']), 'EXDATE')).toEqual(['EXDATE;VALUE=DATE:20261210']);
    // a time that day that is no occurrence is still refused, not taken as held
    expect(isUpdateFieldsError(thrown(() => updateFields(dated, { EXDATE: '2026-12-10T11:00:00' }, { lists: { EXDATE: 'add' } })),
      'UNMATCHED_EXDATE')).toBe(true);
    const restored = restoreOccurrences(dated, ['2026-12-10T10:00:00']);
    expect(lines(restored, 'EXDATE')).toEqual([]);
    expect(starts(restored)).toContain('2026-12-10T10:00:00');
  });

  it('remove of a time matches only that time: the date stays, or the time is not in the list', () => {
    const error = thrown(() => updateFields(dated, { EXDATE: '2026-12-10T10:00:00' }, { lists: { EXDATE: 'remove' } }));
    expect(isUpdateFieldsError(error, 'NOT_IN_LIST')).toBe(true);
    expect(error.message).toMatch(/excludes the whole day\. Give the date \(e\.g\. "2026-12-10"\).*restoreOccurrences/);
    expect(lines(updateFields(berlin('EXDATE;VALUE=DATE:20261210', 'EXDATE:20261210T090000Z'), { EXDATE: '2026-12-10T10:00:00' },
      { lists: { EXDATE: 'remove' } }), 'EXDATE')).toEqual(['EXDATE;VALUE=DATE:20261210']);
  });

  it('restoring one occurrence of a day a date excludes keeps the others of that day excluded', () => {
    const twice = calendar(...event('DTSTART;TZID=Europe/Berlin:20261220T090000', 'RRULE:FREQ=DAILY;BYHOUR=9,17;COUNT=20',
      'EXDATE;VALUE=DATE:20261224'));
    const day = (ics: string) => starts(ics).filter((v) => v.startsWith('2026-12-24'));
    expect(day(twice)).toEqual([]);
    const one = restoreOccurrences(twice, ['2026-12-24T09:00:00']);
    expect(lines(one, 'EXDATE')).toEqual(['EXDATE;TZID=Europe/Berlin:20261224T170000']);
    expect(day(one)).toEqual(['2026-12-24T09:00:00']);
    const both = restoreOccurrences(twice, ['2026-12-24T09:00:00', '2026-12-24T16:00:00Z']);
    expect(lines(both, 'EXDATE')).toEqual([]);
    expect(day(both)).toEqual(['2026-12-24T09:00:00', '2026-12-24T17:00:00']);
    // an occurrence another EXDATE excludes already is left to it
    const also = restoreOccurrences(calendar(...event('DTSTART;TZID=Europe/Berlin:20261220T090000',
      'RRULE:FREQ=DAILY;BYHOUR=9,17;COUNT=20', 'EXDATE;VALUE=DATE:20261224', 'EXDATE:20261224T160000Z')), ['2026-12-24T09:00:00']);
    expect(lines(also, 'EXDATE')).toEqual(['EXDATE:20261224T160000Z']);
  });

  it('restore refuses a time that is no occurrence, though a date holds its day', () => {
    const thrice = calendar(...event('DTSTART;TZID=Europe/Berlin:20261205T090000', 'RRULE:FREQ=DAILY;BYHOUR=9,12,15;COUNT=30',
      'EXDATE;VALUE=DATE:20261209'));
    const error = thrown(() => restoreOccurrences(thrice, ['2026-12-09T13:00:00']));
    expect(isUpdateFieldsError(error, 'UNKNOWN_OCCURRENCE')).toBe(true);
    expect(error).toMatchObject({ remedy: 'fix-value' });
    expect(error.message).toMatch(/nothing to restore/);
  });

  it('remove takes values of mixed forms in one call, each matched on its own', () => {
    expect(lines(updateFields(floating('EXDATE:20261210T100000', 'EXDATE:20261217T090000Z'),
      { EXDATE: '2026-12-10T10:00:00,2026-12-17T09:00:00Z' }, { lists: { EXDATE: 'remove' } }), 'EXDATE')).toEqual([]);
    expect(lines(updateFields(berlin('EXDATE;VALUE=DATE:20261210', 'EXDATE:20261217T090000Z'),
      { EXDATE: '2026-12-10,2026-12-17T10:00:00' }, { lists: { EXDATE: 'remove' } }), 'EXDATE')).toEqual([]);
  });

  it('remove takes the date given as a date', () => {
    expect(lines(updateFields(berlin('EXDATE;VALUE=DATE:20261210,20261217'), { EXDATE: '2026-12-10' },
      { lists: { EXDATE: 'remove' } }), 'EXDATE')).toEqual(['EXDATE;VALUE=DATE:20261217']);
  });

  it('replace keeps the date while a time that day is in the new list, and drops it otherwise', () => {
    expect(lines(updateFields(dated, { EXDATE: '2026-12-10T10:00:00,2026-12-17T10:00:00' }), 'EXDATE'))
      .toEqual(['EXDATE;VALUE=DATE:20261210', 'EXDATE;TZID=Europe/Berlin:20261217T100000']);
    expect(lines(updateFields(dated, { EXDATE: '2026-12-17T10:00:00' }), 'EXDATE'))
      .toEqual(['EXDATE;TZID=Europe/Berlin:20261217T100000']);
  });

  it('an override on that day counts as excluded', () => {
    expect(isUpdateFieldsError(thrown(() => updateFields(overridden(), { EXDATE: '2026-12-17' }, { lists: { EXDATE: 'remove' } })),
      'NOT_IN_LIST')).toBe(true);
    const out = updateFields(overridden('EXDATE;VALUE=DATE:20261217'), { SUMMARY: 'y' });
    expect(lines(out, 'EXDATE')).toEqual(['EXDATE;VALUE=DATE:20261217']);
  });
});

describe('list mode "remove"', () => {
  it('takes values out by instant, whatever line and zone they are on; a line left empty goes', () => {
    const out = updateFields(berlin('EXDATE;TZID=America/New_York;X-FOO=bar:20261210T040000,20261217T040000',
      'EXDATE:20261224T090000Z'), { EXDATE: '2026-12-17T10:00:00,2026-12-24T10:00:00' }, { lists: { EXDATE: 'remove' } });
    expect(lines(out, 'EXDATE')).toEqual(['EXDATE;TZID=America/New_York;X-FOO=bar:20261210T040000']);
  });

  it('removes dates on an all-day series, and RDATE periods by their start', () => {
    expect(lines(updateFields(allDay('EXDATE;VALUE=DATE:20261210,20261217'), { EXDATE: '2026-12-10' },
      { lists: { EXDATE: 'remove' } }), 'EXDATE')).toEqual(['EXDATE;VALUE=DATE:20261217']);
    expect(lines(updateFields(weekly('RDATE;VALUE=PERIOD:20261206T090000Z/PT1H,20261207T090000Z/PT1H'),
      { RDATE: '2026-12-06T09:00:00Z' }, { lists: { RDATE: 'remove' } }), 'RDATE'))
      .toEqual(['RDATE;VALUE=PERIOD:20261207T090000Z/PT1H']);
  });

  it('refuses a value the list does not hold, typed, naming the list', () => {
    const error = thrown(() => updateFields(weekly('EXDATE:20261210T090000Z'), { EXDATE: '2026-12-24T09:00:00Z' },
      { lists: { EXDATE: 'remove' } }));
    expect(isUpdateFieldsError(error, 'NOT_IN_LIST')).toBe(true);
    expect(error).toMatchObject({ remedy: 'fix-value', property: 'EXDATE' });
    expect(error.message).toMatch(/^EXDATE 20261224T090000Z is not in the list \(EXDATE:20261210T090000Z\)/);
  });

  it('meets the moved series', () => {
    const out = updateFields(weekly('EXDATE:20261210T090000Z,20261217T090000Z'),
      { DTSTART: '2026-12-03T10:00:00Z', EXDATE: '2026-12-10T10:00:00Z' }, { lists: { EXDATE: 'remove' } });
    expect(lines(out, 'EXDATE')).toEqual(['EXDATE:20261217T100000Z']);
  });

  it('removing an RDATE an override names is an orphaned override', () => {
    const input = calendar(...event('DTSTART:20261203T090000Z', 'RRULE:FREQ=WEEKLY;COUNT=2', 'RDATE:20261205T090000Z'),
      ...event('RECURRENCE-ID:20261205T090000Z', 'DTSTART:20261205T150000Z'));
    expect(isUpdateFieldsError(thrown(() => updateFields(input, { RDATE: '2026-12-05T09:00:00Z' },
      { lists: { RDATE: 'remove' } })), 'ORPHANED_EXCEPTIONS')).toBe(true);
  });
});

describe('an EXDATE that excludes an overridden occurrence', () => {
  it('is refused in any mode: the override would apply to nothing', () => {
    for (const mode of ['replace', 'add'] as ListMode[]) {
      const error = thrown(() => updateFields(overridden(), { EXDATE: '2026-12-17T10:00:00' }, { lists: { EXDATE: mode } }));
      expect(isUpdateFieldsError(error, 'ORPHANED_EXCEPTIONS')).toBe(true);
      expect(error).toMatchObject({ remedy: 'fix-value', property: 'EXDATE' });
      expect(error.message).toMatch(/cancelOccurrences/);
    }
  });

  it('is left alone when it was excluded already', () => {
    const out = updateFields(overridden('EXDATE;TZID=Europe/Berlin:20261217T100000'), { SUMMARY: 'x', EXDATE: '2026-12-17T10:00:00' });
    expect(lines(out, 'EXDATE')).toEqual(['EXDATE;TZID=Europe/Berlin:20261217T100000']);
  });
});

describe('cancelOccurrences and restoreOccurrences', () => {
  it('cancel by the original start, as expandOccurrences gives it, in the series\' own form', () => {
    const [, second] = expandOccurrences(berlin(), { budget: createRecurrenceBudget(), until: '2027-01-01T00:00:00Z' }).occurrences;
    const out = cancelOccurrences(berlin('EXDATE:20261224T090000Z'), [second.recurrenceId.value]);
    expect(lines(out, 'EXDATE')).toEqual(['EXDATE:20261224T090000Z', 'EXDATE;TZID=Europe/Berlin:20261210T100000']);
  });

  it('accept an id with Z or an offset, matched by instant, and write it in the series\' zone', () => {
    const out = cancelOccurrences(berlin(), ['2026-12-10T09:00:00Z', '2026-12-17T04:00:00-05:00']);
    expect(lines(out, 'EXDATE')).toEqual(['EXDATE;TZID=Europe/Berlin:20261210T100000,20261217T100000']);
  });

  it('cancel an overridden occurrence together with its override', () => {
    const out = cancelOccurrences(overridden(), ['2026-12-17T10:00:00']);
    expect(lines(out, 'EXDATE')).toEqual(['EXDATE;TZID=Europe/Berlin:20261217T100000']);
    expect(out).not.toMatch(/RECURRENCE-ID/);
    expect(out).not.toMatch(/SUMMARY:moved/);
  });

  it('cancel on an all-day and a UTC series', () => {
    expect(lines(cancelOccurrences(allDay(), ['2026-12-10']), 'EXDATE')).toEqual(['EXDATE;VALUE=DATE:20261210']);
    expect(lines(cancelOccurrences(weekly(), ['2026-12-10T09:00:00Z']), 'EXDATE')).toEqual(['EXDATE:20261210T090000Z']);
  });

  it('cancelling twice changes nothing', () => {
    const once = cancelOccurrences(berlin(), ['2026-12-10T10:00:00']);
    expect(cancelOccurrences(once, ['2026-12-10T09:00:00Z'])).toBe(updateFields(once, {}));
  });

  it('refuse an id that is no occurrence, typed', () => {
    const error = thrown(() => cancelOccurrences(berlin(), ['2026-12-10T11:00:00']));
    expect(isUpdateFieldsError(error, 'UNKNOWN_OCCURRENCE')).toBe(true);
    expect(error).toMatchObject({ remedy: 'fix-value' });
    expect(error.message).toMatch(/^20261210T110000 names no occurrence of the series .*that day it has one at 20261210T100000.*nothing to cancel/);
  });

  it('restore removes the EXDATE wherever and however it is written', () => {
    const out = restoreOccurrences(berlin('EXDATE;TZID=America/New_York:20261210T040000', 'EXDATE:20261224T090000Z'),
      ['2026-12-10T10:00:00']);
    expect(lines(out, 'EXDATE')).toEqual(['EXDATE:20261224T090000Z']);
    expect(starts(out)).toContain('2026-12-10T10:00:00');
  });

  it('restore refuses an occurrence that is not cancelled, typed', () => {
    const error = thrown(() => restoreOccurrences(berlin(), ['2026-12-10T10:00:00']));
    expect(isUpdateFieldsError(error, 'NOT_IN_LIST')).toBe(true);
    expect(error.message).toMatch(/^20261210T100000 is not cancelled/);
  });

  it.each([
    ['no list', 'x'],
    ['an empty list', []],
    ['a non-string', [5]],
    ['two values in one id', ['2026-12-10T10:00:00,2026-12-17T10:00:00']],
  ])('refuse %s', (_, ids) => {
    expect(isUpdateFieldsError(thrown(() => cancelOccurrences(berlin(), ids as never)), 'INVALID_INPUT')).toBe(true);
    expect(isUpdateFieldsError(thrown(() => restoreOccurrences(berlin(), ids as never)), 'INVALID_INPUT')).toBe(true);
  });
});

describe('options.lists is checked', () => {
  it.each([
    ['an array', ['EXDATE']],
    ['a property that is no list of dates', { DTSTART: 'add' }],
    ['an unknown mode', { EXDATE: 'append' }],
  ])('refuses %s', (_, lists) => {
    const error = thrown(() => updateFields(weekly(), { EXDATE: '2026-12-24T09:00:00Z' }, { lists: lists as never }));
    expect(isUpdateFieldsError(error, 'INVALID_INPUT')).toBe(true);
    expect(error).toMatchObject({ remedy: 'fix-value' });
  });
});

/*
 * Property: whatever layout the list has (lines, comma lists, zones), each
 * operation leaves exactly the expected occurrences excluded, and an existing
 * value is never lost unless the operation removes it.
 */
describe('every operation on every layout leaves exactly the expected exclusions', () => {
  const OCCURRENCES = 10;
  type Frame = 'tzid' | 'utc' | 'date';
  /** Occurrence i as an object line value in a form, and as a value to give */
  const day = (i: number) => new Date(Date.UTC(2026, 11, 3 + 7 * i));
  const ymd = (i: number) => day(i).toISOString().slice(0, 10);
  const basic = (s: string) => s.replace(/[-:]/g, '');
  const objectValue = (frame: Frame, i: number, form: number): { params: string; value: string } => {
    if (frame === 'date') {
      return { params: ';VALUE=DATE', value: basic(ymd(i)) };
    }
    return [
      { params: '', value: `${basic(ymd(i))}T090000Z` },
      { params: ';TZID=Europe/Berlin', value: `${basic(ymd(i))}T100000` },
      { params: ';TZID=America/New_York', value: `${basic(ymd(i))}T040000` },
    ][form % 3];
  };
  const givenValue = (frame: Frame, i: number, form: number): string => {
    if (frame === 'date') {
      return ymd(i);
    }
    const forms = [`${ymd(i)}T09:00:00Z`, `${ymd(i)}T04:00:00-05:00`, `${ymd(i)}T10:00:00+01:00`];
    // a wall-clock value means the series' own zone
    if (frame === 'tzid') {
      forms.push(`${ymd(i)}T10:00:00`);
    }
    return forms[form % forms.length];
  };
  const DTSTART: Record<Frame, string> = {
    tzid: 'DTSTART;TZID=Europe/Berlin:20261203T100000', utc: 'DTSTART:20261203T090000Z', date: 'DTSTART;VALUE=DATE:20261203',
  };
  const idOf = (frame: Frame, i: number) =>
    frame === 'date' ? ymd(i) : frame === 'utc' ? `${ymd(i)}T09:00:00Z` : `${ymd(i)}T10:00:00`;

  // a small deterministic generator (mulberry32)
  const random = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  it('over 300 random cases', () => {
    const next = random(28);
    const pick = (n: number) => Math.floor(next() * n);
    const subset = () => [...Array(OCCURRENCES).keys()].filter(() => next() < 0.35);
    for (let run = 0; run < 300; run++) {
      const frame = (['tzid', 'utc', 'date'] as Frame[])[pick(3)];
      const held = subset();
      // spread the held values over lines, each line in one zone
      const groups = new Map<string, string[]>();
      const layout: string[] = [];
      for (const i of held) {
        const { params, value } = objectValue(frame, i, pick(3));
        const key = `${params}#${pick(2)}`;
        groups.set(key, [...(groups.get(key) ?? []), value]);
      }
      for (const [key, values] of groups) {
        layout.push(`EXDATE${key.split('#')[0]}:${values.join(',')}`);
      }
      const input = calendar(...event(DTSTART[frame], 'RRULE:FREQ=WEEKLY;COUNT=10', ...layout));
      const operation = (['replace', 'add', 'remove', 'cancel', 'restore'] as const)[pick(5)];
      let target = subset();
      if (operation === 'remove' || operation === 'restore') {
        target = held.filter(() => next() < 0.5);
      }
      if (!target.length && operation !== 'replace') {
        continue;
      }
      let expected: number[];
      let out: string;
      const given = target.map((i) => givenValue(frame, i, pick(4))).join(',');
      const context = `run ${run}: ${frame} ${operation} [${target}] on ${JSON.stringify(layout)}`;
      if (operation === 'replace' && !target.length) {
        continue;
      }
      if (operation === 'cancel') {
        out = cancelOccurrences(input, target.map((i) => idOf(frame, i)));
        expected = [...new Set([...held, ...target])];
      } else if (operation === 'restore') {
        out = restoreOccurrences(input, target.map((i) => idOf(frame, i)));
        expected = held.filter((i) => !target.includes(i));
      } else {
        out = updateFields(input, { EXDATE: given }, { lists: { EXDATE: operation as ListMode } });
        expected = operation === 'replace' ? target
          : operation === 'add' ? [...new Set([...held, ...target])]
          : held.filter((i) => !target.includes(i));
      }
      const left = starts(out);
      const excluded = [...Array(OCCURRENCES).keys()].filter((i) => !left.includes(idOf(frame, i)));
      expect(excluded, context).toEqual([...expected].sort((a, b) => a - b));
      // a line all of whose values stay is kept exactly as it was
      for (const line of layout) {
        const values = line.slice(line.indexOf(':') + 1).split(',');
        const indexes = values.map((v) => [...Array(OCCURRENCES).keys()].find((i) => v.startsWith(basic(ymd(i))))!);
        if (indexes.every((i) => expected.includes(i))) {
          expect(lines(out, 'EXDATE'), context).toContain(line);
        }
      }
    }
  });
});
