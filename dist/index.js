"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  parseDateValue: () => parseDateValue,
  seriesMaster: () => seriesMaster,
  updateFields: () => updateFields
});
module.exports = __toCommonJS(index_exports);

// src/updateFields.ts
var import_ical4 = __toESM(require("ical.js"));

// src/types.ts
var COMPONENT_TYPES = ["vevent", "vtodo", "vjournal"];

// src/series.ts
var import_ical3 = __toESM(require("ical.js"));

// src/typedValue.ts
var import_ical2 = __toESM(require("ical.js"));

// src/zone.ts
var import_ical = __toESM(require("ical.js"));
var DAY = 86400;
function wallOf(y, mo, d, h = 0, mi = 0, s = 0) {
  const t = new Date(Date.UTC(2e3, mo - 1, d, h, mi, s));
  t.setUTCFullYear(y, mo - 1, d);
  return t.getTime() / 1e3;
}
function fieldsOf(wall) {
  const t = new Date(wall * 1e3);
  return {
    year: t.getUTCFullYear(),
    month: t.getUTCMonth() + 1,
    day: t.getUTCDate(),
    hour: t.getUTCHours(),
    minute: t.getUTCMinutes(),
    second: t.getUTCSeconds()
  };
}
var wallOfTime = (t) => wallOf(t.year, t.month, t.day, t.hour, t.minute, t.second);
function zoneFrom(offsetAt) {
  const fits = (wall) => [.../* @__PURE__ */ new Set([wall - offsetAt(wall - 2 * DAY), wall - offsetAt(wall + 2 * DAY)])].filter((utc) => utc + offsetAt(utc) === wall);
  const toUtc = (wall) => {
    const found = fits(wall);
    return found.length ? Math.min(...found) : wall - offsetAt(wall - 2 * DAY);
  };
  return {
    offsetAt,
    fromUtc: (utc) => utc + offsetAt(utc),
    toUtc,
    ambiguity: (wall) => {
      const found = fits(wall).length;
      return found === 0 ? "gap" : found > 1 ? "overlap" : null;
    },
    gapAlias: (utc) => {
      const alias = utc + offsetAt(utc - 4 * 3600);
      return alias !== utc + offsetAt(utc) && fits(alias).length === 0 && toUtc(alias) === utc ? alias : null;
    }
  };
}
function vtimezoneOf(component, tzid) {
  let root = component;
  while (root.parent) {
    root = root.parent;
  }
  return root.getAllSubcomponents("vtimezone").find((tz) => tz.getFirstPropertyValue("tzid") === tzid) ?? null;
}
var offsetSeconds = (value) => value && typeof value.toSeconds === "function" ? value.toSeconds() : 0;
var ONSET_LIMIT = 1e4;
function transitionsOf(vtimezone, horizon) {
  const list = [];
  for (const observance of vtimezone.getAllSubcomponents()) {
    if (observance.name !== "standard" && observance.name !== "daylight") {
      continue;
    }
    const from = offsetSeconds(observance.getFirstPropertyValue("tzoffsetfrom"));
    const to = offsetSeconds(observance.getFirstPropertyValue("tzoffsetto"));
    const start = observance.getFirstPropertyValue("dtstart");
    if (!start) {
      continue;
    }
    const onsets = /* @__PURE__ */ new Set([wallOfTime(start)]);
    for (const rdate of observance.getAllProperties("rdate")) {
      for (const value of rdate.getValues()) {
        const t = value instanceof import_ical.default.Period ? value.start : value;
        onsets.add(wallOfTime(t));
      }
    }
    for (const property of observance.getAllProperties("rrule")) {
      const recur = property.getFirstValue().clone();
      if (recur.freq !== "YEARLY" && recur.freq !== "MONTHLY") {
        throw new Error(`the VTIMEZONE "${vtimezone.getFirstPropertyValue("tzid")}" has an observance repeating ${recur.freq}, which no time zone does, so it is not read`);
      }
      if (recur.until) {
        const until = wallOfTime(recur.until) + (recur.until.zone === import_ical.default.Timezone.utcTimezone ? from : 0);
        recur.until = import_ical.default.Time.fromData({ ...fieldsOf(until), isDate: recur.until.isDate });
      }
      const iterator = recur.iterator(import_ical.default.Time.fromData(fieldsOf(wallOfTime(start))));
      for (let i = 0; i < ONSET_LIMIT; i++) {
        const next = iterator.next();
        if (!next || wallOfTime(next) - from > horizon) {
          break;
        }
        onsets.add(wallOfTime(next));
      }
    }
    for (const onset of onsets) {
      list.push({ at: onset - from, from, to });
    }
  }
  return list.sort((a, b) => a.at - b.at);
}
var transitionCache = /* @__PURE__ */ new WeakMap();
function vtimezoneZone(vtimezone) {
  const transitions = (utc) => {
    let cached = transitionCache.get(vtimezone);
    if (!cached || cached.horizon < utc + DAY * 400) {
      const horizon = utc + DAY * 366 * 10;
      cached = { horizon, list: transitionsOf(vtimezone, horizon) };
      transitionCache.set(vtimezone, cached);
    }
    return cached.list;
  };
  return zoneFrom((utc) => {
    const list = transitions(utc);
    if (!list.length) {
      return 0;
    }
    let lo = 0;
    let hi = list.length - 1;
    if (list[0].at > utc) {
      return list[0].from;
    }
    while (lo < hi) {
      const mid = lo + hi + 1 >> 1;
      if (list[mid].at <= utc) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return list[lo].to;
  });
}
function ianaZone(tzid) {
  let format;
  try {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: tzid,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      era: "short"
    });
  } catch {
    return null;
  }
  return zoneFrom((utc) => {
    const parts = Object.fromEntries(format.formatToParts(new Date(utc * 1e3)).map((p) => [p.type, p.value]));
    const year = parts.era === "BC" || parts.era === "B" ? 1 - Number(parts.year) : Number(parts.year);
    return wallOf(
      year,
      Number(parts.month),
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second)
    ) - utc;
  });
}
function zoneOf(component, tzid) {
  const vtimezone = vtimezoneOf(component, tzid);
  return vtimezone ? vtimezoneZone(vtimezone) : ianaZone(tzid);
}
function unknownZone(tzid) {
  return `the zone "${tzid}" has no VTIMEZONE in the document and is no IANA time zone`;
}

