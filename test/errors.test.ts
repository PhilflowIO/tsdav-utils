import { afterAll, describe, expect, it } from 'vitest';
import ICAL from 'ical.js';
import {
  UPDATE_FIELDS_ERROR_CODES,
  UpdateFieldsError,
  isUpdateFieldsError,
  parseDateValue,
  seriesMaster,
  updateFields,
} from '../src/index';
import type { UpdateFieldsErrorCode } from '../src/index';

const calendar = (...lines: string[]) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...lines, 'END:VCALENDAR', ''].join('\r\n');
const event = (...lines: string[]) => ['BEGIN:VEVENT', 'UID:e', 'DTSTAMP:20260101T000000Z', ...lines, 'END:VEVENT'];
const timed = calendar(...event('DTSTART:20261005T090000Z', 'DTEND:20261005T100000Z'));
const weekly = (...extra: string[]) => calendar(
  ...event('DTSTART:20261005T090000Z', 'RRULE:FREQ=WEEKLY;COUNT=10'),
  ...event('RECURRENCE-ID:20261012T090000Z', 'DTSTART:20261012T130000Z'),
  ...extra);

const seen = new Set<UpdateFieldsErrorCode>();

/** The error a call throws, checked to be a refusal with that code */
function refusal(code: UpdateFieldsErrorCode, call: () => unknown): UpdateFieldsError {
  let thrown: unknown;
  try {
    call();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect(thrown).toBeInstanceOf(UpdateFieldsError);
  expect((thrown as Error).name).toBe('UpdateFieldsError');
  expect({ code: (thrown as UpdateFieldsError).code, message: (thrown as Error).message })
    .toMatchObject({ code });
  expect(isUpdateFieldsError(thrown)).toBe(true);
  expect(isUpdateFieldsError(thrown, code)).toBe(true);
  seen.add(code);
  return thrown as UpdateFieldsError;
}

describe('UpdateFieldsError codes', () => {
  it('INVALID_INPUT: no iCalendar text', () => {
    refusal('INVALID_INPUT', () => updateFields({ data: '' }, { SUMMARY: 'x' }));
  });

  it('INVALID_ICALENDAR: text that does not parse', () => {
    refusal('INVALID_ICALENDAR', () => updateFields('this is not iCalendar', { SUMMARY: 'x' }));
  });

  it('INVALID_TYPE: a type that is no component type, in updateFields and seriesMaster', () => {
    refusal('INVALID_TYPE', () => updateFields(timed, { SUMMARY: 'x' }, { type: 'event' as never }));
    const parsed = new ICAL.Component(ICAL.parse(timed));
    refusal('INVALID_TYPE', () => seriesMaster(parsed, 'VCALENDAR' as never));
  });

  it('INVALID_FLOATING_TIME: an unknown floatingTime', () => {
    refusal('INVALID_FLOATING_TIME', () => updateFields(timed, { SUMMARY: 'x' }, { floatingTime: 'utc' as never }));
  });

  it('INVALID_ABSOLUTE_TIME: an unknown absoluteTime', () => {
    refusal('INVALID_ABSOLUTE_TIME', () => updateFields(timed, { SUMMARY: 'x' }, { absoluteTime: 'utc' as never }));
  });

  it('COMPONENT_NOT_FOUND: a type the object does not hold, or a type on a vCard', () => {
    refusal('COMPONENT_NOT_FOUND', () => updateFields(timed, { SUMMARY: 'x' }, { type: 'vtodo' }));
    const card = ['BEGIN:VCARD', 'VERSION:4.0', 'FN:A', 'END:VCARD', ''].join('\r\n');
    refusal('COMPONENT_NOT_FOUND', () => updateFields(card, { FN: 'B' }, { type: 'vevent' }));
  });

  it('NO_MASTER: several detached instances', () => {
    refusal('NO_MASTER', () => updateFields(calendar(
      ...event('RECURRENCE-ID:20261005T090000Z', 'DTSTART:20261005T090000Z'),
      ...event('RECURRENCE-ID:20261012T090000Z', 'DTSTART:20261012T090000Z'),
    ), { SUMMARY: 'x' }));
  });

  it('INVALID_VALUE: an unparseable or impossible value, with the property', () => {
    const error = refusal('INVALID_VALUE', () => updateFields(timed, { DTEND: 'tomorrow' }));
    expect(error.property).toBe('DTEND');
    expect(error.message).toMatch(/^DTEND: "tomorrow" is not a date or date-time/);
    refusal('INVALID_VALUE', () => parseDateValue('2026-02-30'));
    refusal('INVALID_VALUE', () => parseDateValue('2026-10-26T18:00:00+25:00'));
    expect(refusal('INVALID_VALUE', () => updateFields(timed, { RRULE: 'FREQ=DAILY;UNTIL=soon' })).property)
      .toBe('RRULE');
  });

  it('VALUE_TYPE_MISMATCH: a date next to a timed DTSTART', () => {
    expect(refusal('VALUE_TYPE_MISMATCH', () => updateFields(timed, { DTEND: '2026-10-06' })).property).toBe('DTEND');
    refusal('VALUE_TYPE_MISMATCH', () => updateFields(timed, { EXDATE: '2026-10-06,2026-10-07T09:00:00Z' }));
    refusal('VALUE_TYPE_MISMATCH', () => updateFields(timed, { RRULE: 'FREQ=DAILY;UNTIL=20261010' }));
  });

  it('ZONE_MISMATCH: a time without a zone next to a UTC DTSTART', () => {
    expect(refusal('ZONE_MISMATCH', () => updateFields(timed, { DTEND: '2026-10-05T11:00:00' })).property)
      .toBe('DTEND');
    refusal('ZONE_MISMATCH', () => updateFields(timed, { DTSTAMP: '2026-10-05T11:00:00' }));
    refusal('ZONE_MISMATCH', () => updateFields(timed, { RRULE: 'FREQ=DAILY;UNTIL=20261010T090000' }));
  });

  it('UNKNOWN_TZID: a zone whose rules are needed and unknown', () => {
    const error = refusal('UNKNOWN_TZID', () => updateFields(
      calendar(...event('DTSTART;TZID=Nowhere/Zone:20261005T090000')),
      { RRULE: 'FREQ=DAILY;UNTIL=20261010T090000' }));
    expect(error.property).toBe('RRULE');
  });

  it('UNSUPPORTED_VTIMEZONE: a VTIMEZONE that repeats daily', () => {
    refusal('UNSUPPORTED_VTIMEZONE', () => updateFields(calendar(
      'BEGIN:VTIMEZONE', 'TZID:Hostile/Zone',
      'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'DTSTART:19700101T000000',
      'RRULE:FREQ=DAILY', 'END:STANDARD', 'END:VTIMEZONE',
      ...event('DTSTART;TZID=Hostile/Zone:20261005T090000'),
    ), { RRULE: 'FREQ=DAILY;UNTIL=20261010T090000' }));
  });

  it('UNKNOWN_RULE_PART: a part RFC 5545 does not define, RSCALE, or the property prefix', () => {
    expect(refusal('UNKNOWN_RULE_PART', () => updateFields(timed, { RRULE: 'FREQ=DAILY;FOO=1' })).property)
      .toBe('RRULE');
    refusal('UNKNOWN_RULE_PART', () => updateFields(timed, { RRULE: 'RSCALE=GREGORIAN;FREQ=DAILY' }));
    refusal('UNKNOWN_RULE_PART', () => updateFields(timed, { RRULE: 'RRULE:FREQ=DAILY' }));
  });

  it('DUPLICATE_RULE_PART: a part given twice', () => {
    refusal('DUPLICATE_RULE_PART', () => updateFields(timed, { RRULE: 'FREQ=DAILY;COUNT=1;COUNT=2' }));
  });

  it('INVALID_RULE: no FREQ, a bad value, a combination the RFC rules out', () => {
    refusal('INVALID_RULE', () => updateFields(timed, { RRULE: 'COUNT=5' }));
    refusal('INVALID_RULE', () => updateFields(timed, { RRULE: 'FREQ=DAILY;COUNT=0' }));
    refusal('INVALID_RULE', () => updateFields(timed, { RRULE: 'FREQ=DAILY;COUNT=2;UNTIL=20261010T090000Z' }));
  });

  it('RECURRENCE_ID_ON_MASTER', () => {
    const error = refusal('RECURRENCE_ID_ON_MASTER',
      () => updateFields(timed, { 'RECURRENCE-ID': '2026-10-05T09:00:00Z' }));
    expect(error.property).toBe('RECURRENCE-ID');
  });

  it('SERIES_MOVE_REFUSED: a rule that pins the old start, with the rule to give', () => {
    const error = refusal('SERIES_MOVE_REFUSED', () => updateFields(
      calendar(...event('DTSTART:20261005T090000Z', 'RRULE:FREQ=DAILY;BYHOUR=9;COUNT=5')),
      { DTSTART: '2026-10-05T10:00:00Z' }));
    expect(error.property).toBe('RRULE');
    expect(error.suggestion).toBe('FREQ=DAILY;COUNT=5;BYHOUR=10');
    expect(error.message).toContain(`(e.g. RRULE "${error.suggestion}")`);
  });

  it('SERIES_MOVE_REFUSED: a value that cannot follow the move, without a suggestion', () => {
    const error = refusal('SERIES_MOVE_REFUSED', () => updateFields(
      calendar(...event('DTSTART:20261005T090000Z', 'RRULE:FREQ=DAILY;COUNT=5',
        'RDATE;VALUE=PERIOD:20261020T090000Z/PT1H')),
      { DTSTART: '2026-10-05T10:00:00Z' }));
    expect(error.property).toBe('RDATE');
    expect(error.suggestion).toBeUndefined();
  });

  it('ORPHANS_OVERRIDES: a new rule that drops an overridden occurrence', () => {
    const error = refusal('ORPHANS_OVERRIDES', () => updateFields(weekly(), { RRULE: 'FREQ=WEEKLY;COUNT=1' }));
    expect(error.property).toBe('RRULE');
  });

  it('DST_AMBIGUOUS: an UNTIL in the hour the fall-back shows twice', () => {
    // 2026-10-25 00:30Z is 02:30 CEST, a wall clock Berlin shows twice that night
    const error = refusal('DST_AMBIGUOUS', () => updateFields(calendar(...event(
      'DTSTART;TZID=Europe/Berlin:20261001T090000', 'RRULE:FREQ=DAILY;UNTIL=20261025T003000Z')),
    { DTSTART: '2026-10-01T10:00:00' }));
    expect(error.property).toBe('RRULE');
  });

  it('CHECK_LIMIT_EXCEEDED: a new rule too sparse to check the override against', () => {
    refusal('CHECK_LIMIT_EXCEEDED', () => updateFields(calendar(
      ...event('DTSTART:20260101T235959Z', 'RRULE:FREQ=DAILY'),
      ...event('RECURRENCE-ID:20261231T235959Z', 'DTSTART:20261231T235959Z'),
    ), { RRULE: 'FREQ=SECONDLY;BYMONTH=12;BYMONTHDAY=31;BYHOUR=23;BYMINUTE=59;BYSECOND=59' }));
  });

  it('SERIES_UNVERIFIABLE: a series without DTSTART to check the override against', () => {
    refusal('SERIES_UNVERIFIABLE', () => updateFields(calendar(
      ...event('SUMMARY:no start'),
      ...event('RECURRENCE-ID:20261012T090000Z', 'DTSTART:20261012T130000Z'),
    ), { RRULE: 'FREQ=WEEKLY' }));
  });

  afterAll(() => {
    // every code is produced by at least one input above
    expect([...seen].sort()).toEqual([...UPDATE_FIELDS_ERROR_CODES].sort());
  });
});

describe('a failure of the library is no refusal', () => {
  it('throws a plain Error when ical.js lacks the step the work limit hooks into', () => {
    const proto = (ICAL as unknown as { RecurIterator: { prototype: Record<string, unknown> } }).RecurIterator.prototype;
    const hook = proto.check_contracting_rules;
    delete proto.check_contracting_rules;
    let thrown: unknown;
    try {
      updateFields(weekly(), { RRULE: 'FREQ=WEEKLY;COUNT=12' });
    } catch (error) {
      thrown = error;
    } finally {
      proto.check_contracting_rules = hook;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(UpdateFieldsError);
    expect(isUpdateFieldsError(thrown)).toBe(false);
    expect((thrown as Error).message).toBe('ical.js no longer exposes the step a rule expansion can be bounded at');
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
});
