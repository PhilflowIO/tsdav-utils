import ICAL from 'ical.js';
import { UpdateFieldsError } from './errors';
import { frameOf } from './typedValue';
import { dayOf, icalForm, instantOf, propertyStamps, valuesOf, wallIn } from './series';
import type { Stamp } from './series';
import type { ListMode } from './types';

/*
 * EXDATE and RDATE are lists of dates, which an object may spread over several
 * lines and comma lists (RFC 5545 3.8.5.1, 3.8.5.2), each line with its own
 * TZID and parameters. A write gives values for the list and a mode:
 *
 *  - replace: the values are the whole list. Values already there that are
 *    among them stay where they are, on their own line, in their own zone; the
 *    others go; the rest of the values given are added. So restating the list
 *    changes nothing, byte for byte.
 *  - add: the values join the list; one it holds already is not written twice.
 *  - remove: the values leave the list; one it does not hold is refused.
 *
 * Values are matched by the instant they name (see instantKey), so
 * "2026-12-24T09:00:00Z" matches "EXDATE;TZID=Europe/Berlin:20261224T100000".
 * A date in a timed series stands for every occurrence that day (see
 * dayKeyOf), as ical.js and Thunderbird read it, so it holds any time that day.
 */

/** Who asks, for the wording of a refusal: updateFields, or the occurrence helpers */
export type ListPurpose = 'cancel' | 'restore' | null;

/**
 * What identifies a value of a list. In a timed series with a zone, the
 * instant it names, whatever zone it is written in, read with RFC 5545 3.3.5
 * (so in the hour a DST change shows twice, 00:30Z and 01:30Z are two values);
 * a date there is a whole day of its own ("day ..."). In an all-day series,
 * the date; in a floating series, the wall clock. Where it names nothing to
 * compare (a floating value in a zoned series, UTC in a floating one, a zone
 * without known rules, no DTSTART) the value as written, so it matches only
 * itself.
 */
export function instantKey(master: ICAL.Component, stamp: Stamp): string {
  const written = `as written ${stamp.kind} ${stamp.tzid ?? ''} ${stamp.wall}`;
  const frame = frameOf(master);
  if (!frame) {
    return written;
  }
  try {
    if (frame.form === 'date') {
      return `day ${dayOf(wallIn(master, stamp, frame))}`;
    }
    if (stamp.kind === 'date') {
      return `day ${stamp.wall}`;
    }
    if (frame.form === 'floating') {
      return stamp.kind === 'floating' ? `wall ${stamp.wall}` : written;
    }
    const instant = instantOf(master, stamp, frame);
    return instant === null ? written : `instant ${instant}`;
  } catch {
    // its instant cannot be told: compared as written
    return written;
  }
}

/**
 * The day a timed value of a timed series falls on, on the series' wall
 * clock, in the form instantKey gives a date ("day ..."): a date in the list
 * holds every occurrence that day. Null where there is no such day to tell.
 */
export function dayKeyOf(master: ICAL.Component, stamp: Stamp): string | null {
  const frame = frameOf(master);
  if (!frame || frame.form === 'date' || stamp.kind === 'date') {
    return null;
  }
  // a floating value in a zoned series, or an instant in a floating one, names nothing
  if ((stamp.kind === 'floating') !== (frame.form === 'floating')) {
    return null;
  }
  try {
    return `day ${dayOf(wallIn(master, stamp, frame))}`;
  } catch {
    return null;
  }
}

/** The keys of a line's values; a value in the object that does not parse is refused (INVALID_VALUE) */
export function lineKeys(master: ICAL.Component, property: ICAL.Property): string[] {
  return propertyStamps(property).map((stamp) => instantKey(master, stamp));
}

/** Every key a list holds, in the series as it stands */
export function listKeys(master: ICAL.Component, name: string): Set<string> {
  return new Set(master.getAllProperties(name).flatMap((property) => lineKeys(master, property)));
}

