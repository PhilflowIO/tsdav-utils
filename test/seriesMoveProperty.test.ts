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
const timeAt = (wall: number) => {
  const d = new Date(wall * 1000);
  return ICAL.Time.fromData({
    year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
    hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: 0,
  }, berlin);
};
/** a Berlin wall clock as a property line, in the zone or in UTC */
const line = (name: string, wall: number, utc: boolean) => utc
  ? `${name}:${basic(wallOf(timeAt(wall).convertToZone(ICAL.Timezone.utcTimezone)))}Z`
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
    out.push(`${wallOf(details.startDate.convertToZone(berlin))} ${details.item.summary}`);
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
