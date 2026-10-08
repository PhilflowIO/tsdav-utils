import ICAL from 'ical.js';
import { UpdateFieldsError } from './errors';
import { fieldsOf, ianaZone, vtimezoneIn, vtimezoneZone, wallOf } from './zone';

/*
 * VTIMEZONE generation from the runtime's IANA time zone data.
 *
 * RFC 5545 3.6.5 requires a VTIMEZONE for every TZID an object uses (RFC 7809
 * lets a client leave out standard ones only where the server says it adds
 * them, which a library cannot know). When updateFields writes a TZID the
 * object has no VTIMEZONE for, one is generated here:
 *
 *  - it starts on 1 January 1970, or the year before the earliest value in the
 *    zone if that is earlier, with an observance that only states the offset
 *    then: ical.js reads every time before a VTIMEZONE's first observance with
 *    offset 0, so the start has to lie before every value, also one a later
 *    write moves back in time;
 *  - each run of three or more years in which the zone changes twice by the
 *    same yearly rule (last Sunday of March at 02:00, ...) becomes a DAYLIGHT
 *    and a STANDARD observance with an RRULE, ended with UNTIL where the rule
 *    ended. The last run, which reaches past 2045, has no UNTIL: it is the
 *    zone's current rule and covers an unbounded series. A zone whose changes
 *    follow no yearly rule (Morocco's Ramadan pause) is scanned on until they
 *    stop, so its last change is the last the time zone data knows;
 *  - every other change (a single year's decree, a permanent change of
 *    standard time like Europe/Moscow 2014 or America/Sao_Paulo 2019) is
 *    listed by date: one observance per pair of offsets, its first date as
 *    DTSTART and every date (the first too, see below) as RDATE;
 *  - a zone that never changes in that span has a single STANDARD observance.
 *
 * Every change is found by scanning the zone's offset as Intl reports it, and
 * the VTIMEZONE built from them is read back (with the module's own reader)
 * and compared with Intl at every scanned instant before it is used, so it
 * names the same offsets as the data the values were converted with. The same
 * input gives the same text: nothing depends on the clock or the host zone.
 */

const DAY = 86400;

/** The first year a generated VTIMEZONE covers, unless a value lies earlier */
const FIRST_YEAR = 1970;

/**
 * The last year scanned, at the least. The tz database stores changes up to
 * 2037 and the current rule beyond; eight years past that show the rule on
 * every weekday it can fall on, so the last run is the rule itself, not one
 * that only happens to fit a few years.
 */
const LAST_SCANNED_YEAR = 2045;

/** Years a yearly rule has to hold to be written as an RRULE */
const MIN_RUN = 3;

/**
 * A zone still changing at the end of the scan without a yearly rule
 * (Africa/Casablanca, whose DST pauses for Ramadan, listed in the tz database
 * up to 2087) is scanned further, by this many years at a time, until its
 * last years settle into a rule or into no change, up to SCAN_LIMIT.
 */
const SCAN_STEP = 50;
const SETTLED_YEARS = 10;
const SCAN_LIMIT = 2300;

interface Change {
  /** the UTC instant from which `to` holds */
  at: number;
  from: number;
  to: number;
}

interface Scan {
  /** the offset at `start` */
  initial: number;
  start: number;
  end: number;
  changes: Change[];
  /** every instant looked at and its offset, to check the result against */
  samples: [number, number][];
}

const scans = new Map<string, Scan>();

/**
 * The offset changes of an IANA zone between two UTC instants. The offset is
 * sampled daily and each change found by bisection to the second. Daily, not
 * weekly: Brazil's Boa Vista, Recife and Noronha kept DST for one week in
 * October 2000.
 */