/** Whether a list's keys hold a value: at its instant, or as a date of its day */
export function holds(master: ICAL.Component, keys: Set<string>, stamp: Stamp): boolean {
  const day = dayKeyOf(master, stamp);
  return keys.has(instantKey(master, stamp)) || (day !== null && keys.has(day));
}

/** Keep only some of a line's values; a line left empty goes */
function keepValues(master: ICAL.Component, line: ICAL.Property, keep: (index: number) => boolean) {
  const values = valuesOf(line);
  const kept = values.filter((_, i) => keep(i));
  if (!kept.length) {
    master.removeProperty(line);
  } else if (kept.length < values.length) {
    line.setValues(kept);
  }
}

/** One value the call gave */
export interface Given {
  key: string;
  /** the day it falls on, which a date in the list holds (see dayKeyOf) */
  day: string | null;
  value: unknown;
  stamp: Stamp;
  label: string;
}

/** The date a given value falls on, as a caller writes a date ("2026-12-24") */
const fieldsDate = (g: Given) => new Date(Number(g.day!.slice(4)) * 1000).toISOString().slice(0, 10);

/** Whether keys hold a given value, at its instant or as a date of its day */
const covers = (keys: Set<string>, g: Given) => keys.has(g.key) || (g.day !== null && keys.has(g.day));

/** What a list edit did, for the checks that follow it */
export interface ListOutcome {
  /**
   * the EXDATE values the call added that the list did not hold at their
   * instant, in the series' form — one held only by a date of its day too, so
   * a time that names no occurrence is not let through as held
   */
  addedExdates: Given[];
  /** every EXDATE value the call added, held before or not */
  givenExdates: Given[];
  /** per list, the line the call wrote its new values on, if any */
  written: Map<string, ICAL.Property>;
  /**
   * The days (wall clock of their midnight) restoreOccurrences took a date of
   * a timed series away from, each with the keys of the occurrences restored:
   * every other occurrence the date excluded that day is to stay excluded
   */
  liftedDays: Map<number, Set<string>>;
}

/**
 * The list edits of one call. Created before the fields are written, so it
 * knows which lines the object held; apply() after they are written (and after
 * the series has moved, so added values meet the moved ones).
 */
export class DateListEdit {
  private readonly held: Set<ICAL.Property>;

  /**
   * @param modes - lower-case list name ("exdate", "rdate") to its mode, for
   *   each list the call writes
   */
  constructor(private readonly master: ICAL.Component, readonly modes: Map<string, ListMode>,
    readonly purpose: ListPurpose = null) {
    this.held = new Set(master.getAllProperties());
  }

  /**
   * Refuses values that are no occurrence of the series (UNKNOWN_OCCURRENCE);
   * set by the series edit for restoreOccurrences, run before the list is read
   */
  checkOccurrences: ((given: Given[]) => void) | null = null;

  apply(): ListOutcome {
    const outcome: ListOutcome = { addedExdates: [], givenExdates: [], written: new Map(), liftedDays: new Map() };
    for (const [name, mode] of this.modes) {
      const lines = this.master.getAllProperties(name);
      const fresh = lines.filter((line) => !this.held.has(line));
      if (!fresh.length) {
        // not written as a list of dates (no such property in a vCard)
        continue;
      }
      const old = lines.filter((line) => this.held.has(line));
      // every mode reads the list: a value there that does not parse is refused
      const oldKeys = old.map((property) => lineKeys(this.master, property));
      const given = this.given(name, fresh);
      const [line, ...rest] = fresh;
      for (const extra of rest) {
        this.master.removeProperty(extra);
      }
      if (mode === 'remove') {
        this.master.removeProperty(line);
        this.remove(name, old, oldKeys, given, outcome);
        continue;
      }
      const present = new Set<string>();
      if (mode === 'add') {
        oldKeys.flat().forEach((key) => present.add(key));
      } else {
        // a value stays when it is given again: at its instant, or a date of
        // a timed series when a value that day is given
        const wanted = new Set(given.flatMap((g) => g.day === null ? [g.key] : [g.key, g.day]));
        old.forEach((property, n) => keepValues(this.master, property, (i) => {
          const key = oldKeys[n][i];
          return wanted.has(key) && Boolean(present.add(key));
        }));
      }
      const added = given.filter((g) => !covers(present, g));
      if (added.length) {
        line.setValues(added.map((g) => g.value));
        outcome.written.set(name, line);
      } else {
        this.master.removeProperty(line);
      }
      if (name === 'exdate' && mode === 'add') {
        outcome.addedExdates.push(...given.filter((g) => !present.has(g.key)));
        outcome.givenExdates.push(...given);
      }
    }
    return outcome;
  }

