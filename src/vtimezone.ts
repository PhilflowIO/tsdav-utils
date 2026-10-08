import ICAL from 'ical.js';
import { UpdateFieldsError } from './errors';
import { fieldsOf, ianaZone, ianaZoneName, vtimezoneIn, vtimezoneZone, wallOf } from './zone';

/*
 * VTIMEZONE generation from the runtime's IANA time zone data.
 *
 * RFC 5545 3.6.5 requires a VTIMEZONE for every TZID an object uses (RFC 7809
 * lets a client leave out standard ones only where the server says it adds
 * them, which a library cannot know). When updateFields writes a TZID the
 * object has no VTIMEZONE for, one is generated here:
 *
 *  - it starts on 1 January of the year before the earliest value, with an
 *    observance that only states the offset then: ical.js reads every time
 *    before a VTIMEZONE's first observance with offset 0. A later write that
 *    moves a value before that start regenerates it (see ensureVtimezone);
 *  - each run of three or more years in which the zone changes twice by the
 *    same yearly rule (last Sunday of March at 02:00, ...) becomes a DAYLIGHT
 *    and a STANDARD observance with an RRULE, ended with UNTIL where the rule
 *    ended;
 *  - every other change (a single year's decree) is listed by date: one
 *    observance per pair of offsets, its first date as DTSTART and every date
 *    (the first too: ical.js reads only the RDATEs of an observance that has
 *    any) as RDATE;
 *  - the zone's final state comes last: the STANDARD and the DAYLIGHT with the
 *    latest DTSTART both describe it. Outlook and Exchange read the zone's
 *    current rule from the latest STANDARD and the latest DAYLIGHT, each
 *    picked on its own (MS-OXCICAL 2.1.3.1.1.19.2 and its note <61>), so it
 *    is either the current rule as an open DAYLIGHT/STANDARD pair (which
 *    covers an unbounded series) or, where the zone no longer changes, the
 *    last change as a STANDARD and a DAYLIGHT with the same offsets at the
 *    same DTSTART (Exchange's own way of writing a zone without DST, note
 *    <65>). A DST rule a zone has abolished (America/Sao_Paulo 2019) is never
 *    the latest of its kind;
 *  - TZNAME is the zone's abbreviation where Intl has one ("CET", "EST"), else
 *    the offset ("+0530").
 *
 * The changes are found by scanning the zone's offset as Intl reports it; the
 * VTIMEZONE built from them is read back with the module's own reader and
 * compared with them before it is used. The same input gives the same text:
 * nothing depends on the clock or the host zone.
 */

const DAY = 86400;

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

/** What is known of a zone's offsets: from `start` to `end` (UTC), the offset at start and every change after it */
interface Scan {
  start: number;
  end: number;
  initial: number;
  changes: Change[];
}

/**
 * The changes found per zone, kept for the life of the process: a list of a
 * few hundred changes at most per zone, grown by scanning only the years not
 * yet scanned.
 */
const scans = new Map<string, Scan>();

/** The number of zones and changes held, for tests of the cache's size */
export function scanCacheSize(): { zones: number; changes: number } {
  let changes = 0;
  scans.forEach((s) => { changes += s.changes.length; });
  return { zones: scans.size, changes };
}

/**
 * The offset changes between two UTC instants, each with `at` in (start, end].
 * The offset is sampled daily and each change found by bisection to the
 * second. Daily, not weekly: Brazil's Boa Vista, Recife and Noronha kept DST
 * for one week in October 2000, Gaza and Hebron will in October 2040.
 */
function changesBetween(offsetAt: (utc: number) => number, start: number, end: number): Change[] {
  const changes: Change[] = [];
  let t = start;
  let offset = offsetAt(start);
  while (t < end) {
    const next = Math.min(t + DAY, end);
    if (offsetAt(next) === offset) {
      t = next;
      continue;
    }
    let lo = t;
    let hi = next;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (offsetAt(mid) === offset) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    const to = offsetAt(hi);
    changes.push({ at: hi, from: offset, to });
    t = hi;
    offset = to;
  }
  return changes;
}