function scan(tzid: string, offsetAt: (utc: number) => number, start: number, end: number): Scan {
  const key = `${tzid}|${start}|${end}`;
  const cached = scans.get(key);
  if (cached) {
    return cached;
  }
  const samples: [number, number][] = [];
  const at = (utc: number) => {
    const offset = offsetAt(utc);
    samples.push([utc, offset]);
    return offset;
  };
  const changes: Change[] = [];
  const initial = at(start);
  let t = start;
  let offset = initial;
  while (t < end) {
    const next = Math.min(t + DAY, end);
    const after = at(next);
    if (after === offset) {
      t = next;
      continue;
    }
    let lo = t;
    let hi = next;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (at(mid) === offset) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    const to = at(hi);
    at(hi - 1);
    changes.push({ at: hi, from: offset, to });
    t = hi;
    offset = to;
  }
  const result = { initial, start, end, changes, samples };
  scans.set(key, result);
  return result;
}

/** A change as the wall clock before it shows it */
interface Onset {
  change: Change;
  /** the wall clock (naive seconds) the change happens at, on the clock running before it */
  local: number;
  year: number;
  month: number;
  day: number;
  weekday: number;
  /** seconds since local midnight */
  time: number;
  up: boolean;
}

function onsetOf(change: Change): Onset {
  const local = change.at + change.from;
  const f = fieldsOf(local);
  return {
    change, local, year: f.year, month: f.month, day: f.day,
    weekday: new Date(local * 1000).getUTCDay(),
    time: local - Math.floor(local / DAY) * DAY,
    up: change.to > change.from,
  };
}

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
/** the days of a month */
const daysIn = (year: number, month: number) => fieldsOf(wallOf(year, month + 1, 1) - DAY).day;
const weekdayOf = (year: number, month: number, day: number) => new Date(wallOf(year, month, day) * 1000).getUTCDay();
/** the day of the month of the first `weekday` on or after day `from` */
const firstOnOrAfter = (year: number, month: number, from: number, weekday: number) =>
  from + (weekday - weekdayOf(year, month, from) + 7) % 7;

/**
 * The BY parts of a yearly rule that lands on each of these onsets, or null.
 * All have to share month, wall-clock time and offsets. Tried in this order:
 * the last weekday of the month (-1SU), the n-th (2SU), the first weekday on
 * or after a day (BYMONTHDAY=23,...,29;BYDAY=FR, Israel's "Friday before the
 * last Sunday"), a fixed date.
 */
function yearlyRule(onsets: Onset[]): string | null {
  const [first] = onsets;
  if (onsets.some((o) => o.month !== first.month || o.time !== first.time ||
      o.change.from !== first.change.from || o.change.to !== first.change.to)) {
    return null;
  }
  const month = `BYMONTH=${first.month}`;
  if (onsets.every((o) => o.weekday === first.weekday)) {
    const wd = WEEKDAYS[first.weekday];
    if (onsets.every((o) => o.day + 7 > daysIn(o.year, o.month))) {
      return `${month};BYDAY=-1${wd}`;
    }
    const shortest = first.month === 2 ? 28 : daysIn(2001, first.month);
    const fits = (from: number) => onsets.every((o) => firstOnOrAfter(o.year, o.month, from, o.weekday) === o.day);
    for (const from of [1, 8, 15, 22]) {
      if (fits(from)) {
        return `${month};BYDAY=${(from + 6) / 7}${wd}`;
      }
    }
    for (let from = 1; from + 6 <= shortest; from++) {
      if (fits(from)) {
        const days = Array.from({ length: 7 }, (_, i) => from + i).join(',');
        return `${month};BYMONTHDAY=${days};BYDAY=${wd}`;
      }
    }
  }
  if (onsets.every((o) => o.day === first.day)) {
    return `${month};BYMONTHDAY=${first.day}`;
  }
  return null;
}

interface Run {
  ups: Onset[];
  downs: Onset[];
  upRule: string;
  downRule: string;
}

/**
 * Split the onsets into runs of years that follow one yearly rule pair, and
 * the onsets that follow none. A year belongs to a run when it has exactly one
 * change forward and one back; runs are grown greedily from the earliest year.
 */
