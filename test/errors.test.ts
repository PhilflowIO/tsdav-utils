import { describe, expect, it } from 'vitest';
import ICAL from 'ical.js';
import {
  UPDATE_FIELDS_ERROR_CODES,
  UpdateFieldsError,
  isUpdateFieldsError,
  parseDateValue,
  seriesMaster,
  updateFields,
} from '../src/index';
import type { UpdateFieldsErrorCode, UpdateFieldsRemedy } from '../src/index';

const calendar = (...lines: string[]) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...lines, 'END:VCALENDAR', ''].join('\r\n');
const event = (...lines: string[]) => ['BEGIN:VEVENT', 'UID:e', 'DTSTAMP:20260101T000000Z', ...lines, 'END:VEVENT'];
const timed = calendar(...event('DTSTART:20261005T090000Z', 'DTEND:20261005T100000Z'));
const weekly = (...extra: string[]) => calendar(
  ...event('DTSTART:20261005T090000Z', 'RRULE:FREQ=WEEKLY;COUNT=10', ...extra),
  ...event('RECURRENCE-ID:20261012T090000Z', 'DTSTART:20261012T130000Z'));
const card = ['BEGIN:VCARD', 'VERSION:4.0', 'FN:A', 'END:VCARD', ''].join('\r\n');

/** One input that is refused, and what the refusal has to say about itself */
interface Case {
  name: string;
  call: () => unknown;
  remedy: UpdateFieldsRemedy;
  property?: string;
  suggestion?: string;
  message?: RegExp;
}

/**
 * Every code with at least one input producing it. Typed against every code,
 * so a code without a row does not compile.
 */
