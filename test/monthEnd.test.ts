import ICAL from 'ical.js';
import { describe, expect, it } from 'vitest';
import { createRecurrenceBudget, expandOccurrences } from '../src/index';
import { holdsInstance, recurIterator } from '../src/recur';
import { rfcDates } from './rfcOracle';

// Rules whose period may hold none of its days (#42), and rules ical.js gives
// up on although nothing is left to give. Results are checked against
// RFC 5545 by brute force (rfcOracle), and with `from` against the full
// expansion filtered to `from`.
//
// For a deep run set SERIES_PROPERTY_RUNS (e.g. 20000) and SERIES_PROPERTY_SEED.

const calendar = (...lines: string[]) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...lines, 'END:VCALENDAR', ''].join('\r\n');
const series = (dtstart: string, rule: string) => calendar('BEGIN:VEVENT', 'UID:m', 'DTSTAMP:20260101T000000Z',
  dtstart, `RRULE:${rule}`, 'END:VEVENT');
const expand = (ics: string, until: string, from?: string) => expandOccurrences(ics,
  { budget: createRecurrenceBudget(1e8), until, limit: 1e6, ...(from === undefined ? {} : { from }) });
const values = (result: ReturnType<typeof expandOccurrences>) => result.occurrences.map((o) => o.recurrenceId.value);