/** A zone's changes between two UTC instants, scanning only what the cache lacks */
function scan(tzid: string, offsetAt: (utc: number) => number, start: number, end: number): Scan {
  let known = scans.get(tzid);
  if (!known) {
    known = { start, end, initial: offsetAt(start), changes: changesBetween(offsetAt, start, end) };
  } else {
    if (start < known.start) {
      known = { ...known, start, initial: offsetAt(start),
        changes: [...changesBetween(offsetAt, start, known.start), ...known.changes] };
    }
    if (end > known.end) {
      known = { ...known, end, changes: [...known.changes, ...changesBetween(offsetAt, known.end, end)] };
    }
  }
  scans.set(tzid, known);
  const before = known.changes.filter((c) => c.at <= start);
  return {
    start, end,
    initial: before.length ? before[before.length - 1].to : known.initial,
    changes: known.changes.filter((c) => c.at > start && c.at <= end),
  };
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
  /** days to the end of the year, negated (31 December is -1) */
  back: number;
  /** seconds since local midnight */
  time: number;
  up: boolean;
}

const isLeap = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

function onsetOf(change: Change): Onset {
  const local = change.at + change.from;
  const f = fieldsOf(local);
  const day = Math.floor(local / DAY) * DAY;
  return {
    change, local, year: f.year, month: f.month, day: f.day,
    weekday: new Date(local * 1000).getUTCDay(),
    back: (day - wallOf(f.year + 1, 1, 1)) / DAY,
    time: local - day,
    up: change.to > change.from,
  };
}

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
/** the days of a month */
const daysIn = (year: number, month: number) => fieldsOf(wallOf(year, month + 1, 1) - DAY).day;
const weekdayAt = (wall: number) => new Date(wall * 1000).getUTCDay();
/** the day of the month of the first `weekday` on or after day `from` */
const firstOnOrAfter = (year: number, month: number, from: number, weekday: number) =>
  from + (weekday - weekdayAt(wallOf(year, month, from)) + 7) % 7;
/** the same counted from the end of the year: `from` and the result are negative days */
const firstOnOrAfterBack = (year: number, from: number, weekday: number) =>
  from + (weekday - weekdayAt(wallOf(year + 1, 1, 1) + from * DAY) + 7) % 7;
const range = (from: number) => Array.from({ length: 7 }, (_, i) => from + i).join(',');

/**
 * The BY parts of every yearly rule that lands on this onset, in order of
 * preference — within its month: the last weekday (-1SU), the n-th (2SU), the
 * first weekday on or after a day (BYMONTHDAY=23,...,29;BYDAY=FR, Israel's
 * "Friday before the last Sunday"), the fixed date; then, for a weekday on or
 * after a day whose week reaches into the next month (Egypt's "Friday after
 * the last Thursday of October", which can be 1 November), the same counted
 * back from the end of the year (BYYEARDAY=-67,...,-61;BYDAY=FR), the same days
 * in every year from March on. The order is the same for every onset, so the
 * rules several onsets share keep it.
 */
function rulesFor(o: Onset): string[] {
  const out: string[] = [];
  const month = `BYMONTH=${o.month}`;
  const wd = WEEKDAYS[o.weekday];
  if (o.day + 7 > daysIn(o.year, o.month)) {
    out.push(`${month};BYDAY=-1${wd}`);
  }
  for (const from of [1, 8, 15, 22]) {
    if (firstOnOrAfter(o.year, o.month, from, o.weekday) === o.day) {
      out.push(`${month};BYDAY=${(from + 6) / 7}${wd}`);
    }
  }
  const shortest = o.month === 2 ? 28 : daysIn(2001, o.month);
  for (let from = Math.max(1, o.day - 6); from <= o.day && from + 6 <= shortest; from++) {
    if (firstOnOrAfter(o.year, o.month, from, o.weekday) === o.day) {
      out.push(`${month};BYMONTHDAY=${range(from)};BYDAY=${wd}`);
    }
  }
  out.push(`${month};BYMONTHDAY=${o.day}`);
  if (o.month >= 3) {
    for (let from = o.back - 6; from <= o.back && from + 6 <= -1; from++) {
      if (firstOnOrAfterBack(o.year, from, o.weekday) === o.back) {
        out.push(`BYYEARDAY=${range(from)};BYDAY=${wd}`);
      }
    }
  }
  return out;
}

