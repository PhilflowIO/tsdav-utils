import { describe, it, expect } from 'vitest';
import ICAL from 'ical.js';
import { updateFields, seriesMaster } from '../src/updateFields';

// A recurring event or todo may hold its master and override components (with
// RECURRENCE-ID, RFC 5545 3.8.4.4) in any order. A series-level write belongs to
// the master. The assertions read the serialized lines of each component.

const MASTER_EVENT = [
  'BEGIN:VEVENT', 'UID:series-1', 'DTSTAMP:20260101T000000Z',
  'DTSTART:20261005T100000Z', 'DTEND:20261005T110000Z',
  'RRULE:FREQ=WEEKLY;COUNT=4', 'SUMMARY:Weekly', 'END:VEVENT',
];
const OVERRIDE_EVENT = [
  'BEGIN:VEVENT', 'UID:series-1', 'DTSTAMP:20260101T000000Z',
  'RECURRENCE-ID:20261012T100000Z',
  'DTSTART:20261012T120000Z', 'DTEND:20261012T130000Z',
  'SUMMARY:Moved instance', 'END:VEVENT',
];

const calendar = (...components: string[][]) => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//tsdav-utils//Test//EN',
  ...components.flat(),
  'END:VCALENDAR', '',
].join('\r\n');

/** the lines of every component of a type, in document order */
const components = (ical: string, type: string): string[][] => {
  const out: string[][] = [];
  let current: string[] | null = null;
  for (const line of ical.split(/\r?\n/)) {
    if (line === `BEGIN:${type}`) current = [];
    else if (line === `END:${type}`) { out.push(current!); current = null; }
    else if (current) current.push(line);
  }
  return out;
};

const isOverride = (lines: string[]) => lines.some((l) => /^RECURRENCE-ID[:;]/.test(l));
const prop = (lines: string[], name: string) =>
  lines.filter((l) => l.startsWith(`${name}:`) || l.startsWith(`${name};`));

