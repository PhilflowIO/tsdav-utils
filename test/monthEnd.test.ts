import ICAL from 'ical.js';
import { describe, expect, it } from 'vitest';
import { createRecurrenceBudget, expandOccurrences } from '../src/index';
import { recurIterator } from '../src/recur';
import { rfcDates } from './rfcOracle';

// Rules whose period may hold none of its days (#42). Results are checked against
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
      // ical.js steps a MONTHLY rule with BYMONTH through its months whatever
      // INTERVAL says, and reads a YEARLY BYMONTHDAY in ways of its own:
      // RFC 5545 is checked where neither applies
      if (freq === 'MONTHLY' && (byMonth.length === 0 || interval === 1) && !zoned) {
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
    expect(rfcCompared).toBeGreaterThan(RUNS * 0.3);
    expect(nonEmpty).toBeGreaterThan(compared * 0.3);
  });
});
