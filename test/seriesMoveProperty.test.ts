import { describe, it, expect } from 'vitest';
import ICAL from 'ical.js';
import { updateFields } from '../src/updateFields';

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

describe('the expansion check is bounded', () => {
  const event = (...props: string[]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//EN',
    'BEGIN:VEVENT', 'UID:s', 'DTSTAMP:20260101T000000Z', ...props, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
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

  it.each([
    ['MINUTELY', 'RRULE:FREQ=MINUTELY;BYMONTH=12;BYMONTHDAY=31;BYHOUR=23', 'DTSTART:20261231T230000Z', '2026-12-31T23:01:00Z'],
    ['SECONDLY', 'RRULE:FREQ=SECONDLY;BYMONTH=12;BYMONTHDAY=31;BYHOUR=23;BYMINUTE=59;BYSECOND=59',
      'DTSTART:20261231T235959Z', '2026-12-31T23:59:58Z'],
  ])('a sparse %s rule fails closed, well under a second', (_, rule, dtstart, moved) => {
    const { ms, error } = timed(() => updateFields(event(dtstart, rule), { DTSTART: moved }));
    expect(error?.message).toMatch(/^Cannot check that moving DTSTART keeps the series' occurrences: RRULE:FREQ=\w+;.*too sparse to expand within the work limit\. Give RRULE, UNTIL and EXDATE explicitly in the same call, or rewrite the whole iCalendar object$/);
    expect(ms).toBeLessThan(1000);
  });

  it('the orphan check of a sparse rule given in the call fails closed too', () => {
    const input = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//EN',
      'BEGIN:VEVENT', 'UID:s', 'DTSTAMP:20260101T000000Z', 'DTSTART:20260101T235959Z', 'RRULE:FREQ=DAILY', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:s', 'DTSTAMP:20260101T000000Z', 'RECURRENCE-ID:20261231T235959Z',
      'DTSTART:20261231T235959Z', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
    const { ms, error } = timed(() => updateFields(input,
      { RRULE: 'FREQ=SECONDLY;BYMONTH=12;BYMONTHDAY=31;BYHOUR=23;BYMINUTE=59;BYSECOND=59' }));
    expect(error?.message).toMatch(/^Cannot check that the overrides and EXDATEs still name occurrences of the series: .*Rewrite the whole iCalendar object instead$/);
    expect(ms).toBeLessThan(1000);
  });

  it('dense rules stay well inside the limit', () => {
    const { ms, error } = timed(() => updateFields(
      event('DTSTART:20260101T000000Z', 'RRULE:FREQ=MINUTELY', 'RRULE:FREQ=SECONDLY', 'RRULE:FREQ=HOURLY'),
      { DTSTART: '2026-01-01T00:00:30Z' }));
    expect(error).toBeNull();
    expect(ms).toBeLessThan(1000);
  });
});
