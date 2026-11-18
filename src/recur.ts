import ICAL from 'ical.js';

/*
 * Recurrence iteration in chronological order.
 *
 * ical.js' RecurIterator (2.2) steps through BYSECOND, BYMINUTE, BYHOUR and,
 * in increment_month, BYMONTH by position in the list, and starts every
 * position at 0. Two defects follow, and everything built on next() — a loop
 * that stops at the first instance past its end, ical.js' own UNTIL (it ends
 * at the first instance past it) and COUNT (it counts the first N it yields)
 * — assumes neither happens:
 *
 * - a list out of order comes out of order: FREQ=DAILY;BYHOUR=17,9 gives
 *   17:00 before 09:00 of the same day, FREQ=MONTHLY;BYMONTH=6,1,3 jumps a
 *   year back and forth and skips June of the first year;
 * - where DTSTART's own value is kept (the part limits the rule, or is the
 *   rule's own unit) but is not the first listed, the first step goes back:
 *   FREQ=MONTHLY;BYMONTH=3,6,9;BYDAY=FR from a September walks June, then
 *   that September a second time, so COUNT ends early.
 *
 * So the rule is iterated with these four lists in ascending order and each
 * position starting at DTSTART's value. The other BY parts are put in order
 * by ical.js itself: BYDAY by sort_byday_rules, BYMONTHDAY by
 * normalizeByMonthDayRules, the days of a YEARLY rule by sorting them.
 *
 * This changes no set of values (RFC 5545 3.3.10: each BY part is a set).
 * BYSETPOS is read by ical.js only over the days of a month, in day order
 * (next_month, expand_year_days), never over the order or position of these
 * lists, so which days it selects is unchanged.
 */

/**
 * The installed ical.js lacks a step the expansion relies on (the hook the
 * work limit is charged at, or the start positions of an iteration): a
 * failure of the library, not of the call, so it stays a plain Error and is
 * never turned into a refusal (CI's install smoke test catches it against a
 * fresh ical.js).
 */
export class BoundUnavailable extends Error {}

