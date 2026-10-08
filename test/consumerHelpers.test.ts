import { describe, expect, it } from 'vitest';
import ICAL from 'ical.js';
import {
  createRecurrenceBudget, expandOccurrences, generateVtimezone, isUpdateFieldsError, resolvePropertyZone, resolveZone,
  updateFields,
} from '../src/index';

const calendar = (...lines: string[]) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...lines, 'END:VCALENDAR', ''].join('\r\n');
const event = (...lines: string[]) => ['BEGIN:VEVENT', 'UID:e', 'DTSTAMP:20260101T000000Z', ...lines, 'END:VEVENT'];

const refusal = (call: () => unknown) => {
  try {
    call();
  } catch (error) {
    return error;
  }
  throw new Error('not refused');
};

describe('generateVtimezone', () => {
  it('returns the VTIMEZONE updateFields adds, as text', () => {
    const text = generateVtimezone('Europe/Berlin', { from: 2026 });
    expect(text.startsWith('BEGIN:VTIMEZONE\r\nTZID:Europe/Berlin\r\n')).toBe(true);
    expect(text.endsWith('END:VTIMEZONE')).toBe(true);
    const added = updateFields(calendar(...event()), { DTSTART: '2026-10-05T09:00:00' }, { zone: 'Europe/Berlin' });
    expect(added).toContain(text);
    expect(generateVtimezone('Europe/Berlin', { from: 2026, to: 2030 })).toBe(text);
  });

  it('spells the zone as updateFields does', () => {
    expect(generateVtimezone('europe/berlin', { from: 2026 })).toContain('TZID:Europe/Berlin\r\n');
    expect(resolveZone('europe/berlin')!.tzid).toBe('Europe/Berlin');
    expect(resolveZone('US/Eastern')!.tzid).toBe('US/Eastern');
  });

  it('refuses an unknown zone and a range that is no pair of years', () => {
    expect(refusal(() => generateVtimezone('Mars/Olympus', { from: 2026 }))).toMatchObject({ code: 'UNKNOWN_TZID' });
    for (const range of [{ from: 2026.5 }, { from: 2027, to: 2026 }, null]) {
      expect(refusal(() => generateVtimezone('Europe/Berlin', range as never))).toMatchObject({ code: 'INVALID_INPUT' });
    }
  });
});

describe('resolveZone', () => {
  // 25 October 2026, Berlin: 03:00 CEST becomes 02:00 CET at 01:00Z
  it('converts both ways with the IANA data, with RFC 5545 3.3.5 at the DST changes', () => {
    const berlin = resolveZone('Europe/Berlin')!;
    expect(berlin.source).toBe('iana');
    expect(berlin.toWallTime('2026-10-25T00:30:00Z')).toBe('2026-10-25T02:30:00');
    expect(berlin.toWallTime(new Date('2026-10-25T01:30:00Z'))).toBe('2026-10-25T02:30:00');
    // a time shown twice is its first occurrence
    expect(berlin.toInstant('2026-10-25T02:30:00').toISOString()).toBe('2026-10-25T00:30:00.000Z');
    expect(berlin.ambiguity('2026-10-25T02:30:00')).toBe('overlap');
    // a skipped time is read with the offset before the gap: 02:30 is 03:30 CEST
    expect(berlin.toInstant('2026-03-29T02:30:00').toISOString()).toBe('2026-03-29T01:30:00.000Z');
    expect(berlin.ambiguity('2026-03-29T02:30:00')).toBe('gap');
    expect(berlin.offsetAt('2026-07-01T00:00:00Z')).toBe(7200);
  });

  it('reads the object\'s VTIMEZONE, from its text or any of its components, also from another ical.js', () => {
    const office = ['BEGIN:VTIMEZONE', 'TZID:Office', 'BEGIN:STANDARD', 'TZOFFSETFROM:+0300', 'TZOFFSETTO:+0300',
      'DTSTART:19700101T000000', 'END:STANDARD', 'END:VTIMEZONE'];
    const text = calendar(...office, ...event('DTSTART;TZID=Office:20261005T090000'));
    const fromText = resolveZone('Office', text)!;
    expect(fromText.source).toBe('vtimezone');
    expect(fromText.toInstant('2026-10-05T09:00:00').toISOString()).toBe('2026-10-05T06:00:00.000Z');
    const vevent = new ICAL.Component(ICAL.parse(text)).getFirstSubcomponent('vevent')!;
    expect(resolveZone('Office', vevent)!.toWallTime('2026-10-05T06:00:00Z')).toBe('2026-10-05T09:00:00');
    expect(resolvePropertyZone(vevent.getFirstProperty('dtstart')!)!.toWallTime('2026-10-05T06:00:00Z'))
      .toBe('2026-10-05T09:00:00');
    // a component read through its jCal: another copy of ical.js gives the same
    const foreign = { ...vevent, parent: null, toJSON: () => vevent.parent!.toJSON() } as unknown as ICAL.Component;
    expect(resolveZone('Office', foreign)!.source).toBe('vtimezone');
  });

  it('is wrong nowhere ical.js 2.2 is wrong: UTC to local right after a DST change', () => {
    // ical.js#847 converts 01:30Z on 25 October 2026 to 03:30 Berlin
    const vtimezone = generateVtimezone('Europe/Berlin', { from: 2026 });
    const zone = resolveZone('Europe/Berlin', calendar(vtimezone))!;
    expect(zone.source).toBe('vtimezone');
    expect(zone.toWallTime('2026-10-25T01:30:00Z')).toBe('2026-10-25T02:30:00');
  });

  it('is null for an unknown zone or a property without TZID; refuses values that are no instant or wall time', () => {
    expect(resolveZone('Mars/Olympus')).toBeNull();
    expect(resolveZone('+01:00')).toBeNull();
    const vevent = new ICAL.Component(ICAL.parse(calendar(...event('DTSTART:20261005T090000Z')))).getFirstSubcomponent('vevent')!;
    expect(resolvePropertyZone(vevent.getFirstProperty('dtstart')!)).toBeNull();
    const berlin = resolveZone('Europe/Berlin')!;
    expect(isUpdateFieldsError(refusal(() => berlin.toWallTime('2026-10-05T09:00:00')), 'INVALID_VALUE')).toBe(true);
    expect(isUpdateFieldsError(refusal(() => berlin.toInstant('2026-10-05T09:00:00Z')), 'INVALID_VALUE')).toBe(true);
  });
});