const CASES = {
  INVALID_INPUT: [
    { name: 'no iCalendar text', call: () => updateFields({ data: '' }, { SUMMARY: 'x' }), remedy: 'fix-value' },
    { name: 'calendarObject null', call: () => updateFields(null as never, { SUMMARY: 'x' }), remedy: 'fix-value' },
    { name: 'fields null', call: () => updateFields(timed, null as never), remedy: 'fix-value',
      message: /fields must be an object .* not null/ },
    { name: 'options null', call: () => updateFields(timed, {}, null as never), remedy: 'fix-value' },
    { name: 'parseDateValue of a number', call: () => parseDateValue(5 as never), remedy: 'fix-value' },
    { name: 'two top-level components', call: () => updateFields(timed + timed, { SUMMARY: 'x' }), remedy: 'fix-value',
      message: /holds 2 top-level components/ },
  ],
  INVALID_ICALENDAR: [
    { name: 'text that does not parse', call: () => updateFields('this is not iCalendar', { SUMMARY: 'x' }),
      remedy: 'rewrite-object' },
  ],
  INVALID_TYPE: [
    { name: 'in updateFields', call: () => updateFields(timed, { SUMMARY: 'x' }, { type: 'event' as never }),
      remedy: 'fix-value' },
    { name: 'in seriesMaster', call: () => seriesMaster(new ICAL.Component(ICAL.parse(timed)), 'VCALENDAR' as never),
      remedy: 'fix-value' },
  ],
  INVALID_FLOATING_TIME: [
    { name: 'an unknown floatingTime', call: () => updateFields(timed, { SUMMARY: 'x' }, { floatingTime: 'utc' as never }),
      remedy: 'fix-value' },
  ],
  INVALID_ABSOLUTE_TIME: [
    { name: 'an unknown absoluteTime', call: () => updateFields(timed, { SUMMARY: 'x' }, { absoluteTime: 'utc' as never }),
      remedy: 'fix-value' },
  ],
  COMPONENT_NOT_FOUND: [
    { name: 'a type the VCALENDAR does not hold', call: () => updateFields(timed, { SUMMARY: 'x' }, { type: 'vtodo' }),
      remedy: 'fix-value' },
  ],
  WRONG_OBJECT_KIND: [
    { name: 'a type on a vCard', call: () => updateFields(card, { FN: 'B' }, { type: 'vevent' }), remedy: 'none' },
    { name: 'a type on a bare component of another type', remedy: 'fix-value',
      call: () => updateFields(['BEGIN:VTODO', 'UID:t', 'END:VTODO'].join('\r\n'), { SUMMARY: 'x' }, { type: 'vevent' }) },
  ],
  NO_MASTER: [
    { name: 'several detached instances', remedy: 'rewrite-object', call: () => updateFields(calendar(
      ...event('RECURRENCE-ID:20261005T090000Z', 'DTSTART:20261005T090000Z'),
      ...event('RECURRENCE-ID:20261012T090000Z', 'DTSTART:20261012T090000Z'),
    ), { SUMMARY: 'x' }) },
  ],
  INVALID_VALUE: [
    { name: 'an unparseable DTEND', call: () => updateFields(timed, { DTEND: 'tomorrow' }), remedy: 'fix-value',
      property: 'DTEND', message: /^DTEND: "tomorrow" is not a date or date-time/ },
    { name: 'an impossible date', call: () => parseDateValue('2026-02-30'), remedy: 'fix-value' },
    { name: 'an impossible offset', call: () => parseDateValue('2026-10-26T18:00:00+25:00'), remedy: 'fix-value' },
    { name: 'an unparseable UNTIL', call: () => updateFields(timed, { RRULE: 'FREQ=DAILY;UNTIL=soon' }),
      remedy: 'fix-value', property: 'RRULE' },
    { name: 'a number', call: () => updateFields(timed, { DTEND: 42 as never }), remedy: 'fix-value', property: 'DTEND' },
    { name: 'undefined', call: () => updateFields(timed, { RRULE: undefined as never }), remedy: 'fix-value',
      property: 'RRULE' },
    { name: 'null', call: () => updateFields(timed, { EXDATE: null as never }), remedy: 'fix-value', property: 'EXDATE' },
    { name: 'a malformed DTSTART in the object, on a move', remedy: 'rewrite-object', property: 'DTSTART',
      call: () => updateFields(calendar(...event('DTSTART:garbage', 'RRULE:FREQ=DAILY')), { DTSTART: '2026-10-06T09:00:00Z' }) },
    { name: 'a malformed EXDATE in the object, on a move', remedy: 'same-call', property: 'EXDATE',
      call: () => updateFields(calendar(...event('DTSTART:20261005T090000Z', 'RRULE:FREQ=DAILY', 'EXDATE:garbage')),
        { DTSTART: '2026-10-05T10:00:00Z' }) },
    { name: 'a malformed EXDATE in the object, on a new rule', remedy: 'rewrite-object', property: 'EXDATE',
      call: () => updateFields(weekly('EXDATE:garbage'), { RRULE: 'FREQ=WEEKLY;COUNT=12' }) },
  ],
  VALUE_TYPE_MISMATCH: [
    { name: 'a date DTEND next to a timed DTSTART', call: () => updateFields(timed, { DTEND: '2026-10-06' }),
      remedy: 'fix-value', property: 'DTEND' },
    { name: 'dates and date-times mixed', call: () => updateFields(timed, { EXDATE: '2026-10-06,2026-10-07T09:00:00Z' }),
      remedy: 'fix-value', property: 'EXDATE' },
    { name: 'a date UNTIL next to a timed DTSTART', call: () => updateFields(timed, { RRULE: 'FREQ=DAILY;UNTIL=20261010' }),
      remedy: 'fix-value', property: 'RRULE' },
  ],
  ZONE_MISMATCH: [
    { name: 'a zoneless DTEND next to a UTC DTSTART', call: () => updateFields(timed, { DTEND: '2026-10-05T11:00:00' }),
      remedy: 'fix-value', property: 'DTEND' },
    { name: 'a zoneless DTSTAMP', call: () => updateFields(timed, { DTSTAMP: '2026-10-05T11:00:00' }),
      remedy: 'fix-value', property: 'DTSTAMP' },
    { name: 'a zoneless UNTIL next to a UTC DTSTART', remedy: 'fix-value', property: 'RRULE',
      call: () => updateFields(timed, { RRULE: 'FREQ=DAILY;UNTIL=20261010T090000' }) },
  ],
  UNKNOWN_TZID: [
    { name: 'an UNTIL to convert from an unknown zone', remedy: 'fix-value', property: 'RRULE',
      call: () => updateFields(calendar(...event('DTSTART;TZID=Nowhere/Zone:20261005T090000')),
        { RRULE: 'FREQ=DAILY;UNTIL=20261010T090000' }) },
    // the same zone found by a move and by a new rule: the same code
    { name: 'an override in an unknown zone, on a move', remedy: 'rewrite-object', property: 'RECURRENCE-ID',
      call: () => updateFields(calendar(
        ...event('DTSTART:20261005T090000Z', 'RRULE:FREQ=DAILY'),
        ...event('RECURRENCE-ID;TZID=Nowhere/Zone:20261010T110000', 'DTSTART:20261010T090000Z')),
      { DTSTART: '2026-10-05T10:00:00Z' }) },
    { name: 'an override in an unknown zone, on a new rule', remedy: 'rewrite-object',
      call: () => updateFields(calendar(
        ...event('DTSTART:20261005T090000Z', 'RRULE:FREQ=DAILY'),
        ...event('RECURRENCE-ID;TZID=Nowhere/Zone:20261010T110000', 'DTSTART:20261010T090000Z')),
      { RRULE: 'FREQ=DAILY;COUNT=20' }) },
  ],
  UNSUPPORTED_VTIMEZONE: [
    { name: 'a VTIMEZONE that repeats daily', remedy: 'rewrite-object', call: () => updateFields(calendar(
      'BEGIN:VTIMEZONE', 'TZID:Hostile/Zone',
      'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'DTSTART:19700101T000000',
      'RRULE:FREQ=DAILY', 'END:STANDARD', 'END:VTIMEZONE',
      ...event('DTSTART;TZID=Hostile/Zone:20261005T090000'),
    ), { RRULE: 'FREQ=DAILY;UNTIL=20261010T090000' }) },
  ],
  UNKNOWN_RULE_PART: [
    { name: 'an undefined part', call: () => updateFields(timed, { RRULE: 'FREQ=DAILY;FOO=1' }), remedy: 'fix-value',
      property: 'RRULE' },
    { name: 'RSCALE', call: () => updateFields(timed, { RRULE: 'RSCALE=GREGORIAN;FREQ=DAILY' }), remedy: 'fix-value' },
    { name: 'the property prefix', call: () => updateFields(timed, { RRULE: 'RRULE:FREQ=DAILY' }), remedy: 'fix-value' },
  ],
  DUPLICATE_RULE_PART: [
    { name: 'COUNT twice', call: () => updateFields(timed, { RRULE: 'FREQ=DAILY;COUNT=1;COUNT=2' }), remedy: 'fix-value',
      property: 'RRULE' },
  ],
  INVALID_RULE: [
    { name: 'no FREQ', call: () => updateFields(timed, { RRULE: 'COUNT=5' }), remedy: 'fix-value', property: 'RRULE' },
    { name: 'COUNT=0', call: () => updateFields(timed, { RRULE: 'FREQ=DAILY;COUNT=0' }), remedy: 'fix-value' },
    { name: 'COUNT with UNTIL', call: () => updateFields(timed, { RRULE: 'FREQ=DAILY;COUNT=2;UNTIL=20261010T090000Z' }),
      remedy: 'fix-value' },
    { name: 'a malformed UNTIL in the object, on a move', remedy: 'rewrite-object', property: 'RRULE',
      message: /^the object's RRULE cannot be read: /,
      call: () => updateFields(calendar(...event('DTSTART:20261005T090000Z', 'RRULE:FREQ=DAILY;UNTIL=garbage')),
        { DTSTART: '2026-10-05T10:00:00Z' }) },
  ],
  RECURRENCE_ID_ON_MASTER: [
    { name: 'RECURRENCE-ID on the master', call: () => updateFields(timed, { 'RECURRENCE-ID': '2026-10-05T09:00:00Z' }),
      remedy: 'rewrite-object', property: 'RECURRENCE-ID' },
  ],
  SERIES_MOVE_REFUSED: [
    { name: 'a rule that pins the old start, with the rule to give', remedy: 'same-call', property: 'RRULE',
      suggestion: 'FREQ=DAILY;COUNT=5;BYHOUR=10', message: /\(e\.g\. RRULE "FREQ=DAILY;COUNT=5;BYHOUR=10"\)/,
      call: () => updateFields(calendar(...event('DTSTART:20261005T090000Z', 'RRULE:FREQ=DAILY;BYHOUR=9;COUNT=5')),
        { DTSTART: '2026-10-05T10:00:00Z' }) },
    { name: 'an RDATE of periods', remedy: 'same-call', property: 'RDATE',
      call: () => updateFields(calendar(...event('DTSTART:20261005T090000Z', 'RRULE:FREQ=DAILY;COUNT=5',
        'RDATE;VALUE=PERIOD:20261020T090000Z/PT1H')), { DTSTART: '2026-10-05T10:00:00Z' }) },
    { name: 'an override at another time of day on the switch to all-day', remedy: 'rewrite-object',
      property: 'RECURRENCE-ID', call: () => updateFields(calendar(
        ...event('DTSTART:20261005T090000Z', 'RRULE:FREQ=WEEKLY'),
        ...event('RECURRENCE-ID:20261012T100000Z', 'DTSTART:20261012T130000Z')), { DTSTART: '2026-10-05' }) },
  ],
  ORPHANED_EXCEPTIONS: [
    { name: 'a new rule that drops an overridden occurrence', remedy: 'same-call', property: 'RRULE',
      call: () => updateFields(weekly(), { RRULE: 'FREQ=WEEKLY;COUNT=1' }) },
  ],
  DST_AMBIGUOUS: [
    // 2026-10-25 00:30Z is 02:30 CEST, a wall clock Berlin shows twice that night
    { name: 'an UNTIL in the hour the fall-back shows twice', remedy: 'same-call', property: 'RRULE',
      call: () => updateFields(calendar(...event(
        'DTSTART;TZID=Europe/Berlin:20261001T090000', 'RRULE:FREQ=DAILY;UNTIL=20261025T003000Z')),
      { DTSTART: '2026-10-01T10:00:00' }) },
    // 01:30Z on 29 March is the instant of the skipped 02:30 occurrence
    { name: 'an EXDATE that is the twin of a skipped occurrence', remedy: 'rewrite-object',
      message: /^Writing RRULE is refused: EXDATE:20260329T013000Z names the same instant/,
      call: () => updateFields(calendar(...event('DTSTART;TZID=Europe/Berlin:20260322T023000', 'RRULE:FREQ=WEEKLY;COUNT=4',
        'EXDATE:20260329T013000Z')), { RRULE: 'FREQ=WEEKLY;COUNT=5' }) },
    { name: 'an instant in the second pass, kept in its zone', remedy: 'fix-value', property: 'DTSTART',
      call: () => updateFields(calendar(...event('DTSTART;TZID=Europe/Berlin:20261024T090000')),
        { DTSTART: '2026-10-25T01:30:00Z' }, { absoluteTime: 'keep-zone' }) },
  ],
  CHECK_LIMIT_EXCEEDED: [
    { name: 'a new rule too sparse to check the override against', remedy: 'rewrite-object',
      message: /^Cannot check that the overrides and EXDATEs still name occurrences/,
      call: () => updateFields(calendar(
        ...event('DTSTART:20260101T235959Z', 'RRULE:FREQ=DAILY'),
        ...event('RECURRENCE-ID:20261231T235959Z', 'DTSTART:20261231T235959Z'),
      ), { RRULE: 'FREQ=SECONDLY;BYMONTH=12;BYMONTHDAY=31;BYHOUR=23;BYMINUTE=59;BYSECOND=59' }) },
    // the EXDATE is the twin of a skipped 02:30 a century ahead, too far to expand to
    { name: 'a move whose EXDATE lies too far ahead to check', remedy: 'same-call',
      message: /^Cannot check that moving DTSTART keeps the series' occurrences: .*too far ahead/,
      call: () => updateFields(calendar(...event('DTSTART;TZID=Europe/Berlin:20260322T023000', 'RRULE:FREQ=DAILY',
        'EXDATE:21260331T013000Z')), { DTSTART: '2026-03-22T03:30:00' }) },
  ],
  SERIES_UNVERIFIABLE: [
    { name: 'a series without DTSTART to check the override against', remedy: 'rewrite-object',
      call: () => updateFields(calendar(
        ...event('SUMMARY:no start'),
        ...event('RECURRENCE-ID:20261012T090000Z', 'DTSTART:20261012T130000Z'),
      ), { RRULE: 'FREQ=WEEKLY' }) },
  ],
} satisfies Record<UpdateFieldsErrorCode, Case[]>;

