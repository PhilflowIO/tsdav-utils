import { describe, it, expect } from 'vitest';
import ICAL from 'ical.js';
import { updateFields, seriesMaster } from '../src/updateFields';

// An object holding a VEVENT and a VTODO violates RFC 4791 4.1 but does occur.
// A caller that means the todo (or the event) names the type, and the write
// lands in that component only. All values are UTC or text, so the result does
// not depend on the host timezone.

const MIXED = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//tsdav-utils//Test//EN',
  'BEGIN:VEVENT', 'UID:event-1', 'DTSTAMP:20260101T000000Z',
  'DTSTART:20261005T100000Z', 'DTEND:20261005T110000Z', 'SUMMARY:Event', 'END:VEVENT',
  'BEGIN:VTODO', 'UID:todo-1', 'DTSTAMP:20260101T000000Z',
  'DTSTART:20261005T090000Z', 'DUE:20261006T090000Z', 'SUMMARY:Todo', 'END:VTODO',
  'END:VCALENDAR', '',
].join('\r\n');

const parse = (ical: string) => new ICAL.Component(ICAL.parse(ical));
const lines = (component: ICAL.Component | null) => component!.toString().split('\r\n');

describe('updateFields with a component type', () => {
  it('writes into the VTODO and leaves the VEVENT untouched', () => {
    const updated = parse(updateFields(MIXED, {
      SUMMARY: 'New todo', DUE: '20261007T090000Z',
    }, { type: 'vtodo' }));
    const original = parse(MIXED);

    const todo = updated.getFirstSubcomponent('vtodo')!;
    expect(todo.getFirstPropertyValue('summary')).toBe('New todo');
    expect(todo.getFirstPropertyValue('due')!.toString()).toBe('2026-10-07T09:00:00Z');
    expect(lines(updated.getFirstSubcomponent('vevent')))
      .toEqual(lines(original.getFirstSubcomponent('vevent')));
  });

  it('writes into the VEVENT and leaves the VTODO untouched', () => {
    const updated = parse(updateFields(MIXED, { SUMMARY: 'New event' }, { type: 'vevent' }));
    const original = parse(MIXED);

    expect(updated.getFirstSubcomponent('vevent')!.getFirstPropertyValue('summary')).toBe('New event');
    expect(lines(updated.getFirstSubcomponent('vtodo')))
      .toEqual(lines(original.getFirstSubcomponent('vtodo')));
  });

  it('without a type keeps the default order, VEVENT first', () => {
    const updated = parse(updateFields(MIXED, { SUMMARY: 'x' }));
    expect(updated.getFirstSubcomponent('vevent')!.getFirstPropertyValue('summary')).toBe('x');
    expect(updated.getFirstSubcomponent('vtodo')!.getFirstPropertyValue('summary')).toBe('Todo');
  });

  it('edits the master of the named type, not an override', () => {
    const recurring = MIXED.replace('BEGIN:VTODO', [
      'BEGIN:VTODO', 'UID:todo-1', 'RECURRENCE-ID:20261012T090000Z',
      'SUMMARY:Override', 'END:VTODO', 'BEGIN:VTODO',
    ].join('\r\n')).replace('SUMMARY:Todo', 'RRULE:FREQ=WEEKLY\r\nSUMMARY:Todo');
    const updated = parse(updateFields(recurring, { SUMMARY: 'Series' }, { type: 'vtodo' }));
    const summaries = updated.getAllSubcomponents('vtodo').map((c) => c.getFirstPropertyValue('summary'));
    expect(summaries).toEqual(['Override', 'Series']);
  });

  it('names the requested type when the object holds none of it', () => {
    expect(() => updateFields(MIXED, { SUMMARY: 'x' }, { type: 'vjournal' }))
      .toThrow(/No VJOURNAL found/);
  });

  it('refuses an unknown type instead of falling back to another component', () => {
    expect(() => updateFields(MIXED, { SUMMARY: 'x' }, { type: 'vcard' as any }))
      .toThrow('Invalid type "vcard": use "vevent", "vtodo" or "vjournal"');
    expect(() => updateFields(MIXED, { SUMMARY: 'x' }, { type: '' as any }))
      .toThrow(/Invalid type ""/);
    expect(() => updateFields(MIXED, { SUMMARY: 'x' }, { type: 42 as any }))
      .toThrow(/Invalid type "42"/);
  });

  it('refuses a type on a vCard', () => {
    const vcard = 'BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Jane\r\nEND:VCARD\r\n';
    expect(() => updateFields(vcard, { FN: 'John' }, { type: 'vtodo' }))
      .toThrow(/applies to an iCalendar object, but this is a VCARD/);
  });
});

describe('seriesMaster validates its type', () => {
  it('refuses an unknown type', () => {
    expect(() => seriesMaster(parse(MIXED), 'VTIMEZONE')).toThrow(/Invalid type "VTIMEZONE"/);
  });

  it('accepts either case', () => {
    expect(seriesMaster(parse(MIXED), 'VTODO').getFirstPropertyValue('summary')).toBe('Todo');
  });
});
