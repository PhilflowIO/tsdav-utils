import { afterEach, describe, expect, it } from 'vitest';
import ICAL from 'ical.js';
import { UpdateFieldsError, seriesMaster, updateFields } from '../src/index';
import { scanCacheSize, vtimezoneFor as generateVtimezone } from '../src/vtimezone';
import { zoneOf } from '../src/zone';

// The oracle is Intl, read here on its own (not through src/zone.ts): every
// generated VTIMEZONE is compared with it, read once with the library's own
// reader and once with ical.js.

const formats = new Map<string, Intl.DateTimeFormat>();
/** a zone's UTC offset in seconds at a UTC instant (seconds), from Intl */
function intlOffset(tzid: string, utc: number): number {
  let format = formats.get(tzid);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: tzid, hourCycle: 'h23', era: 'short',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    formats.set(tzid, format);
  }
  const p = Object.fromEntries(format.formatToParts(new Date(utc * 1000)).map((x) => [x.type, x.value]));
  const year = p.era === 'BC' || p.era === 'B' ? 1 - Number(p.year) : Number(p.year);
  const d = new Date(Date.UTC(2000, Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)));
  d.setUTCFullYear(year);
  return d.getTime() / 1000 - utc;
}
const utcOf = (y: number, mo = 1, d = 1, h = 0) => Date.UTC(y, mo - 1, d, h) / 1000;
/** a wall clock (naive seconds) as ICAL.Time without a zone */
const timeOf = (wall: number) => {
  const d = new Date(wall * 1000);
  return ICAL.Time.fromData({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
    hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds() });
};

const calendar = (...lines: string[]) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...lines, 'END:VCALENDAR', ''].join('\r\n');
const skeleton = (...lines: string[]) =>
  calendar('BEGIN:VEVENT', 'UID:named-zone', 'DTSTAMP:20260101T000000Z', 'SUMMARY:Weekly', ...lines, 'END:VEVENT');
const lines = (ics: string) => ics.split('\r\n');
const parse = (ics: string) => new ICAL.Component(ICAL.parse(ics));
const vtimezones = (ics: string) => parse(ics).getAllSubcomponents('vtimezone');

const refusal = (call: () => unknown): UpdateFieldsError => {
  try {
    call();
  } catch (error) {
    return error as UpdateFieldsError;
  }
  throw new Error('not refused');
};

/**
 * Zones chosen for what makes a VTIMEZONE hard: southern-hemisphere DST
 * (Sydney, Santiago, Sao Paulo), offsets in half and quarter hours (Kolkata,
 * Kathmandu, St Johns, Chatham), half-hour DST (Lord Howe), no DST (Tokyo,
 * Kolkata), a two-hour DST (Troll), rules ended or changed (Sao Paulo 2019,
 * Moscow 2011 and 2014, New York 2007), a rule that is not "n-th weekday"
 * (Jerusalem, Friday on or after 23 March), and DST following no yearly rule
 * at all (Casablanca, Gaza: Ramadan, with a one-week DST in October 2040).
 */
const ZONES = ['Europe/Berlin', 'America/New_York', 'Australia/Sydney', 'America/Sao_Paulo', 'Europe/Moscow',
  'Asia/Kolkata', 'Asia/Kathmandu', 'Australia/Lord_Howe', 'Asia/Tokyo', 'Antarctica/Troll', 'Asia/Jerusalem',
  'Africa/Casablanca', 'America/Santiago', 'Pacific/Chatham', 'America/St_Johns', 'Europe/Dublin', 'Asia/Gaza'];

/** Compare a generated VTIMEZONE with Intl, with both readers, at the given UTC instants */
function mismatches(tzid: string, vtimezone: ICAL.Component, instants: number[]): string[] {
  const own = zoneOf(vtimezone, tzid)!;
  const ical = new ICAL.Timezone(vtimezone);
  const iana = zoneOf(parse(calendar()), tzid)!;
  // a VTIMEZONE covers from its first observance on (Africa/Monrovia's from
  // 1972, when it left local mean time)
  const first = vtimezone.getAllSubcomponents()[0];
  const startLocal = first.getFirstPropertyValue('dtstart') as ICAL.Time;
  const start = Date.UTC(startLocal.year, startLocal.month - 1, startLocal.day, startLocal.hour, startLocal.minute,
    startLocal.second) / 1000 - (first.getFirstPropertyValue('tzoffsetfrom') as ICAL.UtcOffset).toSeconds();
  const out: string[] = [];
  for (const utc of instants.filter((t) => t >= start)) {
    const expected = intlOffset(tzid, utc);
    if (own.offsetAt(utc) !== expected) {
      out.push(`own reader at ${new Date(utc * 1000).toISOString()}: ${own.offsetAt(utc)} != ${expected}`);
    }
    // ical.js reads local to UTC (its UTC-to-local is ical.js#847); a wall
    // clock a DST change skips or repeats does not name this instant alone
    const wall = utc + expected;
    if (!iana.ambiguity(wall) && ical.utcOffset(timeOf(wall)) !== expected) {
      out.push(`ical.js at ${new Date(wall * 1000).toISOString()} local: ${ical.utcOffset(timeOf(wall))} != ${expected}`);
    }
  }
  return out;
}

// By default the instants are sampled every 3 days and 1 hour (so the hour
// of day goes round) from 1970 to 2060, and hourly for two days around every
// change in the years the values lie in. VTIMEZONE_DEEP=1 samples daily over
// the whole span and hourly through those years.
const DEEP = Boolean(process.env.VTIMEZONE_DEEP);