/** What has to be equal for onsets to follow one rule, besides the date: time of day and offsets */
const signature = (o: Onset) => `${o.time}|${o.change.from}|${o.change.to}`;

/**
 * The yearly rules several onsets share, grown one onset at a time: the
 * candidates are kept and narrowed, so a run of n years costs n steps.
 */
class RuleSet {
  private candidates: string[] | null = null;
  private sig = '';

  /** the rules if `onset` is added too, without adding it; empty when none */
  with(onset: Onset): string[] {
    if (this.candidates === null) {
      return rulesFor(onset);
    }
    if (signature(onset) !== this.sig) {
      return [];
    }
    const own = new Set(rulesFor(onset));
    return this.candidates.filter((rule) => own.has(rule));
  }

  add(onset: Onset, rules: string[]) {
    this.sig = signature(onset);
    this.candidates = rules;
  }
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
    const list = byYear.get(onset.year);
    if (list) {
      list.push(onset);
    } else {
      byYear.set(onset.year, [onset]);
    }
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
    const ups: Onset[] = [];
    const downs: Onset[] = [];
    const upRules = new RuleSet();
    const downRules = new RuleSet();
    let rules: [string, string] | null = null;
    let j = i;
    for (; j < years.length; j++) {
      const p = pair(years[j]);
      if (!p || (j > i && years[j] !== years[j - 1] + 1)) {
        break;
      }
      const up = upRules.with(p.up);
      const down = downRules.with(p.down);
      if (!up.length || !down.length) {
        break;
      }
      upRules.add(p.up, up);
      downRules.add(p.down, down);
      ups.push(p.up);
      downs.push(p.down);
      rules = [up[0], down[0]];
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

/**
 * Locales tried, in order, for a zone's abbreviation: Intl gives "CET" only
 * in en-GB, "EST" only in en-US, "AEST" only in en-AU, "IST" only in en-IN.
 */
const NAME_LOCALES = ['en-US', 'en-GB', 'en-AU', 'en-IN', 'en-NZ', 'en-CA', 'en-IE', 'en-ZA'];

/** A zone's names at instants: the first abbreviation (letters only) a locale gives, else the offset */
function namer(tzid: string): (utc: number, offset: number) => string {
  const formats = new Map<string, Intl.DateTimeFormat>();
  return (utc, offset) => {
    for (const locale of NAME_LOCALES) {
      let format = formats.get(locale);
      if (!format) {
        format = new Intl.DateTimeFormat(locale, { timeZone: tzid, timeZoneName: 'short' });
        formats.set(locale, format);
      }
      const name = format.formatToParts(new Date(utc * 1000)).find((p) => p.type === 'timeZoneName')?.value ?? '';
      if (/^[A-Z]{2,6}$/.test(name)) {
        return name;
      }
    }
    const text = icalOffset(offset);
    return text.endsWith('00') ? text.slice(0, 3) : text;
  };
}

interface Observance {
  kind: 'STANDARD' | 'DAYLIGHT';
  from: number;
  to: number;
  start: number;
  /** the UTC instant of the first onset, for its name */
  at: number;
  lines: string[];
}

/** The lines of a VTIMEZONE: observances by DTSTART, then kind */
function render(tzid: string, observances: Observance[]): string[] {
  const name = namer(tzid);
  const sorted = [...observances].sort((a, b) => a.start - b.start || a.kind.localeCompare(b.kind));
  return ['BEGIN:VTIMEZONE', `TZID:${tzid}`, ...sorted.flatMap((o) => [
    `BEGIN:${o.kind}`, `DTSTART:${icalLocal(o.start)}`,
    `TZOFFSETFROM:${icalOffset(o.from)}`, `TZOFFSETTO:${icalOffset(o.to)}`, `TZNAME:${name(o.at, o.to)}`,
    ...o.lines, `END:${o.kind}`,
  ]), 'END:VTIMEZONE'];
}

/**
 * The observances for a scan (see the top of the module). `rules` false
 * writes every change as a date. `lastYear` is the last year scanned: a run
 * that reaches it is the zone's current rule.
 */
function observancesOf(found: Scan, rules: boolean, lastYear: number): Observance[] {
  const onsets = found.changes.map(onsetOf);
  const parts = rules ? runsOf(onsets) : { runs: [], single: onsets };
  const runs = [...parts.runs];
  let single = [...parts.single];
  const last = runs[runs.length - 1];
  const open = Boolean(last && Math.max(last.ups[last.ups.length - 1].year, last.downs[last.downs.length - 1].year) >= lastYear);

  // Where the zone no longer changes, its last change is its final state: an
  // observance of its own, the latest, taken out of the run or list it was in
  let final: Onset | null = null;
  if (!open && onsets.length) {
    final = onsets[onsets.length - 1];
    single = single.filter((o) => o !== final);
    if (last && (last.ups.includes(final) || last.downs.includes(final))) {
      const ups = last.ups.filter((o) => o !== final);
      const downs = last.downs.filter((o) => o !== final);
      runs.pop();
      if (ups.length && downs.length) {
        runs.push({ ...last, ups, downs });
      } else {
        single.push(...ups, ...downs);
      }
    }
  }

  const firstUp = onsets[0]?.up;
  const out: Observance[] = [{
    kind: firstUp === undefined || firstUp ? 'STANDARD' : 'DAYLIGHT',
    from: found.initial, to: found.initial, start: found.start + found.initial, at: found.start, lines: [],
  }];
  runs.forEach((run, i) => {
    const isOpen = open && i === runs.length - 1;
    for (const [list, rule] of [[run.ups, run.upRule], [run.downs, run.downRule]] as [Onset[], string][]) {
      const end = list[list.length - 1];
      const until = isOpen ? '' : `;UNTIL=${icalLocal(end.change.at)}Z`;
      out.push({
        kind: list[0].up ? 'DAYLIGHT' : 'STANDARD', from: list[0].change.from, to: list[0].change.to,
        start: list[0].local, at: list[0].change.at, lines: [`RRULE:FREQ=YEARLY;${rule}${until}`],
      });
    }
  });
  const groups = new Map<string, Onset[]>();
  for (const onset of single.sort((a, b) => a.local - b.local)) {
    const key = `${onset.up}|${onset.change.from}|${onset.change.to}`;
    groups.set(key, [...(groups.get(key) ?? []), onset]);
  }
  for (const group of groups.values()) {
    const [first] = group;
    out.push({
      kind: first.up ? 'DAYLIGHT' : 'STANDARD', from: first.change.from, to: first.change.to, start: first.local,
      at: first.change.at, lines: group.length > 1 ? group.map((o) => `RDATE:${icalLocal(o.local)}`) : [],
    });
  }
  if (final) {
    for (const kind of ['STANDARD', 'DAYLIGHT'] as const) {
      out.push({ kind, from: final.change.from, to: final.change.to, start: final.local, at: final.change.at, lines: [] });
    }
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

/**
 * Whether a VTIMEZONE names the offsets of a scan: at its start, on both sides
 * of every change, and between changes.
 */
function matches(vtimezone: ICAL.Component, found: Scan): boolean {
  const zone = vtimezoneZone(vtimezone);
  const points: [number, number][] = [[found.start, found.initial]];
  let previous = found.start;
  let offset = found.initial;
  const last = found.changes.length ? found.changes[found.changes.length - 1].to : found.initial;
  for (const change of [...found.changes, { at: found.end, from: last, to: last }]) {
    points.push([Math.floor((previous + change.at) / 2), offset], [change.at - 1, change.from], [change.at, change.to]);
    previous = change.at;
    offset = change.to;
  }
  return points.every(([utc, expected]) => zone.offsetAt(utc) === expected);
}

/**
 * A VTIMEZONE for an IANA zone that covers the years given (see above), as
 * an ICAL.Component.
 *
 * @throws {UpdateFieldsError} UNKNOWN_TZID for a name that is no IANA zone;
 *   UNSUPPORTED_VTIMEZONE when the zone's offset in those years is not a
 *   whole minute (local mean time, before standard time was adopted), which
 *   iCalendar readers (ical.js among them) cannot read
 */
export function vtimezoneFor(tzid: string, firstYear: number, lastYear: number): ICAL.Component {
  const zone = ianaZone(tzid);
  if (!zone) {
    throw new UpdateFieldsError('UNKNOWN_TZID', `"${tzid}" is no IANA time zone`, { remedy: 'fix-value' });
  }
  const local = wallOf(firstYear - 1, 1, 1);
  const start = local - zone.offsetAt(local);
  // A value's last year does not extend the scan: once the zone has settled
  // into its current rule or a last fixed offset, that state covers every
  // later year (UNTIL=99991231 needs nothing past it)
  void lastYear;
  // A value centuries back on local mean time is refused before scanning
  // the centuries up to today (the scan below finds the date it ended)
  if (firstYear < 1800 && zone.offsetAt(wallOf(firstYear, 1, 1)) % 60 !== 0) {
    throw new UpdateFieldsError('UNSUPPORTED_VTIMEZONE', `"${tzid}" was on local mean time in ${firstYear}, an offset ` +
      'in seconds that iCalendar readers cannot read: give values in UTC, or from the year standard time began',
    { remedy: 'fix-value' });
  }
  let endYear = LAST_SCANNED_YEAR;
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
    found = { ...found, start: resume, initial: found.changes[lastOdd].to, changes: found.changes.slice(lastOdd + 1) };
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

/** The range of years a generated VTIMEZONE is asked to cover */
export interface VtimezoneRange {
  /** the earliest year a value lies in; the VTIMEZONE starts on 1 January of the year before */
  from: number;
  /** the latest year a value lies in (default `from`); the zone's current rule covers every year after */
  to?: number;
}

/**
 * A VTIMEZONE for an IANA zone, as iCalendar text (CRLF, no trailing line
 * break), covering the years given and every year after: the same text
 * updateFields adds with `zone`. Deterministic for a given runtime (the time
 * zone data is Intl's).
 *
 * @throws {UpdateFieldsError} UNKNOWN_TZID for a name that is no IANA zone,
 *   INVALID_INPUT for a range that is no pair of integer years,
 *   UNSUPPORTED_VTIMEZONE for years on local mean time
 */
export function generateVtimezone(tzid: string, range: VtimezoneRange): string {
  const from = range?.from;
  const to = range?.to ?? from;
  if (typeof tzid !== 'string' || !Number.isInteger(from) || !Number.isInteger(to) || to < from) {
    throw new UpdateFieldsError('INVALID_INPUT', 'generateVtimezone takes an IANA zone name and { from, to? }, ' +
      'integer years with from <= to', { remedy: 'fix-value' });
  }
  const name = ianaZoneName(tzid);
  if (!name) {
    throw new UpdateFieldsError('UNKNOWN_TZID', `"${tzid}" is no IANA time zone`, { remedy: 'fix-value' });
  }
  // spelled as updateFields writes it ("europe/berlin" is "Europe/Berlin")
  return vtimezoneFor(name, from, to!).toString();
}

/** The walls (naive seconds) of the values an object writes in a TZID, and the years of its UNTILs */
function valuesIn(calendar: ICAL.Component, tzid: string): { walls: number[]; years: number[] } {
  const walls: number[] = [];
  const years: number[] = [];
  const add = (value: unknown, list: 'walls' | 'years') => {
    const m = /^(\d{4,})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2}))?/.exec(String(value));
    if (!m) {
      return;
    }
    const wall = wallOf(...([1, 2, 3, 4, 5, 6].map((i) => Number(m[i] ?? 0)) as [number, number, number, number, number, number]));
    (list === 'walls' ? walls : years).push(list === 'walls' ? wall : Number(m[1]));
  };
  const visit = (component: ICAL.Component) => {
    if (component.name === 'vtimezone') {
      return;
    }
    for (const property of component.getAllProperties()) {
      if (property.getParameter('tzid') === tzid) {
        for (const value of (property.toJSON() as unknown[]).slice(3)) {
          (Array.isArray(value) ? value : [value]).forEach((v) => add(v, 'walls'));
        }
      }
    }
    if (component.getFirstProperty('dtstart')?.getParameter('tzid') === tzid) {
      for (const name of ['rrule', 'exrule']) {
        for (const property of component.getAllProperties(name)) {
          const until = (property.toJSON() as [string, object, string, { until?: unknown }])[3]?.until;
          if (until !== undefined) {
            add(until, 'years');
          }
        }
      }
    }
    component.getAllSubcomponents().forEach(visit);
  };
  visit(calendar);
  return { walls, years };
}

/** Where a VTIMEZONE starts covering: the earliest DTSTART of its observances (a wall clock) */
function coverageStart(vtimezone: ICAL.Component): number | null {
  const starts = vtimezone.getAllSubcomponents().map((o) => o.getFirstPropertyValue('dtstart') as ICAL.Time | null)
    .filter((t): t is ICAL.Time => Boolean(t)).map((t) => wallOf(t.year, t.month, t.day, t.hour, t.minute, t.second));
  return starts.length ? Math.min(...starts) : null;
}

/** Put a VTIMEZONE into a VCALENDAR, replacing one, or before the first component that is none */
function place(calendar: ICAL.Component, vtimezone: ICAL.Component, replacing: ICAL.Component | null) {
  // a copy: getAllSubcomponents returns the list removeAllSubcomponents empties
  const all = [...calendar.getAllSubcomponents()];
  const at = replacing ? all.indexOf(replacing) : all.findIndex((c) => c.name !== 'vtimezone');
  const next = replacing ? all.map((c) => c === replacing ? vtimezone : c)
    : [...all.slice(0, at < 0 ? all.length : at), vtimezone, ...(at < 0 ? [] : all.slice(at))];
  calendar.removeAllSubcomponents();
  next.forEach((c) => calendar.addSubcomponent(c));
}

/**
 * Make sure a VCALENDAR has a VTIMEZONE for a TZID that covers every value it
 * holds in that zone. Without one, one is generated. One already there is kept
 * as it is — it is what every reader of the object reads the TZID against —
 * while it covers every value. Where a value lies before it (ical.js reads such
 * a time with offset 0), a VTIMEZONE this library generated (the same text it
 * would generate now) is generated again for the wider range; any other is
 * refused (UNSUPPORTED_VTIMEZONE), since rewriting a server's or client's own
 * definition is not this call's to do.
 */
export function ensureVtimezone(calendar: ICAL.Component, tzid: string): void {
  if (calendar.name !== 'vcalendar') {
    return;
  }
  const { walls, years } = valuesIn(calendar, tzid);
  if (!walls.length) {
    return;
  }
  const firstYear = fieldsOf(Math.min(...walls)).year;
  const lastYear = Math.max(fieldsOf(Math.max(...walls)).year, ...years);
  const existing = vtimezoneIn(calendar, tzid);
  if (!existing) {
    place(calendar, vtimezoneFor(tzid, firstYear, lastYear), null);
    return;
  }
  const start = coverageStart(existing);
  const earliest = Math.min(...walls);
  if (start === null || earliest >= start) {
    return;
  }
  const generatedFrom = fieldsOf(start).year + 1;
  let ours = false;
  try {
    ours = Boolean(ianaZone(tzid)) && vtimezoneFor(tzid, generatedFrom, generatedFrom).toString() === existing.toString();
  } catch {
    ours = false;
  }
  if (!ours) {
    throw new UpdateFieldsError('UNSUPPORTED_VTIMEZONE', `the object's VTIMEZONE "${tzid}" starts at ` +
      `${icalLocal(start)}, after ${icalLocal(earliest)}, a value in that zone; readers (ical.js among them) do not ` +
      'read a time before a VTIMEZONE\'s first observance correctly, and this VTIMEZONE is not one updateFields ' +
      'generated, so it is not rewritten: rewrite the whole object with a VTIMEZONE that covers the value',
    { remedy: 'rewrite-object' });
  }
  place(calendar, vtimezoneFor(tzid, Math.min(firstYear, generatedFrom), Math.max(lastYear, generatedFrom)), existing);
}
