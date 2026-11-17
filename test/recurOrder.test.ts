import { describe, expect, it } from 'vitest';
import ICAL from 'ical.js';
import { cancelOccurrences, createRecurrenceBudget, expandOccurrences, isUpdateFieldsError } from '../src/index';
import { recurIterator } from '../src/recur';

// ical.js yields the values of BYSECOND, BYMINUTE, BYHOUR and BYMONTH in the
// order the rule lists them (issue #31). Every expansion stops at the first
// instance past its end, so a rule listing them out of order lost occurrences
// while the result said it was complete.

const calendar = (...lines: string[]) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...lines, 'END:VCALENDAR', ''].join('\r\n');
const event = (...lines: string[]) => ['BEGIN:VEVENT', 'UID:e', 'DTSTAMP:20260101T000000Z', ...lines, 'END:VEVENT'];
const expand = (ics: string, until: string, from?: string) =>
  expandOccurrences(ics, { budget: createRecurrenceBudget(), until, ...(from ? { from } : {}) });
const refusal = (call: () => unknown) => {
  try {
    call();
  } catch (error) {
    return error;
  }
  throw new Error('not refused');
};
const starts = (result: ReturnType<typeof expand>) => result.occurrences.map((o) => o.start.value);

describe('rules listing BY values out of order expand in full', () => {
  it('DAILY;BYHOUR=17,9: the 09:00 behind a 17:00 past the range end is found', () => {
    const result = expand(calendar(...event('DTSTART:20260115T090000Z', 'RRULE:FREQ=DAILY;BYHOUR=17,9')),
      '2026-01-16T12:00:00Z');
    expect(result).toMatchObject({ complete: true, stoppedBy: null });
    expect(starts(result)).toEqual(['2026-01-15T09:00:00Z', '2026-01-15T17:00:00Z', '2026-01-16T09:00:00Z']);
  });

  it('HOURLY;INTERVAL=4;BYMINUTE=45,15', () => {
    const result = expand(calendar(...event('DTSTART:20260115T091500Z', 'RRULE:FREQ=HOURLY;INTERVAL=4;BYMINUTE=45,15')),
      '2026-01-15T13:30:00Z');
    expect(result.complete).toBe(true);
    expect(starts(result)).toEqual(['2026-01-15T09:15:00Z', '2026-01-15T09:45:00Z', '2026-01-15T13:15:00Z']);
  });

  it('MONTHLY;BYMONTH=6,1,3: every listed month of the year, June of the first year included', () => {
    const result = expand(calendar(...event('DTSTART:20260115T090000Z', 'RRULE:FREQ=MONTHLY;BYMONTH=6,1,3')),
      '2027-04-01T00:00:00Z');
    expect(result.complete).toBe(true);
    expect(starts(result)).toEqual(['2026-01-15T09:00:00Z', '2026-03-15T09:00:00Z', '2026-06-15T09:00:00Z',
      '2027-01-15T09:00:00Z', '2027-03-15T09:00:00Z']);
  });

  it('the rule\'s own UNTIL and COUNT take the first instances in time', () => {
    const until = expand(calendar(...event('DTSTART:20260115T090000Z', 'RRULE:FREQ=DAILY;BYHOUR=17,9;UNTIL=20260116T120000Z')),
      '2027-01-01T00:00:00Z');
    const count = expand(calendar(...event('DTSTART:20260115T090000Z', 'RRULE:FREQ=DAILY;BYHOUR=17,9;COUNT=3')),
      '2027-01-01T00:00:00Z');
    for (const result of [until, count]) {
      expect(starts(result)).toEqual(['2026-01-15T09:00:00Z', '2026-01-15T17:00:00Z', '2026-01-16T09:00:00Z']);
    }
  });

  it('a listed month before DTSTART\'s is not walked back to, nor DTSTART\'s month walked twice', () => {
    const count = expand(calendar(...event('DTSTART:20260904T170000Z', 'RRULE:FREQ=MONTHLY;BYMONTH=9,3,6;BYDAY=FR;COUNT=10')),
      '2030-01-01T00:00:00Z');
    expect(starts(count)).toEqual(['2026-09-04T17:00:00Z', '2026-09-11T17:00:00Z', '2026-09-18T17:00:00Z',
      '2026-09-25T17:00:00Z', '2027-03-05T17:00:00Z', '2027-03-12T17:00:00Z', '2027-03-19T17:00:00Z',
      '2027-03-26T17:00:00Z', '2027-06-04T17:00:00Z', '2027-06-11T17:00:00Z']);
    const between = expand(calendar(...event('DTSTART:20260615T090000Z', 'RRULE:FREQ=DAILY;BYMONTH=3,9')),
      '2026-09-03T00:00:00Z');
    expect(starts(between)).toEqual(['2026-06-15T09:00:00Z', '2026-09-01T09:00:00Z', '2026-09-02T09:00:00Z']);
    const daily = expand(calendar(...event('DTSTART:20260929T090000Z', 'RRULE:FREQ=DAILY;BYMONTH=9,3,6;COUNT=3')),
      '2030-01-01T00:00:00Z');
    expect(starts(daily)).toEqual(['2026-09-29T09:00:00Z', '2026-09-30T09:00:00Z', '2027-03-01T09:00:00Z']);
  });

  it('an ical.js that ignores the start positions fails closed, as a failure of the library', () => {
    const proto = (ICAL.RecurIterator as unknown as { prototype: { fromData: (options: Record<string, unknown>) => void } })
      .prototype;
    const fromData = proto.fromData;
    proto.fromData = function (this: unknown, options: Record<string, unknown>) {
      return fromData.call(this, { ...options, by_indices: undefined });
    };
    try {
      const error = refusal(() => expand(calendar(...event('DTSTART:20260115T090000Z', 'RRULE:FREQ=MONTHLY;BYMONTH=6,1,3')),
        '2027-01-01T00:00:00Z'));
      expect((error as Error).message).toMatch(/ical\.js no longer takes the start positions of a rule iteration/);
      expect(isUpdateFieldsError(error)).toBe(false);
    } finally {
      proto.fromData = fromData;
    }
  });

  it('an override of an occurrence behind the cut is applied', () => {
    const result = expand(calendar(
      ...event('DTSTART:20260115T090000Z', 'DURATION:PT1H', 'RRULE:FREQ=DAILY;BYHOUR=17,9'),
      ...event('RECURRENCE-ID:20260116T090000Z', 'DTSTART:20260116T100000Z', 'SUMMARY:moved')),
    '2026-01-16T12:00:00Z', '2026-01-16T00:00:00Z');
    expect(result.occurrences.map((o) => [o.recurrenceId.value, o.start.value, o.overridden]))
      .toEqual([['2026-01-16T09:00:00Z', '2026-01-16T10:00:00Z', true]]);
    expect(result.complete).toBe(true);
  });

  it('the checks of a write see those occurrences too: cancelling one is accepted', () => {
    const out = cancelOccurrences(calendar(...event('DTSTART:20260115T090000Z', 'RRULE:FREQ=MONTHLY;BYMONTH=6,1,3')),
      ['2026-06-15T09:00:00Z']);
    expect(out).toContain('EXDATE:20260615T090000Z');
  });
});

