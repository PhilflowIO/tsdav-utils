import { describe, it, expect } from 'vitest';
import ICAL from 'ical.js';
import { updateFields } from '../src/updateFields';
import { expansionWork } from '../src/series';

// Property check of the whole-series move across DST changes: Berlin series
// with overrides rescheduled up to days away from their occurrence (so an
// override and its RECURRENCE-ID often sit on different sides of a DST
// change), written in the series' zone or in UTC, moved by up to three weeks.
// After the move every occurrence, overrides included, must be the one before
// moved by the same Berlin wall-clock distance.

const BERLIN = [
  'BEGIN:VTIMEZONE', 'TZID:Europe/Berlin',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST',
  'DTSTART:19700329T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET',
  'DTSTART:19701025T030000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
  'END:VTIMEZONE',
];
const berlin = new ICAL.Timezone(new ICAL.Component(ICAL.parse(
  ['BEGIN:VCALENDAR', ...BERLIN, 'END:VCALENDAR'].join('\r\n'))).getFirstSubcomponent('vtimezone')!);

const p2 = (n: number) => String(n).padStart(2, '0');
/** naive seconds of a Berlin wall clock, and back */
const wallOf = (t: ICAL.Time) => Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second) / 1000;
const basic = (wall: number) => {
  const d = new Date(wall * 1000);
  return `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}T` +
    `${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}00`;
};
// The oracle reads Berlin time with Intl, not ical.js: ical.js' convertToZone
// is wrong around DST changes (ical.js#847), which is the kind of defect this
// test is there to catch.
const intl = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Berlin', hourCycle: 'h23',
  year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
});
/** the Berlin wall clock of a UTC instant */
const berlinWall = (utc: number) => {
  const p = Object.fromEntries(intl.formatToParts(new Date(utc * 1000)).map((x) => [x.type, x.value]));
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day),
    Number(p.hour), Number(p.minute), Number(p.second)) / 1000;
};
/** the UTC instant of a Berlin wall clock (the generator keeps clear of the changes) */
const berlinUtc = (wall: number) => [wall - 2 * 3600, wall - 3600].find((utc) => berlinWall(utc) === wall)!;
/** a Berlin wall clock as a property line, in the zone or in UTC */
const line = (name: string, wall: number, utc: boolean) => utc
  ? `${name}:${basic(berlinUtc(wall))}Z`
  : `${name};TZID=Europe/Berlin:${basic(wall)}`;

/** every occurrence as "Berlin wall clock + summary", overrides applied */
const expandBerlin = (ical: string): string[] => {
  const all = new ICAL.Component(ICAL.parse(ical)).getAllSubcomponents('vevent');
  const event = new ICAL.Event(all.find((c) => !c.hasProperty('recurrence-id'))!);
  for (const ex of all.filter((c) => c.hasProperty('recurrence-id'))) {
    event.relateException(new ICAL.Event(ex));
  }
  const it = event.iterator();
  const out: string[] = [];
  let next: ICAL.Time | null;
  while ((next = it.next()) && out.length < 50) {
    const details = event.getOccurrenceDetails(next);
    const start = details.startDate;
    // a UTC start by its instant; a Berlin one is already the wall clock
    const wall = start.zone === ICAL.Timezone.utcTimezone ? berlinWall(start.toUnixTime()) : wallOf(start);
    out.push(`${wall} ${details.item.summary}`);
  }
  return out.sort();
};

