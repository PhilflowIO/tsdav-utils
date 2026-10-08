import { describe, it, expect } from 'vitest';
import ICAL from 'ical.js';
import { zoneOf } from '../src/zone';

// A VTIMEZONE is read from its own transitions. The oracle is the runtime's
// IANA data (Intl), not ical.js: ical.js' convertToZone from UTC gets the
// offset wrong for hours around each DST change.

const BERLIN = [
  'BEGIN:VTIMEZONE', 'TZID:Europe/Berlin',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST',
  'DTSTART:19700329T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET',
  'DTSTART:19701025T030000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
  'END:VTIMEZONE',
];

// As servers send a zone with its history: one-off observances (DTSTART and
// RDATE), and rules bounded by UNTIL. Germany ended DST in September until 1995.
const BERLIN_HISTORIC = [
  'BEGIN:VTIMEZONE', 'TZID:Europe/Berlin',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST',
  'DTSTART:19800406T020000', 'RDATE:19800406T020000', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET',
  'DTSTART:19800928T030000', 'RDATE:19800928T030000', 'END:STANDARD',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST',
  'DTSTART:19810329T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET',
  'DTSTART:19810927T030000', 'RRULE:FREQ=YEARLY;UNTIL=19950924T010000Z;BYMONTH=9;BYDAY=-1SU', 'END:STANDARD',
  'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET',
  'DTSTART:19961027T030000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
  'END:VTIMEZONE',
];

const NEW_YORK = [
  'BEGIN:VTIMEZONE', 'TZID:America/New_York',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'TZNAME:EDT',
  'DTSTART:19700308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'TZNAME:EST',
  'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD',
  'END:VTIMEZONE',
];

// The US rules before and after the 2007 change, each bounded by UNTIL, as
// Apple Calendar writes America/New_York
const NEW_YORK_HISTORIC = [
  'BEGIN:VTIMEZONE', 'TZID:America/New_York',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'TZNAME:EDT',
  'DTSTART:19870405T020000', 'RRULE:FREQ=YEARLY;UNTIL=20060402T070000Z;BYMONTH=4;BYDAY=1SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'TZNAME:EST',
  'DTSTART:19671029T020000', 'RRULE:FREQ=YEARLY;UNTIL=20061029T060000Z;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'TZNAME:EDT',
  'DTSTART:20070311T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'TZNAME:EST',
  'DTSTART:20071104T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD',
  'END:VTIMEZONE',
];

const H = 3600;
const STEP = 15 * 60;

/** a VEVENT inside a VCALENDAR that carries the VTIMEZONE, as zoneOf sees it */
const zoneFrom = (vtimezone: string[], tzid: string) => {
  const calendar = new ICAL.Component(ICAL.parse(['BEGIN:VCALENDAR', ...vtimezone,
    'BEGIN:VEVENT', 'UID:z', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')));
  return zoneOf(calendar.getFirstSubcomponent('vevent')!, tzid)!;
};

/** the wall clock of a UTC instant in an IANA zone, by Intl */
const intlWall = (tzid: string) => {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone: tzid, hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  });
  return (utc: number) => {
    const p = Object.fromEntries(format.formatToParts(new Date(utc * 1000)).map((x) => [x.type, x.value]));
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day),
      Number(p.hour), Number(p.minute), Number(p.second)) / 1000;
  };
};

const iso = (s: number) => new Date(s * 1000).toISOString().slice(0, 19);

