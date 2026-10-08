// Run by CI inside a fresh consumer install of the packed tarball, against the
// ical.js version npm resolves there (the package allows ^2.0.1). The check
// that a new rule keeps every override hooks ical.js internals to bound its
// work; this checks the hook still holds on whatever ical.js a consumer gets:
// a series move works, a rule that does not follow it is refused, a rule
// change keeping the override is accepted, and a sparse one is refused quickly
// instead of running for minutes.
import { createRequire } from 'node:module';
import { UpdateFieldsError, isUpdateFieldsError, updateFields } from 'tsdav-utils';

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

// 2. a rule that pins weekdays the move does not keep is refused
const pinned = refusal(() => updateFields(calendar(...event('DTSTART:20261005T090000Z', 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6')),
  { DTSTART: '2026-10-06T09:00:00Z' }));
if (!/does not move the whole series/.test(pinned ?? '')) {
  fail(`a BYDAY=MO,WE series moved to Tuesday was not refused: ${pinned}`);
}
console.log('✅ pinned rule refused');

// 3. a new rule that keeps the override is checked, through the bounded expansion
const kept = refusal(() => updateFields(calendar(
  ...event('DTSTART:20261005T090000Z', 'RRULE:FREQ=WEEKLY;COUNT=10'),
  ...event('RECURRENCE-ID:20261102T090000Z', 'DTSTART:20261102T100000Z'),
), { RRULE: 'FREQ=WEEKLY;COUNT=12' }));
if (kept !== null) {
  fail(`a rule change that keeps the override was refused: ${kept}`);
}
console.log('✅ rule change checked');

// 4. a sparse new rule is refused within the work budget
const t0 = Date.now();
const sparse = refusal(() => updateFields(calendar(
  ...event('DTSTART:20260101T235959Z', 'RRULE:FREQ=DAILY'),
  ...event('RECURRENCE-ID:20261231T235959Z', 'DTSTART:20261231T235959Z'),
), { RRULE: 'FREQ=SECONDLY;BYMONTH=12;BYMONTHDAY=31;BYHOUR=23;BYMINUTE=59;BYSECOND=59' }));
const ms = Date.now() - t0;
if (!/too sparse to expand within the work limit/.test(sparse ?? '') || ms > 5000) {
  fail(`a sparse rule was not refused within the budget (${ms} ms): ${sparse}`);
}
console.log(`✅ sparse rule refused in ${ms} ms`);

// 5. a refusal is typed in both builds, and the guard holds across them
const thrown = (f) => {
  try {
    f();
  } catch (error) {
    return error;
  }
  return null;
};
const cjs = createRequire(import.meta.url)('tsdav-utils');
const esmError = thrown(() => updateFields(calendar(...event('DTSTART:20261005T090000Z')), { RRULE: 'COUNT=5' }));
const cjsError = thrown(() => cjs.updateFields(calendar(...event('DTSTART:20261005T090000Z')), { RRULE: 'COUNT=5' }));
if (!(esmError instanceof UpdateFieldsError) || esmError.code !== 'INVALID_RULE' || esmError.property !== 'RRULE') {
  fail(`the ESM build threw no typed refusal: ${esmError}`);
}
if (!(cjsError instanceof cjs.UpdateFieldsError) || !isUpdateFieldsError(cjsError, 'INVALID_RULE') ||
    !cjs.isUpdateFieldsError(esmError, 'INVALID_RULE')) {
  fail(`the CommonJS build threw no typed refusal, or the guard does not hold across builds: ${cjsError}`);
}
console.log('✅ typed refusals in ESM and CommonJS');

// 6. a named zone writes the TZID and a VTIMEZONE that the resolved ical.js
//    reads back, in both builds, the same text from each
const named = (build) => build.updateFields(calendar(...event()),
  { DTSTART: '2026-10-05T07:00:00Z', RRULE: 'FREQ=WEEKLY;COUNT=5' }, { zone: 'Europe/Berlin' });
const [esmNamed, cjsNamed] = [named({ updateFields }), named(cjs)];
if (!esmNamed.includes('DTSTART;TZID=Europe/Berlin:20261005T090000') || !esmNamed.includes('TZID:Europe/Berlin')) {
  fail(`a zone write did not produce the TZID and its VTIMEZONE:\n${esmNamed}`);
}
if (esmNamed !== cjsNamed) {
  fail('the ESM and CommonJS builds wrote a zone differently');
}
console.log('✅ named zone with generated VTIMEZONE');
