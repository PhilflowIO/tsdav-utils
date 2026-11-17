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
  return new ICAL.RecurIterator({ rule, dtstart, by_indices: byIndices } as ConstructorParameters<typeof ICAL.RecurIterator>[0]);
}
