// src/updateFields.ts
import ICAL2 from "ical.js";

// src/typedValue.ts
import ICAL from "ical.js";
var TYPED = /* @__PURE__ */ new Set(["date-time", "date", "timestamp"]);
var UTC_ONLY = /* @__PURE__ */ new Set(["completed", "created", "dtstamp", "last-modified"]);
var DATE_TIME_FORMS = '"2026-10-26T18:00:00Z", "2026-10-26T14:00:00-04:00", "20261026T180000Z" or "2026-10-26T18:00:00" (no zone; seconds optional)';
var ACCEPTED_FORMS = `Accepted forms: ${DATE_TIME_FORMS}, or a date "2026-10-26" / "20261026"`;
var DATE_EXTENDED = /^(\d{4})-(\d{2})-(\d{2})$/;
var DATE_BASIC = /^(\d{4})(\d{2})(\d{2})$/;
var ZONE = "(Z|[+-]\\d{2}(?::?\\d{2})?)";
var DATE_TIME_EXTENDED = new RegExp(
  `^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2})(?::(\\d{2})(?:\\.\\d+)?)?${ZONE}?$`,
  "i"
);
var DATE_TIME_BASIC = new RegExp(
  `^(\\d{4})(\\d{2})(\\d{2})T(\\d{2})(\\d{2})(\\d{2})${ZONE}?$`,
  "i"
);
var pad = (n, width = 2) => String(n).padStart(width, "0");
function utcMillis(y, mo, d, h = 0, mi = 0, s = 0) {
  const t = new Date(Date.UTC(2e3, mo - 1, d, h, mi, s));
  t.setUTCFullYear(y, mo - 1, d);
  return t.getTime();
}
function localDate(y, mo, d, h, mi, s) {
  const t = new Date(2e3, mo - 1, d, h, mi, s);
  t.setFullYear(y, mo - 1, d);
  return t;
}
function assertRealDateTime(raw, y, mo, d, h = 0, mi = 0, s = 0) {
  const t = new Date(utcMillis(y, mo, d, h, mi, 0));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d || h > 23 || mi > 59 || s > 60) {
    throw new Error(`"${raw}" is not a valid date or time`);
  }
}
function toUtcJcal(date) {
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}Z`;
}
function parseDateValue(raw) {
  const value = raw.trim();
  let m;
  if ((m = DATE_EXTENDED.exec(value)) || (m = DATE_BASIC.exec(value))) {
    const [y2, mo2, d2] = [Number(m[1]), Number(m[2]), Number(m[3])];
    assertRealDateTime(raw, y2, mo2, d2);
    return { kind: "date", jcal: `${m[1]}-${m[2]}-${m[3]}` };
  }
  m = DATE_TIME_EXTENDED.exec(value) || DATE_TIME_BASIC.exec(value);
  if (!m) {
    throw new Error(`"${raw}" is not a date or date-time. ${ACCEPTED_FORMS}`);
  }
  const [y, mo, d, h, mi] = [1, 2, 3, 4, 5].map((i) => Number(m[i]));
  const s = Number(m[6] ?? 0);
  const zone = m[7];
  assertRealDateTime(raw, y, mo, d, h, mi, s);
  if (zone) {
    let ms = utcMillis(y, mo, d, h, mi, s);
    if (zone.toUpperCase() !== "Z") {
      const sign = zone[0] === "-" ? -1 : 1;
      const digits = zone.slice(1).replace(":", "");
      const hours = Number(digits.slice(0, 2));
      const minutes = Number(digits.slice(2, 4) || 0);
      if (hours > 23 || minutes > 59) {
        throw new Error(`"${raw}" has an invalid UTC offset`);
      }
      ms -= sign * (hours * 60 + minutes) * 6e4;
    }
    return { kind: "utc", jcal: toUtcJcal(new Date(ms)) };
  }
  return {
    kind: "floating",
    jcal: `${pad(y, 4)}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}`,
    local: localDate(y, mo, d, h, mi, s)
  };
}
function designSetFor(component) {
  if (component.name === "vcard") {
    const version = String(component.getFirstPropertyValue("version") ?? "").trim();
    return version === "3.0" ? ICAL.design.vcard3 : ICAL.design.vcard;
  }
  return ICAL.design.icalendar;
}
function dateProperty(component, name) {
  const lower = name.toLowerCase();
  if (component.name === "vcard" && ICAL.design.vcard.property[lower]?.defaultType === "date-and-or-time") {
    return null;
  }
  const design = designSetFor(component).property[lower];
  if (!design || !TYPED.has(design.defaultType)) {
    return null;
  }
  return {
    defaultType: design.defaultType,
    allowedTypes: design.allowedTypes ?? [design.defaultType],
    multiValue: Boolean(design.multiValue)
  };
}
var ANCHORED = /* @__PURE__ */ new Set(["vevent", "vtodo", "vjournal"]);
function anchorOf(component, name) {
  if (name === "dtstart" || UTC_ONLY.has(name) || !ANCHORED.has(component.name)) {
    return null;
  }
  const dtstart = component.getFirstProperty("dtstart");
  if (!dtstart) {
    return null;
  }
  if (dtstart.type === "date") {
    return { form: "date" };
  }
  const tzid = dtstart.getParameter("tzid");
  if (typeof tzid === "string" && tzid) {
    return { form: "tzid", tzid };
  }
  const value = dtstart.toJSON()[3];
  return typeof value === "string" && /Z$/i.test(value) ? { form: "utc" } : { form: "floating" };
}
function setDateValue(component, name, raw, floatingTime = "keep") {
  const shape = dateProperty(component, name);
  if (!shape) {
    return false;
  }
  const upper = name.toUpperCase();
  const lower = name.toLowerCase();
  let parsed;
  try {
    const parts = shape.multiValue ? raw.split(",").filter((part) => part.trim() !== "") : [raw];
    parsed = (parts.length ? parts : [raw]).map(parseDateValue);
  } catch (error) {
    throw new Error(`${upper}: ${error.message}`);
  }
  if (new Set(parsed.map((p) => p.kind === "date")).size > 1) {
    throw new Error(`${upper} mixes dates and date-times; all values must be one or the other`);
  }
  const isDate = parsed[0].kind === "date";
  if (isDate && !shape.allowedTypes.includes("date")) {
    throw new Error(`${upper} needs a date-time, not a date. Accepted forms: ${DATE_TIME_FORMS}`);
  }
  const existing = component.getFirstProperty(lower);
  const anchor = anchorOf(component, lower);
  const why = ["exdate", "rdate"].includes(lower) ? "otherwise it names no occurrence of the series" : "RFC 5545 requires the same value type";
  if (anchor?.form === "date" && !isDate) {
    throw new Error(`${upper} must be a date: DTSTART is a date (all-day), and ${why}`);
  }
  if (anchor && anchor.form !== "date" && isDate) {
    throw new Error(`${upper} needs a time: DTSTART has one, and ${why}`);
  }
  const own = existing?.getParameter("tzid");
  const zone = UTC_ONLY.has(lower) ? null : typeof own === "string" && own ? own : anchor?.form === "tzid" ? anchor.tzid : null;
  const floating = parsed.some((p) => p.kind === "floating");
  const wallClock = !floating ? null : zone ? "tzid" : anchor?.form === "floating" ? "floating" : floatingTime === "local" ? "utc" : anchor?.form === "utc" || UTC_ONLY.has(lower) ? null : "floating";
  if (floating && wallClock === null) {
    throw new Error(UTC_ONLY.has(lower) ? `${upper} must be in UTC (RFC 5545): give a zone, e.g. "2026-10-26T18:00:00Z"` : `${upper} has no zone, and DTSTART is in UTC: give it one, e.g. "2026-10-26T18:00:00Z" or "2026-10-26T14:00:00-04:00"`);
  }
  if (floating && wallClock !== "utc" && parsed.some((p) => p.kind === "utc")) {
    throw new Error(`${upper} mixes values with and without a zone; give all of them a zone, or none`);
  }
  const tzid = wallClock === "tzid" ? zone : null;
  const values = parsed.map((p) => p.kind === "floating" && wallClock === "utc" ? toUtcJcal(p.local) : p.jcal);
  let type = isDate ? "date" : "date-time";
  if (type === "date-time" && shape.defaultType === "timestamp") {
    type = "timestamp";
  }
  let property = existing;
  if (!property) {
    property = new ICAL.Property(lower, component);
    component.addProperty(property);
  }
  if (tzid) {
    property.setParameter("tzid", tzid);
  } else {
    property.removeParameter("tzid");
  }
  property.resetType(type);
  if (shape.multiValue) {
    property.setValues(values);
  } else {
    property.setValue(values[0]);
  }
  return true;
}
var WEEKDAY = "(?:SU|MO|TU|WE|TH|FR|SA)";
function intList(min, max, signed) {
  const item = signed ? /^[+-]?\d{1,3}$/ : /^\d{1,2}$/;
  return (value) => {
    for (const v of value.split(",")) {
      const n = Math.abs(Number(v));
      if (!item.test(v) || n < min || n > max) {
        const range = signed ? `${min} to ${max} or -${max} to -${min}` : `${min} to ${max}`;
        return `"${v}" is not in ${range}`;
      }
    }
    return null;
  };
}
var RULE_PARTS = {
  FREQ: (v) => /^(SECONDLY|MINUTELY|HOURLY|DAILY|WEEKLY|MONTHLY|YEARLY)$/.test(v) ? null : `"${v}" is not one of SECONDLY, MINUTELY, HOURLY, DAILY, WEEKLY, MONTHLY, YEARLY`,
  UNTIL: () => null,
  COUNT: (v) => /^\d+$/.test(v) && Number(v) >= 1 ? null : `"${v}" is not a positive integer`,
  INTERVAL: (v) => /^\d+$/.test(v) && Number(v) >= 1 ? null : `"${v}" is not a positive integer`,
  BYSECOND: intList(0, 60, false),
  BYMINUTE: intList(0, 59, false),
  BYHOUR: intList(0, 23, false),
  BYDAY: (value) => {
    for (const v of value.split(",")) {
      const m = new RegExp(`^([+-]?\\d{1,2})?${WEEKDAY}$`).exec(v);
      const n = m?.[1] === void 0 ? 1 : Math.abs(Number(m[1]));
      if (!m || n < 1 || n > 53) {
        return `"${v}" is not a weekday (SU, MO, TU, WE, TH, FR, SA), optionally with an ordinal 1 to 53 or -53 to -1 ("1MO", "-1FR")`;
      }
    }
    return null;
  },
  BYMONTHDAY: intList(1, 31, true),
  BYYEARDAY: intList(1, 366, true),
  BYWEEKNO: intList(1, 53, true),
  BYMONTH: intList(1, 12, false),
  BYSETPOS: intList(1, 366, true),
  WKST: (v) => new RegExp(`^${WEEKDAY}$`).test(v) ? null : `"${v}" is not a weekday (SU, MO, TU, WE, TH, FR, SA)`
};
function parseRuleParts(raw) {
  const parts = /* @__PURE__ */ new Map();
  for (const part of raw.trim().split(";").filter((p) => p.trim() !== "")) {
    const eq = part.indexOf("=");
    const name = (eq < 0 ? part : part.slice(0, eq)).trim().toUpperCase();
    const value = eq < 0 ? "" : part.slice(eq + 1).trim().toUpperCase();
    const check = RULE_PARTS[name];
    if (!check) {
      throw new Error(`"${part.trim()}" is not a rule part. RFC 5545 defines ${Object.keys(RULE_PARTS).join(", ")} (e.g. "FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10")`);
    }
    if (parts.has(name)) {
      throw new Error(`${name} is given twice; each rule part may occur once`);
    }
    if (value === "") {
      throw new Error(`${name} has no value`);
    }
    const wrong = check(value);
    if (wrong) {
      throw new Error(`${name}: ${wrong}`);
    }
    parts.set(name, value);
  }
  const freq = parts.get("FREQ");
  if (!freq) {
    throw new Error('FREQ is missing; every rule needs one (e.g. "FREQ=DAILY;COUNT=5")');
  }
  if (parts.has("COUNT") && parts.has("UNTIL")) {
    throw new Error("COUNT and UNTIL cannot both be given (RFC 5545 3.3.10); use one of them");
  }
  if (parts.has("BYWEEKNO") && freq !== "YEARLY") {
    throw new Error("BYWEEKNO is only allowed with FREQ=YEARLY (RFC 5545 3.3.10)");
  }
  if (parts.has("BYYEARDAY") && ["DAILY", "WEEKLY", "MONTHLY"].includes(freq)) {
    throw new Error(`BYYEARDAY is not allowed with FREQ=${freq} (RFC 5545 3.3.10)`);
  }
  if (parts.has("BYMONTHDAY") && freq === "WEEKLY") {
    throw new Error("BYMONTHDAY is not allowed with FREQ=WEEKLY (RFC 5545 3.3.10)");
  }
  const ordinalDay = (parts.get("BYDAY") ?? "").split(",").some((d) => /\d/.test(d));
  if (ordinalDay && (!["MONTHLY", "YEARLY"].includes(freq) || parts.has("BYWEEKNO"))) {
    throw new Error('BYDAY with an ordinal ("1MO", "-1FR") is only allowed with FREQ=MONTHLY or FREQ=YEARLY, and not together with BYWEEKNO (RFC 5545 3.3.10)');
  }
  if (parts.has("BYSETPOS") && ![...parts.keys()].some((k) => k.startsWith("BY") && k !== "BYSETPOS")) {
    throw new Error("BYSETPOS needs another BYxxx part to select from (RFC 5545 3.3.10)");
  }
  return parts;
}
function timezoneOf(component, tzid) {
  let root = component;
  while (root.parent) {
    root = root.parent;
  }
  const vtimezone = root.getAllSubcomponents("vtimezone").find((tz) => tz.getFirstPropertyValue("tzid") === tzid);
  return vtimezone ? new ICAL.Timezone(vtimezone) : null;
}
function untilTime(component, ruleName, raw, floatingTime) {
  let parsed;
  try {
    parsed = parseDateValue(raw);
  } catch (error) {
    throw new Error(`${ruleName} UNTIL: ${error.message}`);
  }
  const anchor = anchorOf(component, ruleName.toLowerCase());
  const fail = (why) => new Error(`${ruleName} UNTIL ${why}`);
  if (anchor?.form === "date" && parsed.kind !== "date") {
    throw fail('must be a date: DTSTART is a date (all-day), and RFC 5545 3.3.10 requires the same type, e.g. "2026-10-26"');
  }
  if (anchor && anchor.form !== "date" && parsed.kind === "date") {
    throw fail("needs a time: DTSTART has one, and RFC 5545 3.3.10 requires the same type");
  }
  if (anchor?.form === "floating" && parsed.kind === "utc") {
    throw fail('must be a local time without a zone, like the floating DTSTART (RFC 5545 3.3.10), e.g. "2026-10-26T18:00:00"');
  }
  if (parsed.kind === "floating") {
    if (anchor?.form === "tzid") {
      const tz = timezoneOf(component, anchor.tzid);
      if (!tz) {
        throw fail(`has no zone, and DTSTART's zone "${anchor.tzid}" has no VTIMEZONE in the document to convert it to UTC with (RFC 5545 3.3.10 requires UTC here): give it a zone, e.g. "2026-10-26T18:00:00Z" or "2026-10-26T18:00:00+01:00"`);
      }
      const wall = ICAL.Time.fromDateTimeString(parsed.jcal);
      const zoned = ICAL.Time.fromData({
        year: wall.year,
        month: wall.month,
        day: wall.day,
        hour: wall.hour,
        minute: wall.minute,
        second: wall.second
      }, tz);
      return zoned.convertToZone(ICAL.Timezone.utcTimezone);
    }
    if (anchor?.form === "floating") {
      return ICAL.Time.fromDateTimeString(parsed.jcal);
    }
    if (floatingTime === "local") {
      return ICAL.Time.fromDateTimeString(toUtcJcal(parsed.local));
    }
    if (anchor?.form === "utc") {
      throw fail('has no zone, and DTSTART is in UTC: give it one, e.g. "2026-10-26T18:00:00Z" or "2026-10-26T14:00:00-04:00"');
    }
    return ICAL.Time.fromDateTimeString(parsed.jcal);
  }
  return parsed.kind === "date" ? ICAL.Time.fromDateString(parsed.jcal) : ICAL.Time.fromDateTimeString(parsed.jcal);
}
function isRecurProperty(component, name) {
  return designSetFor(component).property[name.toLowerCase()]?.defaultType === "recur";
}
var isUtcTime = (t) => !t.isDate && t.zone?.tzid === "UTC";
var dateString = (t) => `${pad(t.year, 4)}-${pad(t.month)}-${pad(t.day)}`;
var dateTimeString = (t) => `${dateString(t)}T${pad(t.hour)}:${pad(t.minute)}:${pad(t.second)}`;
function wallClockIn(component, t, tzid) {
  const tz = timezoneOf(component, tzid);
  if (!tz) {
    throw new Error(`the old DTSTART's zone "${tzid}" has no VTIMEZONE in the document to read it in`);
  }
  return t.convertToZone(tz);
}
function untilInput(component, old, oldAnchor, newAnchor) {
  if (newAnchor?.form === "date") {
    return dateString(isUtcTime(old) && oldAnchor?.form === "tzid" ? wallClockIn(component, old, oldAnchor.tzid) : old);
  }
  if (old.isDate) {
    if (!newAnchor) {
      return dateString(old);
    }
    return `${dateString(old)}T23:59:59${newAnchor.form === "utc" ? "Z" : ""}`;
  }
  if (isUtcTime(old)) {
    if (newAnchor?.form === "floating") {
      if (oldAnchor?.form !== "tzid") {
        throw new Error("it is in UTC and the new DTSTART is floating, and without a zone a UTC instant has no wall clock");
      }
      return dateTimeString(wallClockIn(component, old, oldAnchor.tzid));
    }
    return `${dateTimeString(old)}Z`;
  }
  return dateTimeString(old);
}
function untilsFollowingDtstart(component, written) {
  const anchor = anchorOf(component, "rrule");
  return component.getAllProperties().filter((p) => isRecurProperty(component, p.name) && !written.has(p.name)).flatMap((property) => {
    const until = property.getFirstValue()?.until;
    return until ? [{ property, until: until.clone(), anchor }] : [];
  });
}
function realignUntils(component, pending, floatingTime = "keep") {
  const anchor = anchorOf(component, "rrule");
  for (const { property, until, anchor: oldAnchor } of pending) {
    const upper = property.name.toUpperCase();
    const recur = property.getFirstValue();
    try {
      recur.until = untilTime(component, upper, untilInput(component, until, oldAnchor, anchor), floatingTime);
    } catch (error) {
      throw new Error(`DTSTART changed, and the existing ${upper} UNTIL=${until.toICALString()} cannot follow it (${error.message}): give ${upper}, with UNTIL, in the same call`);
    }
    property.setValue(recur);
  }
}
function setRecurValue(component, name, raw, floatingTime = "keep") {
  const lower = name.toLowerCase();
  if (!isRecurProperty(component, lower)) {
    return false;
  }
  const upper = name.toUpperCase();
  let parts;
  try {
    parts = parseRuleParts(raw);
  } catch (error) {
    throw new Error(`${upper}: ${error.message}`);
  }
  const until = parts.get("UNTIL");
  parts.delete("UNTIL");
  const recur = ICAL.Recur.fromString([...parts].map(([k, v]) => `${k}=${v}`).join(";"));
  if (until !== void 0) {
    recur.until = untilTime(component, upper, until, floatingTime);
  }
  let property = component.getFirstProperty(lower);
  if (!property) {
    property = new ICAL.Property(lower, component);
    component.addProperty(property);
  }
  property.resetType("recur");
  property.setValue(recur);
  return true;
}

