// Run by CI inside a fresh consumer install of the packed tarball, against the
// ical.js version npm resolves there (the package allows ^2.0.1). The series
// move hooks ical.js internals to bound its work; this checks the hook still
// holds on whatever ical.js a consumer gets: a move works, a rule that does
// not follow is refused, and a sparse rule is refused quickly instead of
// running for minutes.
import { updateFields } from 'tsdav-utils';

const calendar = (...lines) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ci//EN', ...lines, 'END:VCALENDAR', ''].join('\r\n');
const event = (...lines) => ['BEGIN:VEVENT', 'UID:ci', 'DTSTAMP:20260101T000000Z', ...lines, 'END:VEVENT'];
const fail = (why) => {
  console.error(`❌ ${why}`);
  process.exit(1);
};
const refusal = (f) => {
  try {
    f();
  } catch (error) {
    return error.message;
  }
  return null;
};

// 1. the series moves, the override with it
const moved = updateFields(calendar(
  ...event('DTSTART:20261005T090000Z', 'RRULE:FREQ=WEEKLY;COUNT=3'),
  ...event('RECURRENCE-ID:20261012T090000Z', 'DTSTART:20261012T130000Z'),
), { DTSTART: '2026-10-05T10:00:00Z' });
if (!moved.includes('RECURRENCE-ID:20261012T100000Z') || !moved.includes('DTSTART:20261012T140000Z')) {
  fail(`the series move did not carry the override along:\n${moved}`);
}
console.log('✅ series move');

// 2. a rule that pins the old weekday is refused
const pinned = refusal(() => updateFields(calendar(...event('DTSTART:20261005T090000Z', 'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3')),
  { DTSTART: '2026-10-06T09:00:00Z' }));
if (!/does not move the whole series/.test(pinned ?? '')) {
  fail(`a BYDAY=MO series moved to Tuesday was not refused: ${pinned}`);
}
console.log('✅ pinned rule refused');

// 3. a sparse rule is refused within the work budget
const t0 = Date.now();
const sparse = refusal(() => updateFields(calendar(...event('DTSTART:20261231T230000Z',
  'RRULE:FREQ=MINUTELY;BYMONTH=12;BYMONTHDAY=31;BYHOUR=23')), { DTSTART: '2026-12-31T23:01:00Z' }));
const ms = Date.now() - t0;
if (!/too sparse to expand within the work limit/.test(sparse ?? '') || ms > 5000) {
  fail(`a sparse rule was not refused within the budget (${ms} ms): ${sparse}`);
}
console.log(`✅ sparse rule refused in ${ms} ms`);
