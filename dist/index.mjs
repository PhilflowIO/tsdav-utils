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

// src/updateFields.ts
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
  let actualComponent;
  if (component.name === "vcalendar") {
    actualComponent = component.getFirstSubcomponent("vevent") || component.getFirstSubcomponent("vtodo") || component.getFirstSubcomponent("vjournal");
    if (!actualComponent) {
      throw new Error("No VEVENT, VTODO, or VJOURNAL found in VCALENDAR");
    }
  } else {
    actualComponent = component;
  }
  const entries = Object.entries(fields).sort(
    ([a], [b]) => Number(b.toLowerCase() === "dtstart") - Number(a.toLowerCase() === "dtstart")
  );
  for (const [key, value] of entries) {
    if (!setDateValue(actualComponent, key, value, floatingTime)) {
      actualComponent.updatePropertyWithValue(key.toLowerCase(), value);
    }
  }
  return component.toString();
}
export {
  parseDateValue,
  updateFields
};