function samples(tzid: string, first: number, last: number): number[] {
  const out: number[] = [];
  const stride = DEEP ? 86400 : 3 * 86400 + 3600;
  for (let t = utcOf(1970) + 43200; t < utcOf(2061); t += stride) {
    out.push(t);
  }
  if (DEEP) {
    for (let t = utcOf(first - 1); t < utcOf(last + 2); t += 3600) {
      out.push(t);
    }
    return out;
  }
  // the changes in those years, found on Intl's offsets by the day
  for (let t = utcOf(first - 1); t < utcOf(last + 2); t += 86400) {
    if (intlOffset(tzid, t) !== intlOffset(tzid, t + 86400)) {
      for (let h = -24; h <= 48; h++) {
        out.push(t + h * 3600);
      }
    }
  }
  return out;
}

/**
 * What Outlook and Exchange read as a zone's current rule: the STANDARD and the
 * DAYLIGHT with the latest DTSTART, each picked on its own (MS-OXCICAL
 * 2.1.3.1.1.19.2, note <61>). Problems with them, empty when they describe the
 * zone's final state: an open rule pair while it has DST, else the last offset
 * without rule (a DAYLIGHT, if any, with the same offsets at the same DTSTART).
 */
function finalStateProblems(vtimezone: ICAL.Component, tzid: string, dst: boolean): string[] {
  const key = (o: ICAL.Component) => (o.getFirstPropertyValue('dtstart') as ICAL.Time).toString();
  const latestOf = (kind: string) => vtimezone.getAllSubcomponents(kind)
    .sort((a, b) => key(a).localeCompare(key(b))).pop() ?? null;
  const standard = latestOf('standard');
  const daylight = latestOf('daylight');
  const rule = (o: ICAL.Component | null) => o?.hasProperty('rrule') ? String(o.getFirstPropertyValue('rrule')) : null;
  const problems: string[] = [];
  if (dst) {
    for (const o of [standard, daylight]) {
      if (!rule(o) || /UNTIL/.test(rule(o)!)) {
        problems.push(`latest ${o?.name ?? 'observance'} is no open rule`);
      }
    }
    return problems;
  }
  const offset = intlOffset(tzid, utcOf(2100));
  for (const o of [standard, daylight]) {
    if (!o) {
      continue;
    }
    if (o.hasProperty('rrule') || o.hasProperty('rdate')) {
      problems.push(`latest ${o.name} repeats`);
    }
    if ((o.getFirstPropertyValue('tzoffsetto') as ICAL.UtcOffset).toSeconds() !== offset) {
      problems.push(`latest ${o.name} is not the final offset`);
    }
  }
  if (!standard) {
    problems.push('no STANDARD');
  }
  if (daylight && standard && key(daylight) !== key(standard)) {
    problems.push('the latest DAYLIGHT is not at the final DTSTART');
  }
  return problems;
}
/** whether a zone has DST in 2030 (by Intl) */
const hasDst = (tzid: string) => intlOffset(tzid, utcOf(2030, 1, 15)) !== intlOffset(tzid, utcOf(2030, 7, 15));

