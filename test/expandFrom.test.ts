import ICAL from 'ical.js';
import { describe, expect, it } from 'vitest';
import { createRecurrenceBudget, expandOccurrences } from '../src/index';
import { recurIterator } from '../src/recur';
import { expansionWork } from '../src/series';

// expandOccurrences with `from` walks a rule without COUNT from near `from`
// rather than from DTSTART (issue #37). That must change no result: the list
// is the full expansion filtered to original starts at or after `from`.

const calendar = (...lines: string[]) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...lines, 'END:VCALENDAR', ''].join('\r\n');
const component = (uid: string, ...lines: string[]) =>
  ['BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20260101T000000Z', ...lines, 'END:VEVENT'];

/** Units a call spends */
const spent = (ics: string, from: string | Date | undefined, until: string | Date) => {
  const budget = createRecurrenceBudget(1e9);
  const steps = expansionWork.steps;
  const result = expandOccurrences(ics, { budget, until, ...(from === undefined ? {} : { from }), limit: 100000 });
  return { units: 1e9 - budget.remaining, steps: expansionWork.steps - steps, result };
};

describe('an open-ended series costs the same whatever its age', () => {
  const week = { from: '2026-06-01T00:00:00Z', until: '2026-06-08T00:00:00Z' };

  it('a yearly birthday from 1900 and one from 2025, one week of 2026', () => {
    for (const start of [['DTSTART;VALUE=DATE:19000603', 'DTSTART;VALUE=DATE:20250603'],
      ['DTSTART;TZID=Europe/Berlin:19000603T090000', 'DTSTART;TZID=Europe/Berlin:20250603T090000'],
      ['DTSTART:19000603T090000Z', 'DTSTART:20250603T090000Z']]) {
      const [old, young] = start.map((dtstart) => spent(calendar(...component('b', dtstart, 'RRULE:FREQ=YEARLY')),
        week.from, week.until));
      expect(old.result.occurrences.map((o) => o.recurrenceId.value)).toEqual(
        young.result.occurrences.map((o) => o.recurrenceId.value));
      expect(old.result.occurrences).toHaveLength(1);
      expect(old.result.complete).toBe(true);
      // the same walk: a few candidates of 45 units each, 126 years or one
      expect(old.units, start[0]).toBeLessThanOrEqual(young.units + 2 * 45);
      expect(old.units, start[0]).toBeLessThan(10 * 45);
    }
  });

  it('a daily series from 2010, one week of 2026, costs what one from last month does', () => {
    const [old, young] = ['DTSTART:20100101T080000Z', 'DTSTART:20260501T080000Z']
      .map((dtstart) => spent(calendar(...component('d', dtstart, 'RRULE:FREQ=DAILY;BYDAY=MO,WE')), week.from, week.until));
    expect(old.result.occurrences.map((o) => o.recurrenceId.value)).toEqual(
      ['2026-06-01T08:00:00Z', '2026-06-03T08:00:00Z']);
    expect(young.result.occurrences.map((o) => o.recurrenceId.value)).toEqual(
      ['2026-06-01T08:00:00Z', '2026-06-03T08:00:00Z']);
    expect(Math.abs(old.units - young.units)).toBeLessThanOrEqual(5 * 6);
  });

  it('1,600 yearly series from 1960 fit in one default budget', () => {
    const budget = createRecurrenceBudget(300000);
    const ics = calendar(...component('b', 'DTSTART;VALUE=DATE:19600603', 'RRULE:FREQ=YEARLY'));
    for (let i = 0; i < 1600; i++) {
      expect(expandOccurrences(ics, { budget, ...week }).complete).toBe(true);
    }
    expect(budget.remaining).toBeGreaterThan(0);
  });

  it('with COUNT the walk still starts at DTSTART, and without `from` too', () => {
    const counted = spent(calendar(...component('c', 'DTSTART;VALUE=DATE:19000603', 'RRULE:FREQ=YEARLY;COUNT=500')),
      week.from, week.until);
    const plain = spent(calendar(...component('c', 'DTSTART;VALUE=DATE:19000603', 'RRULE:FREQ=YEARLY')),
      undefined, week.until);
    expect(counted.result.occurrences.map((o) => o.recurrenceId.value)).toEqual(['2026-06-03']);
    expect(counted.steps).toBeGreaterThan(120);
    expect(plain.steps).toBeGreaterThan(120);
  });

  it('a rule whose UNTIL lies before `from` is not walked at all', () => {
    const ended = spent(calendar(...component('u', 'DTSTART:19000603T090000Z',
      'RRULE:FREQ=DAILY;UNTIL=20200101T000000Z', 'RDATE:20260602T090000Z')), week.from, week.until);
    expect(ended.steps).toBe(0);
    expect(ended.result.occurrences.map((o) => o.recurrenceId.value)).toEqual(['2026-06-02T09:00:00Z']);
  });
});

