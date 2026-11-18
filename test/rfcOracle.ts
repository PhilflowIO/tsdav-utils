/**
 * RFC 5545 (3.3.10) for date-only MONTHLY and YEARLY rules, by brute force
 * and without ical.js: every INTERVAL-th period from DTSTART's, its set of
 * days by BYMONTH, BYMONTHDAY and BYDAY (an ordinal counts within the month,
 * or within the year for YEARLY without BYMONTH), then BYSETPOS over that set.
 * A YEARLY BYMONTHDAY or BYDAY without BYMONTH takes every month. Returns the
 * instance dates (YYYY-MM-DD) from `lower` (default DTSTART) to `last`, in
 * order; DTSTART itself is not added.
 */
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const daysIn = (y: number, m: number) =>
  [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
const weekday = (y: number, m: number, d: number) => {
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  return t.getUTCDay();
};
const p2 = (n: number) => String(n).padStart(2, '0');
const dateKey = ([y, m, d]: Day) => `${String(y).padStart(4, '0')}-${p2(m)}-${p2(d)}`;
type Day = [number, number, number];

export function rfcDates(rule: string, dtstart: string, last: string, lower = dtstart): string[] {
  const parts: Record<string, string> = Object.fromEntries(rule.split(';').map((kv) => kv.split('=')));
  const list = (k: string) => (parts[k] ? parts[k].split(',') : []);
  const interval = Number(parts.INTERVAL ?? 1);
  const byMonth = list('BYMONTH').map(Number);
  const byMonthDay = list('BYMONTHDAY').map(Number);
  const bySetPos = list('BYSETPOS').map(Number);
  const byDay = list('BYDAY').map((s) => {
    const m = /^([+-]?\d+)?(\w\w)$/.exec(s)!;
    return { n: m[1] ? Number(m[1]) : 0, w: WEEKDAYS.indexOf(m[2]) };
  });
  const until = parts.UNTIL ? `${parts.UNTIL.slice(0, 4)}-${parts.UNTIL.slice(4, 6)}-${parts.UNTIL.slice(6, 8)}` : '9999-12-31';
  const end = last < until ? last : until;
  const [sy, sm, sd] = dtstart.split('-').map(Number);
  const month = (y: number, m: number): Day[] => Array.from({ length: daysIn(y, m) }, (_, i) => [y, m, i + 1]);
  /** whether `day` is the n-th (from the back for n < 0) of its weekday among `scope` */
  const nth = (scope: Day[], day: Day, n: number) => {
    const same = scope.filter((d) => weekday(...d) === weekday(...day));
    const i = same.findIndex((d) => dateKey(d) === dateKey(day));
    return n > 0 ? i + 1 === n : same.length - i === -n;
  };
  const monthSet = (y: number, m: number): Day[] => {
    const all = month(y, m);
    if (byMonthDay.length) {
      const days = new Set(byMonthDay.filter((v) => v !== 0 && Math.abs(v) <= daysIn(y, m))
        .map((v) => (v > 0 ? v : daysIn(y, m) + v + 1)));
      return all.filter(([, , d]) => days.has(d));
    }
    if (byDay.length) return all;
    return sd <= daysIn(y, m) ? [[y, m, sd]] : [];
  };
  const byWeekday = (set: Day[], scopeOf: (d: Day) => Day[]) => byDay.length === 0 ? set
    : set.filter((d) => byDay.some(({ n, w }) => weekday(...d) === w && (n === 0 || nth(scopeOf(d), d, n))));
  const period = (y: number, m: number): Day[] => {
    let set: Day[];
    if (parts.FREQ === 'MONTHLY') {
      set = byMonth.length && !byMonth.includes(m) ? [] : byWeekday(monthSet(y, m), ([a, b]) => month(a, b));
    } else {
      const months = byMonth.length ? [...byMonth].sort((a, b) => a - b)
        : byMonthDay.length || byDay.length ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] : [sm];
      const year = ([] as Day[]).concat(...Array.from({ length: 12 }, (_, i) => month(y, i + 1)));
      set = byWeekday(([] as Day[]).concat(...months.map((mm) => monthSet(y, mm))),
        ([a, b]) => (byMonth.length ? month(a, b) : year));
    }
    if (bySetPos.length) {
      const n = set.length;
      set = set.filter((_, i) => bySetPos.some((v) => (v > 0 ? v - 1 === i : n + v === i)));
    }
    return set;
  };
  const out: string[] = [];
  const step = parts.FREQ === 'MONTHLY' ? interval : 12 * interval;
  for (let k = 0; ; k++) {
    const index = sy * 12 + (sm - 1) + k * step;
    const y = Math.floor(index / 12);
    const m = (index % 12) + 1;
    if (dateKey([y, parts.FREQ === 'MONTHLY' ? m : 1, 1]) > end) break;
    for (const day of period(y, m)) {
      const key = dateKey(day);
      if (key >= lower && key <= end) out.push(key);
    }
  }
  return out;
}
