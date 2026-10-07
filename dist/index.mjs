// src/updateFields.ts
import ICAL3 from "ical.js";

// src/series.ts
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

// src/series.ts
var DAY = 86400;
var JCAL = /^(\d{4,})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(Z)?)?$/i;
function stampOf(jcal, tzid) {
  const m = JCAL.exec(jcal);
  if (!m) {
    throw new Error(`"${jcal}" is not a date or date-time`);
  }
  const [y, mo, d, h, mi, s] = [1, 2, 3, 4, 5, 6].map((i) => Number(m[i] ?? 0));
  const wall = utcMillis(y, mo, d, h, mi, s) / 1e3;
  if (m[4] === void 0) {
    return { wall, kind: "date" };
  }
  if (m[7]) {
    return { wall, kind: "utc" };
  }
  return typeof tzid === "string" && tzid ? { wall, kind: "tzid", tzid } : { wall, kind: "floating" };
}
var valuesOf = (property) => property.toJSON().slice(3);
function fields(wall) {
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
var dayOf = (wall) => Math.floor(wall / DAY) * DAY;
function jcalOf(wall, frame) {
  const f = fields(wall);
  const date = `${pad(f.year, 4)}-${pad(f.month)}-${pad(f.day)}`;
  if (frame.form === "date") {
    return date;
  }
  return `${date}T${pad(f.hour)}:${pad(f.minute)}:${pad(f.second)}${frame.form === "utc" ? "Z" : ""}`;
}
function convert(component, wall, from, to) {
  const zone = (tzid) => {
    if (tzid === null) {
      return ICAL2.Timezone.utcTimezone;
    }
    const tz = timezoneOf(component, tzid);
    if (!tz) {
      throw new Error(`the zone "${tzid}" has no VTIMEZONE in the document to convert it with`);
    }
    return tz;
  };
  const t = ICAL2.Time.fromData(fields(wall), zone(from)).convertToZone(zone(to));
  return utcMillis(t.year, t.month, t.day, t.hour, t.minute, t.second) / 1e3;
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
  return own === target ? stamp.wall : convert(component, stamp.wall, own, target);
}
function moved(stamp, move) {
  const wall = wallIn(move.component, stamp, move.from);
  if (move.from.form === "date" || move.to.form === "date" || stamp.kind === "date") {
    const days = (dayOf(wall) - dayOf(move.fromWall)) / DAY;
    return (move.to.form === "date" ? dayOf(move.toWall) : move.toWall) + days * DAY;
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
  const tzid = property.getParameter("tzid");
  const walls = valuesOf(property).map((v) => moved(stampOf(String(v), tzid), move));
  writeInstants(property, walls, move.to);
}
function moveUntil(property, move) {
  const recur = property.getFirstValue();
  const wall = moved(stampOf(recur.until.toString()), move);
  if (move.to.form === "date") {
    recur.until = ICAL2.Time.fromDateString(jcalOf(wall, move.to));
  } else if (move.to.form === "tzid") {
    recur.until = ICAL2.Time.fromDateTimeString(
      jcalOf(convert(move.component, wall, move.to.tzid, null), { form: "utc" })
    );
  } else {
    recur.until = ICAL2.Time.fromDateTimeString(jcalOf(wall, move.to));
  }
  property.setValue(recur);
}
function startOf(master) {
  const frame = frameOf(master);
  const dtstart = master.getFirstProperty("dtstart");
  if (!frame || !dtstart) {
    return null;
  }
  return { frame, wall: stampOf(String(valuesOf(dtstart)[0])).wall, text: dtstart.toICALString() };
}
var EXPANSION_LIMIT = 1e5;
function occurrences(master, stamps) {
  const start = startOf(master);
  if (!start) {
    return stamps.map(() => void 0);
  }
  const { frame } = start;
  const day = frame.form === "date";
  const timeOf = (wall) => day ? ICAL2.Time.fromDateString(jcalOf(wall, frame)) : ICAL2.Time.fromDateTimeString(jcalOf(wall, { form: "floating" }));
  const wallOf = (t) => utcMillis(t.year, t.month, t.day, t.hour, t.minute, t.second) / 1e3;
  const norm = (wall) => day ? dayOf(wall) : wall;
  const targets = stamps.map((stamp) => {
    try {
      return norm(wallIn(master, stamp, frame));
    } catch {
      return void 0;
    }
  });
  const result = targets.map((t) => t === void 0 ? void 0 : t === norm(start.wall));
  const known = (wall) => targets.forEach((t, i) => {
    if (t === wall) {
      result[i] = true;
    }
  });
  try {
    for (const rdate of master.getAllProperties("rdate")) {
      const tzid = rdate.getParameter("tzid");
      for (const value of valuesOf(rdate)) {
        const first = Array.isArray(value) ? value[0] : value;
        known(norm(wallIn(master, stampOf(String(first), tzid), frame)));
      }
    }
  } catch {
    return result.map((r) => r || void 0);
  }
  const latest = Math.max(...targets.filter((t) => t !== void 0));
  for (const property of master.getAllProperties("rrule")) {
    const recur = property.getFirstValue().clone();
    try {
      if (recur.until) {
        recur.until = timeOf(norm(wallIn(master, stampOf(recur.until.toString()), frame)));
      }
    } catch {
      return result.map((r) => r || void 0);
    }
    const iterator = recur.iterator(timeOf(start.wall));
    let reached = false;
    for (let i = 0; i < EXPANSION_LIMIT; i++) {
      const next = iterator.next();
      if (!next) {
        reached = true;
        break;
      }
      const wall = norm(wallOf(next));
      known(wall);
      if (wall >= latest) {
        reached = true;
        break;
      }
    }
    if (!reached) {
      return result.map((r) => r || void 0);
    }
  }
  return result;
}
var icalForm = (jcal) => jcal.replace(/[-:]/g, "");
function referenceStamp(ref) {
  return stampOf(String(valuesOf(ref.property)[ref.index]), ref.property.getParameter("tzid"));
}
function checkable(refs, master) {
  const stamps = refs.map((ref) => {
    try {
      return referenceStamp(ref);
    } catch {
      return void 0;
    }
  });
  const present = stamps.filter((s) => s !== void 0);
  const found = present.length ? occurrences(master, present) : [];
  let k = 0;
  return stamps.map((s) => s === void 0 ? void 0 : found[k++]);
}
var SHAPING = ["dtstart", "rrule", "rdate"];
function beginSeriesEdit(calendar, master, written) {
  if (written.has("recurrence-id") && !master.hasProperty("recurrence-id")) {
    throw new Error("RECURRENCE-ID cannot be written on the series master: it would turn the master into an override of a single instance (RFC 5545 3.8.4.4). updateFields edits the series; to change one instance, add or edit an override component (same UID, with RECURRENCE-ID) by rewriting the whole iCalendar object");
  }
  const replaced = new Set([...written].map((name) => master.getFirstProperty(name)).filter(Boolean));
  const own = (name) => master.getAllProperties(name).filter((p) => !replaced.has(p));
  const uid = master.getFirstPropertyValue("uid");
  const overrides = master.hasProperty("recurrence-id") ? [] : calendar.getAllSubcomponents(master.name).filter((c) => c !== master && c.hasProperty("recurrence-id") && c.getFirstPropertyValue("uid") === uid);
  const rids = overrides.map((c) => c.getFirstProperty("recurrence-id"));
  const exdates = own("exdate");
  const rdates = own("rdate");
  const rules = master.getAllProperties().filter((p) => isRecurProperty(master, p.name) && !replaced.has(p) && p.getFirstValue()?.until);
  const references = [
    ...rids.map((property) => ({ property, index: 0, label: `the override for ${property.toICALString()}` })),
    ...exdates.flatMap((property) => valuesOf(property).map((_, index) => ({
      property,
      index,
      label: `EXDATE ${icalForm(String(valuesOf(property)[index]))}`
    })))
  ];
  const shaping = SHAPING.filter((name) => written.has(name));
  const before = shaping.length && references.length ? checkable(references, master) : [];
  const watched = references.filter((_, i) => before[i] === true);
  const start = written.has("dtstart") ? startOf(master) : null;
  return {
    finish() {
      const now = start && startOf(master);
      if (start && now && start.text !== now.text) {
        const move = { component: master, from: start.frame, fromWall: start.wall, to: now.frame, toWall: now.wall };
        for (const property of rules) {
          const upper = property.name.toUpperCase();
          const until = property.getFirstValue().until.toICALString();
          try {
            moveUntil(property, move);
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
        for (const property of rids) {
          const line = property.toICALString();
          try {
            moveInstants(property, move);
          } catch (error) {
            throw new Error(`DTSTART changed, and the override for ${line} cannot follow it (${error.message}): move the override by rewriting the whole iCalendar object, since updateFields edits only the master`);
          }
        }
      }
      if (!watched.length) {
        return;
      }
      const after = checkable(watched, master);
      const lost = watched.filter((_, i) => after[i] === false);
      if (lost.length) {
        const what = shaping.map((n) => n.toUpperCase()).join(" and ");
        throw new Error(`The new ${what} leaves ${lost.map((ref) => ref.label).join(", ")} naming no occurrence of the series, so ${lost.length > 1 ? "they" : "it"} would silently stop applying (RFC 5545 3.8.4.4, 3.8.5.1). Keep a series these instances belong to, give EXDATE in the same call with the exclusions the new series should have, or move or remove an override by rewriting the whole iCalendar object (updateFields edits only the master)`);
      }
    }
  };
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
function updateFields(calendarObject, fields2, options = {}) {
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
    jcalData = ICAL3.parse(icalString);
    component = new ICAL3.Component(jcalData);
  } catch (error) {
    throw new Error(`Failed to parse iCal data: ${error.message}`);
  }
  const actualComponent = component.name === "vcalendar" ? seriesMaster(component) : component;
  const entries = Object.entries(fields2).sort(
    ([a], [b]) => Number(b.toLowerCase() === "dtstart") - Number(a.toLowerCase() === "dtstart")
  );
  const written = new Set(entries.map(([key]) => key.toLowerCase()));
  const series = component.name === "vcalendar" ? beginSeriesEdit(component, actualComponent, written) : null;
  for (const [key, value] of entries) {
    if (!setDateValue(actualComponent, key, value, floatingTime) && !setRecurValue(actualComponent, key, value, floatingTime)) {
      actualComponent.updatePropertyWithValue(key.toLowerCase(), value);
    }
  }
  series?.finish();
  return component.toString();
}
export {
  parseDateValue,
  seriesMaster,
  updateFields
};