// src/typedValue.ts
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
  const zone2 = m[7];
  assertRealDateTime(raw, y, mo, d, h, mi, s);
  if (zone2) {
    let ms = utcMillis(y, mo, d, h, mi, s);
    if (zone2.toUpperCase() !== "Z") {
      const sign = zone2[0] === "-" ? -1 : 1;
      const digits = zone2.slice(1).replace(":", "");
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
    return version === "3.0" ? import_ical2.default.design.vcard3 : import_ical2.default.design.vcard;
  }
  return import_ical2.default.design.icalendar;
}
function dateProperty(component, name) {
  const lower = name.toLowerCase();
  if (component.name === "vcard" && import_ical2.default.design.vcard.property[lower]?.defaultType === "date-and-or-time") {
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
  return frameOf(component);
}
function frameOf(component) {
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
  const zone2 = UTC_ONLY.has(lower) ? null : typeof own === "string" && own ? own : anchor?.form === "tzid" ? anchor.tzid : null;
  const floating = parsed.some((p) => p.kind === "floating");
  const wallClock = !floating ? null : zone2 ? "tzid" : anchor?.form === "floating" ? "floating" : floatingTime === "local" ? "utc" : anchor?.form === "utc" || UTC_ONLY.has(lower) ? null : "floating";
  if (floating && wallClock === null) {
    throw new Error(UTC_ONLY.has(lower) ? `${upper} must be in UTC (RFC 5545): give a zone, e.g. "2026-10-26T18:00:00Z"` : `${upper} has no zone, and DTSTART is in UTC: give it one, e.g. "2026-10-26T18:00:00Z" or "2026-10-26T14:00:00-04:00"`);
  }
  if (floating && wallClock !== "utc" && parsed.some((p) => p.kind === "utc")) {
    throw new Error(`${upper} mixes values with and without a zone; give all of them a zone, or none`);
  }
  const tzid = wallClock === "tzid" ? zone2 : null;
  const values = parsed.map((p) => p.kind === "floating" && wallClock === "utc" ? toUtcJcal(p.local) : p.jcal);
  let type = isDate ? "date" : "date-time";
  if (type === "date-time" && shape.defaultType === "timestamp") {
    type = "timestamp";
  }
  let property = existing;
  if (!property) {
    property = new import_ical2.default.Property(lower, component);
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
      if (name === "RSCALE" || name === "SKIP") {
        throw new Error("RSCALE/SKIP (RFC 7529) are not supported: ical.js cannot write them without losing them");
      }
      const colon = name.indexOf(":");
      if (colon >= 0) {
        throw new Error(`"${part.trim()}" is not a rule part: drop the "${name.slice(0, colon + 1)}" prefix and give only the rule, e.g. "${part.trim().slice(colon + 1)}"`);
      }
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
  const tooFar = (parts.get("BYDAY") ?? "").split(",").find((d) => Math.abs(Number(/^([+-]?\d+)/.exec(d)?.[1] ?? 0)) > 5);
  if (tooFar && (freq === "MONTHLY" || parts.has("BYMONTH"))) {
    throw new Error(`BYDAY: "${tooFar}" counts past the fifth weekday of a month; within a month the ordinal is 1 to 5 or -5 to -1 (RFC 5545 3.3.10)`);
  }
  if (parts.has("BYSETPOS") && ![...parts.keys()].some((k) => k.startsWith("BY") && k !== "BYSETPOS")) {
    throw new Error("BYSETPOS needs another BYxxx part to select from (RFC 5545 3.3.10)");
  }
  return parts;
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
      const zone2 = zoneOf(component, anchor.tzid);
      if (!zone2) {
        throw fail(`has no zone, and DTSTART's zone "${anchor.tzid}" has no VTIMEZONE in the document and is no IANA time zone to convert it to UTC with (RFC 5545 3.3.10 requires UTC here): give it a zone, e.g. "2026-10-26T18:00:00Z" or "2026-10-26T18:00:00+01:00"`);
      }
      const wall = import_ical2.default.Time.fromDateTimeString(parsed.jcal);
      const utc = fieldsOf(zone2.toUtc(wallOf(wall.year, wall.month, wall.day, wall.hour, wall.minute, wall.second)));
      return import_ical2.default.Time.fromData(utc, import_ical2.default.Timezone.utcTimezone);
    }
    if (anchor?.form === "floating") {
      return import_ical2.default.Time.fromDateTimeString(parsed.jcal);
    }
    if (floatingTime === "local") {
      return import_ical2.default.Time.fromDateTimeString(toUtcJcal(parsed.local));
    }
    if (anchor?.form === "utc") {
      throw fail('has no zone, and DTSTART is in UTC: give it one, e.g. "2026-10-26T18:00:00Z" or "2026-10-26T14:00:00-04:00"');
    }
    return import_ical2.default.Time.fromDateTimeString(parsed.jcal);
  }
  return parsed.kind === "date" ? import_ical2.default.Time.fromDateString(parsed.jcal) : import_ical2.default.Time.fromDateTimeString(parsed.jcal);
}
function isRecurProperty(component, name) {
  return designSetFor(component).property[name.toLowerCase()]?.defaultType === "recur";
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
  const recur = import_ical2.default.Recur.fromString([...parts].map(([k, v]) => `${k}=${v}`).join(";"));
  if (until !== void 0) {
    recur.until = untilTime(component, upper, until, floatingTime);
  }
  let property = component.getFirstProperty(lower);
  if (!property) {
    property = new import_ical2.default.Property(lower, component);
    component.addProperty(property);
  }
  property.resetType("recur");
  property.setValue(recur);
  return true;
}

