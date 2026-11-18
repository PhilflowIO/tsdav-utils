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
 * An iterator over a rule's instances from `start`, in chronological order
 * and each once. Every expansion in this package goes through here, so a loop
 * over next() may stop at the first instance past its end.
 */
export function recurIterator(recur: ICAL.Recur, start: ICAL.Time): ICAL.RecurIterator {
  const rule = chronologicalRecur(recur);
  // where ical.js' own setup would go wrong, it is set up in the first month
  // that holds an instance (monthDaySetupStart)
  const setup = monthDaySetupStart(rule, start);
  const dtstart = setup ?? start;
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
  if (byDaySetupEndless(rule, dtstart, byIndices.BYMONTH)) {
    // ical.js' setup would search without end (byDaySetupEndless). A rule
    // with no instance at all is that, ended, without the setup; one with
    // instances cannot be set up by ical.js and is refused (fail closed)
    if (holdsInstance(rule, wallOfTime(start), wallOfTime(start), null, LAST_WALL, start.isDate) !== false) {
      throw new Error('Invalid BYDAY rule: ical.js would search for its fifth or fifth-last weekday without end');
    }
    const ended = new ICAL.RecurIterator({ rule, dtstart, by_indices: byIndices, initialized: true,
      last: dtstart.clone() } as ConstructorParameters<typeof ICAL.RecurIterator>[0]);
    (ended as unknown as { completed: boolean }).completed = true;
    return ended;
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
  if (setup === null) {
    // no month the iteration reaches holds a listed day, in any year: the
    // rule has no instance, which ical.js marks so itself where it sees it
    (iterator as unknown as { completed: boolean }).completed = true;
  }
  if (setup !== undefined) {
    // a MONTHLY;BYMONTHDAY rule without BYDAY
    skipEmptyMonths(iterator);
  }
  firstDayByPosition(iterator, rule);
  keepInstances(iterator, rule, start);
  return iterator;
}

/** The parts of an ical.js iteration this module reads or steps */
interface IteratorState {
  next_month?: () => number;
  by_data: Record<string, number[]>;
  by_indices: Record<string, number>;
  last: ICAL.Time;
}

/**
 * Keeps ical.js (2.2) from yielding a time of day inside a month that holds
 * none of a MONTHLY rule's BYMONTHDAY days. next_month steps the times of
 * the day (BYSECOND, BYMINUTE, BYHOUR, which a MONTHLY rule expands) before
 * the day: in a month it moved to that holds no listed day it reports no
 * instance, but leaves the day at 1, so its next call steps to the next
 * listed time and reports day 1 at that time as one.
 * FREQ=MONTHLY;BYMONTHDAY=31;BYHOUR=0,23 yields 1 February and 1 April at
 * 23:00; which such days appear depends on the months a walk passes, so a
 * walk from near `from` and one from DTSTART differ too. Where next_month
 * lands on a day the month's list (normalised by increment_month) does not
 * hold, every time list is set to its last value, so the step after it ends
 * the day and moves on to the next month, which is the step the empty month
 * needed: one invalid month, as without a time list, and no instance or
 * charge for the times between.
 */
function skipEmptyMonths(iterator: ICAL.RecurIterator): void {
  const it = iterator as unknown as IteratorState;
  const own = it.next_month;
  if (typeof own !== 'function') {
    throw new BoundUnavailable('ical.js no longer steps a MONTHLY rule by next_month');
  }
  it.next_month = function nextMonth(this: IteratorState) {
    let valid = own.call(this);
    if (valid && !this.by_data.BYMONTHDAY.includes(this.last.day)) {
      for (const [part, field] of [['BYSECOND', 'second'], ['BYMINUTE', 'minute'], ['BYHOUR', 'hour']] as const) {
        const values = this.by_data[part];
        if (values?.length) {
          this.by_indices[part] = values.length - 1;
          this.last[field] = values[values.length - 1];
        }
      }
      valid = own.call(this);
    }
    return valid;
  };
}

/**
 * Lets ical.js (2.2) keep the 1st of a month that a negative BYSETPOS names.
 * In a MONTHLY rule with BYDAY and BYSETPOS (no BYMONTHDAY), next_month
 * tests each later day of the month against BYSETPOS from the front and from
 * the back, but on moving to a new month tests its 1st against position 1
 * only: FREQ=MONTHLY;BYDAY=SA;BYSETPOS=-5 never yields 1 August 2020, the
 * fifth-last of its five Saturdays. Where next_month rejects a 1st that
 * matches BYDAY, it is kept when it is the n-th last matching day of the
 * month and BYSETPOS names -n. ical.js reads BYSETPOS over the days, which
 * RFC 5545's date-times are only with one time of day: with more, it is left
 * as it is (tsdav-utils#36).
 */
function firstDayByPosition(iterator: ICAL.RecurIterator, rule: ICAL.Recur): void {
  const count = (part: string) => (rule.getComponent(part) as unknown[]).length;
  const positions = (rule.getComponent('BYSETPOS') as (number | string)[]).map(Number).filter((v) => v < 0);
  if (rule.freq !== 'MONTHLY' || count('BYDAY') === 0 || count('BYMONTHDAY') > 0 || positions.length === 0 ||
      count('BYHOUR') > 1 || count('BYMINUTE') > 1 || count('BYSECOND') > 1) {
    return;
  }
  const it = iterator as unknown as IteratorState & { is_day_in_byday?: (t: ICAL.Time) => number };
  const own = it.next_month;
  const inByDay = it.is_day_in_byday;
  if (typeof own !== 'function' || typeof inByDay !== 'function') {
    throw new BoundUnavailable('ical.js no longer steps a MONTHLY rule by next_month and is_day_in_byday');
  }
  it.next_month = function nextMonth(this: typeof it) {
    const valid = own.call(this);
    if (valid || this.last.day !== 1 || !inByDay.call(this, this.last)) {
      return valid;
    }
    const day = this.last.clone();
    let matching = 0;
    for (let d = 1, length = daysInMonth(day.year, day.month); d <= length; d++) {
      day.day = d;
      matching += inByDay.call(this, day) ? 1 : 0;
    }
    // the 1st is the first matching day, so the matching-th from the back
    return positions.includes(-matching) ? 1 : valid;
  };
}

/**
 * Whether ical.js' (2.2) setup of a MONTHLY rule with BYDAY would never
 * return, read step by step from RecurIterator.init (its MONTHLY BYDAY
 * branch), which this follows exactly:
 * - BYDAY is put in order by sort_byday_rules (weekday counted from WKST);
 * - for each entry, from DTSTART's month, the day is nthWeekDay(weekday,
 *   ordinal) (weekdays counted from Sunday there), tested against
 *   `daysInMonth`, a variable set from DTSTART's month once and only updated
 *   by the searches;
 * - where it does not fit, the entry is skipped if an earlier entry already
 *   found a day in DTSTART's month (`tempLast.month == initLast.month`), and
 *   otherwise searched for month by month with increment_month (INTERVAL
 *   months on, or the next BYMONTH entry, whose position carries over from
 *   one entry to the next), without a bound.
 * A search that has not ended after CYCLE_MONTHS steps never ends: what it
 * tests depends only on the month (its length and weekdays repeat every
 * 4,800 months) and on BYMONTH's position, which follows the month.
 * FREQ=MONTHLY;INTERVAL=24;BYDAY=5MO from February 2019 visits only the
 * Februaries of odd years; BYDAY=1MO,5TU from 4 February 2019 never searches
 * (the first Monday is found first, in that month), BYDAY=1SA,5TU from 23
 * February 2025 does (WKST=MO puts TU first).
 */
function byDaySetupEndless(rule: ICAL.Recur, dtstart: ICAL.Time, byMonthIndex: number): boolean {
  const byDay = (rule.getComponent('BYDAY') as (string | number)[]).map(String);
  if (rule.freq !== 'MONTHLY' || byDay.length === 0) {
    return false;
  }
  const dayOfWeek = (value: string, wkst?: number) => {
    const m = value.match(/([+-]?[0-9])?(MO|TU|WE|TH|FR|SA|SU)/);
    return m ? [parseInt(m[1] || '0', 10), ICAL.Recur.icalDayToNumericDay(m[2], wkst as Parameters<typeof ICAL.Recur.icalDayToNumericDay>[1])]
      : [0, 0];
  };
  // sort_byday_rules, as written
  const rules = [...byDay];
  for (let i = 0; i < rules.length; i++) {
    for (let j = 0; j < i; j++) {
      if (dayOfWeek(rules[j], rule.wkst)[1] > dayOfWeek(rules[i], rule.wkst)[1]) {
        [rules[i], rules[j]] = [rules[j], rules[i]];
      }
    }
  }
  const months = (rule.getComponent('BYMONTH') as (number | string)[]).map(Number);
  const interval = Math.max(1, rule.interval || 1);
  const ordinal = (y: number, m: number, d: number) => {
    const t = new Date(0);
    t.setUTCFullYear(y, m - 1, d);
    return t.getTime();
  };
  let index = byMonthIndex;
  let length = daysInMonth(dtstart.year, dtstart.month);
  let found: { year: number; month: number; day: number } | null = null;
  for (const value of rules) {
    const [pos, dow] = dayOfWeek(value);
    if (pos >= 6 || pos <= -6) {
      // ical.js refuses the rule
      return false;
    }
    const at = ICAL.Time.fromData({ year: dtstart.year, month: dtstart.month, day: 1, isDate: true });
    let day = at.nthWeekDay(dow, pos);
    if (day > length || day <= 0) {
      if (found && found.month === dtstart.month) {
        continue;
      }
      for (let steps = 0; day > length || day <= 0; steps++) {
        if (steps >= CYCLE_MONTHS) {
          return true;
        }
        // increment_month
        if (months.length > 0) {
          index++;
          if (index === months.length) {
            index = 0;
            at.year += 1;
          }
          at.month = months[index];
        } else {
          let month = at.month + interval - 1;
          at.year += Math.trunc(month / 12);
          month %= 12;
          at.month = month + 1;
        }
        length = daysInMonth(at.year, at.month);
        day = at.nthWeekDay(dow, pos);
      }
    }
    if (!found || ordinal(at.year, at.month, day) < ordinal(found.year, found.month, found.day)) {
      found = { year: at.year, month: at.month, day };
    }
  }
  return false;
}

/** The days of a month, January = 1, for any year of the proleptic Gregorian calendar */
function daysInMonth(year: number, month: number): number {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return month === 2 ? (leap ? 29 : 28) : FEWEST_DAYS[month - 1];
}

/** Months in a cycle of the Gregorian calendar: month lengths, and weekdays, repeat every 400 years */
const CYCLE_MONTHS = 400 * 12;

/** The last wall clock Date can hold (year 275760) */
const LAST_WALL = 8.64e12;

/**
 * Where ical.js (2.2) must set up a MONTHLY;BYMONTHDAY rule without BYDAY so
 * that it yields the rule's instances (undefined for any other rule):
 * `dtstart` itself where its month is
 * one the rule takes (BYMONTH) and holds a listed day; otherwise day 1 of the
 * first month after it that ical.js' own steps reach and that is such a
 * month, at the earliest time of day an instance has (the smallest listed
 * BYHOUR, BYMINUTE, BYSECOND, else DTSTART's); null where no such month comes
 * in a full cycle of the calendar, so never.
 *
 * ical.js' setup (init) is exact only in such a month. In any other it
 * searches on with next_month, at most three times, which
 * - reads the BYMONTHDAY list as written, not yet normalised to the month:
 *   its second value, if negative and longer than the month (-31 in a June),
 *   gives day 0 or less, which rolls into the month before, so every later
 *   step lands a month early — FREQ=MONTHLY;INTERVAL=5;BYMONTHDAY=31,-31
 *   from 30 June 1992 yields May+5k months (July and December of 2026)
 *   instead of June+5k (March and August), and from a moved start the
 *   phase depends on the month it lands in (#42);
 * - gives up after three months and leaves the rule without any instance,
 *   where with INTERVAL or BYMONTH the next month holding the day is further
 *   (BYMONTHDAY=31;INTERVAL=5 from a June: June, November, April,
 *   September, February are all short);
 * - and a start month BYMONTH leaves out but which holds the day is yielded
 *   as is, untested.
 * Starting in a month the rule takes that holds a listed day takes the
 * setup's exact branch (the days of that month, normalised), with the same
 * state a correct search would reach: the walk then steps by next_month and
 * increment_month, which normalise BYMONTHDAY for every month. ical.js steps
 * by INTERVAL months, or with BYMONTH through its months in order (it
 * ignores INTERVAL there, from DTSTART as from here), so the start stays on
 * the iteration's own grid; no instance lies in the months skipped, as none
 * of them holds a listed day the rule takes.
 */
function monthDaySetupStart(rule: ICAL.Recur, dtstart: ICAL.Time): ICAL.Time | null | undefined {
  const listed = (part: string) => (rule.getComponent(part) as (number | string)[]).map(Number);
  const days = listed('BYMONTHDAY');
  if (rule.freq !== 'MONTHLY' || days.length === 0 || listed('BYDAY').length > 0) {
    return undefined;
  }
  const months = listed('BYMONTH');
  const interval = Math.max(1, rule.interval || 1);
  const holds = (year: number, month: number) => (months.length === 0 || months.includes(month)) &&
    days.some((d) => Number.isInteger(d) && d !== 0 && Math.abs(d) <= daysInMonth(year, month));
  let { year, month } = dtstart;
  if (holds(year, month)) {
    return dtstart;
  }
  for (let steps = 0; steps < CYCLE_MONTHS; steps++) {
    // increment_month: the next listed month (a year on past the last), or INTERVAL months on
    if (months.length > 0) {
      const next = months.find((m) => m > month);
      year += next === undefined ? 1 : 0;
      month = next ?? months[0];
    } else {
      month += interval;
      year += Math.floor((month - 1) / 12);
      month = ((month - 1) % 12) + 1;
    }
    if (holds(year, month)) {
      // the earliest time of day an instance has: ical.js drops what lies
      // before its start, and takes a time part BYHOUR, BYMINUTE or BYSECOND
      // leaves open from it (its setup takes the first listed one otherwise)
      const earliest = (part: string, own: number) => {
        const values = listed(part).filter((v) => Number.isInteger(v));
        return values.length > 0 ? Math.min(...values) : own;
      };
      const start = dtstart.clone();
      start.year = year;
      start.month = month;
      start.day = 1;
      if (!start.isDate) {
        start.hour = earliest('BYHOUR', dtstart.hour);
        start.minute = earliest('BYMINUTE', dtstart.minute);
        start.second = earliest('BYSECOND', dtstart.second);
      }
      return start;
    }
  }
  return null;
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
 * with February); MONTHLY with BYDAY and BYMONTHDAY; MONTHLY or YEARLY with a
 * fifth or fifth-last weekday or a BYSETPOS of 5 or more either way; YEARLY
 * with BYDAY and BYYEARDAY or BYWEEKNO; a DTSTART
 * before the year 100 (ical.js compares those times as 1900 to 1999:
 * Time.toUnixTime goes through Date.UTC).
 */
export function walkedInFull(recur: ICAL.Recur, dtstart: number, dateOnly: boolean): boolean {
  const has = (part: string) => (recur.getComponent(part) as unknown[]).length > 0;
  const fixed = FIXED_PERIOD[recur.freq];
  return Boolean(recur.count) ||
    (dateOnly && ((fixed !== undefined && fixed < 86400) || has('BYHOUR') || has('BYMINUTE') || has('BYSECOND'))) ||
    (recur.freq === 'YEARLY' &&
      !inEveryMonth(recur, dtstart, (recur.getComponent('BYMONTHDAY') as (number | string)[]).map(Number))) ||
    (recur.freq === 'MONTHLY' && has('BYDAY') && has('BYMONTHDAY')) ||
    (recur.freq === 'YEARLY' && has('BYDAY') && (has('BYYEARDAY') || has('BYWEEKNO'))) ||
    ((recur.freq === 'MONTHLY' || recur.freq === 'YEARLY') && (fifthWeekday(recur) || farSetPosition(recur))) ||
    new Date(dtstart * 1000).getUTCFullYear() < 100;
}

/** Whether BYDAY holds a fifth or fifth-last weekday (5SU, -5FR), one a month may lack */
function fifthWeekday(recur: ICAL.Recur): boolean {
  return (recur.getComponent('BYDAY') as string[]).some((d) => /^[+-]?5/.test(String(d)));
}

/** Whether BYSETPOS picks a fifth or later (or fifth-last or earlier) day, which a month may lack too */
function farSetPosition(recur: ICAL.Recur): boolean {
  return (recur.getComponent('BYSETPOS') as (number | string)[]).some((v) => Math.abs(Number(v)) >= 5);
}

/**
 * Where an iteration of `recur` from `dtstart` may start so that it yields
 * every instance from `from` on, both wall clocks of the series (seconds; a
 * date series a day at 00:00): DTSTART moved by whole multiples of INTERVAL
 * periods, so every field the rule leaves open (the day of the month, the
 * weekday, the time of day) and the phase of INTERVAL stay as they were. That
 * is the same rule from a start of the same shape, and ical.js' steps
 * (next_month, next_year, …) evaluate BY parts and BYSETPOS per period, so
 * once a walk is past its setup, every period is expanded as from DTSTART.
 * The setup is not a step: ical.js yields what it finds there untested (no
 * BYSETPOS, no contracting rule) and filters by the start within its period.
 * So the start is moved to at
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
 * whatever the month.
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
 * - MONTHLY with a fifth or fifth-last weekday (5SU, -5FR): where the
 *   start's month lacks it, the setup searches on month by month
 *   (increment_month) until a month has it, advancing BYMONTH's position,
 *   which resetting the instance it searched from does not undo, and yields
 *   what it finds untested — next to the window, from a moved start. Every
 *   month has a first to fourth (and last to fourth-last) of each weekday, so
 *   no other BYDAY makes it search; an ordinal of 6 or more is refused.
 * - YEARLY whose year may hold no instance (a fifth Sunday of February, a
 *   BYSETPOS of 5 or more): the setup searches on by years without bound
 *   (init loops to UNTIL or the year 20000), while a walk ends the rule after
 *   28 years without an instance (next) — and such a gap can be 40 years
 *   long. So the walk from DTSTART may end where one from a moved start
 *   finds the next instance: walked from DTSTART, as are MONTHLY rules of the
 *   same kind (a walk ends those after 336 empty months). Where a walk ends a
 *   rule so, inside the range, the expansion says it is not complete.
 * The other setups stay within the start's period (WEEKLY steps to its first
 * BYDAY within the week; MONTHLY;BYMONTHDAY without BYDAY is set up in the
 * first month on the start's own grid that holds a listed day, see
 * monthDaySetupStart: ical.js' own search there shifted the grid by a month),
 * or end the rule: the caller then walks from DTSTART. Every other way ical.js refuses is decided by the
 * rule or by DTSTART's own setup, which the caller checks at DTSTART. Moving
 * DTSTART never changes which instances are found, only where the walk
 * begins.
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
 * before, none at all when the window holds no such day. The instances are
 * yielded one by one, for the caller to charge as they come.
 */
export function fixedYearlyWalls(recur: ICAL.Recur, dtstart: number, from: number, to: number,
  last: number): Iterable<number> | null {
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
  if (byMonthDay.length > 0 && byMonth.length === 0) {
    // RFC 5545 takes every month; ical.js DTSTART's only: walked, and checked (keepInstances)
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
  const k0 = Math.max(0, Math.ceil((firstYear - 1 - startYear) / interval));
  const at = (year: number, month: number, day: number, h = 0, m = 0, sec = 0) => {
    // setUTCFullYear, not Date.UTC: that reads the years 0 to 99 as 1900 to 1999
    const t = new Date(0);
    t.setUTCFullYear(year, month - 1, day);
    t.setUTCHours(h, m, sec, 0);
    return t.getTime() / 1000;
  };
  // lazy: the caller charges each instance as it is taken and stops when the
  // budget runs out, so a window of any length costs no more than the budget
  return (function* instances() {
    for (let k = k0; ; k++) {
      const year = startYear + k * interval;
      if (at(year, 1, 1) > end) {
        return;
      }
      for (const month of months) {
        for (const day of days) {
          const wall = at(year, month, day, s.getUTCHours(), s.getUTCMinutes(), s.getUTCSeconds());
          if (wall >= from && wall >= dtstart && wall <= end) {
            yield wall;
          }
        }
      }
    }
  })();
}

/**
 * A MONTHLY or YEARLY rule's periods as RFC 5545 (3.3.10) reads them: every
 * INTERVAL months or years from DTSTART's; in each, a set of days by
 * BYMONTH, BYMONTHDAY, BYYEARDAY and BYDAY (an ordinal weekday counts within
 * the month, or for YEARLY without BYMONTH within the year; a YEARLY
 * BYMONTHDAY or BYDAY without BYMONTH takes every month), each day at every
 * time of day BYHOUR, BYMINUTE and BYSECOND give (else DTSTART's), and of
 * those date-times the positions BYSETPOS names.
 */
interface PeriodModel {
  monthly: boolean;
  /** Months from one period to the next */
  step: number;
  /** Month index (year · 12 + month − 1) of DTSTART's period; a YEARLY period's is its January */
  origin: number;
  /** The days of the set of the period holding month m of year y, in order: days of the month (MONTHLY) or of the year (YEARLY) */
  days(year: number, month: number): number[];
  /** The times of day of each day, in order, in seconds of the day */
  times: number[];
  bySetPos: number[];
}

/** The PeriodModel of a rule from `dtstart` (a wall clock); null where RFC 5545 leaves the set open or it is not modelled here */
function periodModel(recur: ICAL.Recur, dtstart: number, dateOnly: boolean): PeriodModel | null {
  const listed = (part: string) => (recur.getComponent(part) as (number | string)[]).map(String);
  const numbers = (part: string) => [...new Set(listed(part).map(Number))];
  const monthly = recur.freq === 'MONTHLY';
  if ((!monthly && recur.freq !== 'YEARLY') || listed('BYWEEKNO').length > 0) {
    return null;
  }
  const byDay: { n: number; w: number }[] = [];
  for (const value of listed('BYDAY')) {
    const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(value);
    if (!m) {
      return null;
    }
    byDay.push({ n: m[1] ? Number(m[1]) : 0, w: ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'].indexOf(m[2]) });
  }
  const byMonth = numbers('BYMONTH');
  const byMonthDay = numbers('BYMONTHDAY');
  const byYearDay = numbers('BYYEARDAY');
  const ordinal = byDay.some((d) => d.n !== 0);
  // RFC 5545 does not say what an ordinal weekday counts in once BYMONTHDAY
  // or BYYEARDAY limit it; ical.js refuses BYYEARDAY with BYMONTH or BYMONTHDAY
  if (ordinal && (byMonthDay.length > 0 || byYearDay.length > 0) ||
      byYearDay.length > 0 && (monthly || byMonth.length > 0 || byMonthDay.length > 0)) {
    return null;
  }
  const s = new Date(dtstart * 1000);
  const startDay = s.getUTCDate();
  const own = (part: string, value: number) => (numbers(part).length > 0 ? numbers(part) : [value]);
  const times: number[] = [];
  if (dateOnly) {
    times.push(0);
  } else {
    for (const h of own('BYHOUR', s.getUTCHours())) {
      for (const m of own('BYMINUTE', s.getUTCMinutes())) {
        for (const sec of own('BYSECOND', s.getUTCSeconds())) {
          times.push(h * 3600 + m * 60 + sec);
        }
      }
    }
  }
  times.sort((a, b) => a - b);
  const leap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const weekdayOf = (y: number, m: number, d: number) => {
    const t = new Date(0);
    t.setUTCFullYear(y, m - 1, d);
    return t.getUTCDay();
  };
  /** Whether a day matches BYDAY, an ordinal counted within `count` days of which it is the `index`th (1-based) */
  const weekdayMatches = (w: number, index: number, count: number) => byDay.some((d) => d.w === w &&
    (d.n === 0 || (d.n > 0 ? Math.floor((index - 1) / 7) + 1 === d.n : Math.floor((count - index) / 7) + 1 === -d.n)));
  /** The days of month m of year y the rule takes, as days of the month */
  const daysOfMonth = (y: number, m: number, yearScope: { offset: number; length: number } | null) => {
    const length = daysInMonth(y, m);
    const listedDays = byMonthDay.length > 0
      ? new Set(byMonthDay.filter((v) => v !== 0 && Math.abs(v) <= length).map((v) => (v > 0 ? v : length + v + 1)))
      : null;
    const first = weekdayOf(y, m, 1);
    const out: number[] = [];
    for (let d = 1; d <= length; d++) {
      if (listedDays ? !listedDays.has(d) : byDay.length === 0 && d !== startDay) {
        continue;
      }
      const index = yearScope ? yearScope.offset + d : d;
      if (byDay.length === 0 || weekdayMatches((first + d - 1) % 7, index, yearScope ? yearScope.length : length)) {
        out.push(d);
      }
    }
    return out;
  };
  const days = (y: number, m: number): number[] => {
    if (monthly) {
      return byMonth.length > 0 && !byMonth.includes(m) ? [] : daysOfMonth(y, m, null);
    }
    const yearLength = leap(y) ? 366 : 365;
    if (byYearDay.length > 0) {
      const first = weekdayOf(y, 1, 1);
      return [...new Set(byYearDay.filter((v) => v !== 0 && Math.abs(v) <= yearLength)
        .map((v) => (v > 0 ? v : yearLength + v + 1)))]
        .filter((doy) => byDay.length === 0 || weekdayMatches((first + doy - 1) % 7, doy, yearLength))
        .sort((a, b) => a - b);
    }
    // BYMONTH, else every month where BYMONTHDAY or BYDAY expand the year, else DTSTART's month
    const months = byMonth.length > 0 ? byMonth.filter((v) => v >= 1 && v <= 12).sort((a, b) => a - b)
      : byMonthDay.length > 0 || byDay.length > 0 ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] : [s.getUTCMonth() + 1];
    const out: number[] = [];
    for (const month of months) {
      let offset = 0;
      for (let k = 1; k < month; k++) {
        offset += daysInMonth(y, k);
      }
      // an ordinal weekday counts within the month with BYMONTH, within the year without
      for (const d of daysOfMonth(y, month, byMonth.length > 0 ? null : { offset, length: yearLength })) {
        out.push(offset + d);
      }
    }
    return out;
  };
  const interval = Math.max(1, recur.interval || 1);
  return {
    monthly,
    step: monthly ? interval : 12 * interval,
    origin: s.getUTCFullYear() * 12 + (monthly ? s.getUTCMonth() : 0),
    days,
    times,
    bySetPos: numbers('BYSETPOS').filter((v) => v !== 0),
  };
}

/** The greatest common divisor */
const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/**
 * How many consecutive periods of a rule cover every shape its periods take:
 * CYCLE_MONTHS / gcd(step, CYCLE_MONTHS). A period's set depends only on the
 * rule and on the month lengths and weekdays of its months. 400 Gregorian
 * years (4,800 months) are 146,097 days, 20,871 weeks exactly, so those
 * repeat every 4,800 months. The period k periods on lies k · step months
 * on, so periods k and k + K have the same shape for every k when K · step
 * is a multiple of 4,800; the least such K is 4,800 / gcd(step, 4,800).
 * Any K consecutive periods hold a period of every shape the rule ever has,
 * so a rule without an instance in them has none at all. One cycle of 4,800
 * months is not enough: YEARLY;INTERVAL=7 steps 84 months, and its periods
 * come round after 400 of them, 33,600 months.
 */
function cyclePeriods(step: number): number {
  return CYCLE_MONTHS / gcd(step, CYCLE_MONTHS);
}

/**
 * Whether a MONTHLY or YEARLY rule, read by RFC 5545 (periodModel), has an
 * instance in one of its periods after the one holding `after` — from the one
 * holding `begin` where `after` is null — up to the one holding `end`, all
 * wall clocks of the series; null where it cannot be told here (another
 * FREQ, BYWEEKNO, an ordinal BYDAY under BYMONTHDAY or BYYEARDAY). A period
 * holds an instance when its set of date-times is not empty and, with
 * BYSETPOS, has a position BYSETPOS names. `charge` is called with the units
 * each period costs to count (one a month).
 *
 * This tells a rule ical.js gives up on (RecurIterator.next ends a MONTHLY
 * rule after 336 months without an instance, a YEARLY one after 28 years)
 * from one that has no instance left to give: no instance in cyclePeriods
 * consecutive periods means none at all (FREQ=MONTHLY;BYDAY=5MO;BYSETPOS=5:
 * a set of at most one day has no fifth). It counts days, without ical.js.
 */
export function holdsInstance(recur: ICAL.Recur, dtstart: number, begin: number, after: number | null,
  end: number, dateOnly: boolean, charge: (units: number) => void = () => undefined): boolean | null {
  const model = periodModel(recur, dtstart, dateOnly);
  if (!model) {
    return null;
  }
  const unit = model.monthly ? 1 : 12;
  const index = (wall: number) => {
    const d = new Date(wall * 1000);
    return d.getUTCFullYear() * 12 + (model.monthly ? d.getUTCMonth() : 0);
  };
  const lowest = after === null ? index(begin) : index(after) + unit;
  const highest = index(end);
  const periods = cyclePeriods(model.step);
  for (let k = Math.max(0, Math.ceil((lowest - model.origin) / model.step)), n = 0;
    model.origin + k * model.step <= highest && n < periods; k++, n++) {
    const at = model.origin + k * model.step;
    // a month's days take about a microsecond to count (a unit of WORK_BUDGET; measured: 4,800 months 1.3-4.6 ms)
    charge(model.monthly ? 1 : 12);
    // the same year of the 400-year cycle near 2000: Date covers it, whatever the INTERVAL
    const year = 2000 + (((Math.floor(at / 12) - 2000) % 400) + 400) % 400;
    const size = model.days(year, (at % 12) + 1).length * model.times.length;
    if (model.bySetPos.length > 0 ? model.bySetPos.some((v) => Math.abs(v) <= size) : size > 0) {
      return true;
    }
  }
  return false;
}

/** A wall clock in seconds, for any year (Date.UTC reads 0 to 99 as 1900 to 1999) */
function wallAt(year: number, month: number, day: number, seconds = 0): number {
  const t = new Date(0);
  t.setUTCFullYear(year, month - 1, day);
  return t.getTime() / 1000 + seconds;
}

/** The wall clock of an ical.js time; a date at 00:00 */
function wallOfTime(time: ICAL.Time): number {
  return wallAt(time.year, time.month, time.day, time.isDate ? 0 : time.hour * 3600 + time.minute * 60 + time.second);
}

/** What keepInstances leaves on an iterator: the first instance in [lower, end] (wall clocks) ical.js passed without yielding it, or null */
export type MissedCheck = (lower: number, end: number) => number | null;

/**
 * Checks a MONTHLY or YEARLY iteration against RFC 5545 (periodModel), where
 * the rule has one, both ways:
 * - every candidate ical.js (2.2) yields that is no instance is dropped. Its
 *   setup yields the day it finds untested (MONTHLY;INTERVAL=7;BYDAY=5MO;
 *   BYSETPOS=2 from 8 May 1993 gives 31 May 1993); with BYMONTH a MONTHLY
 *   rule steps every listed month whatever INTERVAL says; BYSETPOS goes
 *   unread under a MONTHLY BYMONTHDAY and a YEARLY fifth weekday; a YEARLY
 *   BYMONTHDAY a month lacks becomes a day of the next month
 *   (BYMONTH=2;BYMONTHDAY=30 gives 2 March). COUNT counts the kept
 *   instances (the iterator's `countReached` says it ended so);
 * - every period the iteration passes is compared with the rule's instances
 *   in it from `start` on: one ical.js never yielded (a YEARLY BYMONTHDAY
 *   without BYMONTH it reads in DTSTART's month only, a MONTHLY BYDAY with
 *   BYMONTHDAY it steps month by month whatever INTERVAL says) is recorded,
 *   and the MissedCheck left on the iterator (`missed`) gives the first in
 *   the range the caller walked: the result is then not complete, and with
 *   COUNT, whose count it shifts, nothing after it is one of the rule's.
 * So what passes is exactly RFC 5545's instances, or the caller learns it is
 * not. Where no instance comes in a whole cycle of periods (cyclePeriods),
 * none comes at all: the iteration ends there rather than dropping ical.js'
 * candidates without end.
 */
function keepInstances(iterator: ICAL.RecurIterator, rule: ICAL.Recur, start: ICAL.Time): void {
  if (rule.freq !== 'MONTHLY' && rule.freq !== 'YEARLY') {
    return;
  }
  const startWall = wallOfTime(start);
  const model = periodModel(rule, startWall, start.isDate);
  if (!model) {
    return;
  }
  const it = iterator as unknown as { next: (again?: boolean) => ICAL.Time | null; rule: ICAL.Recur;
    completed: boolean; missed?: MissedCheck; countReached?: boolean };
  const own = it.next;
  if (typeof own !== 'function') {
    throw new BoundUnavailable('ical.js no longer iterates by next');
  }
  // COUNT counts the instances kept here: ical.js' own count (which counts
  // what it yields, and twice where it retries a candidate inside next) is
  // switched off on its copy of the rule (chronologicalRecur)
  const count = it.rule.count || 0;
  it.rule.count = null as unknown as number;
  let counted = 0;
  const periodOf = (year: number, month: number) => year * 12 + (model.monthly ? month - 1 : 0);
  /** The instances of the period at month index `at`, as wall clocks in order; none off the grid */
  let cachedAt = Number.NaN;
  let cached = new Set<number>();
  let cachedList: number[] = [];
  const instancesOf = (at: number): number[] => {
    if (at === cachedAt) {
      return cachedList;
    }
    const list: number[] = [];
    if (at >= model.origin && (at - model.origin) % model.step === 0) {
      const year = Math.floor(at / 12);
      const days = model.days(year, (at % 12) + 1);
      const all: number[] = [];
      for (const day of days) {
        const base = model.monthly ? wallAt(year, (at % 12) + 1, day) : wallAt(year, 1, day);
        for (const time of model.times) {
          all.push(base + time);
        }
      }
      if (model.bySetPos.length === 0) {
        list.push(...all);
      } else {
        all.forEach((wall, i) => {
          if (model.bySetPos.some((v) => (v > 0 ? v - 1 === i : all.length + v === i))) {
            list.push(wall);
          }
        });
      }
    }
    cachedAt = at;
    cachedList = list;
    cached = new Set(list);
    return list;
  };
  // the first period of the grid at or after the one holding `start`
  const first = periodOf(start.year, start.month);
  let pointer = model.origin + Math.max(0, Math.ceil((first - model.origin) / model.step)) * model.step;
  let yielded = new Set<number>();
  /** Instances ical.js passed without yielding them, as wall clocks */
  const missed: number[] = [];
  /** Compares every grid period before `at` not yet compared, and moves on to `at` */
  const passTo = (at: number) => {
    for (; pointer < at; pointer += model.step) {
      for (const wall of instancesOf(pointer)) {
        if (wall >= startWall && !yielded.has(wall)) {
          missed.push(wall);
        }
      }
      yielded = new Set();
    }
  };
  it.missed = (lower: number, end: number) => {
    const d = new Date(end * 1000);
    const at = periodOf(d.getUTCFullYear(), d.getUTCMonth() + 1);
    // a range past a whole cycle without a check: the periods repeat, so one cycle tells
    passTo(Math.min(at, pointer + cyclePeriods(model.step) * model.step));
    const open = pointer === at ? instancesOf(at).filter((wall) => wall >= startWall && !yielded.has(wall)) : [];
    const inRange = [...missed, ...open].filter((wall) => wall >= lower && wall <= end);
    return inRange.length > 0 ? Math.min(...inRange) : null;
  };
  const span = cyclePeriods(model.step) * model.step;
  let kept = model.origin;
  let lastAt = -Infinity;
  it.next = function next(this: typeof it, again?: boolean) {
    if (again) {
      // ical.js' own retry inside next(): not a candidate of ours
      return own.call(this, again);
    }
    if (count && counted >= count) {
      this.completed = true;
      this.countReached = true;
      return null;
    }
    for (;;) {
      const time = own.call(this);
      if (!time) {
        return time;
      }
      const at = periodOf(time.year, time.month);
      if (at < lastAt) {
        // a candidate of a period already passed: ical.js went back
        missed.push(wallOfTime(time));
      } else {
        passTo(at);
        lastAt = at;
      }
      const wall = wallOfTime(time);
      instancesOf(at);
      if (cached.has(wall)) {
        yielded.add(wall);
        kept = at;
        counted++;
        return time;
      }
      if (at - kept > span) {
        this.completed = true;
        return null;
      }
    }
  };
}