describe('the shapes a moved start must not get wrong', () => {
  const values = (ics: string, from: string, until: string) =>
    expandOccurrences(ics, { budget: createRecurrenceBudget(1e8), from, until, limit: 100000 })
      .occurrences.map((o) => o.recurrenceId.value);
  const full = (ics: string, from: string, until: string) =>
    expandOccurrences(ics, { budget: createRecurrenceBudget(1e8), until, limit: 100000 })
      .occurrences.map((o) => o.recurrenceId.value).filter((v) => v >= from);

  it.each([
    ['31st of the month', 'DTSTART:20200131T090000Z', 'RRULE:FREQ=MONTHLY'],
    ['29 February', 'DTSTART;VALUE=DATE:19040229', 'RRULE:FREQ=YEARLY'],
    ['29 February every 4 years', 'DTSTART;VALUE=DATE:18960229', 'RRULE:FREQ=YEARLY;INTERVAL=4'],
    ['BYMONTHDAY=31 every 2 months', 'DTSTART:20200131T090000Z', 'RRULE:FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=31'],
    ['last weekday of the month', 'DTSTART:20200131T090000Z', 'RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1'],
    ['every 3 weeks from Sunday, WKST=SU', 'DTSTART:20200105T090000Z', 'RRULE:FREQ=WEEKLY;INTERVAL=3;WKST=SU;BYDAY=SU,TU'],
    ['every 2 weeks, WKST=MO, start on a Sunday', 'DTSTART:20200105T090000Z', 'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,SU'],
    ['week 1 and 53 of the year', 'DTSTART;VALUE=DATE:20151228', 'RRULE:FREQ=YEARLY;BYWEEKNO=1,53;BYDAY=MO'],
    ['day 366 and -1 of the year', 'DTSTART;VALUE=DATE:20151231', 'RRULE:FREQ=YEARLY;BYYEARDAY=366,-1'],
    ['every 7 hours across DST', 'DTSTART;TZID=Europe/Berlin:20260301T010000', 'RRULE:FREQ=HOURLY;INTERVAL=7'],
    ['02:30 Berlin daily, in the skipped hour', 'DTSTART;TZID=Europe/Berlin:20250101T023000', 'RRULE:FREQ=DAILY'],
    ['off-rule DTSTART', 'DTSTART:20200102T090000Z', 'RRULE:FREQ=MONTHLY;BYMONTHDAY=15;BYMONTH=3,9'],
  ])('%s', (_name, dtstart, rule) => {
    const ics = calendar(...component('s', dtstart, rule));
    const date = dtstart.includes('VALUE=DATE');
    for (const [from, until] of [['2026-03-29T00:30:00', '2026-04-05T00:00:00'], ['2026-10-25T01:00:00', '2026-11-30T00:00:00'],
      ['2028-02-28T00:00:00', '2028-03-02T00:00:00'], ['2100-02-01T00:00:00', '2100-03-02T00:00:00'],
      ['2027-12-27T00:00:00', '2028-01-08T00:00:00']]) {
      const f = date ? from.slice(0, 10) : from;
      const u = date ? until.slice(0, 10) : until;
      if (rule.includes('HOURLY') && from.startsWith('2100')) continue;
      expect(values(ics, f, u), `${rule} from ${f}`).toEqual(full(ics, f, u));
    }
  });

  // ical.js' MONTHLY;BYDAY setup searches forward, month by month, for a
  // fifth weekday the start's month lacks; the search steps BYMONTH's shared
  // position and yields what it finds untested (no BYSETPOS). From a moved
  // start that happens next to the window: such rules are walked from DTSTART
  it.each([
    ['DTSTART;VALUE=DATE:20080405', 'FREQ=MONTHLY;BYMONTH=11;BYDAY=5SU,5TH', '2015-05-09', '2017-05-09', '2015-11-29'],
    ['DTSTART;VALUE=DATE:20001228', 'FREQ=MONTHLY;BYMONTH=2,6;BYDAY=WE,5SU,MO;BYSETPOS=-2,1', '2010-05-21', '2011-10-06',
      '2010-06-02'],
    ['DTSTART;TZID=America/New_York:20221229T140000', 'FREQ=MONTHLY;BYDAY=5SU;BYSETPOS=3,-2', '2043-11-17T00:00:00',
      '2045-07-28T00:00:00', null],
  ])('a fifth weekday, %s %s', (dtstart, rule, from, until, holds) => {
    const ics = calendar(...component('f', dtstart, `RRULE:${rule}`));
    const got = values(ics, from, until);
    expect(got).toEqual(full(ics, from, until));
    if (holds) expect(got).toContain(holds);
  });

  it('an override, RDATE and EXDATE in the window are applied as without the moved start', () => {
    const ics = calendar(
      ...component('o', 'DTSTART;TZID=Europe/Berlin:20100104T090000', 'DTEND;TZID=Europe/Berlin:20100104T100000',
        'RRULE:FREQ=WEEKLY;BYDAY=MO,TH', 'EXDATE;TZID=Europe/Berlin:20260608T090000',
        'RDATE;TZID=Europe/Berlin:20260606T120000,20100105T120000'),
      ...component('o', 'RECURRENCE-ID;TZID=Europe/Berlin:20260604T090000', 'DTSTART;TZID=Europe/Berlin:20260530T150000',
        'DTEND;TZID=Europe/Berlin:20260530T160000'));
    const opts = { until: '2026-06-12T00:00:00', limit: 1e6 };
    const moved = expandOccurrences(ics, { budget: createRecurrenceBudget(1e8), from: '2026-06-01T00:00:00', ...opts });
    const whole = expandOccurrences(ics, { budget: createRecurrenceBudget(1e8), ...opts });
    expect(moved.occurrences).toEqual(whole.occurrences.filter((o) => o.recurrenceId.value >= '2026-06-01T00:00:00'));
    expect(moved.occurrences.map((o) => [o.recurrenceId.value, o.start.value, o.overridden])).toEqual([
      ['2026-06-01T09:00:00', '2026-06-01T09:00:00', false],
      // moved out of the window to before `from`, still found by its id
      ['2026-06-04T09:00:00', '2026-05-30T15:00:00', true],
      ['2026-06-06T12:00:00', '2026-06-06T12:00:00', false],
      ['2026-06-11T09:00:00', '2026-06-11T09:00:00', false],
    ]);
  });
});

