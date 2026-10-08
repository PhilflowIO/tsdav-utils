import { UpdateFieldsError } from './errors';
import { editFields } from './updateFields';
import type { CalendarObjectInput, ComponentType } from './types';

/*
 * Cancel and restore single occurrences of a recurring event, todo or journal,
 * named the way expandOccurrences names them: by their original start
 * (Occurrence.recurrenceId.value), which an override does not change.
 */

export interface OccurrenceEditOptions {
  /** the component type, as for updateFields */
  type?: ComponentType;
}

/** The ids as one EXDATE value, each checked to be one date or date-time */
function idList(ids: unknown, what: string): string {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new UpdateFieldsError('INVALID_INPUT', `${what} needs a non-empty list of occurrence starts, e.g. ` +
      '["2026-12-24T10:00:00"]', { remedy: 'fix-value' });
  }
  for (const id of ids) {
    if (typeof id !== 'string' || id.trim() === '' || id.includes(',')) {
      throw new UpdateFieldsError('INVALID_INPUT', `${what}: each occurrence is one date or date-time string, ` +
        `not ${typeof id === 'string' ? `"${id}"` : id === null ? 'null' : typeof id}`, { remedy: 'fix-value' });
    }
  }
  return ids.join(',');
}

/**
 * Cancel occurrences of a series: each is excluded with an EXDATE, written in
 * the series' own form and zone, and its override (the component with that
 * RECURRENCE-ID), if any, goes too, so nothing is left that applies to
 * nothing. An occurrence cancelled already is left as it is.
 *
 * @param ids - the original starts of the occurrences: as expandOccurrences
 *   gives them (Occurrence.recurrenceId.value — for an override the original
 *   start, not where it was moved to), or with "Z" or an offset; matched by
 *   instant, by date in an all-day series
 * @throws {UpdateFieldsError} UNKNOWN_OCCURRENCE for an id that is no
 *   occurrence of the series; otherwise as updateFields
 */
export function cancelOccurrences(calendarObject: CalendarObjectInput, ids: readonly string[],
  options: OccurrenceEditOptions = {}): string {
  return editFields(calendarObject, { EXDATE: idList(ids, 'cancelOccurrences') },
    { type: options?.type, absoluteTime: 'keep-zone', lists: { EXDATE: 'add' } }, 'cancel');
}

/**
 * Restore cancelled occurrences: the EXDATE values naming them are removed,
 * whatever line and zone each is written in. An override removed when the
 * occurrence was cancelled does not come back; the occurrence is the series'.
 *
 * @param ids - the original starts, in the same forms as for cancelOccurrences
 * @throws {UpdateFieldsError} NOT_IN_LIST for an id no EXDATE names; otherwise
 *   as updateFields
 */
export function restoreOccurrences(calendarObject: CalendarObjectInput, ids: readonly string[],
  options: OccurrenceEditOptions = {}): string {
  return editFields(calendarObject, { EXDATE: idList(ids, 'restoreOccurrences') },
    { type: options?.type, absoluteTime: 'keep-zone', lists: { EXDATE: 'remove' } }, 'restore');
}