// src/updateFields.ts
function seriesMaster(calendar, type) {
  const types = type ? [type.toLowerCase()] : ["vevent", "vtodo", "vjournal"];
  for (const type2 of types) {
    const all = calendar.getAllSubcomponents(type2);
    if (all.length === 0) {
      continue;
    }
    const master = all.find((c) => !c.hasProperty("recurrence-id"));
    if (master) {
      return master;
    }
    if (all.length === 1) {
      return all[0];
    }
    throw new Error(
      `This object holds ${all.length} ${type2.toUpperCase()} instances (each with a RECURRENCE-ID) and no master, so a field update cannot tell which one is meant. Edit the instance by rewriting the whole iCalendar object instead`
    );
  }
  throw new Error(`No ${types.map((t) => t.toUpperCase()).join(", ")} found in VCALENDAR`);
}
function updateFields(calendarObject, fields, options = {}) {
  const icalString = typeof calendarObject === "string" ? calendarObject : calendarObject.data;
  if (!icalString) {
    throw new Error('Invalid input: calendarObject must be a string or object with "data" field');
  }
  const floatingTime = options.floatingTime ?? "keep";
  if (floatingTime !== "keep" && floatingTime !== "local") {
    throw new Error(`Invalid floatingTime "${floatingTime}": use "keep" or "local"`);
  }
  let jcalData;
  let component;
  try {
    jcalData = ICAL2.parse(icalString);
    component = new ICAL2.Component(jcalData);
  } catch (error) {
    throw new Error(`Failed to parse iCal data: ${error.message}`);
  }
  const actualComponent = component.name === "vcalendar" ? seriesMaster(component) : component;
  const entries = Object.entries(fields).sort(
    ([a], [b]) => Number(b.toLowerCase() === "dtstart") - Number(a.toLowerCase() === "dtstart")
  );
  const written = new Set(entries.map(([key]) => key.toLowerCase()));
  const untils = written.has("dtstart") ? untilsFollowingDtstart(actualComponent, written) : [];
  for (const [key, value] of entries) {
    if (!setDateValue(actualComponent, key, value, floatingTime) && !setRecurValue(actualComponent, key, value, floatingTime)) {
      actualComponent.updatePropertyWithValue(key.toLowerCase(), value);
    }
  }
  realignUntils(actualComponent, untils, floatingTime);
  return component.toString();
}
export {
  parseDateValue,
  seriesMaster,
  updateFields
};