describe('generated VTIMEZONE against Intl', () => {
  it.each(ZONES)('%s: both readers give the Intl offset, for values from 2026 and from 1971', (tzid) => {
    expect(mismatches(tzid, generateVtimezone(tzid, 2026, 2026), samples(tzid, 2026, 2026))).toEqual([]);
    expect(mismatches(tzid, generateVtimezone(tzid, 1971, 2026), samples(tzid, 1971, 2026))).toEqual([]);
  });

  it.each([
    ['America/Sao_Paulo', 2018, 2020], ['Europe/Moscow', 2010, 2015], ['America/New_York', 2006, 2008],
    // DST for one week, 8 to 15 October 2000
    ['America/Recife', 2000, 2000],
    // DST ends on the Friday after the last Thursday of October, which can be 1 November
    ['Africa/Cairo', 2023, 2031],
  ])('%s around its rule change (%i-%i)', (tzid, first, last) => {
    const vtimezone = generateVtimezone(tzid, first, last);
    expect(mismatches(tzid, vtimezone, samples(tzid, first, last))).toEqual([]);
  });

  it('starts on 1 January of the year before the earliest value', () => {
    const start = (tzid: string, year: number) =>
      generateVtimezone(tzid, year, year).getAllSubcomponents()[0].getFirstPropertyValue('dtstart')!.toString();
    expect(start('Europe/Berlin', 2026)).toBe('2025-01-01T00:00:00');
    expect(start('Europe/Berlin', 1960)).toBe('1959-01-01T00:00:00');
    // a 2026 Berlin VTIMEZONE is the start and the current rule
    expect(generateVtimezone('Europe/Berlin', 2026, 2026).getAllSubcomponents()).toHaveLength(3);
  });

  it.each(['America/Sao_Paulo', 'Europe/Moscow', 'America/Mexico_City', 'Europe/Istanbul', 'Asia/Tehran',
    'Asia/Amman', 'Europe/Berlin', 'Africa/Cairo', 'Australia/Sydney', 'America/New_York', 'Asia/Kolkata',
    'Africa/Casablanca', 'Asia/Gaza'])(
    '%s: the observances with the latest DTSTART are the zone\'s final state, for Outlook', (tzid) => {
      for (const first of [1971, 2000, 2017, 2026]) {
        const dst = hasDst(tzid) && tzid !== 'Africa/Casablanca';
        expect(finalStateProblems(generateVtimezone(tzid, first, 2026), tzid, dst)).toEqual([]);
      }
    });

  it('a zone without DST has a single STANDARD observance', () => {
    for (const tzid of ['Asia/Kolkata', 'Asia/Tokyo', 'UTC', 'Etc/GMT+5']) {
      const vtimezone = generateVtimezone(tzid, 2026, 2026);
      expect(vtimezone.getAllSubcomponents().map((c) => c.name)).toEqual(['standard']);
    }
  });

  it('names each observance: the zone\'s abbreviation, else its offset', () => {
    const names = (tzid: string) => generateVtimezone(tzid, 2026, 2026).getAllSubcomponents()
      .map((o) => o.getFirstPropertyValue('tzname'));
    expect(names('Europe/Berlin')).toEqual(['CET', 'CEST', 'CET']);
    expect(names('America/New_York')).toEqual(['EST', 'EDT', 'EST']);
    expect(names('Asia/Kolkata')).toEqual(['IST']);
    expect(names('America/Sao_Paulo')).toEqual(['-03']);
    // which zones have an abbreviation depends on the ICU version (Node 18 knows NPT, later ones do not)
    expect(names('Asia/Kathmandu')[0]).toMatch(/^(NPT|\+0545)$/);
    expect(names('Etc/GMT-14')).toEqual(['+14']);
  });

  it('the current rule is an open RRULE, so an unbounded series is covered', () => {
    const text = generateVtimezone('Europe/Berlin', 2026, 2026).toString();
    expect(text).toContain('RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU\r\n');
    expect(text).toContain('RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU\r\n');
    const far = [];
    for (let t = utcOf(2090); t < utcOf(2101); t += 6 * 3600) {
      far.push(t);
    }
    for (const tzid of ['Europe/Berlin', 'Africa/Cairo', 'Asia/Jerusalem', 'Australia/Sydney']) {
      expect(mismatches(tzid, generateVtimezone(tzid, 2026, 2026), far)).toEqual([]);
    }
  });

  it('writes rules that are no n-th weekday as the first weekday on or after a day, across a month end too', () => {
    expect(generateVtimezone('Asia/Jerusalem', 2026, 2026).toString())
      .toContain('RRULE:FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=23,24,25,26,27,28,29;BYDAY=FR');
    // Egypt: the Friday after the last Thursday of October, 26 October to 1 November
    const cairo = generateVtimezone('Africa/Cairo', 2026, 2026);
    expect(cairo.toString()).toContain('RRULE:FREQ=YEARLY;BYYEARDAY=-67,-66,-65,-64,-63,-62,-61;BYDAY=FR\r\n');
    expect(cairo.getAllSubcomponents().length).toBeLessThanOrEqual(3);
  });

  it('is the same text for the same input', () => {
    expect(generateVtimezone('Australia/Sydney', 2026, 2027).toString())
      .toEqual(generateVtimezone('Australia/Sydney', 2026, 2027).toString());
  });

  it('does not scan past the zone\'s final state: an UNTIL in 9999 or a value in year 1 is fast', () => {
    for (const [tzid, until] of [['Europe/Berlin', '99991231T000000Z'], ['Africa/Cairo', '50001231T000000Z'],
      ['Asia/Gaza', '99991231T000000Z']]) {
      // warm the zone's scan of the years up to today, which any first use pays
      generateVtimezone(tzid, 2026, 2026);
      const t0 = performance.now();
      const out = updateFields(skeleton(), { DTSTART: '2026-10-05T09:00:00', RRULE: `FREQ=WEEKLY;UNTIL=${until}` }, { zone: tzid });
      expect(performance.now() - t0).toBeLessThan(200);
      expect(out).toContain(`UNTIL=${until.slice(0, 4)}`);
    }
    const t0 = performance.now();
    expect(refusal(() => generateVtimezone('Europe/Berlin', 1, 1)).code).toBe('UNSUPPORTED_VTIMEZONE');
    expect(performance.now() - t0).toBeLessThan(200);
  });

  it('keeps one cache entry per zone, of its changes only, grown for new years', () => {
    const zones = ['Europe/Paris', 'America/Chicago', 'Pacific/Auckland'];
    const before = scanCacheSize();
    for (const tzid of zones) {
      for (const [first, last] of [[2026, 2026], [2044, 2063], [1990, 1991], [2026, 2030]]) {
        generateVtimezone(tzid, first, last);
      }
    }
    const after = scanCacheSize();
    expect(after.zones - before.zones).toBe(zones.length);
    // Paris, Chicago and Auckland change twice a year: 1989 to 2065 is under 160 changes each
    expect(after.changes - before.changes).toBeLessThan(zones.length * 160);
  });

  it('refuses a value on local mean time, whose offset in seconds iCalendar cannot hold', () => {
    // Monrovia kept -00:44:30 until 7 January 1972
    const error = refusal(() => generateVtimezone('Africa/Monrovia', 1971, 1971));
    expect(error.code).toBe('UNSUPPORTED_VTIMEZONE');
    expect(error.remedy).toBe('fix-value');
    expect(error.message).toContain('19720107');
    // with a value from 1973 on, the VTIMEZONE starts where local mean time ended
    const vtimezone = generateVtimezone('Africa/Monrovia', 1973, 1973);
    expect(vtimezone.getAllSubcomponents()[0].getFirstPropertyValue('dtstart')!.toString()).toBe('1972-01-07T00:44:30');
    expect(mismatches('Africa/Monrovia', vtimezone, samples('Africa/Monrovia', 1973, 1973))).toEqual([]);
  });

  it.runIf(process.env.VTIMEZONE_ALL_ZONES)('every zone the runtime knows, from 1971 and from 2026', () => {
    const failed: string[] = [];
    for (const tzid of Intl.supportedValuesOf('timeZone')) {
      for (const first of [1971, 2026]) {
        try {
          const vtimezone = generateVtimezone(tzid, first, 2026);
          const bad = mismatches(tzid, vtimezone, samples(tzid, first, 2026));
          if (bad.length) {
            failed.push(`${tzid} from ${first}: ${bad.length} mismatches, first ${bad[0]}`);
          }
          const problems = finalStateProblems(vtimezone, tzid, hasDst(tzid) && !/Casablanca|El_Aaiun/.test(tzid));
          if (problems.length) {
            failed.push(`${tzid} from ${first}: ${problems.join(', ')}`);
          }
        } catch (error) {
          if (!(first === 1971 && (error as UpdateFieldsError).code === 'UNSUPPORTED_VTIMEZONE')) {
            failed.push(`${tzid} from ${first}: ${(error as Error).message}`);
          }
        }
      }
    }
    console.log(`all zones: ${Intl.supportedValuesOf('timeZone').length} checked, ${failed.length} failed`);
    expect(failed).toEqual([]);
  }, 1200000);
});