// src/series.ts
var DAY2 = 86400;
var JCAL = /^(\d{4,})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(Z)?)?$/i;
function stampOf(jcal, tzid) {
  const m = JCAL.exec(jcal);
  if (!m) {
    throw new Error(`"${jcal}" is not a date or date-time`);
  }
  const [y, mo, d, h, mi, s] = [1, 2, 3, 4, 5, 6].map((i) => Number(m[i] ?? 0));
  const wall = wallOf(y, mo, d, h, mi, s);
  if (m[4] === void 0) {
    return { wall, kind: "date" };
  }
  if (m[7]) {
    return { wall, kind: "utc" };
  }
  return typeof tzid === "string" && tzid ? { wall, kind: "tzid", tzid } : { wall, kind: "floating" };
}
var valuesOf = (property) => property.toJSON().slice(3);
var propertyStamps = (property) => {
  const tzid = property.getParameter("tzid");
  return valuesOf(property).map((v) => stampOf(String(Array.isArray(v) ? v[0] : v), tzid));
};
var dayOf = (wall) => Math.floor(wall / DAY2) * DAY2;
function jcalOf(wall, frame) {
  const form = typeof frame === "string" ? frame : frame.form;
  const f = fieldsOf(wall);
  const date = `${pad(f.year, 4)}-${pad(f.month)}-${pad(f.day)}`;
  if (form === "date") {
    return date;
  }
  return `${date}T${pad(f.hour)}:${pad(f.minute)}:${pad(f.second)}${form === "utc" ? "Z" : ""}`;
}
var icalForm = (jcal) => jcal.replace(/[-:]/g, "");
function zone(component, tzid) {
  const resolved = zoneOf(component, tzid);
  if (!resolved) {
    throw new Error(unknownZone(tzid));
  }
  return resolved;
}
function convert(component, wall, from, to) {
  const utc = from === null ? wall : zone(component, from).toUtc(wall);
  return to === null ? utc : zone(component, to).fromUtc(utc);
}
function wallIn(component, stamp, frame) {
  if (stamp.kind === "date" || stamp.kind === "floating" || frame.form === "date") {
    return stamp.wall;
  }
  if (frame.form === "floating") {
    if (stamp.kind === "utc") {
      throw new Error("it is in UTC, and a floating series has no zone to read it in");
    }
    return stamp.wall;
  }
  const own = stamp.kind === "utc" ? null : stamp.tzid;
  const target = frame.form === "utc" ? null : frame.tzid;
  if (own === target) {
    return stamp.wall;
  }
  const utc = own === null ? stamp.wall : zone(component, own).toUtc(stamp.wall);
  if (target === null) {
    return utc;
  }
  return zone(component, target).fromUtc(utc);
}
function gapTwin(component, stamp, frame) {
  if (frame.form !== "tzid" || stamp.kind === "date") {
    return null;
  }
  const series = zone(component, frame.tzid);
  const inSeries = stamp.kind === "floating" || stamp.kind === "tzid" && stamp.tzid === frame.tzid;
  const utc = stamp.kind === "utc" ? stamp.wall : inSeries ? series.toUtc(stamp.wall) : zone(component, stamp.tzid).toUtc(stamp.wall);
  const skipped = series.gapAlias(utc);
  if (skipped === null) {
    return null;
  }
  const real = series.fromUtc(utc);
  const wall = inSeries ? stamp.wall : real;
  return { wall, other: wall === skipped ? real : skipped };
}
function findGapTwin(master, properties) {
  const frame = frameOf(master);
  if (!frame || frame.form !== "tzid" || !zoneOf(master, frame.tzid)) {
    return null;
  }
  const twins = properties.filter((property) => property.type !== "period").flatMap((property) => propertyStamps(property).flatMap((stamp) => {
    const twin = gapTwin(master, stamp, frame);
    return twin ? [{ property, twin }] : [];
  }));
  if (!twins.length) {
    return null;
  }
  const walls = expand(master, Math.max(...twins.map(({ twin }) => twin.other)));
  const clash = twins.find(({ twin }) => walls.has(twin.other));
  return clash ? `${clash.property.toICALString()} %NAMES% the same instant as the occurrence at ${icalForm(jcalOf(clash.twin.other, "floating"))} in "${frame.tzid}", a wall-clock time the DST change skips, so which occurrence it names cannot be told` : null;
}
var byDays = (move) => move.from.form === "date" || move.to.form === "date";
function moved(stamp, move) {
  const wall = wallIn(move.component, stamp, move.from);
  if (byDays(move) || stamp.kind === "date") {
    const days = (dayOf(wall) - dayOf(move.fromWall)) / DAY2;
    return (move.to.form === "date" ? dayOf(move.toWall) : move.toWall) + days * DAY2;
  }
  return move.toWall + (wall - move.fromWall);
}
function writeInstants(property, walls, frame) {
  if (frame.form === "tzid") {
    property.setParameter("tzid", frame.tzid);
  } else {
    property.removeParameter("tzid");
  }
  property.resetType(frame.form === "date" ? "date" : "date-time");
  const values = walls.map((wall) => jcalOf(wall, frame));
  if (property.name === "recurrence-id") {
    property.setValue(values[0]);
  } else {
    property.setValues(values);
  }
}
function moveInstants(property, move) {
  if (property.type === "period") {
    throw new Error("it holds periods, which updateFields does not move");
  }
  const stamps = propertyStamps(property);
  if (property.type === "date" && move.from.form !== "date" && move.to.form !== "date") {
    const shift = dayOf(move.toWall) - dayOf(move.fromWall);
    if (move.toWall - move.fromWall !== shift) {
      throw new Error("it is a date, a whole day, which cannot move by the time of day DTSTART moved");
    }
    writeInstants(property, stamps.map((stamp) => stamp.wall + shift), { form: "date" });
    return;
  }
  writeInstants(property, stamps.map((stamp) => moved(stamp, move)), move.to);
}
function wallOut(component, wall, frame, own) {
  if (own.kind === "floating" || own.kind === "date" || frame.form === "floating" || frame.form === "date") {
    return wall;
  }
  const from = frame.form === "utc" ? null : frame.tzid;
  const to = own.kind === "utc" ? null : own.tzid;
  if (from === to) {
    return wall;
  }
  const utc = from === null ? wall : zone(component, from).toUtc(wall);
  if (to === null) {
    return utc;
  }
  const own2 = zone(component, to);
  const out = own2.fromUtc(utc);
  if (own2.toUtc(out) !== utc) {
    throw new Error(`moved, it would be ${icalForm(jcalOf(utc, "utc"))}, which in "${to}" falls in the second pass of the hour the DST change shows twice, where ${icalForm(jcalOf(out, "floating"))} reads as the first`);
  }
  return out;
}
function moveOverrideTimes(override, before, after, move) {
  const component = move.component;
  const days = (dayOf(after.wall) - dayOf(before.wall)) / DAY2;
  const floating = move.from.form === "floating" || move.to.form === "floating";
  for (const name of ["dtstart", "dtend", "due"]) {
    for (const property of override.getAllProperties(name)) {
      const [stamp] = propertyStamps(property);
      let wall;
      if (stamp.kind === "date" || byDays(move)) {
        wall = stamp.wall + days * DAY2;
      } else if (floating || stamp.kind === "floating") {
        wall = stamp.wall + (after.wall - before.wall);
      } else {
        wall = wallOut(component, moved(stamp, move), move.to, stamp);
      }
      const type = property.type;
      property.resetType(type);
      property.setValue(jcalOf(wall, stamp.kind));
    }
  }
}
var RULE_KEYS = /* @__PURE__ */ new Set([
  "freq",
  "until",
  "count",
  "interval",
  "wkst",
  "bysecond",
  "byminute",
  "byhour",
  "byday",
  "bymonthday",
  "byyearday",
  "byweekno",
  "bymonth",
  "bysetpos"
]);
function unknownRuleParts(property) {
  const raw = property.toJSON()[3];
  return raw && typeof raw === "object" ? Object.keys(raw).filter((key) => !RULE_KEYS.has(key.toLowerCase())).map((key) => key.toUpperCase()) : [];
}
var RuleTexts = class {
  constructor(source, calendar, master) {
    this.texts = /* @__PURE__ */ new Map();
    this.changed = /* @__PURE__ */ new Map();
    if (source === null) {
      return;
    }
    const lines = source.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
    const type = master.name.toUpperCase();
    const index = calendar ? calendar.getAllSubcomponents(master.name).indexOf(master) : 0;
    const level = calendar ? 2 : 1;
    const own = [];
    let depth = 0;
    let seen = -1;
    let inside = false;
    for (const line of lines) {
      const boundary = /^(BEGIN|END):(.+)$/i.exec(line.trim());
      if (boundary && boundary[1].toUpperCase() === "BEGIN") {
        depth++;
        if (!inside && depth === level && boundary[2].trim().toUpperCase() === type && ++seen === index) {
          inside = true;
        }
      } else if (boundary) {
        if (inside && depth === level) {
          break;
        }
        depth--;
      } else if (inside && depth === level) {
        own.push(line);
      }
    }
    for (const name of ["rrule", "exrule"]) {
      const written = own.filter((line) => new RegExp(`^${name}[;:]`, "i").test(line));
      const properties = master.getAllProperties(name);
      if (written.length !== properties.length) {
        continue;
      }
      properties.forEach((property, i) => {
        const colon = colonOf(written[i]);
        this.texts.set(property, { head: written[i].slice(0, colon), parts: written[i].slice(colon + 1).split(";") });
      });
    }
  }
  /** The rule part names given more than once (RFC 5545 3.3.10 allows each once) */
  repeated(property) {
    const names = (this.texts.get(property)?.parts ?? []).map((part) => part.split("=")[0].trim().toUpperCase());
    return [...new Set(names.filter((name, i) => names.indexOf(name) !== i))];
  }
  /**
   * Change rule parts: in the rule as parsed (so the rest of the write sees
   * it), and in the rule as written, token by token, the part names matched
   * case-insensitively and everything else kept as it was.
   */
  rewrite(component, property, parsed, written) {
    const text = this.texts.get(property);
    if (!text) {
      throw new Error("its text could not be found in the object, so it cannot be rewritten part by part");
    }
    const parts = text.parts.map((part) => {
      const eq = part.indexOf("=");
      const name = eq < 0 ? part : part.slice(0, eq);
      const value = written[name.trim().toUpperCase()];
      return value === void 0 ? part : `${name}=${value}`;
    });
    const next = rewriteRule(component, property, parsed);
    const line = { head: text.head, parts };
    this.texts.delete(property);
    this.changed.delete(property);
    this.texts.set(next, line);
    this.changed.set(next, line);
    return next;
  }
  /** Before serialising: tag each rewritten rule so render() can find its line */
  mark() {
    [...this.changed.keys()].forEach((property, i) => property.setParameter("x-tsdav-utils-rule", String(i)));
  }
  /** After serialising: put each tagged rule back as written, with only its changed parts */
  render(text) {
    if (!this.changed.size) {
      return text;
    }
    const lines = [...this.changed.values()];
    const physical = text.split("\r\n");
    const out = [];
    for (let i = 0; i < physical.length; ) {
      let j = i + 1;
      while (j < physical.length && /^[ \t]/.test(physical[j])) {
        j++;
      }
      const logical = physical[i] + physical.slice(i + 1, j).map((l) => l.slice(1)).join("");
      const tag = /;X-TSDAV-UTILS-RULE=(\d+)/i.exec(logical.slice(0, colonOf(logical)));
      if (tag) {
        const line = lines[Number(tag[1])];
        out.push(import_ical3.default.helpers.foldline(`${line.head}:${line.parts.join(";")}`));
      } else {
        out.push(...physical.slice(i, j));
      }
      i = j;
    }
    return out.join("\r\n");
  }
};
function colonOf(line) {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') {
      quoted = !quoted;
    } else if (line[i] === ":" && !quoted) {
      return i;
    }
  }
  return line.length;
}
function rewriteRule(component, property, changes) {
  const [name, params, type, value] = property.toJSON();
  const next = new import_ical3.default.Property([name, params, type, { ...value, ...changes }], component);
  const all = [...component.getAllProperties()];
  component.removeAllProperties();
  for (const each of all) {
    component.addProperty(each === property ? next : each);
  }
  return next;
}
function moveUntil(property, move, texts) {
  const repeated = texts.repeated(property);
  if (repeated.length) {
    throw new Error(`the rule gives ${repeated.join(", ")} more than once, which RFC 5545 3.3.10 does not allow and clients read differently`);
  }
  const unknown = unknownRuleParts(property);
  if (unknown.length) {
    throw new Error(`the rule has ${unknown.join(", ")}, which updateFields would lose rewriting it`);
  }
  const recur = property.getFirstValue();
  const until = stampOf(recur.until.toString());
  if (move.from.form === "tzid" && until.kind === "utc") {
    const old = zone(move.component, move.from.tzid);
    if (old.gapAlias(until.wall) !== null || old.ambiguity(old.fromUtc(until.wall))) {
      throw new Error(`it lies at the DST change in "${move.from.tzid}", where the wall clock and the order of instants part, so moved on the wall clock it could let one occurrence too many or too few through`);
    }
  }
  if (until.kind === "date" !== (move.from.form === "date")) {
    throw new Error(`UNTIL is a ${until.kind === "date" ? "date" : "date-time"} next to a ${move.from.form === "date" ? "date" : "date-time"} DTSTART, so where it ends the series is not defined`);
  }
  const wall = move.from.form !== "date" && move.to.form === "date" ? dayOf(move.toWall) + Math.floor((wallIn(move.component, until, move.from) - move.fromWall) / DAY2) * DAY2 : moved(until, move);
  let untilValue;
  if (move.to.form === "date") {
    untilValue = jcalOf(wall, move.to);
  } else if (move.to.form === "tzid") {
    const target = zone(move.component, move.to.tzid);
    const ambiguity = target.ambiguity(wall) ?? (target.gapAlias(target.toUtc(wall)) !== null ? "gap" : null);
    if (ambiguity) {
      throw new Error(`moved, it would be ${icalForm(jcalOf(wall, "floating"))} in "${move.to.tzid}", at the DST change, where ${ambiguity === "gap" ? "the wall clock skips times" : "the wall clock shows an hour twice"} and its order and the order of instants part`);
    }
    untilValue = jcalOf(convert(move.component, wall, move.to.tzid, null), "utc");
  } else {
    untilValue = jcalOf(wall, move.to);
  }
  texts.rewrite(move.component, property, { until: untilValue }, { UNTIL: untilValue.replace(/[-:]/g, "") });
}
function startOf(master) {
  const frame = frameOf(master);
  const dtstart = master.getFirstProperty("dtstart");
  if (!frame || !dtstart) {
    return null;
  }
  return { frame, wall: stampOf(String(valuesOf(dtstart)[0])).wall, text: dtstart.toICALString() };
}
var WORK_BUDGET = 15e4;
function stepCost(recur) {
  const interval = Math.max(1, recur.interval || 1);
  switch (recur.freq) {
    case "SECONDLY":
    case "MINUTELY":
      return 3;
    case "HOURLY":
      return 10;
    case "DAILY":
      return 5 + Math.ceil(interval * 0.15);
    case "WEEKLY":
      return 15 + Math.ceil(interval * 7 * 0.15);
    default:
      return 45;
  }
}
var expansionWork = { steps: 0 };
var SeriesTooSparse = class extends Error {
};
var HorizonReached = class extends Error {
};
var SeriesUnverifiable = class extends Error {
};
function bounded(iterator, budget, recur, horizon) {
  const cost = stepCost(recur);
  const it = iterator;
  const check = it.check_contracting_rules;
  if (typeof check !== "function") {
    throw new SeriesTooSparse("ical.js no longer exposes the step a rule expansion can be bounded at");
  }
  it.check_contracting_rules = function(...args) {
    expansionWork.steps++;
    if ((budget.left -= cost) < 0) {
      throw new SeriesTooSparse("the rule is too sparse to expand within the work limit");
    }
    const last = this.last;
    if (last && wallOf(last.year, last.month, last.day, last.hour, last.minute, last.second) > horizon) {
      throw new HorizonReached();
    }
    return check.apply(this, args);
  };
  return iterator;
}
function expand(master, until) {
  const start = startOf(master);
  if (!start) {
    throw new SeriesUnverifiable("the series has no DTSTART");
  }
  const { frame } = start;
  const day = frame.form === "date";
  const norm = (wall) => day ? dayOf(wall) : wall;
  const timeOf = (wall) => day ? import_ical3.default.Time.fromDateString(jcalOf(wall, frame)) : import_ical3.default.Time.fromDateTimeString(jcalOf(wall, "floating"));
  const walls = /* @__PURE__ */ new Set([norm(start.wall)]);
  const budget = { left: WORK_BUDGET };
  try {
    for (const rdate of master.getAllProperties("rdate")) {
      for (const stamp of propertyStamps(rdate)) {
        walls.add(norm(wallIn(master, stamp, frame)));
      }
    }
    for (const property of master.getAllProperties("rrule")) {
      const recur = property.getFirstValue().clone();
      if (recur.until) {
        recur.until = timeOf(norm(wallIn(master, stampOf(recur.until.toString()), frame)));
      }
      const iterator = bounded(recur.iterator(timeOf(start.wall)), budget, recur, day ? until + DAY2 - 1 : until);
      try {
        for (let next = iterator.next(); next; next = iterator.next()) {
          const wall = norm(wallOf(next.year, next.month, next.day, next.hour, next.minute, next.second));
          if (wall > until) {
            break;
          }
          walls.add(wall);
        }
      } catch (error) {
        if (!(error instanceof HorizonReached)) {
          throw error;
        }
      }
    }
  } catch (error) {
    if (error instanceof SeriesTooSparse) {
      throw new SeriesTooSparse(walls.size > 200 ? `the override or EXDATE furthest ahead (${icalForm(jcalOf(until, frame))}) lies too far ahead to check within the work limit` : error.message);
    }
    throw new SeriesUnverifiable(error.message);
  }
  return walls;
}
function occurrences(master, stamps, labels) {
  const frame = frameOf(master);
  if (!frame) {
    throw new SeriesUnverifiable("the series has no DTSTART");
  }
  const targets = stamps.map((stamp, i) => {
    try {
      const wall = wallIn(master, stamp, frame);
      return frame.form === "date" ? dayOf(wall) : wall;
    } catch (error) {
      throw new SeriesUnverifiable(`${labels[i]}: ${error.message}`);
    }
  });
  const walls = expand(master, Math.max(...targets));
  return targets.map((t) => walls.has(t));
}
function referenceStamps(refs) {
  return refs.map((ref) => {
    try {
      return propertyStamps(ref.property)[ref.index];
    } catch (error) {
      throw new SeriesUnverifiable(`${ref.label}: ${error.message}`);
    }
  });
}
function suggestedRule(rule, start, timed) {
  const f = fieldsOf(start);
  const weekday = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][new Date(start * 1e3).getUTCDay()];
  const values = {
    BYDAY: weekday,
    BYMONTHDAY: String(f.day),
    BYMONTH: String(f.month),
    ...timed ? { BYHOUR: String(f.hour), BYMINUTE: String(f.minute) } : {}
  };
  let changed = false;
  const parts = rule.toString().split(";").map((part) => {
    const [name, value] = part.split("=");
    if (values[name] && /^[A-Z]{2}$|^\d+$/.test(value) && value !== values[name]) {
      changed = true;
      return `${name}=${values[name]}`;
    }
    return part;
  });
  return changed ? parts.join(";") : null;
}
var SHAPING = ["dtstart", "rrule", "rdate"];
var NO_SERIES = { finish() {
}, render: (text) => text };
function beginSeriesEdit(calendar, master, written, source = null) {
  const failClosed = (error) => {
    if (error instanceof SeriesUnverifiable) {
      return new Error(`Cannot check that the overrides and EXDATEs still name occurrences of the series: ${error.message}. Rewrite the whole iCalendar object instead`);
    }
    if (!(error instanceof SeriesTooSparse)) {
      return error;
    }
    const rule = master.getFirstProperty("rrule")?.toICALString() ?? "The rule";
    return written.has("rrule") || written.has("rdate") ? new Error(`Cannot check that the overrides and EXDATEs still name occurrences of the series: ${rule}: ${error.message}. Rewrite the whole iCalendar object instead`) : new Error(`Cannot check that moving DTSTART keeps the series' occurrences: ${rule}: ${error.message}. Give RRULE, UNTIL and EXDATE explicitly in the same call, or rewrite the whole iCalendar object`);
  };
  try {
    const edit = startSeriesEdit(calendar, master, written, source);
    return {
      finish() {
        try {
          edit.finish();
        } catch (error) {
          throw failClosed(error);
        }
      },
      render: (text) => edit.render(text)
    };
  } catch (error) {
    throw failClosed(error);
  }
}
function startSeriesEdit(calendar, master, written, source) {
  if (!["vevent", "vtodo", "vjournal"].includes(master.name) || master.hasProperty("recurrence-id")) {
    return NO_SERIES;
  }
  if (written.has("recurrence-id")) {
    throw new Error("RECURRENCE-ID cannot be written on the series master: it would turn the master into an override of a single instance (RFC 5545 3.8.4.4). updateFields edits the series; to change one instance, add or edit an override component (same UID, with RECURRENCE-ID) by rewriting the whole iCalendar object");
  }
  const replaced = new Set([...written].map((name) => master.getFirstProperty(name)).filter(Boolean));
  const own = (name) => master.getAllProperties(name).filter((p) => !replaced.has(p));
  const uid = master.getFirstPropertyValue("uid");
  const overrides = (calendar?.getAllSubcomponents(master.name) ?? []).filter((c) => c !== master && c.hasProperty("recurrence-id") && c.getFirstPropertyValue("uid") === uid);
  const exdates = own("exdate");
  const rdates = own("rdate");
  const rules = master.getAllProperties().filter((p) => isRecurProperty(master, p.name) && !replaced.has(p) && p.getFirstValue()?.until);
  const references = [
    ...overrides.map((c) => {
      const property = c.getFirstProperty("recurrence-id");
      return { property, index: 0, label: `the override for ${property.toICALString()}` };
    }),
    ...exdates.flatMap((property) => valuesOf(property).map((v, index) => ({
      property,
      index,
      label: `EXDATE ${icalForm(String(v))}`
    })))
  ];
  const shaping = SHAPING.filter((name) => written.has(name));
  const ruleWritten = written.has("rrule") || written.has("rdate");
  const before = ruleWritten && references.length ? occurrences(master, referenceStamps(references), references.map((ref) => ref.label)) : [];
  const watched = references.filter((_, i) => before[i] === true);
  const start = written.has("dtstart") ? startOf(master) : null;
  const keepsRule = !["rrule", "exrule", "rdate"].some((name) => written.has(name));
  const texts = new RuleTexts(source, calendar, master);
  const named = () => [
    ...master.getAllProperties("exdate"),
    ...master.getAllProperties("rdate"),
    ...overrides.map((c) => c.getFirstProperty("recurrence-id"))
  ];
  let twinBefore = null;
  let twinError = null;
  if (start || ruleWritten) {
    try {
      twinBefore = findGapTwin(master, named());
    } catch (error) {
      twinError = error;
    }
  }
  return {
    render: (text) => texts.render(text),
    finish() {
      const now = start && startOf(master);
      if (start && now && start.text !== now.text) {
        const move = { component: master, from: start.frame, fromWall: start.wall, to: now.frame, toWall: now.wall };
        if (move.from.form !== "date" && move.to.form === "date") {
          checkDatesOnly(master, move, [
            ...exdates,
            ...rdates,
            ...overrides.map((c) => c.getFirstProperty("recurrence-id"))
          ]);
        }
        for (const property of rules) {
          const upper = property.name.toUpperCase();
          const until = property.getFirstValue().until.toICALString();
          try {
            moveUntil(property, move, texts);
          } catch (error) {
            throw new Error(`DTSTART changed, and the existing ${upper} UNTIL=${until} cannot follow it (${error.message}): give ${upper}, with UNTIL, in the same call`);
          }
        }
        for (const property of [...exdates, ...rdates]) {
          const line = property.toICALString();
          try {
            moveInstants(property, move);
          } catch (error) {
            throw new Error(`DTSTART changed, and the existing ${line} cannot follow it (${error.message}): give ${property.name.toUpperCase()} in the same call`);
          }
        }
        for (const override of overrides) {
          const rid = override.getFirstProperty("recurrence-id");
          const line = rid.toICALString();
          try {
            const [old] = propertyStamps(rid);
            moveInstants(rid, move);
            moveOverrideTimes(override, old, propertyStamps(rid)[0], move);
          } catch (error) {
            throw new Error(`DTSTART changed, and the override for ${line} cannot follow it (${error.message}): rewrite the whole iCalendar object with the override moved`);
          }
        }
        if (keepsRule) {
          checkMove(master, move, start.text, now.text, texts);
        }
      }
      const moving = Boolean(start && now && start.text !== now.text);
      if (moving || ruleWritten) {
        const cause = moving ? "Moving DTSTART" : `Writing ${shaping.filter((n) => n !== "dtstart").map((n) => n.toUpperCase()).join(" and ")}`;
        if (twinError) {
          throw twinError;
        }
        const after2 = twinBefore ? null : findGapTwin(master, named());
        const twin = twinBefore ?? after2;
        if (twin) {
          const verb = twinBefore ? "names" : moving ? "would name, moved," : "would name";
          throw new Error(`${cause} is refused: ${twin.replace("%NAMES%", verb)}. Rewrite the whole iCalendar object with the values it should have`);
        }
      }
      texts.mark();
      if (!watched.length) {
        return;
      }
      const after = occurrences(master, referenceStamps(watched), watched.map((ref) => ref.label));
      const lost = watched.filter((_, i) => after[i] === false);
      if (lost.length) {
        const what = shaping.map((n) => n.toUpperCase()).join(" and ");
        throw new Error(`The new ${what} leaves ${lost.map((ref) => ref.label).join(", ")} naming no occurrence of the series, so ${lost.length > 1 ? "they" : "it"} would silently stop applying (RFC 5545 3.8.4.4, 3.8.5.1). Give RRULE (or RDATE) in the same call so the series still has ${lost.length > 1 ? "these occurrences" : "this occurrence"}, and EXDATE in the same call with the exclusions the new series should have; or rewrite the whole iCalendar object to move or remove the override`);
      }
    }
  };
}
function yearlyFollows(from, to) {
  const everyYear = (month, day) => day <= new Date(Date.UTC(2025, month, 0)).getUTCDate();
  if (!everyYear(from.month, from.day) || !everyYear(to.month, to.day)) {
    return false;
  }
  const years = to.year - from.year;
  const distances = [2023, 2024, 2025, 2026].map((y) => Date.UTC(y + years, to.month - 1, to.day) - Date.UTC(y, from.month - 1, from.day));
  return distances.every((d) => d === distances[0]);
}
var SUB_DAILY = /* @__PURE__ */ new Set(["SECONDLY", "MINUTELY", "HOURLY"]);
var FREQS = /* @__PURE__ */ new Set([...SUB_DAILY, "DAILY", "WEEKLY", "MONTHLY", "YEARLY"]);
var DATE_PARTS = ["BYMONTH", "BYMONTHDAY", "BYYEARDAY", "BYWEEKNO", "BYSETPOS"];
var TIME_PARTS = ["BYHOUR", "BYMINUTE", "BYSECOND"];
var KNOWN_PARTS = /* @__PURE__ */ new Set([...DATE_PARTS, ...TIME_PARTS, "BYDAY"]);
function moveBreaksRule(recur, move) {
  const parts = Object.entries(recur.parts ?? {}).filter(([, values]) => Array.isArray(values) && values.length).map(([name]) => name);
  const unknown = parts.find((name) => !KNOWN_PARTS.has(name));
  if (!FREQS.has(recur.freq)) {
    return `has FREQ=${recur.freq}, whose occurrences updateFields cannot tell`;
  }
  if (unknown) {
    return `has ${unknown}, whose effect on a move updateFields cannot tell`;
  }
  const switched = move.from.form === "date" !== (move.to.form === "date");
  const days = Math.round((dayOf(move.toWall) - dayOf(move.fromWall)) / DAY2);
  const timeChanged = switched || move.toWall - dayOf(move.toWall) !== move.fromWall - dayOf(move.fromWall);
  const has = (names) => parts.filter((name) => names.includes(name));
  if (SUB_DAILY.has(recur.freq)) {
    if (switched) {
      return `repeats more often than daily, which an all-day series cannot`;
    }
    const dateParts2 = has([...DATE_PARTS, "BYDAY"]);
    if (dateParts2.length && (days !== 0 || timeChanged)) {
      return `repeats more often than daily within ${dateParts2.join(" and ")}, whose limits the moved times cross elsewhere`;
    }
  }
  const timeParts = has(TIME_PARTS);
  if (timeParts.length && timeChanged) {
    return `has ${timeParts.join(" and ")}, which ${timeParts.length > 1 ? "pin" : "pins"} the time of day the move changes`;
  }
  if (days === 0) {
    return null;
  }
  const dateParts = has(DATE_PARTS);
  if (dateParts.length) {
    return `has ${dateParts.join(" and ")}, which ${dateParts.length > 1 ? "pin" : "pins"} the dates the move changes`;
  }
  if (parts.includes("BYDAY") && !(["DAILY", "WEEKLY"].includes(recur.freq) && days % 7 === 0)) {
    return "has BYDAY, which pins weekdays: only a DAILY or WEEKLY rule follows a move, and only by whole weeks";
  }
  const from = fieldsOf(move.fromWall);
  const to = fieldsOf(move.toWall);
  if (recur.freq === "MONTHLY" && (from.year !== to.year || from.month !== to.month || from.day > 28 || to.day > 28)) {
    return `repeats on DTSTART's day of the month, which only follows a move within the same month between the 1st and the 28th`;
  }
  if (recur.freq === "YEARLY" && !yearlyFollows(from, to)) {
    return `repeats on DTSTART's month and day, which only follows a move to a date every year has, by the same number of days in every year (not across the end of February)`;
  }
  return null;
}
var WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
var weekdayOf = (wall) => WEEKDAYS[new Date(wall * 1e3).getUTCDay()];
function restatedParts(property, recur, move) {
  const raw = property.toJSON()[3];
  const single = (value) => Array.isArray(value) ? value.length === 1 ? value[0] : void 0 : value;
  const from = fieldsOf(move.fromWall);
  const to = fieldsOf(move.toWall);
  const out = {};
  if (recur.freq === "WEEKLY" && String(single(raw.byday) ?? "").toUpperCase() === weekdayOf(move.fromWall)) {
    out.byday = weekdayOf(move.toWall);
  }
  if (recur.freq === "YEARLY" && Number(single(raw.bymonth)) === from.month) {
    out.bymonth = to.month;
  }
  if (Number(single(raw.bymonthday)) === from.day && (recur.freq === "MONTHLY" || "bymonth" in out)) {
    out.bymonthday = to.day;
  }
  return out;
}
function checkMove(master, move, from, to, texts) {
  for (const property of [...master.getAllProperties()]) {
    if (!isRecurProperty(master, property.name)) {
      continue;
    }
    const recur = property.getFirstValue();
    const unknown = unknownRuleParts(property);
    const restating = unknown.length ? {} : restatedParts(property, recur, move);
    const plain = recur.clone();
    for (const name of Object.keys(restating)) {
      delete plain.parts[name.toUpperCase()];
    }
    const repeated = texts.repeated(property);
    const why = repeated.length ? `gives ${repeated.join(", ")} more than once, which RFC 5545 3.3.10 does not allow and clients read differently` : unknown.length ? `has ${unknown.join(", ")}, whose effect on a move updateFields cannot tell` : moveBreaksRule(plain, move);
    if (!why) {
      if (Object.keys(restating).length) {
        texts.rewrite(
          master,
          property,
          restating,
          Object.fromEntries(Object.entries(restating).map(([k, v]) => [k.toUpperCase(), String(v)]))
        );
      }
      continue;
    }
    const upper = property.name.toUpperCase();
    const suggestion = suggestedRule(recur, move.toWall, move.to.form !== "date");
    throw new Error(`Moving DTSTART (${from} to ${to}) does not move the whole series: ${property.toICALString()} ${why}, so the moved series would not have the same occurrences, each moved. Give ${upper} in the same call to fit the new start${suggestion ? ` (e.g. ${upper} "${suggestion}")` : ""}; to start the series later without moving it, give RRULE, UNTIL and EXDATE explicitly, or rewrite the whole iCalendar object`);
  }
}
function checkDatesOnly(master, move, properties) {
  const timeOfDay = move.fromWall - dayOf(move.fromWall);
  for (const property of properties) {
    for (const stamp of propertyStamps(property)) {
      const wall = stamp.kind === "date" ? null : wallIn(master, stamp, move.from);
      if (wall === null || wall - dayOf(wall) !== timeOfDay) {
        const line = property.toICALString();
        throw new Error(`DTSTART changed to a date, and ${line} is ${wall === null ? "a date already" : "not at the series' time of day"}, so as a date it could name an occurrence it did not name before: give ${property.name === "recurrence-id" ? "the override" : property.name.toUpperCase()} as dates by rewriting the whole iCalendar object`);
      }
    }
  }
}