describe('a moved series keeps every occurrence on the wall clock, across DST changes', () => {
  ICAL.TimezoneService.register(berlin.component);
  let seed = 16;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
  const H = 3600;
  const D = 24 * H;

  it('holds for 300 seeded series around both 2026 changes', () => {
    for (let i = 0; i < 300; i++) {
      // a start a few weeks before a DST change, at a time no gap can hit
      const change = rnd() < 0.5 ? Date.UTC(2026, 2, 29) / 1000 : Date.UTC(2026, 9, 25) / 1000;
      const start = change - int(1, 5) * 7 * D + int(-3, 3) * D + int(6, 20) * H;
      const freq = rnd() < 0.5 ? 'DAILY' : 'WEEKLY';
      const step = freq === 'DAILY' ? D : 7 * D;
      const count = int(4, 12);
      const overrides = [...new Set(Array.from({ length: int(1, 3) }, () => int(1, count - 1)))].map((k, n) => {
        const rid = start + k * step;
        // rescheduled up to four days away, between 06:00 and 21:00
        const at = Math.floor((rid + int(-4, 4) * D) / D) * D + int(6, 21) * H;
        return ['BEGIN:VEVENT', `UID:p${i}`, 'DTSTAMP:20260101T000000Z', line('RECURRENCE-ID', rid, rnd() < 0.3),
          line('DTSTART', at, rnd() < 0.5), `SUMMARY:o${n}`, 'END:VEVENT'];
      });
      const ical = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//EN', ...(rnd() < 0.5 ? BERLIN : []),
        'BEGIN:VEVENT', `UID:p${i}`, 'DTSTAMP:20260101T000000Z', 'SUMMARY:M', line('DTSTART', start, false),
        `RRULE:FREQ=${freq};COUNT=${count}`, 'END:VEVENT', ...overrides.flat(), 'END:VCALENDAR', ''].join('\r\n');

      const distance = int(-21, 21) * D + int(-5, 5) * H;
      const moved = start + distance;
      if (new Date(moved * 1000).getUTCHours() < 4) {
        continue; // keep the new start out of the 02:00-03:00 gap
      }
      const iso = basic(moved).replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/, '$1-$2-$3T$4:$5:$6');
      const out = updateFields(ical, { DTSTART: iso });
      const expected = expandBerlin(ical).map((o) => {
        const [wall, summary] = o.split(' ');
        return `${Number(wall) + distance} ${summary}`;
      }).sort();
      expect(expandBerlin(out), `case ${i}:\n${ical}`).toEqual(expected);
    }
  });
});