describe('updateFields edits the master of a recurring object', () => {
  it.each([
    ['override first', calendar(OVERRIDE_EVENT, MASTER_EVENT)],
    ['override last', calendar(MASTER_EVENT, OVERRIDE_EVENT)],
  ])('%s: SUMMARY and EXDATE land on the master', (_, input) => {
    const out = updateFields(input, { SUMMARY: 'Renamed', EXDATE: '20261019T100000Z' });
    const events = components(out, 'VEVENT');
    const master = events.find((c) => !isOverride(c))!;
    const override = events.find(isOverride)!;

    expect(prop(master, 'SUMMARY')).toEqual(['SUMMARY:Renamed']);
    expect(prop(master, 'EXDATE')).toEqual(['EXDATE:20261019T100000Z']);
    // overrides are independent instances: a series-level write leaves them alone
    expect(override).toEqual(OVERRIDE_EVENT.slice(1, -1));
  });

  it('keeps the document order of master and overrides', () => {
    const out = updateFields(calendar(OVERRIDE_EVENT, MASTER_EVENT), { SUMMARY: 'Renamed' });
    expect(components(out, 'VEVENT').map(isOverride)).toEqual([true, false]);
  });

  it("anchors date-times to the master's DTSTART, not the override's", () => {
    const zonedMaster = MASTER_EVENT.map((l) =>
      l.startsWith('DTSTART:') ? 'DTSTART;TZID=Europe/Berlin:20261005T100000'
        : l.startsWith('DTEND:') ? 'DTEND;TZID=Europe/Berlin:20261005T110000' : l);
    // the override's UTC DTSTART would reject a zoneless value under "keep"
    const out = updateFields(calendar(OVERRIDE_EVENT, zonedMaster), { DTEND: '2026-10-05T12:00:00' });
    const master = components(out, 'VEVENT').find((c) => !isOverride(c))!;
    expect(prop(master, 'DTEND')).toEqual(['DTEND;TZID=Europe/Berlin:20261005T120000']);
  });

  it('edits the master of a todo series, overrides first', () => {
    const toVtodo = (lines: string[]) => lines
      .filter((l) => !l.startsWith('DTEND'))
      .map((l) => l.replace(/^(BEGIN|END):VEVENT$/, '$1:VTODO'));
    const out = updateFields(calendar(toVtodo(OVERRIDE_EVENT), toVtodo(MASTER_EVENT)), {
      SUMMARY: 'Renamed', DUE: '20261005T180000Z',
    });
    const todos = components(out, 'VTODO');
    const master = todos.find((c) => !isOverride(c))!;
    const override = todos.find(isOverride)!;
    expect(prop(master, 'SUMMARY')).toEqual(['SUMMARY:Renamed']);
    expect(prop(master, 'DUE')).toEqual(['DUE:20261005T180000Z']);
    expect(prop(override, 'SUMMARY')).toEqual(['SUMMARY:Moved instance']);
    expect(prop(override, 'DUE')).toEqual([]);
  });

  it('edits a lone detached instance, which has no master', () => {
    const out = updateFields(calendar(OVERRIDE_EVENT), { SUMMARY: 'Renamed' });
    const [only] = components(out, 'VEVENT');
    expect(prop(only, 'SUMMARY')).toEqual(['SUMMARY:Renamed']);
    expect(prop(only, 'RECURRENCE-ID')).toEqual(['RECURRENCE-ID:20261012T100000Z']);
  });

  it('throws between several instances without a master', () => {
    const second = OVERRIDE_EVENT.map((l) => l
      .replace('RECURRENCE-ID:20261012T100000Z', 'RECURRENCE-ID:20261019T100000Z'));
    expect(() => updateFields(calendar(OVERRIDE_EVENT, second), { SUMMARY: 'Renamed' }))
      .toThrow('This object holds 2 VEVENT instances (each with a RECURRENCE-ID) and no master');
  });

  it('leaves a vCard as it was handled before', () => {
    const card = ['BEGIN:VCARD', 'VERSION:4.0', 'UID:card-1', 'FN:Old', 'END:VCARD', ''].join('\r\n');
    const out = updateFields(card, { FN: 'New' });
    expect(out.split(/\r?\n/).filter((l) => l.startsWith('FN:'))).toEqual(['FN:New']);
  });
});

describe('seriesMaster', () => {
  const doc = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//EN',
    'BEGIN:VTODO', 'UID:t', 'RECURRENCE-ID:20261012T090000Z', 'SUMMARY:override', 'END:VTODO',
    'BEGIN:VTODO', 'UID:t', 'DTSTART:20261005T090000Z', 'RRULE:FREQ=WEEKLY', 'SUMMARY:master', 'END:VTODO',
    'END:VCALENDAR', '',
  ].join('\r\n');
  const calendar = () => new ICAL.Component(ICAL.parse(doc));

  it('returns the master for a caller that checks what updateFields wrote', () => {
    expect(seriesMaster(calendar()).getFirstPropertyValue('summary')).toBe('master');
    expect(seriesMaster(calendar(), 'VTODO').getFirstPropertyValue('summary')).toBe('master');
  });

  it('names the missing type when restricted to one that is absent', () => {
    expect(() => seriesMaster(calendar(), 'vevent')).toThrow(/No VEVENT found/);
  });

  it('tells the caller how to proceed when there is no master', () => {
    const instances = doc.replace(/BEGIN:VTODO\r\nUID:t\r\nDTSTART[^]*?END:VTODO\r\n/, [
      'BEGIN:VTODO', 'UID:t', 'RECURRENCE-ID:20261019T090000Z', 'SUMMARY:o2', 'END:VTODO', '',
    ].join('\r\n'));
    expect(() => updateFields(instances, { SUMMARY: 'x' })).toThrow(/rewriting the whole iCalendar object/);
  });
});