describe('with `from` or without, the same verdict', () => {
  const call = (ics: string, from?: string) => () => expandOccurrences(ics,
    { budget: createRecurrenceBudget(1e8), until: '2050-01-01T00:00:00Z', ...(from ? { from } : {}), limit: 1e6 });

  const refusal = (run: () => unknown) => { try { run(); return null; } catch (error) { return (error as Error).message; } };

  it.each([
    // ical.js' MONTHLY BYDAY+BYMONTHDAY setup checks the day it finds against DTSTART's month
    ['MONTHLY;BYDAY;BYMONTHDAY', 'DTSTART:20210318T020900Z',
      'FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=-2,5;BYDAY=WE,-1FR;BYHOUR=9,0;BYSETPOS=-2;WKST=WE', '2045-01-01T00:00:00Z'],
    // its UNTIL lies long before `from`, but the walk to it is refused: no skip
    ['MONTHLY;BYDAY;BYMONTHDAY ended before `from`', 'DTSTART:20190417T224600Z',
      'FREQ=MONTHLY;INTERVAL=4;BYMONTHDAY=-2,31;BYDAY=1SA,1TU;BYSETPOS=2;WKST=WE;UNTIL=20190707T172407Z', '2028-12-20T00:29:46Z'],
    ['YEARLY;BYDAY;BYYEARDAY ended before `from`', 'DTSTART;TZID=Europe/Berlin:20130615T110500',
      'FREQ=YEARLY;INTERVAL=2;BYMONTH=9;BYYEARDAY=-1;BYDAY=TH;BYHOUR=2;BYMINUTE=30;BYSETPOS=2;UNTIL=20190130T121437Z',
      '2028-08-16T19:26:20'],
    // a date series with BYHOUR: one date twice, refused; its UNTIL before `from` does not skip that
    ['a date series with BYHOUR', 'DTSTART;VALUE=DATE:20250602', 'FREQ=DAILY;BYHOUR=23,13,0;UNTIL=20251002', '2026-05-23'],
    // ical.js' MONTHLY BYDAY setup refuses this DTSTART (a fifth Sunday found in May, checked against April's
    // length); a moved start in another month would be accepted, so the setup is read at DTSTART first
    ['MONTHLY;BYDAY=5SU,5FR from an April', 'DTSTART:19910401T090000', 'FREQ=MONTHLY;BYDAY=5SU,5FR', '2026-06-01T00:00:00'],
  ])('%s: refused with `from` as without it', (_name, dtstart, rule, from) => {
    const ics = calendar(...component('r', dtstart, `RRULE:${rule}`));
    const message = refusal(call(ics));
    expect(message).not.toBeNull();
    expect(refusal(call(ics, from))).toBe(message);
  });

  /** As call, with a window to 2110 */
  const late = (ics: string, from?: string) => expandOccurrences(ics,
    { budget: createRecurrenceBudget(1e8), until: '2110-01-01T00:00:00Z', ...(from ? { from } : {}), limit: 1e6 });

  it('a moved start whose setup ends the rule is walked from DTSTART instead', () => {
    // from 2100 the start moves to 31 December 2097; ical.js' setup looks for
    // day 366 there and in the three years after, all without a 29 February
    // (2100 is none), ends the rule, and would lose 2104 — DTSTART's walk has it
    const rule = 'FREQ=YEARLY;BYYEARDAY=366';
    const ics = calendar(...component('r', 'DTSTART;VALUE=DATE:20001231', `RRULE:${rule}`));
    const at2097 = recurIterator(ICAL.Recur.fromString(rule), ICAL.Time.fromDateString('2097-12-31'));
    expect(at2097.next()).toBeNull();
    const restarts = expansionWork.restarts;
    const all = late(ics).occurrences.map((o) => o.recurrenceId.value);
    const moved = late(ics, '2100-06-01').occurrences.map((o) => o.recurrenceId.value);
    expect(expansionWork.restarts).toBe(restarts + 1);
    expect(moved).toEqual(['2104-12-31', '2108-12-31']);
    expect(moved).toEqual(all.filter((v) => v >= '2100-06-01'));
  });

  it('restarts from DTSTART give the full result filtered, for random day-366 rules around 2100', () => {
    let seed = seedFor(366) * 1000003;
    const rnd = () => mulberry(seed++);
    const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
    const restarts = expansionWork.restarts;
    for (let i = 0; i < Math.max(40, RUNS / 5); i++) {
      const date = rnd() < 0.5;
      const leap = [1996, 2000, 2004, 2008, 2012, 2016, 2020, 2024, 2028, 2032, 2036, 2040, 2044][int(0, 12)];
      const v = date ? `VALUE=DATE:${leap}1231` : `TZID=Europe/Berlin:${leap}1231T${String(int(0, 23)).padStart(2, '0')}3000`;
      let rule = `FREQ=YEARLY;BYYEARDAY=${['366', '-366', '366,1', '-366,200'][int(0, 3)]}`;
      if (rnd() < 0.3) rule += ';INTERVAL=2';
      if (!date && rnd() < 0.3) rule += `;BYHOUR=${int(0, 11)},${int(12, 23)}`;
      const ics = calendar(...component('r', `DTSTART;${v}`, `RRULE:${rule}`));
      const fromDay = `${int(2096, 2104)}-${String(int(1, 12)).padStart(2, '0')}-${String(int(1, 28)).padStart(2, '0')}`;
      const from = date ? fromDay : `${fromDay}T00:00:00`;
      const full = late(ics);
      const got = late(ics, from);
      expect(got.occurrences, `${rule} ${v} from ${from}`)
        .toEqual(full.occurrences.filter((o) => o.recurrenceId.value >= from));
    }
    // the restart path is taken, not only the moved walk
    expect(expansionWork.restarts - restarts).toBeGreaterThan(3);
  });

  it('a rule ical.js gives up inside the range is not complete, with `from` or without', () => {
    // fifth Sundays of February lie up to 40 years apart: a walk from 2058
    // finds 2060 and 2088 (a cut of 28 empty years ends it before 2128),
    // a setup from a moved start would search on and find 2128-02-29
    const ics = calendar(...component('c', 'DTSTART:20580120T130000', 'RRULE:FREQ=YEARLY;BYMONTH=2;BYDAY=5SU'));
    const window = { until: '2133-08-01T00:00:00' };
    const whole = expandOccurrences(ics, { budget: createRecurrenceBudget(1e8), ...window });
    const moved = expandOccurrences(ics, { budget: createRecurrenceBudget(1e8), from: '2117-09-19T00:00:00', ...window });
    expect(whole).toMatchObject({ complete: false, stoppedBy: 'library' });
    expect(moved).toMatchObject({ complete: false, stoppedBy: 'library' });
    expect(moved.occurrences).toEqual(whole.occurrences.filter((o) => o.recurrenceId.value >= '2117-09-19T00:00:00'));
    // a range that ends before ical.js gives up is complete
    const early = expandOccurrences(ics, { budget: createRecurrenceBudget(1e8), until: '2100-01-01T00:00:00' });
    expect(early).toMatchObject({ complete: true, stoppedBy: null });
  });

  it('a rule whose setup month holds none of its days yields from the first that does, with `from` or without', () => {
    // 31 in a November: ical.js' own setup searched three months on through
    // BYMONTH (February, April, June), found none and never yielded; the
    // iteration is set up in October instead (#42)
    const ics = calendar(...component('r', 'DTSTART;TZID=Europe/Berlin:20181107T231400',
      'RRULE:FREQ=MONTHLY;BYMONTH=6,10,4,2;BYMONTHDAY=31;BYMINUTE=30;BYSETPOS=-1,2;WKST=SA'));
    const all = call(ics)().occurrences.map((o) => o.recurrenceId.value);
    expect(all.slice(0, 3)).toEqual(['2018-11-07T23:14:00', '2019-10-31T23:30:00', '2020-10-31T23:30:00']);
    expect(all).toHaveLength(1 + 2050 - 2019);
    expect(call(ics, '2027-03-28T00:05:16.000Z')().occurrences.map((o) => o.recurrenceId.value))
      .toEqual(all.filter((v) => v >= '2027-03-28T01:05:16'));
  });

  it('a YEARLY weekday pinned to day 366 is walked from DTSTART, so it ends where the walk from DTSTART ends', () => {
    const ics = calendar(...component('r', 'DTSTART;VALUE=DATE:19921231', 'RRULE:FREQ=YEARLY;BYYEARDAY=366;BYDAY=TH'));
    const all = call(ics)().occurrences.map((o) => o.recurrenceId.value);
    expect(call(ics, '2030-01-01')().occurrences.map((o) => o.recurrenceId.value)).toEqual(all.filter((v) => v >= '2030-01-01'));
  });
});