describe('a move is accepted only where the rule provably moves with it', () => {
  // The oracle: ical.js' own expansion of the series before and after, far
  // beyond anything updateFields expands (30 years, 3000 occurrences), on a
  // floating wall clock. Every accepted move must give exactly the occurrences
  // before, each moved by the same distance.
  let seed = 22;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
  const pick = <T,>(list: T[]): T => list[Math.floor(rnd() * list.length)];
  const some = <T,>(list: T[], n: number) => [...new Set(Array.from({ length: n }, () => pick(list)))];
  const D = 86400;
  const DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
  const YEARS_30 = 30 * 366 * D;
  const LIMIT = 3000;

  const p2 = (n: number) => String(n).padStart(2, '0');
  const fmt = (wall: number, date: boolean) => {
    const d = new Date(wall * 1000);
    const ymd = `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}`;
    return date ? ymd : `${ymd}T${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}`;
  };
  const input = (wall: number, date: boolean) => {
    const iso = new Date(wall * 1000).toISOString();
    return date ? iso.slice(0, 10) : iso.slice(0, 19);
  };
  const wallOfTime = (t: ICAL.Time) => Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second) / 1000;

  /** the occurrences of DTSTART + RRULE by ical.js, up to `until` or LIMIT; complete when the rule ended first */
  const oracle = (dtstart: ICAL.Time, rule: ICAL.Recur, until: number) => {
    const it = rule.iterator(dtstart);
    const walls: number[] = [];
    let next: ICAL.Time | null;
    while ((next = it.next())) {
      const w = wallOfTime(next);
      if (w > until || walls.length >= LIMIT) {
        return { walls, complete: false, last: walls.at(-1)! };
      }
      walls.push(w);
    }
    return { walls, complete: true, last: Infinity };
  };
  const seriesOf = (ical: string) => {
    const vevent = new ICAL.Component(ICAL.parse(ical)).getFirstSubcomponent('vevent')!;
    return { dtstart: vevent.getFirstPropertyValue('dtstart') as ICAL.Time, rule: vevent.getFirstPropertyValue('rrule') as ICAL.Recur };
  };
  const event = (dtstart: number, date: boolean, rule: string) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//EN',
    'BEGIN:VEVENT', 'UID:s', 'DTSTAMP:20260101T000000Z', 'SUMMARY:M',
    date ? `DTSTART;VALUE=DATE:${fmt(dtstart, true)}` : `DTSTART:${fmt(dtstart, false)}`,
    `RRULE:${rule}`, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');

  /**
   * Move a series and compare with the oracle. Returns 'refused' or
   * 'accepted'; an accepted move whose occurrences differ fails the test.
   */
  const check = (start: number, date: boolean, rule: string, to: number, toDate: boolean, label: string) => {
    const before = event(start, date, rule);
    let after: string;
    try {
      after = updateFields(before, { DTSTART: input(to, toDate) });
    } catch (error) {
      expect((error as Error).message, label).toMatch(/does not move the whole series/);
      return 'refused';
    }
    const dayOf = (w: number) => Math.floor(w / D) * D;
    const days = (dayOf(to) - dayOf(start)) / D;
    const move = (w: number) => toDate ? dayOf(w) + days * D
      : date ? w + days * D + (to - dayOf(to))
      : w + (to - start);
    const old = seriesOf(before);
    const moved = seriesOf(after);
    const a = oracle(old.dtstart, old.rule, start + YEARS_30);
    const b = oracle(moved.dtstart, moved.rule, to + YEARS_30);
    const want = [...new Set(a.walls.map(move))];
    const horizon = Math.min(a.complete ? Infinity : move(a.last), b.complete ? Infinity : b.last);
    expect(b.walls.filter((w) => w <= horizon).map((w) => fmt(w, toDate)), `${label}\n${before}\n${after}`)
      .toEqual(want.filter((w) => w <= horizon).map((w) => fmt(w, toDate)));
    return 'accepted';
  };

  const randomRule = (date: boolean) => {
    const freq = date ? pick(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'])
      : pick(['MINUTELY', 'HOURLY', 'DAILY', 'DAILY', 'WEEKLY', 'WEEKLY', 'MONTHLY', 'YEARLY']);
    const parts = [`FREQ=${freq}`];
    if (rnd() < 0.3) parts.push(`INTERVAL=${int(2, 3)}`);
    if (rnd() < 0.35) parts.push(`BYDAY=${(['MONTHLY', 'YEARLY'].includes(freq) && rnd() < 0.5
      ? [`${pick(['1', '2', '-1'])}${pick(DAYS)}`] : some(DAYS, int(1, 3))).join(',')}`);
    if (rnd() < 0.2) parts.push(`BYMONTH=${some(['1', '3', '6', '10', '12'], int(1, 3)).join(',')}`);
    if (freq !== 'WEEKLY' && rnd() < 0.2) parts.push(`BYMONTHDAY=${some(['1', '5', '15', '28', '31', '-1'], int(1, 2)).join(',')}`);
    if (!date && rnd() < 0.2) parts.push(`BYHOUR=${some(['6', '9', '13', '17'], int(1, 2)).join(',')}`);
    if (!date && freq === 'MINUTELY' && rnd() < 0.3) parts.push(`BYMINUTE=${some(['0', '15', '30'], int(1, 2)).join(',')}`);
    if (freq === 'MONTHLY' && parts.some((x) => x.startsWith('BYDAY')) && rnd() < 0.3) parts.push('BYSETPOS=-1');
    const end = pick(['count', 'until', 'none']);
    if (end === 'count') parts.push(`COUNT=${int(3, 60)}`);
    return { freq, rule: parts.join(';'), end };
  };

  it('every accepted random move keeps the occurrences, each moved (2000 series)', () => {
    let accepted = 0;
    for (let i = 0; i < 2000; i++) {
      const date = rnd() < 0.2;
      const start = Date.UTC(2026, int(0, 11), int(1, 28)) / 1000 + (date ? 0 : int(0, 23) * 3600 + pick([0, 15, 30, 45]) * 60);
      let { freq, rule, end } = randomRule(date);
      if (end === 'until') {
        const span = { MINUTELY: 3600, HOURLY: 3 * D, DAILY: 60 * D, WEEKLY: 300 * D, MONTHLY: 900 * D, YEARLY: 4000 * D }[freq]!;
        rule += `;UNTIL=${fmt(start + span, date)}`;
      }
      const kind = pick(['time', 'date', 'week', 'both', 'switch']);
      const days = kind === 'week' ? 7 * int(-3, 3) : int(-40, 40);
      const minutes = pick([15, 30, 60, 90, 300, -60, -120]);
      let to = start;
      let toDate = date;
      if (kind === 'switch' && freq !== 'MINUTELY' && freq !== 'HOURLY') {
        toDate = !date;
        to = Math.floor(start / D) * D + days * D + (toDate ? 0 : int(6, 20) * 3600);
      } else if (date) {
        to = start + days * D;
      } else {
        to = start + (kind === 'time' ? minutes * 60 : kind === 'both' ? days * D + minutes * 60 : days * D);
      }
      if (to === start && toDate === date) {
        continue;
      }
      if (check(start, date, rule, to, toDate, `case ${i}: ${rule} by ${kind}`) === 'accepted') {
        accepted++;
      }
    }
    console.log(`random rules and moves: ${accepted} of 2000 accepted, each checked against ical.js`);
    expect(accepted).toBeGreaterThan(500);
  });

  it('realistic rules are accepted: weekly by weekday at a new time, daily, monthly by a date up to the 28th', () => {
    const cases: [number, boolean, string, number, boolean][] = [];
    for (let i = 0; i < 300; i++) {
      const start = Date.UTC(2026, int(0, 11), int(1, 20)) / 1000 + int(6, 20) * 3600;
      const end = pick(['', `;COUNT=${int(5, 50)}`, `;UNTIL=${fmt(start + int(30, 900) * D, false)}`]);
      const weekday = DAYS[(new Date(start * 1000).getUTCDay() + 6) % 7];
      cases.push([start, false, `FREQ=WEEKLY;BYDAY=${weekday}${end}`, start + pick([30, 60, -60, 120]) * 60, false]);
      cases.push([start, false, `FREQ=WEEKLY;BYDAY=${weekday},${pick(DAYS)}${end}`, start + 7 * int(-4, 4) * D, false]);
      cases.push([start, false, `FREQ=DAILY${end}`, start + int(-30, 30) * D + pick([0, 3600, -1800]), false]);
      cases.push([start, false, `FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR${end}`, start + pick([3600, -3600, 7 * D]), false]);
      const day = new Date(start * 1000).getUTCDate();
      cases.push([start, false, `FREQ=MONTHLY${end}`, start + int(1 - day, 28 - day) * D + pick([0, 3600]), false]);
    }
    const refused = cases.filter(([s, d, r, t, td], i) => check(s, d, r, t, td, `realistic ${i}: ${r}`) === 'refused');
    console.log(`realistic rules and moves: ${refused.length} of ${cases.length} refused`);
    expect(refused.map(([, , r]) => r)).toEqual([]);
  });

  it.each([
    ['DAILY;BYMONTH=1..11 a day later', 'FREQ=DAILY;BYMONTH=1,2,3,4,5,6,7,8,9,10,11', D],
    ['HOURLY;BYMONTH=1 an hour later', 'FREQ=HOURLY;BYMONTH=1', 3600],
    ['WEEKLY;BYMONTH=1..6,9..12 a day later', 'FREQ=WEEKLY;BYMONTH=1,2,3,4,5,6,9,10,11,12', D],
  ])('refuses %s, which diverges only after hundreds of occurrences', (_, rule, distance) => {
    const start = Date.UTC(2026, 0, 5, 9) / 1000;
    expect(check(start, false, rule, start + distance, false, rule)).toBe('refused');
  });

  it('accepts WEEKLY;INTERVAL=2;BYDAY moved by a week, which shifts the active weeks with it', () => {
    const start = Date.UTC(2026, 0, 5, 9) / 1000;
    expect(check(start, false, 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;WKST=SU', start + 7 * D, false, 'biweekly')).toBe('accepted');
  });

  it('refuses a monthly move across a month end, which meets months of different lengths', () => {
    const start = Date.UTC(2026, 0, 25, 9) / 1000;
    expect(check(start, false, 'FREQ=MONTHLY', start + 9 * D, false, 'monthly 25th -> 3rd')).toBe('refused');
  });
});

describe('the orphan check is bounded', () => {
  const calendar = (...lines: string[]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//EN', ...lines,
    'END:VCALENDAR', ''].join('\r\n');
  const vevent = (...lines: string[]) => ['BEGIN:VEVENT', 'UID:s', 'DTSTAMP:20260101T000000Z', ...lines, 'END:VEVENT'];
  const timed = (f: () => void) => {
    const t0 = performance.now();
    let error: Error | null = null;
    try {
      f();
    } catch (e) {
      error = e as Error;
    }
    return { ms: performance.now() - t0, error };
  };

  it('a sparse rule given in the call fails closed, well under a second', () => {
    const input = calendar(...vevent('DTSTART:20260101T235959Z', 'RRULE:FREQ=DAILY'),
      ...vevent('RECURRENCE-ID:20261231T235959Z', 'DTSTART:20261231T235959Z'));
    const { ms, error } = timed(() => updateFields(input,
      { RRULE: 'FREQ=SECONDLY;BYMONTH=12;BYMONTHDAY=31;BYHOUR=23;BYMINUTE=59;BYSECOND=59' }));
    expect(error?.message).toMatch(/^Cannot check that the overrides and EXDATEs still name occurrences of the series: .*Rewrite the whole iCalendar object instead$/);
    expect(ms).toBeLessThan(1000);
  });

  it.each([
    ['DAILY;INTERVAL=5000;BYMONTH=2;BYMONTHDAY=29', 'DTSTART:20280229T090000Z', 'RECURRENCE-ID:20280229T090000Z'],
    ['WEEKLY;INTERVAL=5000;BYMONTH=2', 'DTSTART:20260202T090000Z', 'RECURRENCE-ID:20260202T090000Z'],
    ['YEARLY;INTERVAL=5000;BYMONTH=2;BYMONTHDAY=29;BYDAY=MO', 'DTSTART:20160229T090000Z', 'RECURRENCE-ID:20160229T090000Z'],
  ])('%s with an override, and an RDATE written: bounded', (rule, dtstart, rid) => {
    const input = calendar(...vevent(dtstart, `RRULE:FREQ=${rule}`),
      ...vevent(rid, dtstart.replace('DTSTART', 'DTSTART')));
    const { ms } = timed(() => updateFields(input, { RDATE: '2030-01-01T09:00:00Z' }));
    expect(ms).toBeLessThan(1000);
  });

  it('the expansion is metered: the step counter in ical.js\' iterator is hooked', () => {
    // fails if an ical.js release renames the method the bound hooks, which
    // would leave the expansion unbounded
    const before = expansionWork.steps;
    updateFields(calendar(...vevent('DTSTART:20261005T090000Z', 'RRULE:FREQ=WEEKLY;COUNT=10'),
      ...vevent('RECURRENCE-ID:20261102T090000Z', 'DTSTART:20261102T100000Z')), { RRULE: 'FREQ=WEEKLY;COUNT=12' });
    expect(expansionWork.steps - before).toBeGreaterThan(3);
  });

  it('a move is decided without expanding anything', () => {
    const before = expansionWork.steps;
    const { ms, error } = timed(() => updateFields(calendar(...vevent('DTSTART:20261231T230000Z',
      'RRULE:FREQ=MINUTELY;BYMONTH=12;BYMONTHDAY=31;BYHOUR=23')), { DTSTART: '2026-12-31T23:01:00Z' }));
    expect(error?.message).toMatch(/does not move the whole series/);
    expect(expansionWork.steps).toBe(before);
    expect(ms).toBeLessThan(100);
  });
});
