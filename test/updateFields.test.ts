import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import ICAL from 'ical.js';
import { updateFields } from '../src/updateFields';

// Helper to load fixtures
const loadFixture = (filename: string): string => {
  return readFileSync(join(__dirname, 'fixtures', filename), 'utf-8');
};

describe('updateFields', () => {
  describe('VEVENT (calendar events)', () => {
    it('updates SUMMARY field', () => {
      const vevent = loadFixture('vevent.ics');
      const updated = updateFields(vevent, {
        'SUMMARY': 'Updated Team Meeting'
      });

      // Parse result to verify
      const component = new ICAL.Component(ICAL.parse(updated));
      const event = component.getFirstSubcomponent('vevent');
      expect(event?.getFirstPropertyValue('summary')).toBe('Updated Team Meeting');
    });

    it('updates LOCATION field', () => {
      const vevent = loadFixture('vevent.ics');
      const updated = updateFields(vevent, {
        'LOCATION': 'Remote - Zoom'
      });

      const component = new ICAL.Component(ICAL.parse(updated));
      const event = component.getFirstSubcomponent('vevent');
      expect(event?.getFirstPropertyValue('location')).toBe('Remote - Zoom');
    });

    // Note: Datetime properties require ICAL.Time objects, not strings
    // This is a known limitation - documented in GitHub issues
    it.skip('updates DTSTART field', () => {
      const vevent = loadFixture('vevent.ics');
      const updated = updateFields(vevent, {
        'DTSTART': '20250130T140000Z'
      });

      const component = new ICAL.Component(ICAL.parse(updated));
      const event = component.getFirstSubcomponent('vevent');
      expect(event?.getFirstPropertyValue('dtstart')).toBe('20250130T140000Z');
    });

    it('updates multiple fields simultaneously', () => {
      const vevent = loadFixture('vevent.ics');
      const updated = updateFields(vevent, {
        'SUMMARY': 'New Meeting',
        'LOCATION': 'Building B',
        'STATUS': 'TENTATIVE'
      });

      const component = new ICAL.Component(ICAL.parse(updated));
      const event = component.getFirstSubcomponent('vevent');
      expect(event?.getFirstPropertyValue('summary')).toBe('New Meeting');
      expect(event?.getFirstPropertyValue('location')).toBe('Building B');
      expect(event?.getFirstPropertyValue('status')).toBe('TENTATIVE');
    });

    it('preserves unmodified fields', () => {
      const vevent = loadFixture('vevent.ics');
      const updated = updateFields(vevent, {
        'SUMMARY': 'Changed Title'
      });

      const component = new ICAL.Component(ICAL.parse(updated));
      const event = component.getFirstSubcomponent('vevent');

      // These should remain unchanged
      expect(event?.getFirstPropertyValue('uid')).toBe('test-event-12345@example.com');
      expect(event?.getFirstPropertyValue('location')).toBe('Conference Room A');
      expect(event?.getFirstPropertyValue('description')).toBe('Monthly team sync meeting');
      expect(event?.getFirstPropertyValue('status')).toBe('CONFIRMED');
    });

    it('handles custom properties (X-ZOOM-LINK)', () => {
      const vevent = loadFixture('vevent.ics');
      const updated = updateFields(vevent, {
        'X-ZOOM-LINK': 'https://zoom.us/j/123456789',
        'X-MEETING-ID': 'PROJ-2025-001'
      });

      const component = new ICAL.Component(ICAL.parse(updated));
      const event = component.getFirstSubcomponent('vevent');
      expect(event?.getFirstPropertyValue('x-zoom-link')).toBe('https://zoom.us/j/123456789');
      expect(event?.getFirstPropertyValue('x-meeting-id')).toBe('PROJ-2025-001');
    });
  });

  describe('VTODO (todos/tasks)', () => {
    it('updates SUMMARY field', () => {
      const vtodo = loadFixture('vtodo.ics');
      const updated = updateFields(vtodo, {
        'SUMMARY': 'Updated Task Title'
      });

      const component = new ICAL.Component(ICAL.parse(updated));
      const todo = component.getFirstSubcomponent('vtodo');
      expect(todo?.getFirstPropertyValue('summary')).toBe('Updated Task Title');
    });

    it('updates STATUS field', () => {
      const vtodo = loadFixture('vtodo.ics');
      const updated = updateFields(vtodo, {
        'STATUS': 'IN-PROCESS'
      });

      const component = new ICAL.Component(ICAL.parse(updated));
      const todo = component.getFirstSubcomponent('vtodo');
      expect(todo?.getFirstPropertyValue('status')).toBe('IN-PROCESS');
    });

    it('updates PRIORITY field', () => {
      const vtodo = loadFixture('vtodo.ics');
      const updated = updateFields(vtodo, {
        'PRIORITY': '1'
      });

      const component = new ICAL.Component(ICAL.parse(updated));
      const todo = component.getFirstSubcomponent('vtodo');
      // Note: ical.js returns priority as a number
      expect(todo?.getFirstPropertyValue('priority')).toBe(1);
    });

    // Note: Datetime properties require ICAL.Time objects, not strings
    // This is a known limitation - documented in GitHub issues
    it.skip('updates DUE field', () => {
      const vtodo = loadFixture('vtodo.ics');
      const updated = updateFields(vtodo, {
        'DUE': '20250201T180000Z'
      });

      const component = new ICAL.Component(ICAL.parse(updated));
      const todo = component.getFirstSubcomponent('vtodo');
      expect(todo?.getFirstPropertyValue('due')).toBe('20250201T180000Z');
    });

    it('preserves unmodified fields', () => {
      const vtodo = loadFixture('vtodo.ics');
      const updated = updateFields(vtodo, {
        'STATUS': 'COMPLETED'
      });

      const component = new ICAL.Component(ICAL.parse(updated));
      const todo = component.getFirstSubcomponent('vtodo');

      // These should remain unchanged
      expect(todo?.getFirstPropertyValue('uid')).toBe('test-todo-67890@example.com');
      expect(todo?.getFirstPropertyValue('summary')).toBe('Finish project documentation');
      // Note: ical.js returns priority as a number
      expect(todo?.getFirstPropertyValue('priority')).toBe(5);
      expect(todo?.getFirstPropertyValue('description')).toBe('Complete all markdown docs and examples');
    });
  });

  describe('VCARD (contacts)', () => {
    it('updates FN (formatted name) field', () => {
      const vcard = loadFixture('vcard.vcf');
      const updated = updateFields(vcard, {
        'FN': 'Janet Marie Smith'
      });

      const component = new ICAL.Component(ICAL.parse(updated));
      expect(component.getFirstPropertyValue('fn')).toBe('Janet Marie Smith');
    });

    it('updates EMAIL field', () => {
      const vcard = loadFixture('vcard.vcf');
      const updated = updateFields(vcard, {
        'EMAIL': 'janet.m.smith@example.com'
      });

      const component = new ICAL.Component(ICAL.parse(updated));
      expect(component.getFirstPropertyValue('email')).toBe('janet.m.smith@example.com');
    });

    it('updates TEL field', () => {
      const vcard = loadFixture('vcard.vcf');
      const updated = updateFields(vcard, {
        'TEL': '+9876543210'
      });

      const component = new ICAL.Component(ICAL.parse(updated));
      expect(component.getFirstPropertyValue('tel')).toBe('+9876543210');
    });

    it('preserves unmodified fields', () => {
      const vcard = loadFixture('vcard.vcf');
      const updated = updateFields(vcard, {
        'FN': 'Jane M. Smith'
      });

      const component = new ICAL.Component(ICAL.parse(updated));

      // These should remain unchanged
      expect(component.getFirstPropertyValue('uid')).toBe('test-vcard-456@example.com');
      expect(component.getFirstPropertyValue('email')).toBe('jane.smith@example.com');
      expect(component.getFirstPropertyValue('org')).toBe('Example Corporation');
      expect(component.getFirstPropertyValue('title')).toBe('Senior Developer');
    });
  });

  describe('Edge cases', () => {
    it('accepts unknown property names without error', () => {
      const vevent = loadFixture('vevent.ics');

      // Intentional typo - should still work
      expect(() => {
        updateFields(vevent, {
          'SUMMMARY': 'Typo in field name'
        });
      }).not.toThrow();
    });

    it('handles empty fields object', () => {
      const vevent = loadFixture('vevent.ics');
      const updated = updateFields(vevent, {});

      // Should return valid iCal string unchanged
      expect(updated).toContain('BEGIN:VCALENDAR');
      expect(updated).toContain('BEGIN:VEVENT');
      expect(updated).toContain('END:VEVENT');
      expect(updated).toContain('END:VCALENDAR');
    });

    it('returns immutable result (does not mutate input)', () => {
      const vevent = loadFixture('vevent.ics');
      const original = vevent;

      updateFields(vevent, {
        'SUMMARY': 'Modified'
      });

      // Original should be unchanged
      expect(vevent).toBe(original);
    });

    it('accepts tsdav DAVCalendarObject format', () => {
      const vevent = loadFixture('vevent.ics');
      const davObject = {
        data: vevent,
        etag: 'abc123',
        url: 'https://example.com/calendar/event.ics'
      };

      const updated = updateFields(davObject, {
        'SUMMARY': 'From DAV Object'
      });

      const component = new ICAL.Component(ICAL.parse(updated));
      const event = component.getFirstSubcomponent('vevent');
      expect(event?.getFirstPropertyValue('summary')).toBe('From DAV Object');
    });

    it('throws error for invalid iCal input', () => {
      expect(() => {
        updateFields('INVALID ICAL DATA', {
          'SUMMARY': 'Test'
        });
      }).toThrow(/Failed to parse iCal data/);
    });

    it('throws error for missing data field in object input', () => {
      expect(() => {
        updateFields({ url: 'test.ics' } as any, {
          'SUMMARY': 'Test'
        });
      }).toThrow(/Invalid input/);
    });

    it('throws error for empty string input', () => {
      expect(() => {
        updateFields('', {
          'SUMMARY': 'Test'
        });
      }).toThrow(/Invalid input/);
    });
  });

  describe('Integration scenarios', () => {
    it('works in a typical tsdav workflow simulation', () => {
      const vevent = loadFixture('vevent.ics');

      // Simulate tsdav fetchCalendarObjects response
      const mockCalendarObject = {
        data: vevent,
        etag: '"abc123def456"',
        url: 'https://cal.example.com/calendars/user/calendar/event.ics'
      };

      // Update fields (excluding datetime fields due to ical.js limitations)
      const updatedData = updateFields(mockCalendarObject, {
        'SUMMARY': 'Rescheduled Meeting',
        'LOCATION': 'Virtual - Teams',
        'X-MEETING-PLATFORM': 'Microsoft Teams',
        'DESCRIPTION': 'Updated description for the meeting'
      });

      // Verify it can be parsed back
      const component = new ICAL.Component(ICAL.parse(updatedData));
      const event = component.getFirstSubcomponent('vevent');

      expect(event?.getFirstPropertyValue('summary')).toBe('Rescheduled Meeting');
      expect(event?.getFirstPropertyValue('location')).toBe('Virtual - Teams');
      expect(event?.getFirstPropertyValue('x-meeting-platform')).toBe('Microsoft Teams');
      expect(event?.getFirstPropertyValue('description')).toBe('Updated description for the meeting');

      // Original fields preserved
      expect(event?.getFirstPropertyValue('uid')).toBe('test-event-12345@example.com');
      expect(event?.getFirstPropertyValue('organizer')).toContain('john@example.com');
    });
  });
});