describe.each([
  ['Europe/Berlin', 'as servers send it', BERLIN, [2026, 2005]],
  ['Europe/Berlin', 'with its history, RDATE and UNTIL', BERLIN_HISTORIC, [2026, 1990, 1980]],
  ['America/New_York', 'as servers send it', NEW_YORK, [2026, 2015]],
  ['America/New_York', 'with the rules before 2007', NEW_YORK_HISTORIC, [2026, 2005]],
] as const)('%s %s, against Intl every 15 minutes', (tzid, _, vtimezone, years) => {
  const zone = zoneFrom([...vtimezone], tzid);
  const wall = intlWall(tzid);

  it.each([...years])('UTC to wall clock in %i', (year) => {
    const wrong: string[] = [];
    for (let utc = Date.UTC(year, 0, 1) / 1000; utc < Date.UTC(year + 1, 0, 1) / 1000; utc += STEP) {
      if (zone.fromUtc(utc) !== wall(utc)) {
        wrong.push(`${iso(utc)}Z -> ${iso(zone.fromUtc(utc))}, Intl ${iso(wall(utc))}`);
      }
    }
    expect(wrong.slice(0, 5)).toEqual([]);
  });

  it.each([...years])('wall clock to UTC in %i: an ambiguous time is its first occurrence, a nonexistent one lies past the gap', (year) => {
    const from = Date.UTC(year, 0, 1) / 1000;
    const to = Date.UTC(year + 1, 0, 1) / 1000;
    // the offsets the zone uses that year, by Intl
    const offsets = new Set<number>();
    for (let utc = from - 86400; utc < to + 86400; utc += 6 * H) {
      offsets.add(wall(utc) - utc);
    }
    const wrong: string[] = [];
    for (let w = from; w < to; w += STEP) {
      // every UTC instant Intl shows as this wall clock; none: in the gap,
      // read with the offset before it
      const fits = [...offsets].map((o) => w - o).filter((utc) => wall(utc) === w);
      const expected = fits.length ? Math.min(...fits) : w - (wall(w - 2 * 86400) - (w - 2 * 86400));
      if (zone.toUtc(w) !== expected) {
        wrong.push(`${iso(w)} -> ${iso(zone.toUtc(w))}Z, expected ${iso(expected)}Z`);
      }
    }
    expect(wrong.slice(0, 5)).toEqual([]);
  });
});

describe('an IANA zone without VTIMEZONE follows the same rules', () => {
  const calendar = new ICAL.Component(ICAL.parse(
    ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:z', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')));
  const zone = zoneOf(calendar.getFirstSubcomponent('vevent')!, 'Europe/Berlin')!;
  const at = (s: string) => Date.parse(`${s}Z`) / 1000;

  it('02:30 on the spring-forward day is 03:30 CEST', () => {
    expect(iso(zone.toUtc(at('2026-03-29T02:30:00')))).toBe('2026-03-29T01:30:00');
  });

  it('02:30 on the fall-back day is the first one, still CEST', () => {
    expect(iso(zone.toUtc(at('2026-10-25T02:30:00')))).toBe('2026-10-25T00:30:00');
  });
});

describe('a VTIMEZONE with an observance no time zone has is refused, quickly', () => {
  it.each(['DAILY', 'HOURLY', 'MINUTELY', 'SECONDLY'])('FREQ=%s', (freq) => {
    const zone = zoneFrom(['BEGIN:VTIMEZONE', 'TZID:Hostile/Zone',
      'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'DTSTART:19700101T000000',
      `RRULE:FREQ=${freq};BYMONTH=2;BYMONTHDAY=30`, 'END:DAYLIGHT',
      'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'DTSTART:19700101T000000',
      `RRULE:FREQ=${freq}`, 'END:STANDARD', 'END:VTIMEZONE'], 'Hostile/Zone');
    const t0 = performance.now();
    expect(() => zone.fromUtc(Date.UTC(2026, 5, 1) / 1000))
      .toThrow(`the VTIMEZONE "Hostile/Zone" has an observance repeating ${freq}, which no time zone does, so it is not read`);
    expect(performance.now() - t0).toBeLessThan(100);
  });

  it('a YEARLY or MONTHLY rule that matches nothing ends by itself', () => {
    const zone = zoneFrom(['BEGIN:VTIMEZONE', 'TZID:Odd/Zone',
      'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'DTSTART:19700329T020000',
      'RRULE:FREQ=MONTHLY;BYMONTH=2;BYMONTHDAY=30', 'END:DAYLIGHT',
      'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'DTSTART:19701025T030000',
      'RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30', 'END:STANDARD', 'END:VTIMEZONE'], 'Odd/Zone');
    const t0 = performance.now();
    zone.fromUtc(Date.UTC(2026, 5, 1) / 1000);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});