const RUNS = Math.max(20, Number(process.env.SERIES_PROPERTY_RUNS ?? 300));
const SEED = process.env.SERIES_PROPERTY_SEED === undefined ? null : Number(process.env.SERIES_PROPERTY_SEED);
const seedFor = (fixed: number) => SEED === null ? fixed : SEED * 7919 + fixed;
/** mulberry32, as in expandFrom.test.ts */
const mulberry = (n: number) => {
  let t = (n * 0x6d2b79f5 + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const random = (fixed: number) => {
  let seed = seedFor(fixed) * 1000003;
  const rnd = () => mulberry(seed++);
  const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
  const pick = <T,>(list: T[]): T => list[Math.floor(rnd() * list.length)];
  /** 1 to n distinct values of `list`, in random order */
  const some = <T,>(list: T[], n: number): T[] => {
    const out = [...new Set(Array.from({ length: int(1, n) }, () => pick(list)))];
    for (let k = out.length - 1; k > 0; k--) {
      const j = int(0, k);
      [out[k], out[j]] = [out[j], out[k]];
    }
    return out;
  };
  return { rnd, int, pick, some };
};
const p2 = (n: number) => String(n).padStart(2, '0');

describe('a MONTHLY;BYMONTHDAY rule whose start month holds none of its days (#42)', () => {
  it('the 31st and day -31 every fifth month from 30 June 1992 keep June\'s grid, with `from` or without', () => {
    // June + 5k months: of those in 2026 only March and August have 31 days.
    // ical.js' own setup read -31 in June as day 0, so May 31, and stepped
    // from May: July and December
    const ics = series('DTSTART;VALUE=DATE:19920630', 'FREQ=MONTHLY;INTERVAL=5;BYMONTHDAY=31,-31');
    const rule = 'FREQ=MONTHLY;INTERVAL=5;BYMONTHDAY=31,-31';
    const all = values(expand(ics, '2027-01-01'));
    expect(all).toEqual(['1992-06-30', ...rfcDates(rule, '1992-06-30', '2027-01-01').filter((v) => v < '2027-01-01')]);
    expect(all.filter((v) => v >= '2026-01-01')).toEqual(['2026-03-01', '2026-03-31', '2026-08-01', '2026-08-31']);
    for (const from of ['2026-01-01', '2025-11-15', '2026-03-31', '2026-04-01']) {
      expect(values(expand(ics, '2027-01-01', from)), from).toEqual(all.filter((v) => v >= from));
    }
  });

  it('the 31st every fifth month from a June is found past the five short months before it', () => {
    // June, November, April, September, February: ical.js' setup searched
    // three months on and left the rule without any instance
    const ics = series('DTSTART;VALUE=DATE:19920630', 'FREQ=MONTHLY;INTERVAL=5;BYMONTHDAY=31');
    const result = expand(ics, '1995-01-01');
    expect(result).toMatchObject({ complete: true, stoppedBy: null });
    expect(values(result)).toEqual(['1992-06-30', '1994-07-31', '1994-12-31']);
    // the same with BYMONTH: from November, the 31st of June or April never comes, October's does
    const listed = series('DTSTART:20181107T231400', 'FREQ=MONTHLY;BYMONTH=6,10,4,2;BYMONTHDAY=31;BYMINUTE=30');
    expect(values(expand(listed, '2020-12-31T00:00:00'))).toEqual(
      ['2018-11-07T23:14:00', '2019-10-31T23:30:00', '2020-10-31T23:30:00']);
    expect(values(expand(listed, '2020-12-31T00:00:00', '2020-01-01T00:00:00'))).toEqual(['2020-10-31T23:30:00']);
  });

  it('the month it is set up in keeps an instance at an hour before DTSTART\'s time of day', () => {
    // from 2028-08-23 the start moves to June, which BYMONTH leaves out; the
    // setup goes to 1 September at 02:57, the earliest listed hour, not at
    // DTSTART's 13:57, which would drop the 02:57 of the 1st
    const ics = series('DTSTART:20231204T135700', 'FREQ=MONTHLY;BYMONTH=9,12,10;BYMONTHDAY=-1,-30,31;BYHOUR=2,23');
    const all = values(expand(ics, '2029-01-01T00:00:00'));
    const from = '2028-08-23T11:45:38';
    expect(all.filter((v) => v >= from).slice(0, 2)).toEqual(['2028-09-01T02:57:00', '2028-09-01T23:57:00']);
    expect(values(expand(ics, '2029-01-01T00:00:00', from))).toEqual(all.filter((v) => v >= from));
  });

  it('a month without the day yields no time of day on its 1st', () => {
    // ical.js stepped BYHOUR on into day 1 of February and April: 23:30 there
    const ics = series('DTSTART:19820101T003000', 'FREQ=MONTHLY;BYMONTHDAY=31;BYHOUR=0,23');
    expect(values(expand(ics, '1982-06-01T00:00:00'))).toEqual(['1982-01-01T00:30:00', '1982-01-31T00:30:00',
      '1982-01-31T23:30:00', '1982-03-31T00:30:00', '1982-03-31T23:30:00', '1982-05-31T00:30:00', '1982-05-31T23:30:00']);
    // COUNT counts instances only
    const counted = series('DTSTART:19820131T003000', 'FREQ=MONTHLY;BYMONTHDAY=31;BYHOUR=0,23;BYMINUTE=30,45;COUNT=6');
    expect(values(expand(counted, '1990-01-01T00:00:00')).slice(-3)).toEqual(['1982-01-31T23:45:00', '1982-03-31T00:30:00', '1982-03-31T00:45:00']);
  });

  it('a rule no month of which ever holds a listed day has no instance, and its iteration says so', () => {
    for (const [dtstart, rule] of [['20181207', 'FREQ=MONTHLY;BYMONTH=6;BYMONTHDAY=31'],
      ['20200215', 'FREQ=MONTHLY;INTERVAL=12;BYMONTHDAY=30,-30'], ['20200415', 'FREQ=MONTHLY;BYMONTH=2;BYMONTHDAY=30']]) {
      const ics = series(`DTSTART;VALUE=DATE:${dtstart}`, rule);
      expect(expand(ics, '2400-01-01'), rule).toMatchObject({ complete: true, stoppedBy: null });
      expect(values(expand(ics, '2400-01-01')), rule).toHaveLength(1);
      const start = ICAL.Time.fromDateString(`${dtstart.slice(0, 4)}-${dtstart.slice(4, 6)}-${dtstart.slice(6)}`);
      expect(recurIterator(ICAL.Recur.fromString(rule), start).next(), rule).toBeNull();
    }
  });

  it('for random month-end lists, INTERVAL and BYMONTH: RFC 5545 without `from`, the filtered result with it', () => {
    const { rnd, int, pick, some } = random(42);
    const DAYS = [29, 30, 31, -29, -30, -31, 1, 15, 28, -1, -28];
    let compared = 0;
    let rfcCompared = 0;
    let nonEmpty = 0;
    for (let i = 0; i < RUNS; i++) {
      const freq = rnd() < 0.7 ? 'MONTHLY' : 'YEARLY';
      const interval = freq === 'MONTHLY' ? pick([1, 2, 3, 4, 5, 6, 7, 11, 12, 13, 24]) : pick([1, 2, 3, 4]);
      const days = rnd() < 0.7 ? some(DAYS.slice(0, 6), 3) : some(DAYS, 4);
      const byMonth = rnd() < (freq === 'YEARLY' ? 0.8 : 0.35) ? some([1, 2, 3, 4, 6, 9, 10, 11, 12], 3) : [];
      let rule = `FREQ=${freq};INTERVAL=${interval};BYMONTHDAY=${days.join(',')}`;
      if (byMonth.length) rule += `;BYMONTH=${byMonth.join(',')}`;
      // DTSTART mostly late in a short month: the case whose month may hold none of the days
      const year = int(1960, 2024);
      const month = rnd() < 0.7 ? pick([2, 4, 6, 9, 11]) : int(1, 12);
      const day = rnd() < 0.7 ? int(26, month === 2 ? 28 : 30) : int(1, 28);
      const start = `${year}-${p2(month)}-${p2(day)}`;
      const zoned = rnd() < 0.3;
      const dtstart = zoned ? `DTSTART;TZID=Europe/Berlin:${start.replace(/-/g, '')}T${p2(int(0, 23))}3000`
        : `DTSTART;VALUE=DATE:${start.replace(/-/g, '')}`;
      // times of day before and after DTSTART's: a setup moved to day 1 must keep the earlier ones
      if (zoned && rnd() < 0.5) rule += `;BYHOUR=${some([0, 2, 9, 13, 23], 2).join(',')}`;
      if (zoned && rnd() < 0.3) rule += `;BYMINUTE=${some([0, 15, 45], 2).join(',')}`;
      if (rnd() < 0.2) rule += `;UNTIL=${int(year + 1, 2030)}${p2(int(1, 12))}${p2(int(1, 28))}${zoned ? 'T000000Z' : ''}`;
      const last = `${int(2026, 2030)}-${p2(int(1, 12))}-${p2(int(1, 28))}`;
      const until = zoned ? `${last}T00:00:00` : last;
      const ics = series(dtstart, rule);
      const whole = expand(ics, until);
      if (!whole.complete) {
        // ical.js reads a YEARLY BYMONTHDAY without BYMONTH in DTSTART's month
        // only and gives up where that month lacks the day (-31 from a
        // November); RFC 5545 takes every month, so instances follow: a
        // library stop, with `from` as without it
        expect(freq, `${rule} ${dtstart}`).toBe('YEARLY');
        expect(whole.stoppedBy, `${rule} ${dtstart}`).toBe('library');
        expect(expand(ics, until, `${int(2026, 2030)}-01-01${zoned ? 'T00:00:00' : ''}`).stoppedBy).toBe('library');
        continue;
      }
      const all = values(whole);
      // ical.js reads a YEARLY BYMONTHDAY in ways of its own (#36): RFC 5545
      // is checked for MONTHLY
      if (freq === 'MONTHLY' && !zoned) {
        // `until` is exclusive
        expect(all, `${rule} ${dtstart}`).toEqual([start, ...rfcDates(rule, start, last).filter((v) => v !== start && v < last)]);
        rfcCompared++;
      }
      const froms = [`${year}-${p2(month)}-${p2(day)}`];
      for (let k = 0; k < 8; k++) {
        // the first, a middle, the last and the day before the last of a month
        const [y, m] = [int(Math.min(year + 1, 2026), 2030), int(1, 12)];
        const length = new Date(Date.UTC(y, m, 0)).getUTCDate();
        froms.push(`${y}-${p2(m)}-${p2(pick([1, int(2, 27), length, length - 1]))}`);
      }
      for (const fromDay of froms) {
        const from = zoned ? `${fromDay}T00:00:00` : fromDay;
        const got = expand(ics, until, from);
        expect(got.complete, `${rule} ${dtstart} from ${from}`).toBe(true);
        const want = all.filter((v) => v >= from);
        expect(values(got), `${rule} ${dtstart} from ${from}`).toEqual(want);
        compared++;
        if (want.length > 0) nonEmpty++;
      }
    }
    expect(compared).toBeGreaterThan(RUNS * 8);
    expect(rfcCompared).toBeGreaterThan(RUNS * 0.4);
    expect(nonEmpty).toBeGreaterThan(compared * 0.3);
  });
});

describe('a MONTHLY rule yields RFC 5545\'s instances where ical.js yields more', () => {
  it('a setup day BYSETPOS rules out is dropped', () => {
    // ical.js' setup yields the fifth Monday it finds, BYSETPOS unread
    for (const [start, rule] of [['1993-05-08', 'FREQ=MONTHLY;INTERVAL=7;BYDAY=5MO;BYSETPOS=2'],
      ['2001-01-01', 'FREQ=MONTHLY;BYDAY=5MO;BYSETPOS=5']]) {
      const ics = series(`DTSTART;VALUE=DATE:${start.replace(/-/g, '')}`, rule);
      const result = expand(ics, '2040-01-01');
      expect(values(result), rule).toEqual([start]);
      expect(rfcDates(rule, start, '2040-01-01')).toEqual([]);
      expect(result, rule).toMatchObject({ complete: true, stoppedBy: null });
    }
  });

  it('BYMONTH with INTERVAL keeps the grid, and COUNT counts instances only', () => {
    // May + 24k months is never a November; ical.js stepped every November
    const none = series('DTSTART:20070528T015900', 'FREQ=MONTHLY;INTERVAL=24;BYMONTHDAY=-2,28;BYMONTH=11;COUNT=1');
    expect(values(expand(none, '2100-01-01T00:00:00'))).toEqual(['2007-05-28T01:59:00']);
    const rule = 'FREQ=MONTHLY;INTERVAL=2;BYMONTH=1,2,3,4;BYMONTHDAY=1;COUNT=4';
    expect(values(expand(series('DTSTART;VALUE=DATE:20260101', rule), '2030-01-01')))
      .toEqual(['2026-01-01', '2026-03-01', '2027-01-01', '2027-03-01']);
  });

  it('BYSETPOS over BYMONTHDAY picks a position, not every listed day', () => {
    // a set of at most two days has no third: ical.js gave every 30th and 31st
    const rule = 'FREQ=MONTHLY;BYMONTHDAY=31,30;BYMONTH=7,4,10,1;BYSETPOS=3';
    expect(values(expand(series('DTSTART;VALUE=DATE:20100105', rule), '2026-01-01'))).toEqual(['2010-01-05']);
    const second = 'FREQ=MONTHLY;BYMONTHDAY=31,30,1;BYSETPOS=-2';
    expect(values(expand(series('DTSTART;VALUE=DATE:20100105', second), '2010-06-01')))
      .toEqual(['2010-01-05', ...rfcDates(second, '2010-01-05', '2010-06-01').filter((v) => v < '2010-06-01')]);
  });

  it('for random MONTHLY rules with BYDAY or BYMONTHDAY, BYSETPOS, BYMONTH and INTERVAL, all-day: RFC 5545', () => {
    const { rnd, int, pick, some } = random(4343);
    const WD = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
    let compared = 0;
    let nonEmpty = 0;
    for (let i = 0; i < RUNS; i++) {
      const parts = ['FREQ=MONTHLY', `INTERVAL=${pick([1, 1, 2, 3, 5, 7, 12, 24])}`];
      if (rnd() < 0.5) parts.push(`BYMONTH=${some([1, 2, 3, 4, 6, 9, 11, 12], 3).join(',')}`);
      const monthDays = rnd() < 0.4;
      if (monthDays) parts.push(`BYMONTHDAY=${some([1, 13, 28, 29, 30, 31, -1, -29, -30, -31], 3).join(',')}`);
      // BYDAY with BYMONTHDAY is left as ical.js gives it (#36)
      if (!monthDays) {
        const ordinal = rnd() < 0.6;
        parts.push(`BYDAY=${some(WD, 3).map((d) => (ordinal ? pick(['1', '2', '4', '5', '-1', '-2', '-5']) : '') + d).join(',')}`);
      }
      if (rnd() < 0.5) parts.push(`BYSETPOS=${some([1, 2, 3, 5, -1, -2, -5], 2).join(',')}`);
      if (rnd() < 0.2) parts.push(`COUNT=${int(1, 12)}`);
      const rule = parts.join(';');
      // with BYMONTH, a fifth weekday's setup search moves BYMONTH's position
      // and loses the first year (#36): left as ical.js gives it
      if (/BYMONTH=/.test(rule) && /[=,]-?5[A-Z]{2}/.test(rule)) continue;
      const start = `${int(1990, 2024)}-${p2(int(1, 12))}-${p2(int(1, 28))}`;
      const last = `${int(2026, 2030)}-${p2(int(1, 12))}-01`;
      let result;
      try {
        result = expand(series(`DTSTART;VALUE=DATE:${start.replace(/-/g, '')}`, rule), last);
      } catch (error) {
        // ical.js refuses some BYDAY setups (a fifth weekday in a month without one)
        expect((error as Error).message, rule).toMatch(/Malformed|Invalid/i);
        continue;
      }
      if (!result.complete) {
        expect(result.stoppedBy, `${rule} from ${start}`).toBe('library');
        continue;
      }
      const count = /COUNT=(\d+)/.exec(rule);
      let want = rfcDates(rule.replace(/;COUNT=\d+/, ''), start, last).filter((v) => v !== start && v < last);
      if (count) {
        // COUNT as ical.js counts it: the instances, DTSTART aside (#36)
        want = rfcDates(rule.replace(/;COUNT=\d+/, ''), start, '2400-01-01').slice(0, Number(count[1]))
          .filter((v) => v !== start && v < last);
      }
      expect(values(result), `${rule} from ${start}`).toEqual([start, ...want]);
      compared++;
      if (want.length > 0) nonEmpty++;
    }
    expect(compared).toBeGreaterThan(RUNS * 0.6);
    expect(nonEmpty).toBeGreaterThan(compared * 0.3);
  });
});

describe('a rule with nothing left to give is complete, one ical.js gives up on is not', () => {
  it('a fifth Monday by BYSETPOS=5 never recurs: complete, with `from` or without', () => {
    // a set of at most one Monday has no fifth; ical.js ends the walk after
    // 336 empty months, which is the rule's end here, not a give-up
    const ics = series('DTSTART;TZID=Europe/Berlin:19711005T233000', 'FREQ=MONTHLY;INTERVAL=2;BYDAY=5MO;BYSETPOS=5');
    const whole = expand(ics, '2030-01-01T00:00:00');
    expect(whole).toMatchObject({ complete: true, stoppedBy: null });
    expect(expand(ics, '2030-01-01T00:00:00', '2028-10-01T00:00:00')).toMatchObject(
      { occurrences: [], complete: true, stoppedBy: null });
  });

  it('a fifth Sunday of February is cut where the next one lies in the range, complete where none does', () => {
    // 2060 and 2088, then ical.js stops after 28 years; the next is 2128
    const ics = series('DTSTART:20580120T130000', 'FREQ=YEARLY;BYMONTH=2;BYDAY=5SU');
    expect(expand(ics, '2125-01-01T00:00:00')).toMatchObject({ complete: true, stoppedBy: null });
    expect(expand(ics, '2133-08-01T00:00:00')).toMatchObject({ complete: false, stoppedBy: 'library' });
    expect(expand(ics, '2133-08-01T00:00:00', '2117-01-01T00:00:00')).toMatchObject({ complete: false, stoppedBy: 'library' });
  });

  it('looks at a whole cycle of the rule\'s own periods, not of 4,800 months', () => {
    // every 7 years from 2001, a 29 February on a Monday: 2596, then 3408 —
    // 116 periods, 812 years apart; ical.js gives up after 28 empty years
    const rule = 'FREQ=YEARLY;INTERVAL=7;BYMONTH=2;BYMONTHDAY=29;BYDAY=MO';
    const ics = series('DTSTART;VALUE=DATE:20010201', rule);
    const result = expand(ics, '4000-01-01');
    expect(result).toMatchObject({ complete: false, stoppedBy: 'library' });
    expect(rfcDates(rule, '2001-02-01', '3500-01-01').filter((v) => v > '2596-03-01')[0]).toBe('3408-02-29');
    const wall = (d: string) => Date.parse(`${d}T00:00:00Z`) / 1000;
    expect(holdsInstance(ICAL.Recur.fromString(rule), wall('2001-02-01'), wall('2001-02-01'), wall('2596-02-29'),
      wall('3999-12-31'), true)).toBe(true);
    expect(holdsInstance(ICAL.Recur.fromString(rule), wall('2001-02-01'), wall('2001-02-01'), wall('2596-02-29'),
      wall('3400-12-31'), true)).toBe(false);
  });

  it('charges counting the periods to the budget', () => {
    // INTERVAL=2: 2,400 periods of one month to prove the fifth Monday never comes
    const ics = series('DTSTART;VALUE=DATE:20010101', 'FREQ=MONTHLY;INTERVAL=2;BYDAY=5MO;BYSETPOS=5');
    const budget = createRecurrenceBudget(1e8);
    expect(expandOccurrences(ics, { budget, until: '2100-01-01' }).complete).toBe(true);
    expect(1e8 - budget.remaining).toBeGreaterThanOrEqual(2400);
    // a budget too small for the count says so
    const small = expandOccurrences(ics, { budget: createRecurrenceBudget(1e8 - budget.remaining - 100), until: '2100-01-01' });
    expect(small).toMatchObject({ complete: false, stoppedBy: 'budget' });
  });

  it('says a period holds an instance exactly when RFC 5545 gives one, for random rules', () => {
    const { rnd, int, pick, some } = random(4242);
    const WD = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
    let held = 0;
    let empty = 0;
    for (let i = 0; i < RUNS; i++) {
      const freq = pick(['MONTHLY', 'YEARLY']);
      const parts = [`FREQ=${freq}`, `INTERVAL=${pick([1, 1, 2, 3, 5, 12])}`];
      if (rnd() < 0.5) parts.push(`BYMONTH=${some([1, 2, 3, 4, 6, 9, 11, 12], 3).join(',')}`);
      const monthDays = rnd() < 0.5;
      if (monthDays) parts.push(`BYMONTHDAY=${some([1, 13, 28, 29, 30, 31, -1, -29, -30, -31], 3).join(',')}`);
      if (rnd() < 0.6) {
        const ordinal = !monthDays && rnd() < 0.6;
        parts.push(`BYDAY=${some(WD, 2).map((d) => (ordinal ? pick(['1', '2', '4', '5', '-1', '-5', '53', '-53']) : '') + d)
          .join(',')}`);
      }
      if (rnd() < 0.4) parts.push(`BYSETPOS=${some([1, 2, 5, -1, -3, -5, 8], 2).join(',')}`);
      const rule = parts.join(';');
      const start = `${int(1990, 2030)}-${p2(int(1, 12))}-${p2(int(1, 28))}`;
      const startWall = Date.parse(`${start}T00:00:00Z`) / 1000;
      const begin = startWall + int(0, 60) * 31 * 86400;
      const end = begin + int(0, 120) * 31 * 86400;
      const recur = ICAL.Recur.fromString(rule);
      const verdict = holdsInstance(recur, startWall, begin, null, end, true);
      if (verdict === null) continue;
      // the oracle's instances in the periods from begin's through end's
      const day = (wall: number) => new Date(wall * 1000).toISOString().slice(0, 10);
      const periodStart = freq === 'MONTHLY' ? `${day(begin).slice(0, 7)}-01` : `${day(begin).slice(0, 4)}-01-01`;
      const periodEnd = freq === 'MONTHLY' ? `${day(end).slice(0, 7)}-31` : `${day(end).slice(0, 4)}-12-31`;
      const want = rfcDates(rule, start, periodEnd, periodStart).length > 0;
      expect(verdict, `${rule} from ${start}, ${day(begin)} to ${day(end)}`).toBe(want);
      if (want) held++;
      else empty++;
    }
    expect(held).toBeGreaterThan(RUNS * 0.2);
    expect(empty).toBeGreaterThan(RUNS * 0.05);
  });
});