describe('a yearly rule of fixed days is worked out without walking', () => {
  let seed = seedFor(3737) * 1000003;
  const rnd = () => mulberry(seed++);
  const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19);
  const distinct = (n: number, a: number, b: number) => [...new Set(Array.from({ length: n }, () => int(a, b)))];
  const pick = <T,>(list: T[]): T => list[Math.floor(rnd() * list.length)];
  const some = (list: number[], n: number) => [...new Set(Array.from({ length: int(1, n) }, () => pick(list)))];

  it('equals the walk from DTSTART, for any shape, interval, UNTIL, zone and window', () => {
    let worked = 0;
    let nonEmpty = 0;
    for (let i = 0; i < RUNS; i++) {
      const form = ['utc', 'floating', 'berlin', 'date'][int(0, 3)];
      const startMs = Date.UTC(int(1900, 2026), int(0, 11), [1, 15, 28, 29, 30, 31][int(0, 5)], int(0, 23), 15 * int(0, 3));
      const start = iso(startMs);
      const v = form === 'date' ? start.slice(0, 10).replace(/-/g, '') : start.replace(/[-:]/g, '');
      const dtstart = { utc: `DTSTART:${v}Z`, floating: `DTSTART:${v}`, berlin: `DTSTART;TZID=Europe/Berlin:${v}`,
        date: `DTSTART;VALUE=DATE:${v}` }[form]!;
      // plain, BYMONTH, BYMONTHDAY or both; a day from 29 to 31 now and then
      // (fixed only where every month taken has it), or -1 (never fixed)
      const shape = int(0, 3);
      const months = shape & 1 ? (rnd() < 0.3 ? some([1, 3, 5, 7, 8, 10, 12, 4, 6, 9, 11], 2) : distinct(int(1, 3), 1, 12)) : [];
      const monthDays = shape & 2 ? (rnd() < 0.3 ? [pick([29, 30, 31, -1]), ...distinct(int(0, 2), 1, 28)]
        : distinct(int(1, 3), 1, 28)) : [];
      let rule = `FREQ=YEARLY${rnd() < 0.4 ? `;INTERVAL=${int(2, 5)}` : ''}`;
      if (months.length) rule += `;BYMONTH=${months}`;
      if (monthDays.length) rule += `;BYMONTHDAY=${monthDays}`;
      if (rnd() < 0.3) {
        const u = iso(startMs + rnd() * 140 * 366 * 864e5).replace(/[-:]/g, '');
        rule += `;UNTIL=${form === 'date' ? u.slice(0, 8) : u}${form === 'utc' || form === 'berlin' ? 'Z' : ''}`;
      }
      const ics = calendar(...component('y', dtstart, `RRULE:${rule}`));
      const fromMs = Date.UTC(int(2024, 2030), int(0, 11), int(1, 28), int(0, 23));
      const toMs = fromMs + int(1, 400) * 864e5;
      const text = (ms: number) => form === 'date' ? iso(ms).slice(0, 10) : iso(ms) + (form === 'utc' ? 'Z' : '');
      const all = expandOccurrences(ics, { budget: createRecurrenceBudget(1e8), until: text(toMs), limit: 1e6 });
      const budget = createRecurrenceBudget(1e8);
      const got = expandOccurrences(ics, { budget, from: text(fromMs), until: text(toMs), limit: 1e6 });
      const f = text(fromMs).replace(/Z$/, '');
      expect(got.occurrences, `${rule} ${dtstart} [${text(fromMs)}, ${text(toMs)})`)
        .toEqual(all.occurrences.filter((o) => o.recurrenceId.value.replace(/Z$/, '') >= f));
      // worked out where every day is fixed (fixedYearlyWalls): the instances
      // found, at 45 units each, and nothing else
      const taken = months.length ? months : [Number(start.slice(5, 7))];
      const fewest = Math.min(...taken.map((m) => [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]));
      const fits = (d: number) => d >= 1 && d <= fewest;
      const fixed = shape === 0 ? start.slice(5, 10) !== '02-29'
        : (monthDays.length ? monthDays.every(fits) : fits(Number(start.slice(8, 10)))) &&
          Number(f.slice(0, 4)) > Number(start.slice(0, 4));
      if (fixed) {
        expect(1e8 - budget.remaining, `${rule} ${dtstart} from ${f}`).toBe(45 * got.occurrences.length);
        worked++;
      }
      if (got.occurrences.length) nonEmpty++;
    }
    expect(worked).toBeGreaterThan(RUNS * 0.6);
    expect(nonEmpty).toBeGreaterThan(RUNS * 0.2);
  });

  it.each([
    ['plain', 'RRULE:FREQ=YEARLY'],
    ['BYMONTH and BYMONTHDAY', 'RRULE:FREQ=YEARLY;BYMONTH=9;BYMONTHDAY=3'],
  ])('a birthday (%s) with no day in the window costs nothing', (_name, rule) => {
    const r = spent(calendar(...component('b', 'DTSTART;VALUE=DATE:19600903', rule)),
      '2026-06-01T00:00:00Z', '2026-06-08T00:00:00Z');
    expect(r.result).toMatchObject({ occurrences: [], complete: true });
    expect(r.units).toBe(0);
  });

  it('a window of any length is charged as it is worked out, and stops at the budget', () => {
    // 336 days a year, to the year 200000: worked out in full first, that is
    // 60 million values; taken one by one, the budget ends it after 6,666
    const days = Array.from({ length: 28 }, (_, i) => i + 1).join(',');
    const ics = calendar(...component('w', 'DTSTART:20000101T000000Z',
      `RRULE:FREQ=YEARLY;BYMONTH=1,2,3,4,5,6,7,8,9,10,11,12;BYMONTHDAY=${days}`));
    const until = new Date(Date.UTC(2000, 0, 1));
    until.setUTCFullYear(200000);
    const budget = createRecurrenceBudget(300000);
    const heap = process.memoryUsage().heapUsed;
    const r = expandOccurrences(ics, { budget, from: '2001-01-01T00:00:00Z', until, limit: 1e6 });
    expect(process.memoryUsage().heapUsed - heap).toBeLessThan(64 * 1024 * 1024);
    expect(r).toMatchObject({ complete: false, stoppedBy: 'budget' });
    expect(300000 - budget.remaining).toBeLessThanOrEqual(300000 + 45);
    expect(r.occurrences.length).toBe(Math.floor(300000 / 45));
  });

  it('before the year 100, with `from` as without it', () => {
    // ical.js reads the years 0 to 99 as 1900 to 1999 when it compares times
    // (Time.toUnixTime goes through Date.UTC): a series from then is walked
    // from DTSTART, as without `from`
    for (const rule of ['RRULE:FREQ=YEARLY', 'RRULE:FREQ=YEARLY;BYMONTH=6,7;BYMONTHDAY=3', 'RRULE:FREQ=MONTHLY']) {
      const ics = calendar(...component('a', 'DTSTART;VALUE=DATE:00500603', rule));
      const all = expandOccurrences(ics, { budget: createRecurrenceBudget(1e8), until: '0060-01-01', limit: 1e6 });
      const got = expandOccurrences(ics, { budget: createRecurrenceBudget(1e8), from: '0055-01-01', until: '0060-01-01', limit: 1e6 });
      expect(got.complete, rule).toBe(all.complete);
      expect(got.occurrences, rule).toEqual(all.occurrences.filter((o) => o.recurrenceId.value >= '0055-01-01'));
    }
  });

  it('5,000 birthdays from 1960 fit well inside one budget of 300,000 units', () => {
    const week = { from: '2026-06-01', until: '2026-06-08' };
    const budget = createRecurrenceBudget(300000);
    let found = 0;
    for (let i = 0; i < 5000; i++) {
      // a day of the year for each, as a contact list has them (of 1961: no 29 February)
      const d = new Date(Date.UTC(1961, 0, 1 + (i * 7919) % 365));
      const v = `1960${d.toISOString().slice(5, 10).replace(/-/g, '')}`;
      const rule = i % 2 ? 'RRULE:FREQ=YEARLY' : `RRULE:FREQ=YEARLY;BYMONTH=${d.getUTCMonth() + 1};BYMONTHDAY=${d.getUTCDate()}`;
      const r = expandOccurrences(calendar(...component(`b${i}`, `DTSTART;VALUE=DATE:${v}`, rule)), { budget, ...week });
      expect(r.complete).toBe(true);
      found += r.occurrences.length;
    }
    expect(found).toBeGreaterThan(50);
    // 45 units for each birthday in the week, nothing for the others
    expect(300000 - budget.remaining).toBe(45 * found);
  });
});