/** The BY parts ical.js steps through by position, with the FREQ that is their own unit; all hold non-negative values, so numeric order is time order */
const STEPPED_PARTS = [
  ['BYSECOND', 'SECONDLY'], ['BYMINUTE', 'MINUTELY'], ['BYHOUR', 'HOURLY'], ['BYMONTH', 'MONTHLY'],
] as const;
const FREQ_ORDER = ['SECONDLY', 'MINUTELY', 'HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];

/** A copy of the rule with BYSECOND, BYMINUTE, BYHOUR and BYMONTH in ascending order, without duplicates */
export function chronologicalRecur(recur: ICAL.Recur): ICAL.Recur {
  const copy = recur.clone();
  for (const [part] of STEPPED_PARTS) {
    const values = copy.getComponent(part) as (number | string)[];
    if (values.length > 1) {
      const sorted = [...new Map(values.map((v) => [Number(v), v])).entries()]
        .sort(([a], [b]) => a - b)
        .map(([, v]) => v);
      copy.setComponent(part, sorted);
    }
  }
  return copy;
}

/**
 * An iterator over a rule's instances from `dtstart`, in chronological order
 * and each once. Every expansion in this package goes through here, so a loop
 * over next() may stop at the first instance past its end.
 */
export function recurIterator(recur: ICAL.Recur, dtstart: ICAL.Time): ICAL.RecurIterator {
  const rule = chronologicalRecur(recur);
  const field = { BYSECOND: dtstart.second, BYMINUTE: dtstart.minute, BYHOUR: dtstart.hour, BYMONTH: dtstart.month };
  // the positions ical.js starts from (its constructor takes them to resume an iteration)
  const byIndices: Record<string, number> = {
    BYSECOND: 0, BYMINUTE: 0, BYHOUR: 0, BYDAY: 0, BYMONTH: 0, BYWEEKNO: 0, BYMONTHDAY: 0,
  };
  for (const [part, unit] of STEPPED_PARTS) {
    const values = (rule.getComponent(part) as (number | string)[]).map(Number);
    // ical.js keeps DTSTART's value where the part limits the rule or is its
    // own unit (FREQ as fine or finer than the part's unit), and takes the
    // first listed value otherwise, where position 0 is right. Where it keeps
    // DTSTART's, the position is the last listed value at or before it, so
    // the next step moves to the next listed value after it; -1 when every
    // listed value comes after it.
    if (values.length > 0 && FREQ_ORDER.indexOf(rule.freq) <= FREQ_ORDER.indexOf(unit)) {
      byIndices[part] = values.filter((v) => v <= field[part]).length - 1;
    }
  }
  const iterator = new ICAL.RecurIterator({ rule, dtstart, by_indices: byIndices } as
    ConstructorParameters<typeof ICAL.RecurIterator>[0]);
  // every ical.js 2.x keeps the object it is given (fromData); one that
  // ignored it would start at position 0 again and lose instances in
  // silence (MONTHLY;BYMONTH=6,1,3 from January drops that June): fail
  // closed instead
  if ((iterator as unknown as { by_indices?: unknown }).by_indices !== byIndices) {
    throw new BoundUnavailable('ical.js no longer takes the start positions of a rule iteration');
  }
  return iterator;
}

/** The length of a rule period of a fixed length, in seconds of the wall clock */
const FIXED_PERIOD: Record<string, number> = {
  SECONDLY: 1, MINUTELY: 60, HOURLY: 3600, DAILY: 86400, WEEKLY: 7 * 86400,
};

/** How many periods the iteration starts before the one holding `from` */
const LEAD_PERIODS = 2;

/** How many earlier periods a MONTHLY or YEARLY start that does not exist (31 April, 29 February) is tried back */
const CALENDAR_TRIES = 100;

/** The fewest days each month has in any year, January first */
const FEWEST_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Whether every value of `days` is a day that each month a YEARLY rule takes
 * has in every year: the months of BYMONTH, else DTSTART's month (which is
 * what ical.js' expand_year_days takes without BYMONTH). Then ical.js reads
 * such a day the same in every month it may read it by (see iterationStart),
 * and a date built from it exists.
 */
function inEveryMonth(recur: ICAL.Recur, dtstart: number, days: number[]): boolean {
  const byMonth = (recur.getComponent('BYMONTH') as (number | string)[]).map(Number);
  const months = byMonth.length ? byMonth : [new Date(dtstart * 1000).getUTCMonth() + 1];
  if (!months.every((m) => Number.isInteger(m) && m >= 1 && m <= 12)) {
    return false;
  }
  const fewest = Math.min(...months.map((m) => FEWEST_DAYS[m - 1]));
  return days.every((d) => Number.isInteger(d) && d >= 1 && d <= fewest);
}

/**
 * Whether a rule is always walked from DTSTART in full, with `from` too — no
 * moved start, no skip when its UNTIL lies before `from`, no arithmetic —
 * because only the whole walk gives its result or its verdict (see
 * iterationStart): COUNT; a date series with a FREQ below a day or with
 * BYHOUR, BYMINUTE or BYSECOND (ical.js yields one date twice and throws, at
 * a step that depends on where it began); YEARLY with a BYMONTHDAY that a
 * month the rule takes may lack (a negative one, 31 with a 30-day month, 29
 * with February); MONTHLY with BYDAY and BYMONTHDAY; YEARLY with BYDAY and
 * BYYEARDAY or BYWEEKNO.
 */
export function walkedInFull(recur: ICAL.Recur, dtstart: number, dateOnly: boolean): boolean {
  const has = (part: string) => (recur.getComponent(part) as unknown[]).length > 0;
  const fixed = FIXED_PERIOD[recur.freq];
  return Boolean(recur.count) ||
    (dateOnly && ((fixed !== undefined && fixed < 86400) || has('BYHOUR') || has('BYMINUTE') || has('BYSECOND'))) ||
    (recur.freq === 'YEARLY' &&
      !inEveryMonth(recur, dtstart, (recur.getComponent('BYMONTHDAY') as (number | string)[]).map(Number))) ||
    (recur.freq === 'MONTHLY' && has('BYDAY') && has('BYMONTHDAY')) ||
    (recur.freq === 'YEARLY' && has('BYDAY') && (has('BYYEARDAY') || has('BYWEEKNO')));
}

/**
 * Where an iteration of `recur` from `dtstart` may start so that it yields
 * every instance from `from` on, both wall clocks of the series (seconds; a
 * date series a day at 00:00): DTSTART moved by whole multiples of INTERVAL
 * periods, so every field the rule leaves open (the day of the month, the
 * weekday, the time of day) and the phase of INTERVAL stay as they were. That
 * is the same rule from a start of the same shape, and ical.js evaluates BY
 * parts and BYSETPOS per period, so every period after the first is expanded
 * as from DTSTART. The first period is not: ical.js yields the start itself
 * untested and filters by it within its period. So the start is moved to at
 * least LEAD_PERIODS periods before the one holding `from`, and the caller
 * drops every instance before `from` — which also covers a YEARLY;BYWEEKNO
 * period whose weeks reach a few days into the next year, and a WEEKLY period
 * that begins on WKST before the moved start.
 *
 * DTSTART itself is returned (no move) where that is not exact: a rule with
 * COUNT (the count needs every earlier instance); `from` within the first
 * periods; a date series with a rule below a day; a MONTHLY or YEARLY start
 * whose day does not exist in any of the CALENDAR_TRIES candidate periods;
 * and a YEARLY rule with a BYMONTHDAY some month it takes may lack. ical.js (2.2,
 * next_year) resolves a YEARLY rule's BYMONTHDAY for each new year against
 * the month of the instance before it — dropping 31 after a 30-day month,
 * reading -2 by the wrong month's length — so what such a rule yields
 * depends on every year before, not on the year alone. The month it reads
 * by is always one the rule takes (_nextByYearDay sets it from the days of
 * those months), so a positive day each of them has in every year — any day
 * from 1 to 28, 30 with BYMONTH=4,6, 31 with BYMONTH=1,3 — reads the same
 * whatever the month; a day from 1 to 28
 * exists in every month and reads the same whatever the month.
 *
 * Nor is a start moved where ical.js may refuse or stop in the middle of a
 * walk depending on how far back it began, so that a walk from near `from`
 * would give a result where the walk from DTSTART refuses or ends (fail
 * closed: with `from` or without, the same verdict):
 * - MONTHLY with BYDAY and BYMONTHDAY: its search for the next match gives
 *   up after 48 months and throws (_byDayAndMonthDay), so a gap that long
 *   before `from` refuses the walk from DTSTART;
 * - YEARLY with BYDAY and BYYEARDAY or BYWEEKNO: ical.js ends a YEARLY rule
 *   in silence after 28 years without an instance (next), and a weekday
 *   pinned to a day of the year can skip that long (day 366 on a Monday).
 * Every other way ical.js refuses is decided by the rule or by DTSTART's own
 * setup, which the caller checks at DTSTART. Moving DTSTART never changes
 * which instances are found, only where the walk begins.
 */
export function iterationStart(recur: ICAL.Recur, dtstart: number, from: number, dateOnly: boolean): number {
  const interval = Math.max(1, recur.interval || 1);
  if (!Number.isFinite(from) || from <= dtstart || walkedInFull(recur, dtstart, dateOnly)) {
    return dtstart;
  }
  const fixed = FIXED_PERIOD[recur.freq];
  if (fixed !== undefined) {
    const k = Math.floor((from - dtstart) / (fixed * interval)) - LEAD_PERIODS;
    return k > 0 ? dtstart + k * fixed * interval : dtstart;
  }
  const months = recur.freq === 'MONTHLY' ? 1 : recur.freq === 'YEARLY' ? 12 : 0;
  if (months === 0) {
    return dtstart;
  }
  const s = new Date(dtstart * 1000);
  const f = new Date(from * 1000);
  const index = (d: Date) => d.getUTCFullYear() * 12 + d.getUTCMonth();
  const step = months * interval;
  const kMax = Math.floor((index(f) - index(s)) / step) - LEAD_PERIODS;
  for (let k = kMax; k > 0 && k > kMax - CALENDAR_TRIES; k--) {
    // the same day of the month and time of day k periods on; Date.UTC rolls
    // a day the month lacks into the next month, which is no such start
    const t = new Date(0);
    t.setUTCFullYear(s.getUTCFullYear(), s.getUTCMonth() + k * step, s.getUTCDate());
    t.setUTCHours(s.getUTCHours(), s.getUTCMinutes(), s.getUTCSeconds(), 0);
    if (t.getUTCDate() === s.getUTCDate()) {
      return t.getTime() / 1000;
    }
  }
  return dtstart;
}

/**
 * The instances of a YEARLY rule of fixed days in [from, to], wall clocks of
 * the series, worked out without ical.js; null for any other rule, which is
 * walked. A rule of fixed days has no COUNT and no part but BYMONTH and
 * BYMONTHDAY, each value once, every BYMONTHDAY a day each month it takes has
 * in every year (inEveryMonth): a birthday or
 * anniversary as clients write it (FREQ=YEARLY, or with BYMONTH and
 * BYMONTHDAY). Its instances are DTSTART's time of day on each listed day of
 * each listed month (DTSTART's day where BYMONTHDAY is missing, DTSTART's
 * month where BYMONTH is), every INTERVAL years from DTSTART's year, from
 * DTSTART up to `last` (UNTIL read on the wall clock). That is what ical.js
 * (2.2) yields for it, with no state carried from one year to the next:
 * - expand_year_days takes, with no BY part, DTSTART with the year set; with
 *   BYMONTH alone, DTSTART with the year and each month set; with BYMONTHDAY
 *   alone, DTSTART with the year and each day set; with both, each day of
 *   each month;
 * - next_year adds INTERVAL to the year and expands it again. It reads
 *   BYMONTHDAY by the month of the instance before, which keeps a day from 1
 *   to 28 as it is (normalizeByMonthDayRules drops only a day past the
 *   month's end, and turns only negative days);
 * - such a day exists in each month taken in every year, and DTSTART's own
 *   day in its own month in every year but for 29 February (increment_year
 *   moves that in a way of its own: walked).
 * Any other BYMONTHDAY never reaches here (walkedInFull), and BYMONTH alone
 * on a DTSTART day some listed month lacks (expand_year_days would read 31
 * April as 1 May) is walked. Where a BY part is given, only years after DTSTART's are worked
 * out: in DTSTART's year ical.js yields BYMONTHDAY in the order written
 * before it first sorts it, and that year is cheap to walk.
 * So a birthday costs the instances in the window and nothing for the years
 * before, none at all when the window holds no such day.
 */
export function fixedYearlyWalls(recur: ICAL.Recur, dtstart: number, from: number, to: number, last: number): number[] | null {
  if (recur.freq !== 'YEARLY' || recur.count || !Number.isFinite(from)) {
    return null;
  }
  const parts = (recur as unknown as { parts?: Record<string, unknown> }).parts ?? {};
  const listed = (part: string) => (Array.isArray(parts[part]) ? parts[part] as unknown[] : []).map(Number);
  if (Object.entries(parts).some(([part, values]) =>
    Array.isArray(values) && values.length > 0 && part !== 'BYMONTH' && part !== 'BYMONTHDAY')) {
    return null;
  }
  const s = new Date(dtstart * 1000);
  const byMonth = listed('BYMONTH');
  const byMonthDay = listed('BYMONTHDAY');
  const distinct = (values: number[]) => new Set(values).size === values.length;
  if (!byMonth.every((m) => Number.isInteger(m) && m >= 1 && m <= 12) || !distinct(byMonth) ||
      !inEveryMonth(recur, dtstart, byMonthDay) || !distinct(byMonthDay)) {
    return null;
  }
  const plain = byMonth.length === 0 && byMonthDay.length === 0;
  if (plain ? s.getUTCMonth() === 1 && s.getUTCDate() === 29
    : byMonthDay.length === 0 && !inEveryMonth(recur, dtstart, [s.getUTCDate()])) {
    return null;
  }
  const startYear = s.getUTCFullYear();
  const firstYear = new Date(Math.max(from, dtstart) * 1000).getUTCFullYear();
  if (!plain && firstYear <= startYear) {
    return null;
  }
  const months = byMonth.length ? [...byMonth].sort((a, b) => a - b) : [s.getUTCMonth() + 1];
  const days = byMonthDay.length ? [...byMonthDay].sort((a, b) => a - b) : [s.getUTCDate()];
  const interval = Math.max(1, recur.interval || 1);
  const end = Math.min(to, last);
  const out: number[] = [];
  const k0 = Math.max(0, Math.ceil((firstYear - 1 - startYear) / interval));
  for (let k = k0; ; k++) {
    const year = startYear + k * interval;
    if (Date.UTC(year, 0, 1) / 1000 > end) {
      break;
    }
    for (const month of months) {
      for (const day of days) {
        const t = new Date(0);
        t.setUTCFullYear(year, month - 1, day);
        t.setUTCHours(s.getUTCHours(), s.getUTCMinutes(), s.getUTCSeconds(), 0);
        const wall = t.getTime() / 1000;
        if (wall >= from && wall >= dtstart && wall <= end) {
          out.push(wall);
        }
      }
    }
  }
  return out;
}