describe('expandOccurrences', () => {
  const series = calendar(
    ...event('DTSTART;TZID=Europe/Berlin:20261005T090000', 'DTEND;TZID=Europe/Berlin:20261005T100000',
      'RRULE:FREQ=WEEKLY', 'EXDATE;TZID=Europe/Berlin:20261019T090000'),
    ...event('RECURRENCE-ID;TZID=Europe/Berlin:20261026T090000', 'DTSTART;TZID=Europe/Berlin:20261026T140000',
      'DTEND;TZID=Europe/Berlin:20261026T150000', 'SUMMARY:moved'));

  it('lists the occurrences in a range on the series\' wall clock, without EXDATEs, with overrides', () => {
    const result = expandOccurrences(series, { budget: createRecurrenceBudget(), from: '2026-10-01T00:00:00Z',
      until: '2026-11-03T00:00:00Z' });
    expect(result).toMatchObject({ complete: true, stoppedBy: null });
    expect(result.occurrences.map((o) => [o.start.value, o.start.instant, o.end?.instant, o.overridden])).toEqual([
      ['2026-10-05T09:00:00', '2026-10-05T07:00:00.000Z', '2026-10-05T08:00:00.000Z', false],
      ['2026-10-12T09:00:00', '2026-10-12T07:00:00.000Z', '2026-10-12T08:00:00.000Z', false],
      ['2026-10-26T14:00:00', '2026-10-26T13:00:00.000Z', '2026-10-26T14:00:00.000Z', true],
      ['2026-11-02T09:00:00', '2026-11-02T08:00:00.000Z', '2026-11-02T09:00:00.000Z', false],
    ]);
    expect(result.occurrences[2].recurrenceId).toEqual({ value: '2026-10-26T09:00:00', tzid: 'Europe/Berlin',
      instant: '2026-10-26T08:00:00.000Z' });
  });

  it('ends an override by its own DTEND, else its own DURATION, else the master\'s length from its own start', () => {
    const ends = (masterEnd: string, ...override: string[]) => expandOccurrences(calendar(
      ...event('DTSTART;TZID=Europe/Berlin:20260921T090000', masterEnd, 'RRULE:FREQ=WEEKLY;COUNT=2'),
      ...event('RECURRENCE-ID;TZID=Europe/Berlin:20260928T090000', 'DTSTART;TZID=Europe/Berlin:20260928T120000', ...override)),
    { budget: createRecurrenceBudget(), until: '2027-01-01T00:00:00Z' }).occurrences[1].end?.value;
    expect(ends('DTEND;TZID=Europe/Berlin:20260921T100000')).toBe('2026-09-28T13:00:00');
    expect(ends('DTEND;TZID=Europe/Berlin:20260921T100000', 'DURATION:PT3H')).toBe('2026-09-28T15:00:00');
    expect(ends('DTEND;TZID=Europe/Berlin:20260921T100000', 'DTEND;TZID=Europe/Berlin:20260928T123000')).toBe('2026-09-28T12:30:00');
    expect(ends('DURATION:PT2H')).toBe('2026-09-28T14:00:00');
    // an override written in UTC keeps its own form
    expect(expandOccurrences(calendar(
      ...event('DTSTART;TZID=Europe/Berlin:20260921T090000', 'DURATION:PT1H', 'RRULE:FREQ=WEEKLY;COUNT=2'),
      ...event('RECURRENCE-ID;TZID=Europe/Berlin:20260928T090000', 'DTSTART:20260928T100000Z')),
    { budget: createRecurrenceBudget(), until: '2027-01-01T00:00:00Z' }).occurrences[1].end)
      .toEqual({ value: '2026-09-28T11:00:00Z', tzid: null, instant: '2026-09-28T11:00:00.000Z' });
  });

  it('stops at the limit and says so', () => {
    const result = expandOccurrences(series, { budget: createRecurrenceBudget(), until: '2030-01-01T00:00:00Z', limit: 3 });
    expect(result).toMatchObject({ complete: false, stoppedBy: 'limit' });
    expect(result.occurrences).toHaveLength(3);
  });

  it('handles all-day and floating series, and an event that does not recur', () => {
    const allDay = calendar(...event('DTSTART;VALUE=DATE:20261005', 'DTEND;VALUE=DATE:20261006', 'RRULE:FREQ=DAILY;COUNT=3'));
    expect(expandOccurrences(allDay, { budget: createRecurrenceBudget(), until: '2027-01-01' }).occurrences
      .map((o) => [o.start.value, o.end?.value, o.start.instant])).toEqual([
      ['2026-10-05', '2026-10-06', null], ['2026-10-06', '2026-10-07', null], ['2026-10-07', '2026-10-08', null]]);
    const floating = calendar(...event('DTSTART:20261005T090000', 'DURATION:PT30M', 'RRULE:FREQ=DAILY;COUNT=2'));
    expect(expandOccurrences(floating, { budget: createRecurrenceBudget(), until: '2027-01-01T00:00:00' }).occurrences
      .map((o) => [o.start.value, o.end?.value])).toEqual([
      ['2026-10-05T09:00:00', '2026-10-05T09:30:00'], ['2026-10-06T09:00:00', '2026-10-06T09:30:00']]);
    const single = calendar(...event('DTSTART:20261005T090000Z'));
    expect(expandOccurrences(single, { budget: createRecurrenceBudget(0), until: '2027-01-01T00:00:00Z' }))
      .toMatchObject({ complete: true, occurrences: [{ start: { value: '2026-10-05T09:00:00Z' } }] });
  });

  it('a rule that never matches ends at the range: only DTSTART, which always counts, in bounded time', () => {
    for (const until of ['2027-01-01T00:00:00Z', '2400-01-01T00:00:00Z']) {
      const t0 = Date.now();
      const result = expandOccurrences(calendar(...event('DTSTART:20260101T000000Z', 'RRULE:FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30')),
        { budget: createRecurrenceBudget(), until });
      expect(Date.now() - t0).toBeLessThan(5000);
      expect(result.occurrences.map((o) => o.start.value)).toEqual(['2026-01-01T00:00:00Z']);
      // over 374 years the budget runs out before the range does
      expect(result.complete).toBe(until.startsWith('2027'));
    }
  });

  it.each([
    ['once a day by the second, since 1950', '19500101T000000Z', 'FREQ=SECONDLY;BYHOUR=9;BYMINUTE=0;BYSECOND=0'],
    ['once a day by the minute, since 1960', '19600101T000000Z', 'FREQ=MINUTELY;BYHOUR=10;BYMINUTE=0'],
  ])('%s fails closed within the budget, in bounded time', (_, start, rule) => {
    const ics = calendar(...event(`DTSTART:${start}`, `RRULE:${rule}`));
    const t0 = Date.now();
    const result = expandOccurrences(ics, { budget: createRecurrenceBudget(), until: '2027-01-01T00:00:00Z' });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(result).toMatchObject({ complete: false, stoppedBy: 'budget' });
  });

  it('spends one shared budget across calls', () => {
    const budget = createRecurrenceBudget(2000);
    const daily = calendar(...event('DTSTART:20260101T090000Z', 'RRULE:FREQ=DAILY'));
    const first = expandOccurrences(daily, { budget, until: '2026-02-01T00:00:00Z' });
    expect(first.complete).toBe(true);
    expect(budget.remaining).toBeLessThan(2000);
    let calls = 0;
    while (expandOccurrences(daily, { budget, until: '2026-02-01T00:00:00Z' }).complete) {
      calls++;
    }
    expect(budget.remaining).toBeLessThan(0);
    expect(calls).toBeLessThan(20);
  });

  it('refuses a call without a budget', () => {
    expect(isUpdateFieldsError(refusal(() => expandOccurrences(series, { until: '2027-01-01T00:00:00Z' } as never)),
      'INVALID_INPUT')).toBe(true);
  });
});