function thrown(call: () => unknown): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  throw new Error('not refused');
}

describe('UpdateFieldsError codes', () => {
  describe.each(Object.entries(CASES) as [UpdateFieldsErrorCode, Case[]][])('%s', (code, cases) => {
    it.each(cases.map((c) => [c.name, c] as const))('%s', (_, c) => {
      const error = thrown(c.call) as UpdateFieldsError;
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(UpdateFieldsError);
      expect({ name: error.name, code: error.code, remedy: error.remedy, message: error.message })
        .toMatchObject({ name: 'UpdateFieldsError', code, remedy: c.remedy });
      expect(isUpdateFieldsError(error, code)).toBe(true);
      if (c.property !== undefined) {
        expect(error.property).toBe(c.property);
      }
      expect(error.suggestion).toBe(c.suggestion);
      if (c.message) {
        expect(error.message).toMatch(c.message);
      }
    });
  });

  it('lists every code once, frozen', () => {
    expect(new Set(UPDATE_FIELDS_ERROR_CODES).size).toBe(UPDATE_FIELDS_ERROR_CODES.length);
    expect(Object.keys(CASES).sort()).toEqual([...UPDATE_FIELDS_ERROR_CODES].sort());
    expect(Object.isFrozen(UPDATE_FIELDS_ERROR_CODES)).toBe(true);
  });

  it('keeps the refusal it reports with a longer message as its cause', () => {
    const error = thrown(() => updateFields(timed, { DTEND: 'tomorrow' })) as UpdateFieldsError;
    expect(error.cause).toBeInstanceOf(UpdateFieldsError);
    expect((error.cause as UpdateFieldsError).code).toBe('INVALID_VALUE');
  });

  it('serialises with its message, code and remedy', () => {
    const error = thrown(() => updateFields(timed, { DTEND: 'tomorrow' })) as UpdateFieldsError;
    expect(JSON.parse(JSON.stringify(error))).toEqual({
      name: 'UpdateFieldsError', code: 'INVALID_VALUE', remedy: 'fix-value', property: 'DTEND', message: error.message,
    });
  });

  it('leaves a malformed rule the write does not touch as it was, byte for byte', () => {
    const out = updateFields(calendar(...event('DTSTART:20261005T090000Z', 'RRULE:FREQ=DAILY;UNTIL=garbage')),
      { SUMMARY: 'renamed' });
    expect(out).toContain('SUMMARY:renamed');
    expect(out.split('\r\n')).toContain('RRULE:FREQ=DAILY;UNTIL=garbage');
  });

  it('leaves a rule the write does not touch as the object spells it', () => {
    const out = updateFields(calendar(...event('DTSTART:20261005T090000Z', 'RRULE:COUNT=5;BYHOUR=9;FREQ=DAILY')),
      { SUMMARY: 'renamed' });
    expect(out.split('\r\n')).toContain('RRULE:COUNT=5;BYHOUR=9;FREQ=DAILY');
    expect(out).not.toContain('X-TSDAV-UTILS-RULE');
  });

  it('carries the ical.js parse error as cause', () => {
    const error = thrown(() => updateFields('this is not iCalendar', { SUMMARY: 'x' })) as UpdateFieldsError;
    expect(error.cause).toBeInstanceOf(Error);
  });
});