// src/updateFields.ts
function componentType(type) {
  const name = typeof type === "string" ? type.toLowerCase() : "";
  if (!COMPONENT_TYPES.includes(name)) {
    throw new Error(`Invalid type "${String(type)}": use "vevent", "vtodo" or "vjournal"`);
  }
  return name;
}
function seriesMaster(calendar, type) {
  const types = type === void 0 ? COMPONENT_TYPES : [componentType(type)];
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
  const held = [...new Set(calendar.getAllSubcomponents().map((c) => String(c.name).toUpperCase()))];
  throw new Error(`No ${types.map((t) => t.toUpperCase()).join(", ")} found in VCALENDAR ` + (held.length ? `(it holds: ${held.join(", ")})` : "(it holds no components)"));
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
  const type = options.type === void 0 ? void 0 : componentType(options.type);
  let jcalData;
  let component;
  try {
    jcalData = import_ical4.default.parse(icalString);
    component = new import_ical4.default.Component(jcalData);
  } catch (error) {
    throw new Error(`Failed to parse iCal data: ${error.message}`);
  }
  if (type && component.name !== "vcalendar" && component.name !== type) {
    const name = String(component.name).toUpperCase();
    throw new Error(component.name === "vcard" ? `type "${type}" applies to an iCalendar object, but this is a VCARD` : `type "${type}" asks for a ${type.toUpperCase()}, but this object is a bare ${name}`);
  }
  const actualComponent = component.name === "vcalendar" ? seriesMaster(component, type) : component;
  const entries = Object.entries(fields).sort(
    ([a], [b]) => Number(b.toLowerCase() === "dtstart") - Number(a.toLowerCase() === "dtstart")
  );
  const written = new Set(entries.map(([key]) => key.toLowerCase()));
  const series = beginSeriesEdit(
    component.name === "vcalendar" ? component : null,
    actualComponent,
    written,
    icalString
  );
  for (const [key, value] of entries) {
    if (!setDateValue(actualComponent, key, value, floatingTime) && !setRecurValue(actualComponent, key, value, floatingTime)) {
      actualComponent.updatePropertyWithValue(key.toLowerCase(), value);
    }
  }
  series.finish();
  return series.render(component.toString());
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  parseDateValue,
  seriesMaster,
  updateFields
});