describe('options.zone', () => {
  const registered: string[] = [];
  afterEach(() => {
    registered.splice(0).forEach((tzid) => ICAL.TimezoneService.remove(tzid));
  });

  /** the UTC instants of a series' occurrences as ical.js expands it, with the object's VTIMEZONEs */
  function icalInstants(ics: string, limit = 60): number[] {
    for (const vtimezone of vtimezones(ics)) {
      const tzid = String(vtimezone.getFirstPropertyValue('tzid'));
      ICAL.TimezoneService.register(new ICAL.Timezone(vtimezone));
      registered.push(tzid);
    }
    const event = new ICAL.Event(seriesMaster(parse(ics)));
    const it = event.iterator();
    const out: number[] = [];
    for (let next = it.next(); next && out.length < limit; next = it.next()) {
      out.push(next.toUnixTime());
    }
    return out;
  }

  /** the wall clocks (as "YYYY-MM-DD HH:MM") of instants in a zone, from Intl */
  const walls = (tzid: string, instants: number[]) => instants.map((utc) =>
    new Date((utc + intlOffset(tzid, utc)) * 1000).toISOString().slice(0, 16).replace('T', ' '));

  it('creates a weekly Berlin series that keeps 09:00 across both 2026 DST changes', () => {
    const out = updateFields(skeleton(), {
      DTSTART: '2026-03-16T09:00:00', DTEND: '2026-03-16T10:00:00', RRULE: 'FREQ=WEEKLY;UNTIL=20261130T235959',
    }, { zone: 'Europe/Berlin' });
    expect(lines(out)).toContain('DTSTART;TZID=Europe/Berlin:20260316T090000');
    expect(lines(out)).toContain('DTEND;TZID=Europe/Berlin:20260316T100000');
    // UNTIL is read in the zone and written in UTC (RFC 5545 3.3.10)
    expect(lines(out)).toContain('RRULE:FREQ=WEEKLY;UNTIL=20261130T225959Z');
    // the VTIMEZONE comes before the event
    expect(out.indexOf('BEGIN:VTIMEZONE')).toBeLessThan(out.indexOf('BEGIN:VEVENT'));
    expect(vtimezones(out)).toHaveLength(1);

    // ical.js, with the generated VTIMEZONE: every occurrence at 09:00 in Berlin
    const instants = icalInstants(out);
    expect(instants).toHaveLength(38);
    expect(new Set(walls('Europe/Berlin', instants).map((w) => w.slice(11)))).toEqual(new Set(['09:00']));
    // the instants move by an hour at each change: 08:00Z in winter, 07:00Z in summer
    expect(new Date(instants[1] * 1000).toISOString()).toBe('2026-03-23T08:00:00.000Z');
    expect(new Date(instants[2] * 1000).toISOString()).toBe('2026-03-30T07:00:00.000Z');
    expect(new Date(instants[32] * 1000).toISOString()).toBe('2026-10-26T08:00:00.000Z');

    // the library's own reader of the same VTIMEZONE agrees with Intl
    const own = zoneOf(parse(out), 'Europe/Berlin')!;
    for (const utc of instants) {
      expect(own.offsetAt(utc)).toBe(intlOffset('Europe/Berlin', utc));
    }
  });

  it('writes an instant given with Z or an offset as its wall-clock time in the zone', () => {
    const out = updateFields(skeleton(), {
      DTSTART: '2026-10-19T07:00:00Z', DTEND: '2026-10-19T10:00:00+01:00', RRULE: 'FREQ=WEEKLY;COUNT=3',
    }, { zone: 'Europe/Berlin' });
    expect(lines(out)).toContain('DTSTART;TZID=Europe/Berlin:20261019T090000');
    expect(lines(out)).toContain('DTEND;TZID=Europe/Berlin:20261019T110000');
    expect(walls('Europe/Berlin', icalInstants(out))).toEqual(['2026-10-19 09:00', '2026-10-26 09:00', '2026-11-02 09:00']);
  });

  it.each([
    ['America/Sao_Paulo', '2018-10-29T10:00:00', 30],
    ['Europe/Moscow', '2014-10-06T10:00:00', 10],
    ['Australia/Sydney', '2026-03-30T10:00:00', 30],
    ['Australia/Lord_Howe', '2026-03-30T10:00:00', 30],
  ])('a weekly series in %s keeps its wall-clock time across the zone\'s changes', (tzid, start, count) => {
    const out = updateFields(skeleton(), { DTSTART: start, RRULE: `FREQ=WEEKLY;COUNT=${count}` }, { zone: tzid });
    const instants = icalInstants(out);
    expect(instants).toHaveLength(count);
    expect(new Set(walls(tzid, instants).map((w) => w.slice(11)))).toEqual(new Set(['10:00']));
    const own = zoneOf(parse(out), tzid)!;
    for (const utc of instants) {
      expect(own.offsetAt(utc)).toBe(intlOffset(tzid, utc));
    }
  });

  it('is idempotent: a second write adds no second VTIMEZONE, and the same input gives the same text', () => {
    const once = updateFields(skeleton(), { DTSTART: '2026-10-05T09:00:00', RRULE: 'FREQ=WEEKLY' }, { zone: 'Europe/Berlin' });
    expect(updateFields(skeleton(), { DTSTART: '2026-10-05T09:00:00', RRULE: 'FREQ=WEEKLY' }, { zone: 'Europe/Berlin' }))
      .toBe(once);
    const twice = updateFields(once, { DTSTART: '2026-10-06T09:00:00', DTEND: '2026-10-06T10:00:00' }, { zone: 'Europe/Berlin' });
    expect(vtimezones(twice)).toHaveLength(1);
    expect(vtimezones(twice)[0].toString()).toBe(vtimezones(once)[0].toString());
  });

  it('reuses a VTIMEZONE the object has, unchanged, and converts with it', () => {
    const berlin = ['BEGIN:VTIMEZONE', 'TZID:Europe/Berlin', 'X-LIC-LOCATION:Europe/Berlin',
      'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST', 'DTSTART:19700329T020000',
      'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
      'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET', 'DTSTART:19701025T030000',
      'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD', 'END:VTIMEZONE'];
    const ics = calendar(...berlin, 'BEGIN:VEVENT', 'UID:x', 'DTSTAMP:20260101T000000Z', 'END:VEVENT');
    const out = updateFields(ics, { DTSTART: '2026-07-01T07:00:00Z' }, { zone: 'Europe/Berlin' });
    expect(vtimezones(out)).toHaveLength(1);
    expect(out).toContain(berlin.join('\r\n'));
    expect(lines(out)).toContain('DTSTART;TZID=Europe/Berlin:20260701T090000');
  });

  it('accepts a zone only the object\'s VTIMEZONE defines', () => {
    const office = ['BEGIN:VTIMEZONE', 'TZID:Office', 'BEGIN:STANDARD', 'TZOFFSETFROM:+0300', 'TZOFFSETTO:+0300',
      'DTSTART:19700101T000000', 'END:STANDARD', 'END:VTIMEZONE'];
    const out = updateFields(calendar(...office, 'BEGIN:VEVENT', 'UID:x', 'END:VEVENT'),
      { DTSTART: '2026-07-01T07:00:00Z' }, { zone: 'Office' });
    expect(lines(out)).toContain('DTSTART;TZID=Office:20260701T100000');
    expect(vtimezones(out)).toHaveLength(1);
  });

  it('spells the zone as the time zone data does, and keeps the name the caller chose', () => {
    expect(lines(updateFields(skeleton(), { DTSTART: '2026-07-01T09:00:00' }, { zone: 'europe/berlin' })))
      .toContain('DTSTART;TZID=Europe/Berlin:20260701T090000');
    const kolkata = updateFields(skeleton(), { DTSTART: '2026-07-01T09:00:00' }, { zone: 'Asia/Kolkata' });
    expect(lines(kolkata)).toContain('DTSTART;TZID=Asia/Kolkata:20260701T090000');
    expect(lines(kolkata)).toContain('TZID:Asia/Kolkata');
  });

  it('writes dependent values in the zone with DTSTART, whatever the key order', () => {
    const out = updateFields(skeleton(), {
      EXDATE: '2026-10-12T09:00:00,2026-10-26T08:00:00Z', RDATE: '2026-10-28T09:00:00',
      DTSTART: '2026-10-05T09:00:00', RRULE: 'FREQ=WEEKLY;COUNT=4',
    }, { zone: 'Europe/Berlin' });
    expect(lines(out)).toContain('EXDATE;TZID=Europe/Berlin:20261012T090000,20261026T090000');
    expect(lines(out)).toContain('RDATE;TZID=Europe/Berlin:20261028T090000');
    expect(walls('Europe/Berlin', icalInstants(out))).toEqual(['2026-10-05 09:00', '2026-10-19 09:00', '2026-10-28 09:00']);
  });

  it('writes a value next to DTSTART in the same zone, also replacing an end\'s own TZID', () => {
    const ics = skeleton('DTSTART;TZID=Europe/Berlin:20261005T090000', 'DTEND;TZID=Asia/Tokyo:20261005T170000');
    const out = updateFields(ics, { DTEND: '2026-10-05T10:30:00' }, { zone: 'Europe/Berlin' });
    expect(lines(out)).toContain('DTEND;TZID=Europe/Berlin:20261005T103000');
    expect(vtimezones(out)).toHaveLength(1);
  });

  it('writes a todo\'s DUE without DTSTART in the zone', () => {
    const todo = calendar('BEGIN:VTODO', 'UID:t', 'DTSTAMP:20260101T000000Z', 'END:VTODO');
    const out = updateFields(todo, { DUE: '2026-10-26T18:00:00' }, { zone: 'America/New_York' });
    expect(lines(out)).toContain('DUE;TZID=America/New_York:20261026T180000');
    expect(vtimezones(out).map((c) => c.getFirstPropertyValue('tzid'))).toEqual(['America/New_York']);
  });

  it('reads a time without a zone in the zone on UTC-only properties and writes UTC', () => {
    const out = updateFields(skeleton('DTSTART;TZID=Europe/Berlin:20261005T090000'),
      { 'LAST-MODIFIED': '2026-10-05T12:00:00', DTSTAMP: '2026-10-05T10:00:00Z' }, { zone: 'Europe/Berlin' });
    expect(lines(out)).toContain('LAST-MODIFIED:20261005T100000Z');
    expect(lines(out)).toContain('DTSTAMP:20261005T100000Z');
    // nothing was written in the zone, so no VTIMEZONE
    expect(vtimezones(out)).toHaveLength(0);
  });

  it('writes a vCard date-time, which has no TZID, as UTC read in the zone', () => {
    const card = ['BEGIN:VCARD', 'VERSION:4.0', 'FN:A', 'END:VCARD', ''].join('\r\n');
    expect(lines(updateFields(card, { REV: '2026-07-01T09:00:00' }, { zone: 'Europe/Berlin' })))
      .toContain('REV:20260701T070000Z');
  });

  it('leaves dates alone: an all-day event has no zone', () => {
    const out = updateFields(skeleton(), { DTSTART: '2026-10-05', DTEND: '2026-10-06' }, { zone: 'Europe/Berlin' });
    expect(lines(out)).toContain('DTSTART;VALUE=DATE:20261005');
    expect(vtimezones(out)).toHaveLength(0);
  });

  it('writes the TZID on a bare component, which has no VCALENDAR to hold a VTIMEZONE', () => {
    const bare = ['BEGIN:VEVENT', 'UID:b', 'DTSTAMP:20260101T000000Z', 'END:VEVENT', ''].join('\r\n');
    const out = updateFields(bare, { DTSTART: '2026-10-05T09:00:00' }, { zone: 'Europe/Berlin' });
    expect(lines(out)).toContain('DTSTART;TZID=Europe/Berlin:20261005T090000');
    expect(out).not.toContain('VTIMEZONE');
  });

  it('covers a value a later write moves before the first one', () => {
    const once = updateFields(skeleton(), { DTSTART: '2026-10-05T09:00:00' }, { zone: 'Europe/Berlin' });
    const earlier = updateFields(once, { DTSTART: '1999-07-05T09:00:00' }, { zone: 'Europe/Berlin' });
    expect(vtimezones(earlier)).toHaveLength(1);
    const [start] = icalInstants(earlier);
    expect(walls('Europe/Berlin', [start])).toEqual(['1999-07-05 09:00']);
  });

  it('generates its own VTIMEZONE again when a later write moves a value before it', () => {
    const once = updateFields(skeleton(), { DTSTART: '2026-10-05T09:00:00' }, { zone: 'Europe/Berlin' });
    expect(vtimezones(once)[0].getAllSubcomponents()[0].getFirstPropertyValue('dtstart')!.toString()).toBe('2025-01-01T00:00:00');
    for (const [value, start] of [['2020-07-06T09:00:00', '2019-01-01T00:00:00'], ['1950-07-03T09:00:00', '1949-01-01T00:00:00']]) {
      const moved = updateFields(once, { DTSTART: value }, { zone: 'Europe/Berlin' });
      expect(vtimezones(moved)).toHaveLength(1);
      expect(vtimezones(moved)[0].getAllSubcomponents()[0].getFirstPropertyValue('dtstart')!.toString()).toBe(start);
      const [instant] = icalInstants(moved, 1);
      expect(walls('Europe/Berlin', [instant])).toEqual([value.slice(0, 16).replace('T', ' ')]);
      registered.splice(0).forEach((tzid) => ICAL.TimezoneService.remove(tzid));
    }
  });

  it('refuses a value before a VTIMEZONE it did not generate, rather than rewrite it', () => {
    const server = ['BEGIN:VTIMEZONE', 'TZID:Europe/Berlin',
      'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST', 'DTSTART:19810329T020000',
      'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
      'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET', 'DTSTART:19961027T030000',
      'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD', 'END:VTIMEZONE'];
    const ics = calendar(...server, 'BEGIN:VEVENT', 'UID:x', 'DTSTAMP:20260101T000000Z', 'END:VEVENT');
    expect(lines(updateFields(ics, { DTSTART: '1990-07-02T09:00:00' }, { zone: 'Europe/Berlin' })))
      .toContain('DTSTART;TZID=Europe/Berlin:19900702T090000');
    const error = refusal(() => updateFields(ics, { DTSTART: '1975-07-07T09:00:00' }, { zone: 'Europe/Berlin' }));
    expect(error.code).toBe('UNSUPPORTED_VTIMEZONE');
    expect(error.remedy).toBe('rewrite-object');
  });

  describe('DTEND and DUE follow a DTSTART written in a zone', () => {
    const berlin = skeleton('DTSTART;TZID=Europe/Berlin:20260907T100000', 'DTEND;TZID=Europe/Berlin:20260907T110000');

    it('keeps the duration on the new zone\'s wall clock', () => {
      const out = updateFields(berlin, { DTSTART: '2026-09-07T10:00:00' }, { zone: 'America/New_York' });
      expect(lines(out)).toContain('DTSTART;TZID=America/New_York:20260907T100000');
      expect(lines(out)).toContain('DTEND;TZID=America/New_York:20260907T110000');
      expect(vtimezones(out).map((c) => c.getFirstPropertyValue('tzid'))).toEqual(['America/New_York']);
    });

    it('also within the same zone, and into UTC', () => {
      expect(lines(updateFields(berlin, { DTSTART: '2026-09-07T14:00:00' }, { zone: 'Europe/Berlin' })))
        .toContain('DTEND;TZID=Europe/Berlin:20260907T150000');
      expect(lines(updateFields(berlin, { DTSTART: '2026-09-07T14:00:00Z' }, { zone: 'UTC' })))
        .toContain('DTEND:20260907T150000Z');
    });

    it('measures an end in another zone than its start in elapsed time', () => {
      const flight = skeleton('DTSTART;TZID=Europe/Berlin:20260907T100000', 'DTEND;TZID=America/New_York:20260907T120000');
      // 08:00Z to 16:00Z: eight hours
      expect(lines(updateFields(flight, { DTSTART: '2026-09-08T10:00:00' }, { zone: 'Europe/Berlin' })))
        .toContain('DTEND;TZID=Europe/Berlin:20260908T180000');
    });

    it('keeps an elapsed length elapsed across a DST change', () => {
      // 08:00Z to 09:00Z the next day: 25 hours, start in Berlin, end in UTC
      const ics = skeleton('DTSTART;TZID=Europe/Berlin:20260907T100000', 'DTEND:20260908T090000Z');
      // New York leaves DST on 1 November: 31 October 10:00 EDT + 25 h is 1 November 10:00 EST
      expect(lines(updateFields(ics, { DTSTART: '2026-10-31T10:00:00' }, { zone: 'America/New_York' })))
        .toContain('DTEND;TZID=America/New_York:20261101T100000');
    });

    it('moves a todo\'s DUE', () => {
      const todo = calendar('BEGIN:VTODO', 'UID:t', 'DTSTAMP:20260101T000000Z', 'DTSTART:20260907T080000Z',
        'DUE:20260907T100000Z', 'END:VTODO');
      expect(lines(updateFields(todo, { DTSTART: '2026-09-08T09:00:00' }, { zone: 'Europe/Berlin' })))
        .toContain('DUE;TZID=Europe/Berlin:20260908T110000');
    });

    it('leaves an end the call writes itself, and refuses one before the start', () => {
      expect(lines(updateFields(berlin, { DTSTART: '2026-09-07T10:00:00', DTEND: '2026-09-07T12:30:00' },
        { zone: 'America/New_York' }))).toContain('DTEND;TZID=America/New_York:20260907T123000');
      const error = refusal(() => updateFields(berlin, { DTEND: '2026-09-07T09:00:00' }, { zone: 'Europe/Berlin' }));
      expect(error.code).toBe('END_BEFORE_START');
      expect(error.property).toBe('DTEND');
    });

    it('does not refuse an unrelated write next to an end that already lies before its start', () => {
      const broken = skeleton('DTSTART;TZID=Europe/Berlin:20260907T100000', 'DTEND;TZID=Europe/Berlin:20260907T090000');
      expect(lines(updateFields(broken, { SUMMARY: 'x' }, { zone: 'Europe/Berlin' }))).toContain('SUMMARY:x');
    });
  });

  it.each(['UTC', 'Etc/UTC', 'GMT', 'Etc/GMT', 'Zulu'])('zone "%s" writes UTC with Z and no VTIMEZONE', (zone) => {
    const out = updateFields(skeleton(), { DTSTART: '2026-10-05T09:00:00', DTEND: '2026-10-05T12:00:00+02:00',
      RRULE: 'FREQ=WEEKLY;UNTIL=20261102T090000' }, { zone });
    expect(lines(out)).toContain('DTSTART:20261005T090000Z');
    expect(lines(out)).toContain('DTEND:20261005T100000Z');
    expect(lines(out)).toContain('RRULE:FREQ=WEEKLY;UNTIL=20261102T090000Z');
    expect(out).not.toContain('VTIMEZONE');
    expect(out).not.toContain('TZID');
  });

  it('spells an alias properly: as given in proper case, else as the zone it links to', () => {
    const tzidOf = (zone: string) => /DTSTART;TZID=([^:]+):/.exec(updateFields(skeleton(), { DTSTART: '2026-07-01T09:00:00' }, { zone }))![1];
    const linked = (name: string) => new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone;
    expect(tzidOf('US/Eastern')).toBe('US/Eastern');
    expect(tzidOf('us/eastern')).toBe('America/New_York');
    expect(tzidOf('asia/kolkata')).toBe(Intl.supportedValuesOf('timeZone').includes('Asia/Kolkata') ? 'Asia/Kolkata' : linked('Asia/Kolkata'));
    expect(tzidOf('europe/kyiv')).toBe(Intl.supportedValuesOf('timeZone').includes('Europe/Kyiv') ? 'Europe/Kyiv' : linked('Europe/Kyiv'));
    expect(tzidOf('Europe/Kyiv')).toBe('Europe/Kyiv');
  });

  describe('moving an existing series into the zone', () => {
    // weekly Monday 09:00 New York, from 5 October 2026 over both DST ends
    // (Europe 25 October, US 1 November), one EXDATE and one override
    const newYork = calendar(
      'BEGIN:VEVENT', 'UID:s', 'DTSTAMP:20260101T000000Z', 'DTSTART;TZID=America/New_York:20261005T090000',
      'DTEND;TZID=America/New_York:20261005T100000', 'RRULE:FREQ=WEEKLY;COUNT=6',
      'EXDATE;TZID=America/New_York:20261019T090000', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:s', 'DTSTAMP:20260101T000000Z', 'RECURRENCE-ID;TZID=America/New_York:20261026T090000',
      'DTSTART;TZID=America/New_York:20261026T110000', 'DTEND;TZID=America/New_York:20261026T120000',
      'SUMMARY:moved', 'END:VEVENT');

    it('moves it like any DTSTART write: every occurrence keeps its place, on the new zone\'s wall clock', () => {
      const out = updateFields(newYork, { DTSTART: '2026-10-05T15:00:00', DTEND: '2026-10-05T16:00:00' },
        { zone: 'Europe/Berlin' });
      expect(lines(out)).toContain('DTSTART;TZID=Europe/Berlin:20261005T150000');
      expect(lines(out)).toContain('EXDATE;TZID=Europe/Berlin:20261019T150000');
      expect(lines(out)).toContain('RECURRENCE-ID;TZID=Europe/Berlin:20261026T150000');
      // the override keeps its own form and its two hours after the occurrence
      expect(lines(out)).toContain('DTSTART;TZID=America/New_York:20261026T120000');
      // the VTIMEZONE for Berlin is added, the zone the override still uses needs none from the call
      expect(vtimezones(out).map((c) => c.getFirstPropertyValue('tzid'))).toEqual(['Europe/Berlin']);
      // every occurrence of the master at 15:00 Berlin, also in the weeks
      // where New York and Berlin are five hours apart instead of six
      expect(walls('Europe/Berlin', icalInstants(out))).toEqual(['2026-10-05 15:00', '2026-10-12 15:00',
        '2026-10-26 15:00', '2026-11-02 15:00', '2026-11-09 15:00']);
    });

    it('turns a UTC series into one that keeps its local time', () => {
      const utc = calendar('BEGIN:VEVENT', 'UID:u', 'DTSTAMP:20260101T000000Z', 'DTSTART:20261005T070000Z',
        'RRULE:FREQ=WEEKLY;UNTIL=20261102T070000Z', 'EXDATE:20261026T070000Z', 'END:VEVENT');
      const out = updateFields(utc, { DTSTART: '2026-10-05T07:00:00Z' }, { zone: 'Europe/Berlin' });
      expect(lines(out)).toContain('DTSTART;TZID=Europe/Berlin:20261005T090000');
      expect(lines(out)).toContain('EXDATE;TZID=Europe/Berlin:20261026T090000');
      // 2 November 09:00 in Berlin is 08:00Z
      expect(lines(out)).toContain('RRULE:FREQ=WEEKLY;UNTIL=20261102T080000Z');
      expect(walls('Europe/Berlin', icalInstants(out))).toEqual(['2026-10-05 09:00', '2026-10-12 09:00',
        '2026-10-19 09:00', '2026-11-02 09:00']);
    });

    it('refuses a value that follows DTSTART in another zone, without DTSTART in the call', () => {
      for (const fields of [{ DTEND: '2026-10-05T16:00:00' }, { EXDATE: '2026-10-12T15:00:00' },
        { RRULE: 'FREQ=WEEKLY;UNTIL=20261130T090000' }]) {
        const error = refusal(() => updateFields(newYork, fields, { zone: 'Europe/Berlin' }));
        expect(error.code).toBe('ZONE_MISMATCH');
        expect(error.remedy).toBe('same-call');
        expect(error.message).toContain('America/New_York');
      }
    });
  });

  describe('refusals', () => {
    it.each([
      ['Mars/Olympus_Mons', 'UNKNOWN_TZID'], ['+01:00', 'UNKNOWN_TZID'], ['CEST', 'UNKNOWN_TZID'],
    ])('zone "%s" is %s', (zone, code) => {
      const error = refusal(() => updateFields(skeleton(), { DTSTART: '2026-10-05T09:00:00' }, { zone }));
      expect(error.code).toBe(code);
      expect(error.remedy).toBe('fix-value');
    });

    it('a zone that is no non-empty string is INVALID_INPUT', () => {
      for (const zone of ['', ' ', 42, null]) {
        const error = refusal(() => updateFields(skeleton(), { SUMMARY: 'x' }, { zone } as any));
        expect(error.code).toBe('INVALID_INPUT');
      }
    });

    it('floatingTime and absoluteTime "as-given" contradict zone; "keep-zone" agrees with it', () => {
      expect(refusal(() => updateFields(skeleton(), { SUMMARY: 'x' }, { zone: 'Europe/Berlin', floatingTime: 'keep' })).code)
        .toBe('INVALID_FLOATING_TIME');
      expect(refusal(() => updateFields(skeleton(), { SUMMARY: 'x' }, { zone: 'Europe/Berlin', floatingTime: 'local' })).code)
        .toBe('INVALID_FLOATING_TIME');
      expect(refusal(() => updateFields(skeleton(), { SUMMARY: 'x' }, { zone: 'Europe/Berlin', absoluteTime: 'as-given' })).code)
        .toBe('INVALID_ABSOLUTE_TIME');
      expect(lines(updateFields(skeleton(), { DTSTART: '2026-10-05T07:00:00Z' },
        { zone: 'Europe/Berlin', absoluteTime: 'keep-zone' }))).toContain('DTSTART;TZID=Europe/Berlin:20261005T090000');
    });

    it('an instant in the second pass of the repeated hour has no wall clock of its own: DST_AMBIGUOUS', () => {
      // 25 October 2026: 02:30 CEST is 00:30Z, 02:30 CET is 01:30Z
      expect(lines(updateFields(skeleton(), { DTSTART: '2026-10-25T00:30:00Z' }, { zone: 'Europe/Berlin' })))
        .toContain('DTSTART;TZID=Europe/Berlin:20261025T023000');
      const error = refusal(() => updateFields(skeleton(), { DTSTART: '2026-10-25T01:30:00Z' }, { zone: 'Europe/Berlin' }));
      expect(error.code).toBe('DST_AMBIGUOUS');
      expect(error.remedy).toBe('fix-value');
      expect(error.property).toBe('DTSTART');
    });

    it('a value on local mean time is UNSUPPORTED_VTIMEZONE, and nothing is written', () => {
      const error = refusal(() => updateFields(skeleton(), { DTSTART: '1960-05-01T09:00:00' }, { zone: 'Africa/Monrovia' }));
      expect(error.code).toBe('UNSUPPORTED_VTIMEZONE');
      expect(error.remedy).toBe('fix-value');
    });
  });
});
