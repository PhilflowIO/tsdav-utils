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
 *  - replace: the values are the whole list. Values already there whose
 *    instant is among them stay where they are, on their own line, in their
 *    own zone; the others go; the rest of the values given are added. So
 *    restating the list changes nothing, byte for byte.
 *  - add: the values join the list; one it holds already is not written twice.
 *  - remove: the values leave the list; one it does not hold is refused.
 *
 * Values are matched by instant, read on the series' wall clock (see
 * instantKey), so "2026-12-24T09:00:00Z" matches
 * "EXDATE;TZID=Europe/Berlin:20261224T100000".
 */

/** Who asks, for the wording of a refusal: updateFields, or the occurrence helpers */
export type ListPurpose = 'cancel' | 'restore' | null;

/**
 * What identifies a value of a list. In a timed series with a zone, the
 * instant it names, whatever zone it is written in, read with RFC 5545 3.3.5
 * (so in the hour a DST change shows twice, 00:30Z and 01:30Z are two values);
 * a date there is a whole day of its own. In an all-day series, the date; in a
 * floating series, the wall clock. Where it names nothing to compare (a
 * floating value in a zoned series, UTC in a floating one, a zone without
 * known rules, no DTSTART) the value as written, so it matches only itself.
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

/** The keys of a line's values, or null when the object's line does not parse */
export function lineKeys(master: ICAL.Component, property: ICAL.Property): string[] | null {
  try {
    return propertyStamps(property).map((stamp) => instantKey(master, stamp));
  } catch {
    return null;
  }
}

/** Every key a list holds, in the series as it stands */
export function listKeys(master: ICAL.Component, name: string): Set<string> {
  return new Set(master.getAllProperties(name).flatMap((property) => lineKeys(master, property) ?? []));
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
interface Given {
  key: string;
  value: unknown;
  stamp: Stamp;
  label: string;
}

/** What a list edit did, for the checks that follow it */
export interface ListOutcome {
  /** the EXDATE values the call added that the list did not hold, in the series' form */
  addedExdates: Given[];
  /** the keys of every EXDATE value the call added, held before or not */
  givenExdates: Set<string>;
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

  apply(): ListOutcome {
    const outcome: ListOutcome = { addedExdates: [], givenExdates: new Set() };
    for (const [name, mode] of this.modes) {
      const lines = this.master.getAllProperties(name);
      const fresh = lines.filter((line) => !this.held.has(line));
      if (!fresh.length) {
        // not written as a list of dates (no such property in a vCard)
        continue;
      }
      const old = lines.filter((line) => this.held.has(line));
      const given = this.given(name, fresh);
      const [line, ...rest] = fresh;
      for (const extra of rest) {
        this.master.removeProperty(extra);
      }
      if (mode === 'remove') {
        this.master.removeProperty(line);
        this.remove(name, old, given);
        continue;
      }
      const wanted = new Set(given.map((g) => g.key));
      const present = new Set<string>();
      for (const property of old) {
        const keys = lineKeys(this.master, property);
        if (mode === 'add') {
          keys?.forEach((key) => present.add(key));
        } else if (!keys) {
          // a value that does not parse is not among the ones given
          this.master.removeProperty(property);
        } else {
          keepValues(this.master, property, (i) => wanted.has(keys[i]) && Boolean(present.add(keys[i])));
        }
      }
      const added = given.filter((g) => !present.has(g.key));
      if (added.length) {
        line.setValues(added.map((g) => g.value));
      } else {
        this.master.removeProperty(line);
      }
      if (name === 'exdate' && mode === 'add') {
        outcome.addedExdates.push(...added);
        given.forEach((g) => outcome.givenExdates.add(g.key));
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
        return [{ key, value: values[i], stamp, label: `${name.toUpperCase()} ${icalForm(String(values[i]))}` }];
      });
    });
  }

  /** Take values out of a list; refused, naming them, where the list does not hold one */
  private remove(name: string, old: ICAL.Property[], given: Given[]) {
    const upper = name.toUpperCase();
    const remove = new Set(given.map((g) => g.key));
    const holds = new Set(old.flatMap((property) => lineKeys(this.master, property) ?? []));
    const missing = given.filter((g) => !holds.has(g.key));
    if (missing.length) {
      const list = old.map((property) => property.toICALString()).join(', ');
      const values = missing.map((g) => icalForm(String(g.value))).join(', ');
      throw new UpdateFieldsError('NOT_IN_LIST', this.purpose === 'restore'
        ? `${values} ${missing.length > 1 ? 'are' : 'is'} not cancelled: no EXDATE names ${missing.length > 1 ? 'them' : 'it'} ` +
          `(${list || 'the series has no EXDATE'}). Give the original start of a cancelled occurrence`
        : `${missing.map((g) => g.label).join(', ')} ${missing.length > 1 ? 'are' : 'is'} not in the list ` +
          `(${list || `the object has no ${upper}`}), so there is nothing to remove. Give a value the list holds, ` +
          'at the same instant (in any zone)', { remedy: 'fix-value', property: upper });
    }
    for (const property of old) {
      const keys = lineKeys(this.master, property);
      if (keys) {
        keepValues(this.master, property, (i) => !remove.has(keys[i]));
      }
    }
  }
}