describe('a failure of the library is no refusal', () => {
  const plain = (call: () => unknown, patch: () => () => void) => {
    const restore = patch();
    let error: unknown;
    try {
      error = thrown(call);
    } finally {
      restore();
    }
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(UpdateFieldsError);
    expect(isUpdateFieldsError(error)).toBe(false);
    return error as Error;
  };
  const proto = (ICAL as unknown as Record<string, { prototype: Record<string, unknown> }>);

  it('throws a plain Error when ical.js lacks the step the work limit hooks into', () => {
    const error = plain(() => updateFields(weekly(), { RRULE: 'FREQ=WEEKLY;COUNT=12' }), () => {
      const it = proto.RecurIterator.prototype;
      const hook = it.check_contracting_rules;
      delete it.check_contracting_rules;
      return () => { it.check_contracting_rules = hook; };
    });
    expect(error.message).toBe('Cannot check the series: ical.js no longer exposes the step a rule expansion can be bounded at');
    expect((error as { cause?: unknown }).cause).toBeInstanceOf(Error);
  });

  it('throws a plain Error when ical.js fails while moving an EXDATE', () => {
    const error = plain(() => updateFields(calendar(...event('DTSTART:20261005T090000Z', 'RRULE:FREQ=DAILY',
      'EXDATE:20261007T090000Z')), { DTSTART: '2026-10-05T10:00:00Z' }), () => {
      const property = proto.Property.prototype;
      const setValues = property.setValues;
      property.setValues = () => { throw new TypeError('broken'); };
      return () => { property.setValues = setValues; };
    });
    expect((error as { cause?: unknown }).cause).toBeInstanceOf(TypeError);
  });

  it('throws a plain Error when ical.js fails while expanding a rule', () => {
    plain(() => updateFields(weekly(), { RRULE: 'FREQ=WEEKLY;COUNT=12' }), () => {
      const it = proto.RecurIterator.prototype;
      const next = it.next;
      it.next = () => { throw new TypeError('broken'); };
      return () => { it.next = next; };
    });
  });
});