  /** The values the call gave for a list, each once */
  private given(name: string, fresh: ICAL.Property[]): Given[] {
    const seen = new Set<string>();
    return fresh.flatMap((line) => {
      const values = valuesOf(line);
      return propertyStamps(line).flatMap((stamp, i) => {
        const key = instantKey(this.master, stamp);
        if (seen.has(key)) {
          return [];
        }
        seen.add(key);
        return [{ key, day: dayKeyOf(this.master, stamp), value: values[i], stamp,
          label: `${name.toUpperCase()} ${icalForm(String(values[i]))}` }];
      });
    });
  }

  /**
   * Take values out of a list, each matched directly against the values held,
   * by instant (or as a date given as a date); refused, naming them, where the
   * list does not hold one.
   *
   * A date of a timed series excludes every occurrence that day. Restoring one
   * of them (restoreOccurrences) takes the date away and records the day, so
   * the other occurrences it excluded are excluded one by one instead (see
   * ListOutcome.liftedDays) and exactly the restored ones come back. A plain
   * remove of a time held only by such a date is refused, as it cannot tell
   * which of the two the caller means.
   */
  private remove(name: string, old: ICAL.Property[], oldKeys: string[][], given: Given[], outcome: ListOutcome) {
    const upper = name.toUpperCase();
    const held = new Set(oldKeys.flat());
    const restore = this.purpose === 'restore';
    if (restore) {
      this.checkOccurrences?.(given);
    }
    const missing = given.filter((g) => restore ? !covers(held, g) : !held.has(g.key));
    if (missing.length) {
      const list = old.map((property) => property.toICALString()).join(', ');
      const values = missing.map((g) => icalForm(String(g.value))).join(', ');
      const byDate = !restore && missing.every((g) => g.day !== null && held.has(g.day));
      throw new UpdateFieldsError('NOT_IN_LIST', restore
        ? `${values} ${missing.length > 1 ? 'are' : 'is'} not cancelled: no EXDATE names ${missing.length > 1 ? 'them' : 'it'} ` +
          `(${list || 'the series has no EXDATE'}). Give the original start of a cancelled occurrence`
        : byDate
          ? `${missing.map((g) => g.label).join(', ')} ${missing.length > 1 ? 'are' : 'is'} not in the list as such: ` +
            `a date in it (${list}) excludes the whole day. Give the date (e.g. "${fieldsDate(missing[0])}") to remove ` +
            'it, which brings back every occurrence that day, or use restoreOccurrences to bring back this occurrence only'
          : `${missing.map((g) => g.label).join(', ')} ${missing.length > 1 ? 'are' : 'is'} not in the list ` +
            `(${list || `the object has no ${upper}`}), so there is nothing to remove. Give a value the list holds, ` +
            'at the same instant (in any zone)', { remedy: 'fix-value', property: upper });
    }
    const remove = new Set(given.map((g) => g.key));
    if (restore) {
      for (const g of given) {
        if (g.day !== null && held.has(g.day)) {
          remove.add(g.day);
          const day = Number(g.day.slice(4));
          outcome.liftedDays.set(day, (outcome.liftedDays.get(day) ?? new Set()).add(g.key));
        }
      }
    }
    old.forEach((property, n) => keepValues(this.master, property, (i) => !remove.has(oldKeys[n][i])));
  }
}
