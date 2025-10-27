import { describe, it, expect, beforeAll } from 'vitest';
import { createDAVClient, DAVClient, DAVCalendar } from 'tsdav';
import { config } from 'dotenv';
import { updateFields } from '../src';

// Load environment variables
config();

// Helper to generate unique test IDs
const generateTestId = () => `${process.env.TEST_PREFIX || 'test-'}${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

// Check if credentials are available
const hasRadicaleCredentials = !!process.env.RADICALE_PASSWORD;
const hasBaikalCredentials = !!process.env.BAIKAL_PASSWORD;
const hasNextcloudCredentials = !!process.env.NEXTCLOUD_PASSWORD;

describe('Real-World Integration Tests', () => {
  // Skip all tests if no credentials
  if (!hasRadicaleCredentials && !hasBaikalCredentials && !hasNextcloudCredentials) {
    it.skip('Integration tests skipped (no server credentials in .env)', () => {});
    return;
  }

  describe('Radicale Server - VEVENT', () => {
    let client: DAVClient;
    let calendar: DAVCalendar;
    let testEventUrl: string;

    const testDescribe = hasRadicaleCredentials ? describe : describe.skip;

    testDescribe('Calendar Event Tests', () => {
      beforeAll(async () => {
        if (!hasRadicaleCredentials) return;

        client = await createDAVClient({
          serverUrl: process.env.RADICALE_SERVER_URL!,
          credentials: {
            username: process.env.RADICALE_USERNAME!,
            password: process.env.RADICALE_PASSWORD!,
          },
          authMethod: 'Basic',
          defaultAccountType: 'caldav',
        });

        const calendars = await client.fetchCalendars();
        calendar = calendars[0];
      });

      it('should create, update, and fetch an event', async () => {
        const testId = generateTestId();

        // Create initial event
        const initialEvent = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//tsdav-utils//Integration Test//EN
BEGIN:VEVENT
UID:${testId}
DTSTART:20250201T100000Z
DTEND:20250201T110000Z
DTSTAMP:20250128T000000Z
SUMMARY:Original Test Event
LOCATION:Test Location
DESCRIPTION:Original description
END:VEVENT
END:VCALENDAR`;

        // Create event on server
        const createResponse = await client.createCalendarObject({
          calendar,
          filename: `${testId}.ics`,
          iCalString: initialEvent,
        });

        expect(createResponse.ok).toBe(true);

        // Fetch the created event
        const events = await client.fetchCalendarObjects({
          calendar,
        });

        const createdEvent = events.find(e => e.url.includes(testId));
        expect(createdEvent).toBeDefined();
        testEventUrl = createdEvent!.url;

        // Update using updateFields()
        const updated = updateFields(createdEvent!.data, {
          'SUMMARY': 'Updated via tsdav-utils',
          'LOCATION': 'New Location',
          'DESCRIPTION': 'Updated description via integration test',
        });

        // Save updated event back to server
        await client.updateCalendarObject({
          calendarObject: {
            ...createdEvent!,
            data: updated,
          },
        });

        // Fetch again to verify update
        const eventsAfterUpdate = await client.fetchCalendarObjects({
          calendar,
        });

        const updatedEvent = eventsAfterUpdate.find(e => e.url === testEventUrl);
        expect(updatedEvent).toBeDefined();

        // Verify the update
        expect(updatedEvent!.data).toContain('Updated via tsdav-utils');
        expect(updatedEvent!.data).toContain('New Location');
        expect(updatedEvent!.data).toContain('Updated description via integration test');

        // Verify original UID is preserved
        expect(updatedEvent!.data).toContain(testId);

        // Cleanup
        await client.deleteCalendarObject({
          calendarObject: updatedEvent!,
        });
      }, 30000); // 30 second timeout for network operations

      it('should preserve unmodified fields', async () => {
        const testId = generateTestId();

        const initialEvent = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//tsdav-utils//Integration Test//EN
BEGIN:VEVENT
UID:${testId}
DTSTART:20250202T140000Z
DTEND:20250202T150000Z
DTSTAMP:20250128T000000Z
SUMMARY:Field Preservation Test
LOCATION:Original Location
DESCRIPTION:Original Description
STATUS:CONFIRMED
ORGANIZER:mailto:test@example.com
END:VEVENT
END:VCALENDAR`;

        await client.createCalendarObject({
          calendar,
          filename: `${testId}.ics`,
          iCalString: initialEvent,
        });

        const events = await client.fetchCalendarObjects({ calendar });
        const event = events.find(e => e.url.includes(testId));

        // Update only SUMMARY
        const updated = updateFields(event!.data, {
          'SUMMARY': 'Only Summary Changed',
        });

        await client.updateCalendarObject({
          calendarObject: { ...event!, data: updated },
        });

        // Fetch and verify
        const verifyEvents = await client.fetchCalendarObjects({ calendar });
        const verifiedEvent = verifyEvents.find(e => e.url.includes(testId));

        // Changed field
        expect(verifiedEvent!.data).toContain('Only Summary Changed');

        // Preserved fields
        expect(verifiedEvent!.data).toContain('Original Location');
        expect(verifiedEvent!.data).toContain('Original Description');
        expect(verifiedEvent!.data).toContain('CONFIRMED');
        expect(verifiedEvent!.data).toContain('test@example.com');

        // Cleanup
        await client.deleteCalendarObject({
          calendarObject: verifiedEvent!,
        });
      }, 30000);
    });
  });

  describe('Baikal Server - VTODO', () => {
    let client: DAVClient;
    let calendar: DAVCalendar;

    const testDescribe = hasBaikalCredentials ? describe : describe.skip;

    testDescribe('Todo/Task Tests', () => {
      beforeAll(async () => {
        if (!hasBaikalCredentials) return;

        client = await createDAVClient({
          serverUrl: process.env.BAIKAL_SERVER_URL!,
          credentials: {
            username: process.env.BAIKAL_USERNAME!,
            password: process.env.BAIKAL_PASSWORD!,
          },
          authMethod: 'Basic',
          defaultAccountType: 'caldav',
        });

        const calendars = await client.fetchCalendars();
        calendar = calendars[0];
      }, 30000);

      it('should create and update a todo', async () => {
        const testId = generateTestId();

        const initialTodo = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//tsdav-utils//Integration Test//EN
BEGIN:VTODO
UID:${testId}
DTSTAMP:20250128T000000Z
SUMMARY:Original Todo
STATUS:NEEDS-ACTION
PRIORITY:5
DESCRIPTION:Original todo description
END:VTODO
END:VCALENDAR`;

        await client.createCalendarObject({
          calendar,
          filename: `${testId}.ics`,
          iCalString: initialTodo,
        });

        // Small delay to let server process
        await new Promise(resolve => setTimeout(resolve, 1000));

        const todos = await client.fetchCalendarObjects({ calendar });
        const todo = todos.find(t => t.url.includes(testId));

        if (!todo) {
          console.log('Available todos:', todos.map(t => t.url));
          throw new Error(`Todo with ID ${testId} not found on server`);
        }

        // Update todo
        const updated = updateFields(todo!.data, {
          'SUMMARY': 'Updated Todo Title',
          'STATUS': 'IN-PROCESS',
          'DESCRIPTION': 'Work in progress',
        });

        await client.updateCalendarObject({
          calendarObject: { ...todo!, data: updated },
        });

        // Verify
        const verifyTodos = await client.fetchCalendarObjects({ calendar });
        const verifiedTodo = verifyTodos.find(t => t.url.includes(testId));

        expect(verifiedTodo!.data).toContain('Updated Todo Title');
        expect(verifiedTodo!.data).toContain('IN-PROCESS');
        expect(verifiedTodo!.data).toContain('Work in progress');

        // Cleanup
        await client.deleteCalendarObject({
          calendarObject: verifiedTodo!,
        });
      }, 30000);
    });
  });

  describe('Nextcloud Server - Custom Properties', () => {
    let client: DAVClient;
    let calendar: DAVCalendar;

    const testDescribe = hasNextcloudCredentials ? describe : describe.skip;

    testDescribe('Custom X-* Properties', () => {
      beforeAll(async () => {
        if (!hasNextcloudCredentials) return;

        client = await createDAVClient({
          serverUrl: process.env.NEXTCLOUD_SERVER_URL!,
          credentials: {
            username: process.env.NEXTCLOUD_USERNAME!,
            password: process.env.NEXTCLOUD_PASSWORD!,
          },
          authMethod: 'Basic',
          defaultAccountType: 'caldav',
        });

        const calendars = await client.fetchCalendars();
        calendar = calendars[0];
      }, 30000);

      it('should handle custom X-* properties', async () => {
        const testId = generateTestId();

        const initialEvent = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//tsdav-utils//Integration Test//EN
BEGIN:VEVENT
UID:${testId}
DTSTART:20250203T100000Z
DTEND:20250203T110000Z
DTSTAMP:20250128T000000Z
SUMMARY:Custom Properties Test
END:VEVENT
END:VCALENDAR`;

        await client.createCalendarObject({
          calendar,
          filename: `${testId}.ics`,
          iCalString: initialEvent,
        });

        const events = await client.fetchCalendarObjects({ calendar });
        const event = events.find(e => e.url.includes(testId));

        // Add custom properties
        const updated = updateFields(event!.data, {
          'SUMMARY': 'Event with Custom Fields',
          'X-ZOOM-LINK': 'https://zoom.us/j/123456789',
          'X-PROJECT-ID': 'PROJ-2025-001',
          'X-MEETING-ROOM': 'Conference Room A',
        });

        await client.updateCalendarObject({
          calendarObject: { ...event!, data: updated },
        });

        // Verify custom properties persisted
        const verifyEvents = await client.fetchCalendarObjects({ calendar });
        const verifiedEvent = verifyEvents.find(e => e.url.includes(testId));

        expect(verifiedEvent!.data).toContain('Event with Custom Fields');
        expect(verifiedEvent!.data).toContain('X-ZOOM-LINK');
        expect(verifiedEvent!.data).toContain('https://zoom.us/j/123456789');
        expect(verifiedEvent!.data).toContain('X-PROJECT-ID:PROJ-2025-001');
        expect(verifiedEvent!.data).toContain('X-MEETING-ROOM:Conference Room A');

        // Cleanup
        await client.deleteCalendarObject({
          calendarObject: verifiedEvent!,
        });
      }, 30000);
    });
  });
});