function runsOf(onsets: Onset[]): { runs: Run[]; single: Onset[] } {
  const byYear = new Map<number, Onset[]>();
  for (const onset of onsets) {
    byYear.set(onset.year, [...(byYear.get(onset.year) ?? []), onset]);
  }
  const pair = (year: number) => {
    const list = byYear.get(year);
    if (!list || list.length !== 2 || list[0].up === list[1].up) {
      return null;
    }
    return list[0].up ? { up: list[0], down: list[1] } : { up: list[1], down: list[0] };
  };
  const years = [...byYear.keys()].sort((a, b) => a - b);
  const runs: Run[] = [];
  const inRun = new Set<Onset>();
  for (let i = 0; i < years.length;) {
    let ups: Onset[] = [];
    let downs: Onset[] = [];
    let rules: [string, string] | null = null;
    let j = i;
    for (; j < years.length; j++) {
      const p = pair(years[j]);
      if (!p || (j > i && years[j] !== years[j - 1] + 1)) {
        break;
      }
      const upRule = yearlyRule([...ups, p.up]);
      const downRule = yearlyRule([...downs, p.down]);
      if (!upRule || !downRule) {
        break;
      }
      ups = [...ups, p.up];
      downs = [...downs, p.down];
      rules = [upRule, downRule];
    }
    if (rules && ups.length >= MIN_RUN) {
      runs.push({ ups, downs, upRule: rules[0], downRule: rules[1] });
      [...ups, ...downs].forEach((o) => inRun.add(o));
      i = j;
    } else {
      i = Math.max(j, i + 1);
    }
  }
  return { runs, single: onsets.filter((o) => !inRun.has(o)) };
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');
const icalLocal = (wall: number) => {
  const f = fieldsOf(wall);
  return `${pad(f.year, 4)}${pad(f.month)}${pad(f.day)}T${pad(f.hour)}${pad(f.minute)}${pad(f.second)}`;
};
const icalOffset = (seconds: number) => {
  const abs = Math.abs(seconds);
  return `${seconds < 0 ? '-' : '+'}${pad(Math.floor(abs / 3600))}${pad(Math.floor(abs / 60) % 60)}`;
};

interface Observance {
  kind: 'STANDARD' | 'DAYLIGHT';
  from: number;
  to: number;
  start: number;
  lines: string[];
}

/** The lines of a VTIMEZONE: observances by DTSTART, then kind */
function render(tzid: string, observances: Observance[]): string[] {
  const sorted = [...observances].sort((a, b) => a.start - b.start || a.kind.localeCompare(b.kind));
  return ['BEGIN:VTIMEZONE', `TZID:${tzid}`, ...sorted.flatMap((o) => [
    `BEGIN:${o.kind}`, `DTSTART:${icalLocal(o.start)}`,
    `TZOFFSETFROM:${icalOffset(o.from)}`, `TZOFFSETTO:${icalOffset(o.to)}`,
    ...o.lines, `END:${o.kind}`,
  ]), 'END:VTIMEZONE'];
}

/**
 * The observances for a scan: the offset at its start, a DAYLIGHT and STANDARD
 * pair per run (the last without UNTIL when it reaches the end of the scan),
 * and every other change as a dated observance, those with the same offsets
 * grouped with RDATE. `rules` false writes every change as a date.
 */
function observancesOf(found: Scan, rules: boolean, lastYear: number): Observance[] {
  const onsets = found.changes.map(onsetOf);
  const { runs, single } = rules ? runsOf(onsets) : { runs: [], single: onsets };
  const firstUp = onsets[0]?.up;
  const out: Observance[] = [{
    kind: firstUp === undefined || firstUp ? 'STANDARD' : 'DAYLIGHT',
    from: found.initial, to: found.initial, start: found.start + found.initial, lines: [],
  }];
  runs.forEach((run) => {
    const open = run.ups[run.ups.length - 1].year >= lastYear || run.downs[run.downs.length - 1].year >= lastYear;
    for (const [list, rule] of [[run.ups, run.upRule], [run.downs, run.downRule]] as [Onset[], string][]) {
      const last = list[list.length - 1];
      const until = open ? '' : `;UNTIL=${icalLocal(last.change.at)}Z`;
      out.push({
        kind: list[0].up ? 'DAYLIGHT' : 'STANDARD', from: list[0].change.from, to: list[0].change.to,
        start: list[0].local, lines: [`RRULE:FREQ=YEARLY;${rule}${until}`],
      });
    }
  });
  const groups = new Map<string, Onset[]>();
  for (const onset of single) {
    const key = `${onset.up}|${onset.change.from}|${onset.change.to}`;
    groups.set(key, [...(groups.get(key) ?? []), onset]);
  }
  // DTSTART is an onset too (RFC 5545 3.6.5), but ical.js reads only the
  // RDATEs of an observance that has any, so DTSTART is repeated among them,
  // as vzic (libical's generator) writes it
  for (const group of groups.values()) {
    const [first] = group;
    out.push({
      kind: first.up ? 'DAYLIGHT' : 'STANDARD', from: first.change.from, to: first.change.to, start: first.local,
      lines: group.length > 1 ? group.map((o) => `RDATE:${icalLocal(o.local)}`) : [],
    });
  }
  return out;
}

/**
 * Whether a scan's last years follow the zone's rule from then on: no change
 * in them, or every change in them part of the last run of a yearly rule.
 */
function settled(found: Scan, endYear: number): boolean {
  const onsets = found.changes.map(onsetOf);
  const tail = onsets.filter((o) => o.year > endYear - SETTLED_YEARS);
  if (!tail.length) {
    return true;
  }
  const { runs } = runsOf(onsets);
  const last = runs[runs.length - 1];
  return Boolean(last && tail.every((o) => last.ups.includes(o) || last.downs.includes(o)));
}

/** Whether a VTIMEZONE names the offset of every instant the scan looked at */
function matches(vtimezone: ICAL.Component, found: Scan): boolean {
  const zone = vtimezoneZone(vtimezone);
  return found.samples.every(([utc, offset]) => zone.offsetAt(utc) === offset);
}

/** The years (lowest, highest) of the values an object writes in a TZID, or null when none */
function yearsIn(calendar: ICAL.Component, tzid: string): [number, number] | null {
  const years: number[] = [];
  const yearOf = (value: unknown) => {
    const m = /^(\d{4,})-/.exec(String(value));
    if (m) {
      years.push(Number(m[1]));
    }
  };
  const visit = (component: ICAL.Component) => {
    if (component.name === 'vtimezone') {
      return;
    }
    for (const property of component.getAllProperties()) {
      if (property.getParameter('tzid') === tzid) {
        for (const value of (property.toJSON() as unknown[]).slice(3)) {
          (Array.isArray(value) ? value : [value]).forEach(yearOf);
        }
      }
    }
    if (component.getFirstProperty('dtstart')?.getParameter('tzid') === tzid) {
      for (const name of ['rrule', 'exrule']) {
        for (const property of component.getAllProperties(name)) {
          const until = (property.toJSON() as [string, object, string, { until?: unknown }])[3]?.until;
          if (until !== undefined) {
            yearOf(until);
          }
        }
      }
    }
    component.getAllSubcomponents().forEach(visit);
  };
  visit(calendar);
  return years.length ? [Math.min(...years), Math.max(...years)] : null;
}

/**
 * A VTIMEZONE for an IANA zone that covers the years given (see above).
 *
 * @throws {UpdateFieldsError} UNSUPPORTED_VTIMEZONE when the zone's offset in
 *   those years is not a whole minute (local mean time, before standard time
 *   was adopted), which iCalendar readers (ical.js among them) cannot read
 */
export function generateVtimezone(tzid: string, firstYear: number, lastYear: number): ICAL.Component {
  const zone = ianaZone(tzid);
  if (!zone) {
    throw new UpdateFieldsError('UNKNOWN_TZID', `"${tzid}" is no IANA time zone`, { remedy: 'fix-value' });
  }
  const startYear = Math.min(FIRST_YEAR, firstYear - 1);
  const local = wallOf(startYear, 1, 1);
  const start = local - zone.offsetAt(local);
  let endYear = Math.max(LAST_SCANNED_YEAR, lastYear + 2);
  let found: Scan;
  for (;;) {
    const endLocal = wallOf(endYear + 1, 1, 1);
    found = scan(tzid, zone.offsetAt, start, endLocal - zone.offsetAt(endLocal));
    if (endYear + SCAN_STEP > SCAN_LIMIT || settled(found, endYear)) {
      break;
    }
    endYear += SCAN_STEP;
  }

  // Local mean time has offsets in seconds, which ical.js reads as whole
  // minutes. A VTIMEZONE can start after the last change away from it if that
  // lies before the first value; a value on local mean time cannot be written.
  const odd = (offset: number) => offset % 60 !== 0;
  const lastOdd = found.changes.reduce((last, change, i) => odd(change.from) ? i : last, -1);
  if (lastOdd >= 0 && found.changes[lastOdd].at <= wallOf(firstYear, 1, 1) - DAY) {
    const resume = found.changes[lastOdd].at;
    found = { ...found, start: resume, initial: found.changes[lastOdd].to, changes: found.changes.slice(lastOdd + 1),
      samples: found.samples.filter(([utc]) => utc >= resume) };
  }
  if (odd(found.initial) || found.changes.some((change) => odd(change.to))) {
    const end = lastOdd >= 0 ? found.changes[lastOdd] : null;
    const since = end ? icalLocal(end.at + end.to).slice(0, 8) : null;
    throw new UpdateFieldsError('UNSUPPORTED_VTIMEZONE', `"${tzid}" was on local mean time, an offset in seconds ` +
      `that iCalendar readers cannot read${since ? ` before ${since}` : ''}: give values in UTC` +
      `${since ? ` or from ${since} on` : ''}`, { remedy: 'fix-value' });
  }

  for (const rules of [true, false]) {
    const text = ['BEGIN:VCALENDAR', ...render(tzid, observancesOf(found, rules, endYear)), 'END:VCALENDAR'].join('\r\n');
    const vtimezone = new ICAL.Component(ICAL.parse(text)).getFirstSubcomponent('vtimezone')!;
    if (matches(vtimezone, found)) {
      return vtimezone;
    }
  }
  // Every change written as a date reproduces the scan by construction
  throw new Error(`the VTIMEZONE generated for "${tzid}" does not match the time zone data`);
}

/**
 * Add a VTIMEZONE for a TZID to a VCALENDAR that has none, covering every
 * value the object holds in that zone. A VTIMEZONE already there is kept as it
 * is: it is what every reader of the object reads the TZID against.
 */
export function ensureVtimezone(calendar: ICAL.Component, tzid: string): void {
  if (calendar.name !== 'vcalendar' || vtimezoneIn(calendar, tzid)) {
    return;
  }
  const years = yearsIn(calendar, tzid);
  if (!years) {
    return;
  }
  const vtimezone = generateVtimezone(tzid, years[0], years[1]);
  // VTIMEZONEs go before the components that use them, as clients write them
  // a copy: getAllSubcomponents returns the list removeAllSubcomponents empties
  const all = [...calendar.getAllSubcomponents()];
  const at = all.findIndex((c) => c.name !== 'vtimezone');
  calendar.removeAllSubcomponents();
  [...all.slice(0, at < 0 ? all.length : at), vtimezone, ...(at < 0 ? [] : all.slice(at))]
    .forEach((c) => calendar.addSubcomponent(c));
}