describe('isUpdateFieldsError', () => {
  it('is false for a plain Error, a lookalike without a known code, and non-errors', () => {
    expect(isUpdateFieldsError(new Error('x'))).toBe(false);
    expect(isUpdateFieldsError(Object.assign(new Error('x'), { name: 'UpdateFieldsError', code: 'NOPE' }))).toBe(false);
    expect(isUpdateFieldsError({ name: 'UpdateFieldsError', code: 'INVALID_VALUE' })).toBe(false);
    expect(isUpdateFieldsError(undefined)).toBe(false);
  });

  it('holds for a refusal from another copy of the class (ESM next to CommonJS)', () => {
    const other = Object.assign(new Error('x'), { name: 'UpdateFieldsError', code: 'INVALID_VALUE' });
    expect(isUpdateFieldsError(other, 'INVALID_VALUE')).toBe(true);
    expect(isUpdateFieldsError(other, 'INVALID_RULE')).toBe(false);
  });

  it('narrows to the code asked for', () => {
    const error: unknown = thrown(() => updateFields(timed, { RRULE: 'COUNT=5' }));
    if (isUpdateFieldsError(error, 'INVALID_RULE')) {
      const code: 'INVALID_RULE' = error.code; // a compile error if the guard does not narrow
      expect(code).toBe('INVALID_RULE');
    } else {
      throw new Error('not narrowed');
    }
  });
});