// Size and seed as in seriesMoveProperty.test.ts.
const RUNS = Math.max(20, Number(process.env.SERIES_PROPERTY_RUNS ?? 300));
const SEED = process.env.SERIES_PROPERTY_SEED === undefined ? null : Number(process.env.SERIES_PROPERTY_SEED);
const seedFor = (fixed: number) => SEED === null ? fixed : SEED * 7919 + fixed;
/**
 * A draw in [0, 1) from a counter, exact in 32-bit integer arithmetic
 * (mulberry32). The usual LCG in doubles loses bits in its product and falls
 * into short cycles (seed 37: after 852 draws, every 220), which repeats the
 * sample instead of widening it.
 */
const mulberry = (n: number) => {
  let t = (n * 0x6d2b79f5 + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

describe('expansion with `from` equals the full expansion filtered to `from`', () => {
  let seed = seedFor(37) * 1000003;
  const rnd = () => mulberry(seed++);
  const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
  const pick = <T,>(list: T[]): T => list[Math.floor(rnd() * list.length)];
  const some = (list: (number | string)[], n: number) => {
    const out = [...new Set(Array.from({ length: int(1, n) }, () => pick(list)))];
    for (let k = out.length - 1; k > 0; k--) {
      const j = int(0, k);
      [out[k], out[j]] = [out[j], out[k]];
    }
    return out;
  };
  const D = 86400;
  type Freq = 'YEARLY' | 'MONTHLY' | 'WEEKLY' | 'DAILY' | 'HOURLY' | 'MINUTELY' | 'SECONDLY';
  const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  /** How far before the window DTSTART may lie, and how long the window is: the full walk must stay affordable */
  const AGE: Record<Freq, number> = { YEARLY: 40 * 366 * D, MONTHLY: 12 * 366 * D, WEEKLY: 4 * 366 * D, DAILY: 2 * 366 * D,
    HOURLY: 40 * D, MINUTELY: 3 * D, SECONDLY: 6 * 3600 };
  const WINDOW: Record<Freq, number> = { YEARLY: 3 * 366 * D, MONTHLY: 120 * D, WEEKLY: 60 * D, DAILY: 20 * D,
    HOURLY: 3 * D, MINUTELY: 6 * 3600, SECONDLY: 1200 };
  const p2 = (n: number) => String(n).padStart(2, '0');
  const wallText = (wall: number) => new Date(wall * 1000).toISOString().slice(0, 19);
  const basic = (wall: number) => wallText(wall).replace(/[-:]/g, '');
  const berlinWall = (instant: number) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(instant * 1000)).map((p) => [p.type, p.value]));
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
  };
  /** The last Sunday of a month at 01:00 UTC: when Berlin's clock changes (March, October) */
  const dstChange = (year: number, month: number) => {
    const last = new Date(Date.UTC(year, month, 0));
    return Date.UTC(year, month - 1, last.getUTCDate() - last.getUTCDay(), 1) / 1000;
  };

  const randomRule = (freq: Freq): string => {
    const sub = ['HOURLY', 'MINUTELY', 'SECONDLY'].includes(freq);
    const parts = [`FREQ=${freq}`];
    if (rnd() < 0.5) parts.push(`INTERVAL=${int(2, sub ? 7 : 4)}`);
    if (rnd() < (freq === 'YEARLY' ? 0.6 : sub ? 0.15 : 0.3)) parts.push(`BYMONTH=${some([1, 2, 3, 4, 6, 9, 10, 12], 4)}`);
    const monthly = freq === 'MONTHLY' || freq === 'YEARLY';
    if (monthly && rnd() < 0.35) parts.push(`BYMONTHDAY=${some([1, 5, 13, 28, 29, 30, 31, -1, -2, -29, -30, -31], 3)}`);
    else if (freq === 'YEARLY' && rnd() < 0.15) parts.push(`BYWEEKNO=${some([1, 2, 10, 52, 53, -1], 2)}`);
    else if (freq === 'YEARLY' && rnd() < 0.15) parts.push(`BYYEARDAY=${some([1, 59, 60, 200, 365, 366, -1], 3)}`);
    let byday = false;
    if (rnd() < (freq === 'WEEKLY' ? 0.7 : 0.4)) {
      byday = true;
      const ordinal = monthly && !parts.some((p) => p.startsWith('BYWEEKNO')) && rnd() < 0.3;
      parts.push(`BYDAY=${some(DAYS, 3).map((d) => (ordinal ? pick(['1', '2', '-1', '5', '-5', '']) : '') + d)}`);
    }
    if (rnd() < (sub ? 0.3 : 0.4)) parts.push(`BYHOUR=${some([0, 2, 3, 9, 13, 23], 3)}`);
    if (rnd() < 0.3) parts.push(`BYMINUTE=${some([0, 15, 30, 45], 2)}`);
    if (freq !== 'SECONDLY' && rnd() < 0.15) parts.push(`BYSECOND=${some([0, 30], 2)}`);
    if ((monthly || freq === 'WEEKLY') && (byday || parts.some((p) => p.startsWith('BYMONTHDAY'))) && rnd() < 0.4) {
      parts.push(`BYSETPOS=${some([1, 2, -1, -2], 2)}`);
    }
    if (rnd() < 0.4) parts.push(`WKST=${pick(['MO', 'SU', 'WE', 'SA'])}`);
    return parts.join(';');
  };

  it('for random rules without COUNT, zones and DTSTART on or off the rule, at many `from`', () => {
    let compared = 0;
    let nonEmpty = 0;
    let moved = 0;
    let refused = 0;
    const forms = new Set<string>();
    for (let i = 0; i < RUNS; i++) {
      const form = pick(['utc', 'floating', 'berlin', 'berlin', 'date']);
      const freq = pick<Freq>(form === 'date' ? ['YEARLY', 'MONTHLY', 'WEEKLY', 'DAILY']
        : ['YEARLY', 'MONTHLY', 'MONTHLY', 'WEEKLY', 'DAILY', 'DAILY', 'HOURLY', 'MINUTELY', 'SECONDLY']);
      let rule = randomRule(freq);
      const windowStart = Date.UTC(pick([2026, 2027, 2028]), int(0, 11), int(1, 28), int(0, 23), pick([0, 15, 30, 45])) / 1000;
      let start = windowStart - Math.floor(rnd() * AGE[freq]);
      start = form === 'date' ? Math.floor(start / D) * D : Math.floor(start / 60) * 60 + pick([0, 0, 30]);
      if (rnd() < 0.3) rule += `;UNTIL=${basic(start + Math.floor(rnd() * (windowStart + WINDOW[freq] - start)))
        .slice(0, form === 'date' ? 8 : 15)}${form === 'utc' || form === 'berlin' ? (form === 'date' ? '' : 'Z') : ''}`;
      const value = form === 'date' ? basic(start).slice(0, 8) : basic(start);
      const dtstart = { utc: `DTSTART:${value}Z`, floating: `DTSTART:${value}`, berlin: `DTSTART;TZID=Europe/Berlin:${value}`,
        date: `DTSTART;VALUE=DATE:${value}` }[form];
      const extra: string[] = [];
      if (rnd() < 0.3) extra.push(`DTEND${dtstart.slice(7, dtstart.indexOf(':'))}:${form === 'date'
        ? basic(start + D).slice(0, 8) : basic(start + 3600)}${form === 'utc' ? 'Z' : ''}`);
      const ics = calendar(...component('p', dtstart, `RRULE:${rule}`, ...extra));
      const end = windowStart + WINDOW[freq];
      const untilText = form === 'date' ? wallText(end).slice(0, 10) : wallText(end) + (form === 'utc' ? 'Z' : '');

      // `from` values: around the window start, at Berlin's DST changes of
      // its year (as instants), and one before DTSTART
      const year = new Date(windowStart * 1000).getUTCFullYear();
      const froms: (string | Date)[] = [];
      for (let k = 0; k < 4; k++) {
        const at = windowStart + Math.floor(rnd() * WINDOW[freq] / 2);
        froms.push(form === 'date' ? wallText(at).slice(0, 10) : wallText(at) + (form === 'utc' ? 'Z' : ''));
      }
      if (form === 'berlin') {
        for (const change of [dstChange(year, 3), dstChange(year, 10)]) {
          if (change < end) froms.push(new Date((change + int(-3600, 3600)) * 1000));
        }
      }
      froms.push(form === 'date' ? wallText(start - D).slice(0, 10) : wallText(start - 60) + (form === 'utc' ? 'Z' : ''));
      let whole;
      const wholeBudget = createRecurrenceBudget(5e7);
      try {
        whole = expandOccurrences(ics, { budget: wholeBudget, until: untilText, limit: 1e6 });
      } catch (error) {
        // ical.js refuses some rules (a BYDAY/BYMONTHDAY search it gives up
        // on, one candidate twice): with `from` the call refuses as well —
        // fail closed, the same verdict either way
        if (!/Malformed|Invalid|Same occurrence found twice/i.test((error as Error).message)) throw error;
        refused++;
        for (const from of froms) {
          expect(() => expandOccurrences(ics, { budget: createRecurrenceBudget(5e7), from, until: untilText, limit: 1e6 }),
            `${rule} ${dtstart} from ${String(from)} refuses as without it`).toThrow((error as Error).message);
        }
        continue;
      }
      if (!whole.complete) continue;
      forms.add(form);
      for (const from of froms) {
        const fromWall = from instanceof Date ? berlinWall(from.getTime() / 1000) : from.replace(/Z$/, '');
        const want = whole.occurrences.filter((o) => o.recurrenceId.value.replace(/Z$/, '') >= fromWall.slice(0,
          form === 'date' ? 10 : 19));
        const budget = createRecurrenceBudget(5e7);
        const got = expandOccurrences(ics, { budget, from, until: untilText, limit: 1e6 });
        expect(got.complete, `${rule} ${dtstart} from ${String(from)}`).toBe(true);
        expect(got.occurrences, `${rule} ${dtstart} from ${from instanceof Date ? from.toISOString() : from}`)
          .toEqual(want);
        compared++;
        if (want.length > 0) nonEmpty++;
        // the walk started near `from`: it spent less than the whole one
        if (budget.remaining > wholeBudget.remaining) moved++;
      }
    }
    expect(forms.size).toBe(4);
    expect(compared).toBeGreaterThan(RUNS * 3);
    expect(nonEmpty).toBeGreaterThan(compared * 0.4);
    expect(moved).toBeGreaterThan(compared * 0.2);
    expect(refused).toBeLessThan(RUNS * 0.1);
  });
});