// Property test against an independent brute force: every day (every hour for
// HOURLY) in the range is tested against the rule as RFC 5545 3.3.10 reads it.
// Size and seed as in seriesMoveProperty.test.ts.
const RUNS = Math.max(20, Number(process.env.SERIES_PROPERTY_RUNS ?? 300));
const SEED = process.env.SERIES_PROPERTY_SEED === undefined ? null : Number(process.env.SERIES_PROPERTY_SEED);
const seedFor = (fixed: number) => SEED === null ? fixed : SEED * 7919 + fixed;

describe('expansion matches a brute-force reading of the rule, in any listed order', () => {
  let seed = seedFor(31);
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
  const pick = <T,>(list: T[]): T => list[Math.floor(rnd() * list.length)];
  /** 1 to n distinct values, in random order */
  const some = (list: number[], n: number) => {
    const out = [...new Set(Array.from({ length: int(1, n) }, () => pick(list)))];
    // Fisher-Yates on the seeded generator: the same sample on every engine
    for (let k = out.length - 1; k > 0; k--) {
      const j = int(0, k);
      [out[k], out[j]] = [out[j], out[k]];
    }
    return out;
  };
  const D = 86400;
  const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  type Freq = 'YEARLY' | 'MONTHLY' | 'WEEKLY' | 'DAILY' | 'HOURLY' | 'MINUTELY' | 'SECONDLY';
  interface Rule {
    freq: Freq; interval: number; byMonth?: number[]; byMonthDay?: number[]; byDay?: number[];
    byHour?: number[]; byMinute?: number[]; bySecond?: number[]; count?: number; until?: number;
  }
  /** the length of the rule's period, for the units below a day */
  const UNIT: Partial<Record<Freq, number>> = { HOURLY: 3600, MINUTELY: 60, SECONDLY: 1 };
  const range = (n: number) => Array.from({ length: n }, (_, k) => k);
  const text = (r: Rule) => [`FREQ=${r.freq}`, r.interval > 1 ? `INTERVAL=${r.interval}` : '',
    r.byMonth ? `BYMONTH=${r.byMonth}` : '', r.byMonthDay ? `BYMONTHDAY=${r.byMonthDay}` : '',
    r.byDay ? `BYDAY=${r.byDay.map((d) => DAYS[d])}` : '', r.byHour ? `BYHOUR=${r.byHour}` : '',
    r.byMinute ? `BYMINUTE=${r.byMinute}` : '', r.bySecond ? `BYSECOND=${r.bySecond}` : '', r.count ? `COUNT=${r.count}` : '',
    r.until ? `UNTIL=${basic(r.until)}Z` : ''].filter(Boolean).join(';');
  const p2 = (n: number) => String(n).padStart(2, '0');
  const basic = (wall: number) => {
    const d = new Date(wall * 1000);
    return `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}T` +
      `${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}`;
  };

  /**
   * The instances of the rule from `start` up to `end` (inclusive): every day
   * is tested against the date parts, and every hour, minute and second of it
   * the rule's unit reaches. Values a part leaves open come from `start`.
   */
  const brute = (r: Rule, start: number, end: number): number[] => {
    const s = new Date(start * 1000);
    const [y0, m0, d0, h0, mi0, s0, dow0] = [s.getUTCFullYear(), s.getUTCMonth() + 1, s.getUTCDate(), s.getUTCHours(),
      s.getUTCMinutes(), s.getUTCSeconds(), s.getUTCDay()];
    const day0 = Math.floor(start / D);
    // weeks start on Monday (WKST=MO); 1970-01-01 was a Thursday
    const weekOf = (day: number) => Math.floor((day + 3) / 7);
    const below = (f: Freq) => ['HOURLY', 'MINUTELY', 'SECONDLY'].indexOf(r.freq) >= ['HOURLY', 'MINUTELY', 'SECONDLY'].indexOf(f);
    const out: number[] = [];
    for (let day = day0; day * D <= end; day++) {
      const t = new Date(day * D * 1000);
      const [y, m, d, dow] = [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), t.getUTCDay()];
      const period = { YEARLY: y - y0, MONTHLY: (y - y0) * 12 + m - m0, WEEKLY: weekOf(day) - weekOf(day0),
        DAILY: day - day0 }[r.freq as 'YEARLY'] ?? 0;
      if (period % r.interval !== 0) continue;
      if (r.byMonth ? !r.byMonth.includes(m) : r.freq === 'YEARLY' && m !== m0) continue;
      if (r.byMonthDay && !r.byMonthDay.includes(d)) continue;
      if (r.byDay ? !r.byDay.includes(dow) : r.freq === 'WEEKLY' && dow !== dow0) continue;
      if (!r.byMonthDay && !r.byDay && (r.freq === 'MONTHLY' || r.freq === 'YEARLY') && d !== d0) continue;
      const hours = UNIT[r.freq] && below('HOURLY') ? range(24).filter((h) => !r.byHour || r.byHour.includes(h)) : r.byHour ?? [h0];
      const minutes = UNIT[r.freq] && r.freq !== 'HOURLY' ? range(60).filter((v) => !r.byMinute || r.byMinute.includes(v))
        : r.byMinute ?? [mi0];
      const seconds = r.freq === 'SECONDLY' ? range(60).filter((v) => !r.bySecond || r.bySecond.includes(v)) : r.bySecond ?? [s0];
      for (const h of hours) {
        for (const mi of minutes) {
          for (const se of seconds) {
            const wall = day * D + h * 3600 + mi * 60 + se;
            const unit = UNIT[r.freq];
            if (unit && (Math.floor(wall / unit) - Math.floor(start / unit)) % r.interval !== 0) continue;
            if (wall >= start && wall <= end && (r.until === undefined || wall <= r.until)) out.push(wall);
          }
        }
      }
    }
    out.sort((a, b) => a - b);
    return r.count ? out.slice(0, r.count) : out;
  };

  const randomRule = (): Rule => {
    const freq = pick<Freq>(['YEARLY', 'MONTHLY', 'MONTHLY', 'WEEKLY', 'DAILY', 'DAILY', 'HOURLY', 'MINUTELY', 'SECONDLY']);
    const sub = UNIT[freq] !== undefined;
    const r: Rule = { freq, interval: rnd() < 0.4 ? int(2, sub ? 5 : 3) : 1 };
    const months = [1, 2, 3, 4, 6, 9, 10, 12];
    if (freq === 'YEARLY' || (!sub && rnd() < 0.4)) r.byMonth = some(months, freq === 'MONTHLY' || freq === 'YEARLY' ? 4 : 3);
    if ((freq === 'MONTHLY' || freq === 'YEARLY') && rnd() < 0.4) r.byMonthDay = some([1, 5, 13, 20, 28], 3);
    if (rnd() < (freq === 'WEEKLY' ? 0.6 : 0.3)) r.byDay = some([0, 1, 2, 3, 4, 5, 6], 3);
    if (rnd() < (sub ? 0.3 : 0.6)) r.byHour = some([0, 6, 9, 13, 17, 23], sub ? 4 : 3);
    if (rnd() < 0.6) r.byMinute = some([0, 15, 30, 45], 3);
    if (rnd() < 0.4) r.bySecond = some([0, 10, 30, 50], 3);
    // ical.js steps through a BY part of the rule's own unit without INTERVAL
    // (MONTHLY;BYMONTH, HOURLY;BYHOUR, MINUTELY;BYMINUTE, SECONDLY;BYSECOND;
    // a quirk of its own, not of order): kept out
    if ((freq === 'MONTHLY' && r.byMonth) || (freq === 'HOURLY' && r.byHour) || (freq === 'MINUTELY' && r.byMinute) ||
      (freq === 'SECONDLY' && r.bySecond)) r.interval = 1;
    // Two quirks of ical.js of their own, not of order, kept out: YEARLY uses
    // only the first BYHOUR, BYMINUTE and BYSECOND value, and MONTHLY;BYDAY
    // with more than one time of day adds an instance on the 1st of the next month
    if (freq === 'YEARLY' || (freq === 'MONTHLY' && r.byDay)) {
      for (const part of ['byHour', 'byMinute', 'bySecond'] as const) {
        if (r[part]) r[part] = r[part]!.slice(0, 1);
      }
    }
    return r;
  };
  const SPAN: Record<Freq, number> = { YEARLY: 8 * 366 * D, MONTHLY: 3 * 366 * D, WEEKLY: 366 * D, DAILY: 90 * D,
    HOURLY: 12 * D, MINUTELY: 2 * D, SECONDLY: 4 * 3600 };

  it('every random rule gives the brute-force instances, complete, and ical.js yields them ascending', () => {
    let checked = 0;
    let unordered = 0;
    let offRuleChecked = 0;
    for (let i = 0; i < RUNS; i++) {
      const r = randomRule();
      const provisional = Date.UTC(pick([2026, 2027]), int(0, 11), int(1, 28), int(0, 23), pick([0, 15, 30, 45]),
        pick([0, 10, 30, 50])) / 1000;
      // DTSTART on the rule's first instance, or (without COUNT, whose reading
      // RFC 5545 leaves open for it) on a time the rule does not match, which
      // still counts as the first occurrence
      const offRule = rnd() < 0.3;
      const first = offRule ? provisional : brute(r, provisional, provisional + SPAN[r.freq])[0];
      if (first === undefined) continue;
      const end = first + 1 + Math.floor(rnd() * SPAN[r.freq]);
      if (!offRule && rnd() < 0.25) r.count = int(1, 40);
      else if (rnd() < 0.3) r.until = first + Math.floor(rnd() * (end - first));
      const rule = text(r);
      const ruleInstances = brute(r, first, end - 1);
      // ical.js yields the candidate it starts on first without testing it
      // against the rule, so a DTSTART off the rule can bring one instance the
      // rule does not have (MONTHLY;BYMONTH=1,6,2;BYMONTHDAY=20 from 1 Nov
      // gives 20 Nov; a quirk of its own, with or without the order): the one
      // allowed extra, and only that one
      const startTime = ICAL.Time.fromDateTimeString(new Date(first * 1000).toISOString().slice(0, 19));
      const initial = offRule ? recurIterator(ICAL.Recur.fromString(rule), startTime).next() : null;
      const initialWall = initial && Date.UTC(initial.year, initial.month - 1, initial.day, initial.hour, initial.minute,
        initial.second) / 1000;
      const extra = initialWall !== null && initialWall < end && (r.until === undefined || initialWall <= r.until)
        ? [initialWall] : [];
      const want = [...new Set([...(offRule ? [first] : []), ...extra, ...ruleInstances])].sort((a, b) => a - b).map(basic);
      if (offRule && want.length > 1) offRuleChecked++;

      const result = expandOccurrences(calendar(...event(`DTSTART:${basic(first)}Z`, `RRULE:${rule}`)),
        { budget: createRecurrenceBudget(1e8), until: new Date(end * 1000), limit: 100000 });
      expect(result.complete, rule).toBe(true);
      expect(result.occurrences.map((o) => o.recurrenceId.value.replace(/[-:Z]/g, '')), `${rule} from ${basic(first)}`)
        .toEqual(want);

      // the order the loops rely on, also past the range
      const it = recurIterator(ICAL.Recur.fromString(rule), ICAL.Time.fromDateTimeString(new Date(first * 1000)
        .toISOString().slice(0, 19)));
      let previous = -Infinity;
      // ical.js gives up on BYDAY with BYMONTHDAY after 48 steps of its search
      // and throws, also for a rule that does match later (MONTHLY;INTERVAL=3;
      // BYMONTHDAY=13,5,20;BYDAY=TU; a quirk of its own, with or without the
      // order): the check ends there
      const step = () => {
        try {
          return it.next();
        } catch (error) {
          if (/Malformed values in BYDAY combined with BYMONTHDAY/.test((error as Error).message)) return null;
          throw error;
        }
      };
      for (let n = 0, next = step(); next && n < 500; n++, next = step()) {
        const wall = Date.UTC(next.year, next.month - 1, next.day, next.hour, next.minute, next.second) / 1000;
        expect(wall, rule).toBeGreaterThan(previous);
        previous = wall;
      }
      if ([r.byMonth, r.byHour, r.byMinute, r.bySecond].some((l) => l && l.some((v, k) => k > 0 && v < l[k - 1]))) unordered++;
      checked++;
    }
    // the sample must exercise what it is there for
    expect(checked).toBeGreaterThan(RUNS * 0.8);
    expect(unordered).toBeGreaterThan(RUNS * 0.2);
    expect(offRuleChecked).toBeGreaterThan(RUNS * 0.1);
  });

  it('BYSETPOS selects the same instances whatever order BYHOUR and BYMONTH are listed in', () => {
    // ical.js reads BYSETPOS over the days of a month in day order; ordering
    // the other lists only changes the order instances come out in. The
    // listed-order iteration is read far past the horizon and compared as a set.
    for (let i = 0; i < Math.ceil(RUNS / 3); i++) {
      const days = some([0, 1, 2, 3, 4, 5, 6], 4).map((d) => DAYS[d]).join(',');
      const positions = some([1, 2, -1, -2], 2);
      const setpos = positions.join(',');
      const yearly = rnd() < 0.4;
      // YEARLY uses only the first BYHOUR value (see above): one there
      const hours = some([6, 9, 13, 17], yearly ? 1 : 3).join(',');
      const rule = yearly
        ? `FREQ=YEARLY;BYMONTH=${some([1, 3, 6, 10, 12], 3)};BYDAY=${days};BYSETPOS=${setpos};BYHOUR=${hours}`
        : `FREQ=MONTHLY;BYDAY=${days};BYSETPOS=${setpos};BYHOUR=${hours}`;
      const dtstart = ICAL.Time.fromDateTimeString(`${pick([2026, 2027])}-${p2(int(1, 12))}-01T00:00:00`);
      const wallOf = (t: ICAL.Time) => Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second) / 1000;
      const horizon = wallOf(dtstart) + 3 * 366 * D;
      const collect = (it: ICAL.RecurIterator, until: number) => {
        const walls: number[] = [];
        for (let next = it.next(); next && wallOf(next) <= until; next = it.next()) {
          walls.push(wallOf(next));
        }
        return walls;
      };
      // the instance ical.js adds on the 1st of the next month (see above),
      // and the first BYDAY day it starts on, need not be days BYSETPOS
      // selects: left out on both sides
      const weekdays = days.split(',').map((d) => DAYS.indexOf(d));
      /** whether the day is one BYSETPOS selects among the month's BYDAY days */
      const genuine = (w: number) => {
        const t = new Date(w * 1000);
        const matching = Array.from({ length: 31 }, (_, k) => new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), k + 1)))
          .filter((d) => d.getUTCMonth() === t.getUTCMonth() && weekdays.includes(d.getUTCDay()))
          .map((d) => d.getUTCDate());
        return positions.some((p) => matching.at(p > 0 ? p - 1 : p) === t.getUTCDate());
      };
      // every instant ical.js' reading gives: each selected day at every listed hour
      const months = yearly ? rule.match(/BYMONTH=([\d,]+)/)![1].split(',').map(Number) : null;
      const hourList = hours.split(',').map(Number).sort((a, b) => a - b);
      const want: number[] = [];
      for (let day = Math.floor(wallOf(dtstart) / D); day * D <= horizon; day++) {
        const t = new Date(day * D * 1000);
        if (months && !months.includes(t.getUTCMonth() + 1)) continue;
        for (const h of hourList) {
          const wall = day * D + h * 3600;
          if (wall >= wallOf(dtstart) && wall <= horizon && genuine(wall)) want.push(wall);
        }
      }
      const ordered = [...new Set(collect(recurIterator(ICAL.Recur.fromString(rule), dtstart), horizon))].filter(genuine);
      const listed = [...new Set(collect(ICAL.Recur.fromString(rule).iterator(dtstart), horizon + 366 * D))]
        .filter((w) => w <= horizon && genuine(w)).sort((a, b) => a - b);
      expect(want.length, rule).toBeGreaterThan(0);
      expect(ordered.map(basic), rule).toEqual(want.map(basic));
      expect(listed.map(basic), rule).toEqual(want.map(basic));
    }
  });
});
