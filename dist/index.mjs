// src/updateFields.ts
import ICAL5 from "ical.js";

// src/types.ts
var COMPONENT_TYPES = ["vevent", "vtodo", "vjournal"];

// src/series.ts
import ICAL3 from "ical.js";

// src/typedValue.ts
import ICAL2 from "ical.js";

// src/zone.ts
import ICAL from "ical.js";

// src/errors.ts
var CODES = [
  /** an argument has the wrong type: calendarObject, fields, options (or options.zone), or several top-level components */
  "INVALID_INPUT",
  /** the iCalendar or vCard text does not parse */
  "INVALID_ICALENDAR",
  /** options.type (or seriesMaster's type) is not "vevent", "vtodo" or "vjournal" */
  "INVALID_TYPE",
  /** options.floatingTime is not "keep" or "local", or is given together with options.zone */
  "INVALID_FLOATING_TIME",
  /** options.absoluteTime is not "as-given" or "keep-zone", or is "as-given" together with options.zone */
  "INVALID_ABSOLUTE_TIME",
  /** the VCALENDAR holds no component of the type asked for */
  "COMPONENT_NOT_FOUND",
  /** the object is not what the type asks for: a vCard, or a bare component of another type */
  "WRONG_OBJECT_KIND",
  /** several instances with RECURRENCE-ID and no master: which one is meant cannot be told */
  "NO_MASTER",
  /** a date or date-time value does not parse, names no real date, time or offset, or is no string */
  "INVALID_VALUE",
  /** a date where a date-time is needed, or the other way round */
  "VALUE_TYPE_MISMATCH",
  /** a value lacks the zone it needs, has one it must not have, mixes both, or follows a DTSTART in another zone than options.zone */
  "ZONE_MISMATCH",
  /** a TZID whose rules are needed (or options.zone) has no VTIMEZONE in the object and is no IANA zone */
  "UNKNOWN_TZID",
  /** a VTIMEZONE in the object repeats in a way no time zone does, so it is not read; or none can be generated for options.zone at the dates given (local mean time) */
  "UNSUPPORTED_VTIMEZONE",
  /** a rule given has a part RFC 5545 3.3.10 does not define (or RSCALE/SKIP, or an "RRULE:" prefix) */
  "UNKNOWN_RULE_PART",
  /** a rule given names a part twice */
  "DUPLICATE_RULE_PART",
  /** a rule is otherwise invalid: a bad value, no FREQ, a combination RFC 5545 rules out, or unreadable in the object */
  "INVALID_RULE",
  /** under options.zone, DTEND or DUE would lie before DTSTART */
  "END_BEFORE_START",
  /** RECURRENCE-ID written on the series master */
  "RECURRENCE_ID_ON_MASTER",
  /** a DTSTART move the series (its rule, UNTIL, EXDATE, RDATE or overrides) cannot follow exactly */
  "SERIES_MOVE_REFUSED",
  /** a new RRULE or RDATE leaves an override or EXDATE naming no occurrence */
  "ORPHANED_EXCEPTIONS",
  /** an EXDATE added (list mode "add") names no occurrence of the series, so it would exclude nothing */
  "UNMATCHED_EXDATE",
  /** a value to remove (list mode "remove", restoreOccurrences) is not in the list */
  "NOT_IN_LIST",
  /** an occurrence given to cancelOccurrences is no occurrence of the series */
  "UNKNOWN_OCCURRENCE",
  /** a value sits at a DST change, where the wall clock does not name one instant */
  "DST_AMBIGUOUS",
  /** the series is too sparse, or what has to be checked too far ahead, to check within the work limit */
  "CHECK_LIMIT_EXCEEDED",
  /** whether the overrides and EXDATEs still name occurrences cannot be checked: the series has no DTSTART */
  "SERIES_UNVERIFIABLE"
];
var UPDATE_FIELDS_ERROR_CODES = Object.freeze(CODES);
var UpdateFieldsError = class extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "UpdateFieldsError";
    this.code = code;
    this.remedy = details.remedy;
    if (details.property !== void 0) {
      this.property = details.property;
    }
    if (details.suggestion !== void 0) {
      this.suggestion = details.suggestion;
    }
    if (details.cause !== void 0) {
      this.cause = details.cause;
    }
  }
  /**
   * The refusal as plain data, for a log or a response body (JSON.stringify
   * of an Error otherwise drops the message).
   */
  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      remedy: this.remedy,
      ...this.property !== void 0 ? { property: this.property } : {},
      ...this.suggestion !== void 0 ? { suggestion: this.suggestion } : {}
    };
  }
};
function isUpdateFieldsError(error, code) {
  if (!(error instanceof Error) || error.name !== "UpdateFieldsError") {
    return false;
  }
  const actual = error.code;
  return CODES.includes(actual) && (code === void 0 || actual === code);
}
function wrapped(error, message, details = {}) {
  if (error instanceof UpdateFieldsError) {
    return new UpdateFieldsError(error.code, message, {
      remedy: details.remedy ?? error.remedy,
      property: details.property ?? error.property,
      suggestion: details.suggestion ?? error.suggestion,
      cause: error
    });
  }
  const plain = new Error(message);
  plain.cause = error;
  return plain;
}

// src/zone.ts
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
        const t = value instanceof ICAL.Period ? value.start : value;
        onsets.add(wallOfTime(t));
      }
    }
    for (const property of observance.getAllProperties("rrule")) {
      let recur;
      try {
        recur = property.getFirstValue().clone();
      } catch (error) {
        throw new UpdateFieldsError("UNSUPPORTED_VTIMEZONE", `the VTIMEZONE "${vtimezone.getFirstPropertyValue("tzid")}" has an observance rule that cannot be read: ${error.message}`, { remedy: "rewrite-object" });
      }
      if (recur.freq !== "YEARLY" && recur.freq !== "MONTHLY") {
        throw new UpdateFieldsError("UNSUPPORTED_VTIMEZONE", `the VTIMEZONE "${vtimezone.getFirstPropertyValue("tzid")}" has an observance repeating ${recur.freq}, which no time zone does, so it is not read`, { remedy: "rewrite-object" });
      }
      if (recur.until) {
        const until = wallOfTime(recur.until) + (recur.until.zone === ICAL.Timezone.utcTimezone ? from : 0);
        recur.until = ICAL.Time.fromData({ ...fieldsOf(until), isDate: recur.until.isDate });
      }
      const iterator = recur.iterator(ICAL.Time.fromData(fieldsOf(wallOfTime(start))));
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
var ianaZones = /* @__PURE__ */ new Map();
function ianaZone(tzid) {
  if (typeof tzid !== "string" || /^[+-]/.test(tzid.trim())) {
    return null;
  }
  const key = tzid.toLowerCase();
  const cached = ianaZones.get(key);
  if (cached) {
    return cached;
  }
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
  const zone2 = zoneFrom((utc) => {
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
  ianaZones.set(key, zone2);
  return zone2;
}
function zoneOf(component, tzid) {
  const vtimezone = vtimezoneOf(component, tzid);
  return vtimezone ? vtimezoneZone(vtimezone) : ianaZone(tzid);
}
function vtimezoneIn(component, tzid) {
  return vtimezoneOf(component, tzid);
}
var lowerNames = null;
var properCase = (name) => name.split("/").every((part) => /^[A-Z]/.test(part));
function ianaZoneName(name) {
  if (!ianaZone(name)) {
    return null;
  }
  if (!lowerNames) {
    const supported = Intl.supportedValuesOf?.("timeZone") ?? [];
    lowerNames = new Map(supported.map((n) => [n.toLowerCase(), n]));
  }
  const listed = lowerNames.get(name.toLowerCase());
  if (listed) {
    return listed;
  }
  return properCase(name) ? name : new Intl.DateTimeFormat("en-US", { timeZone: name }).resolvedOptions().timeZone;
}
function isUtcZone(name) {
  if (!ianaZone(name)) {
    return false;
  }
  const resolved = new Intl.DateTimeFormat("en-US", { timeZone: name }).resolvedOptions().timeZone;
  return ["UTC", "Etc/UTC", "Etc/GMT", "GMT", "Etc/UCT", "Etc/Zulu", "Etc/Universal"].includes(resolved);
}
function unknownZone(tzid) {
  return `the zone "${tzid}" has no VTIMEZONE in the document and is no IANA time zone`;
}

// src/typedValue.ts
var TYPED = /* @__PURE__ */ new Set(["date-time", "date", "timestamp"]);
var UTC_ONLY = /* @__PURE__ */ new Set(["completed", "created", "dtstamp", "last-modified"]);
var refuse = (code, message, property) => new UpdateFieldsError(code, message, { remedy: "fix-value", property });
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
    throw refuse("INVALID_VALUE", `"${raw}" is not a valid date or time`);
  }
}
function toUtcJcal(date) {
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}Z`;
}
function parseDateValue(raw) {
  if (typeof raw !== "string") {
    throw refuse("INVALID_INPUT", `Invalid input: the value must be a string, not ${raw === null ? "null" : typeof raw}`);
  }
  const value = raw.trim();
  let m;
  if ((m = DATE_EXTENDED.exec(value)) || (m = DATE_BASIC.exec(value))) {
    const [y2, mo2, d2] = [Number(m[1]), Number(m[2]), Number(m[3])];
    assertRealDateTime(raw, y2, mo2, d2);
    return { kind: "date", jcal: `${m[1]}-${m[2]}-${m[3]}` };
  }
  m = DATE_TIME_EXTENDED.exec(value) || DATE_TIME_BASIC.exec(value);
  if (!m) {
    throw refuse("INVALID_VALUE", `"${raw}" is not a date or date-time. ${ACCEPTED_FORMS}`);
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
        throw refuse("INVALID_VALUE", `"${raw}" has an invalid UTC offset`);
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
    return version === "3.0" ? ICAL2.design.vcard3 : ICAL2.design.vcard;
  }
  return ICAL2.design.icalendar;
}
function dateProperty(component, name) {
  const lower = name.toLowerCase();
  if (component.name === "vcard" && ICAL2.design.vcard.property[lower]?.defaultType === "date-and-or-time") {
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
function isDateListProperty(component, name) {
  return Boolean(dateProperty(component, name)?.multiValue);
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
function wallInZone(component, upper, tzid, value, named = false) {
  const zone2 = zoneOf(component, tzid);
  if (!zone2) {
    throw refuse("UNKNOWN_TZID", `${upper}: ${unknownZone(tzid)}, so the instant cannot be written as its wall-clock time there: give a time without a zone, or leave absoluteTime "as-given"`, upper);
  }
  const m = /^(\d{4,})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/.exec(value.jcal);
  const utc = wallOf(...[1, 2, 3, 4, 5, 6].map((i) => Number(m[i])));
  const wall = zone2.fromUtc(utc);
  const f = fieldsOf(wall);
  const jcal = `${pad(f.year, 4)}-${pad(f.month)}-${pad(f.day)}T${pad(f.hour)}:${pad(f.minute)}:${pad(f.second)}`;
  if (zone2.toUtc(wall) !== utc) {
    throw refuse("DST_AMBIGUOUS", `${upper}: ${value.jcal.replace(/[-:]/g, "")} is ${jcal.replace(/[-:]/g, "")} in "${tzid}", in the second pass of the hour the DST change shows twice, where that wall-clock time reads as the first pass: ` + (named ? `no time in "${tzid}" names this instant; give another time, or leave out zone to write it in UTC` : 'give the time in UTC with absoluteTime "as-given", or another time'), upper);
  }
  return { kind: "floating", jcal, local: new Date(utc * 1e3) };
}
function utcOfWall(component, upper, tzid, value) {
  const zone2 = zoneOf(component, tzid);
  if (!zone2) {
    throw refuse("UNKNOWN_TZID", `${upper}: ${unknownZone(tzid)}`, upper);
  }
  const m = /^(\d{4,})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(value.jcal);
  const wall = wallOf(...[1, 2, 3, 4, 5, 6].map((i) => Number(m[i])));
  return { kind: "utc", jcal: toUtcJcal(new Date(zone2.toUtc(wall) * 1e3)) };
}
var asUtc = (value) => ({ kind: "utc", jcal: `${value.jcal}Z` });
var anchorIs = (anchor, named) => named.utc ? anchor.form === "utc" : anchor.form === "tzid" && anchor.tzid === named.tzid;
var anchorText = (anchor) => anchor.form === "tzid" ? `in "${anchor.tzid}"` : anchor.form === "utc" ? "in UTC" : anchor.form;
function setDateValue(component, name, raw, floatingTime = "keep", absoluteTime = "as-given", named = null, matchOnly = false) {
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
    throw wrapped(error, `${upper}: ${error.message}`, { property: upper });
  }
  if (new Set(parsed.map((p) => p.kind === "date")).size > 1) {
    throw refuse("VALUE_TYPE_MISMATCH", `${upper} mixes dates and date-times; all values must be one or the other`, upper);
  }
  const isDate = parsed[0].kind === "date";
  if (isDate && !shape.allowedTypes.includes("date")) {
    throw refuse("VALUE_TYPE_MISMATCH", `${upper} needs a date-time, not a date. Accepted forms: ${DATE_TIME_FORMS}`, upper);
  }
  const existing = shape.multiValue ? null : component.getFirstProperty(lower);
  const anchor = anchorOf(component, lower);
  const why = ["exdate", "rdate"].includes(lower) ? "otherwise it names no occurrence of the series" : "RFC 5545 requires the same value type";
  if (anchor?.form === "date" && !isDate && !matchOnly) {
    throw refuse("VALUE_TYPE_MISMATCH", `${upper} must be a date: DTSTART is a date (all-day), and ${why}`, upper);
  }
  if (anchor && anchor.form !== "date" && isDate && !matchOnly) {
    throw refuse("VALUE_TYPE_MISMATCH", `${upper} needs a time: DTSTART has one, and ${why}`, upper);
  }
  if (shape.multiValue && anchor?.form === "floating" && !named && !matchOnly && parsed.some((p) => p.kind === "utc")) {
    throw refuse("ZONE_MISMATCH", `${upper}: DTSTART is a local time without a zone (floating), so a value with "Z" or an offset names no occurrence of the series: drop the zone and give the wall-clock time, e.g. "${parsed.find((p) => p.kind === "utc").jcal.replace(/Z$/, "")}"`, upper);
  }
  const own = existing?.getParameter("tzid");
  let zone2 = UTC_ONLY.has(lower) ? null : typeof own === "string" && own ? own : anchor?.form === "tzid" ? anchor.tzid : null;
  if (named && !isDate) {
    const target = UTC_ONLY.has(lower) || component.name === "vcard";
    if (!target && anchor && anchor.form !== "date" && !anchorIs(anchor, named)) {
      throw new UpdateFieldsError("ZONE_MISMATCH", `${upper} follows DTSTART, which is ${anchorText(anchor)}, so it cannot be written in "${named.tzid}": give DTSTART in the same call to move the event into "${named.tzid}" (DTEND and DUE follow it then), or leave out zone`, { remedy: "same-call", property: upper });
    }
    if (target || named.utc) {
      parsed = parsed.map((p) => p.kind !== "floating" ? p : named.utc ? asUtc(p) : utcOfWall(component, upper, named.tzid, p));
      zone2 = null;
    } else {
      parsed = parsed.map((p) => p.kind === "utc" ? wallInZone(component, upper, named.tzid, p, true) : p);
      zone2 = named.tzid;
    }
  }
  if (absoluteTime === "keep-zone" && zone2 && !named) {
    parsed = parsed.map((p) => p.kind === "utc" ? wallInZone(component, upper, zone2, p) : p);
  }
  if (shape.multiValue && zone2 && parsed.some((p) => p.kind === "utc") && parsed.some((p) => p.kind === "floating")) {
    parsed = parsed.map((p) => p.kind === "floating" ? utcOfWall(component, upper, zone2, p) : p);
  }
  const floating = parsed.some((p) => p.kind === "floating");
  const wallClock = !floating ? null : zone2 ? "tzid" : anchor?.form === "floating" ? "floating" : floatingTime === "local" ? "utc" : anchor?.form === "utc" || UTC_ONLY.has(lower) ? null : "floating";
  if (floating && wallClock === null) {
    throw refuse("ZONE_MISMATCH", UTC_ONLY.has(lower) ? `${upper} must be in UTC (RFC 5545): give a zone, e.g. "2026-10-26T18:00:00Z"` : `${upper} has no zone, and DTSTART is in UTC: give it one, e.g. "2026-10-26T18:00:00Z" or "2026-10-26T14:00:00-04:00"`, upper);
  }
  if (floating && wallClock !== "utc" && parsed.some((p) => p.kind === "utc")) {
    throw refuse(
      "ZONE_MISMATCH",
      `${upper} mixes values with and without a zone; give all of them a zone, or none`,
      upper
    );
  }
  const tzid = wallClock === "tzid" ? zone2 : null;
  const values = parsed.map((p) => p.kind === "floating" && wallClock === "utc" ? toUtcJcal(p.local) : p.jcal);
  let type = isDate ? "date" : "date-time";
  if (type === "date-time" && shape.defaultType === "timestamp") {
    type = "timestamp";
  }
  let property = existing;
  if (!property) {
    property = new ICAL2.Property(lower, component);
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
        const range2 = signed ? `${min} to ${max} or -${max} to -${min}` : `${min} to ${max}`;
        return `"${v}" is not in ${range2}`;
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
        throw refuse("UNKNOWN_RULE_PART", "RSCALE/SKIP (RFC 7529) are not supported: ical.js cannot write them without losing them");
      }
      const colon = name.indexOf(":");
      if (colon >= 0) {
        throw refuse("UNKNOWN_RULE_PART", `"${part.trim()}" is not a rule part: drop the "${name.slice(0, colon + 1)}" prefix and give only the rule, e.g. "${part.trim().slice(colon + 1)}"`);
      }
      throw refuse("UNKNOWN_RULE_PART", `"${part.trim()}" is not a rule part. RFC 5545 defines ${Object.keys(RULE_PARTS).join(", ")} (e.g. "FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10")`);
    }
    if (parts.has(name)) {
      throw refuse("DUPLICATE_RULE_PART", `${name} is given twice; each rule part may occur once`);
    }
    if (value === "") {
      throw refuse("INVALID_RULE", `${name} has no value`);
    }
    const wrong = check(value);
    if (wrong) {
      throw refuse("INVALID_RULE", `${name}: ${wrong}`);
    }
    parts.set(name, value);
  }
  const freq = parts.get("FREQ");
  if (!freq) {
    throw refuse("INVALID_RULE", 'FREQ is missing; every rule needs one (e.g. "FREQ=DAILY;COUNT=5")');
  }
  if (parts.has("COUNT") && parts.has("UNTIL")) {
    throw refuse("INVALID_RULE", "COUNT and UNTIL cannot both be given (RFC 5545 3.3.10); use one of them");
  }
  if (parts.has("BYWEEKNO") && freq !== "YEARLY") {
    throw refuse("INVALID_RULE", "BYWEEKNO is only allowed with FREQ=YEARLY (RFC 5545 3.3.10)");
  }
  if (parts.has("BYYEARDAY") && ["DAILY", "WEEKLY", "MONTHLY"].includes(freq)) {
    throw refuse("INVALID_RULE", `BYYEARDAY is not allowed with FREQ=${freq} (RFC 5545 3.3.10)`);
  }
  if (parts.has("BYMONTHDAY") && freq === "WEEKLY") {
    throw refuse("INVALID_RULE", "BYMONTHDAY is not allowed with FREQ=WEEKLY (RFC 5545 3.3.10)");
  }
  const ordinalDay = (parts.get("BYDAY") ?? "").split(",").some((d) => /\d/.test(d));
  if (ordinalDay && (!["MONTHLY", "YEARLY"].includes(freq) || parts.has("BYWEEKNO"))) {
    throw refuse("INVALID_RULE", 'BYDAY with an ordinal ("1MO", "-1FR") is only allowed with FREQ=MONTHLY or FREQ=YEARLY, and not together with BYWEEKNO (RFC 5545 3.3.10)');
  }
  const tooFar = (parts.get("BYDAY") ?? "").split(",").find((d) => Math.abs(Number(/^([+-]?\d+)/.exec(d)?.[1] ?? 0)) > 5);
  if (tooFar && (freq === "MONTHLY" || parts.has("BYMONTH"))) {
    throw refuse("INVALID_RULE", `BYDAY: "${tooFar}" counts past the fifth weekday of a month; within a month the ordinal is 1 to 5 or -5 to -1 (RFC 5545 3.3.10)`);
  }
  if (parts.has("BYSETPOS") && ![...parts.keys()].some((k) => k.startsWith("BY") && k !== "BYSETPOS")) {
    throw refuse("INVALID_RULE", "BYSETPOS needs another BYxxx part to select from (RFC 5545 3.3.10)");
  }
  return parts;
}
function untilTime(component, ruleName, raw, floatingTime, named) {
  let parsed;
  try {
    parsed = parseDateValue(raw);
  } catch (error) {
    throw wrapped(error, `${ruleName} UNTIL: ${error.message}`, { property: ruleName });
  }
  const anchor = anchorOf(component, ruleName.toLowerCase());
  const fail = (code, why) => refuse(code, `${ruleName} UNTIL ${why}`, ruleName);
  if (anchor?.form === "date" && parsed.kind !== "date") {
    throw fail("VALUE_TYPE_MISMATCH", 'must be a date: DTSTART is a date (all-day), and RFC 5545 3.3.10 requires the same type, e.g. "2026-10-26"');
  }
  if (anchor && anchor.form !== "date" && parsed.kind === "date") {
    throw fail("VALUE_TYPE_MISMATCH", "needs a time: DTSTART has one, and RFC 5545 3.3.10 requires the same type");
  }
  if (anchor?.form === "floating" && parsed.kind === "utc") {
    throw fail("ZONE_MISMATCH", 'must be a local time without a zone, like the floating DTSTART (RFC 5545 3.3.10), e.g. "2026-10-26T18:00:00"');
  }
  if (parsed.kind === "floating" && named && anchor?.form !== "date") {
    if (anchor && !anchorIs(anchor, named)) {
      throw new UpdateFieldsError("ZONE_MISMATCH", `${ruleName} UNTIL follows DTSTART, which is ${anchorText(anchor)}, so it cannot be read in "${named.tzid}": give DTSTART in the same call to move the series into "${named.tzid}", give UNTIL with a zone, or leave out zone`, { remedy: "same-call", property: ruleName });
    }
    if (!anchor || named.utc) {
      return ICAL2.Time.fromDateTimeString(named.utc ? asUtc(parsed).jcal : utcOfWall(component, ruleName, named.tzid, parsed).jcal);
    }
  }
  if (parsed.kind === "floating") {
    if (anchor?.form === "tzid") {
      const zone2 = zoneOf(component, anchor.tzid);
      if (!zone2) {
        throw fail("UNKNOWN_TZID", `has no zone, and DTSTART's zone "${anchor.tzid}" has no VTIMEZONE in the document and is no IANA time zone to convert it to UTC with (RFC 5545 3.3.10 requires UTC here): give it a zone, e.g. "2026-10-26T18:00:00Z" or "2026-10-26T18:00:00+01:00"`);
      }
      const wall = ICAL2.Time.fromDateTimeString(parsed.jcal);
      const utc = fieldsOf(zone2.toUtc(wallOf(wall.year, wall.month, wall.day, wall.hour, wall.minute, wall.second)));
      return ICAL2.Time.fromData(utc, ICAL2.Timezone.utcTimezone);
    }
    if (anchor?.form === "floating") {
      return ICAL2.Time.fromDateTimeString(parsed.jcal);
    }
    if (floatingTime === "local") {
      return ICAL2.Time.fromDateTimeString(toUtcJcal(parsed.local));
    }
    if (anchor?.form === "utc") {
      throw fail("ZONE_MISMATCH", 'has no zone, and DTSTART is in UTC: give it one, e.g. "2026-10-26T18:00:00Z" or "2026-10-26T14:00:00-04:00"');
    }
    return ICAL2.Time.fromDateTimeString(parsed.jcal);
  }
  return parsed.kind === "date" ? ICAL2.Time.fromDateString(parsed.jcal) : ICAL2.Time.fromDateTimeString(parsed.jcal);
}
function isRecurProperty(component, name) {
  return designSetFor(component).property[name.toLowerCase()]?.defaultType === "recur";
}
function setRecurValue(component, name, raw, floatingTime = "keep", named = null) {
  const lower = name.toLowerCase();
  if (!isRecurProperty(component, lower)) {
    return false;
  }
  const upper = name.toUpperCase();
  let parts;
  try {
    parts = parseRuleParts(raw);
  } catch (error) {
    throw wrapped(error, `${upper}: ${error.message}`, { property: upper });
  }
  const until = parts.get("UNTIL");
  parts.delete("UNTIL");
  const recur = ICAL2.Recur.fromString([...parts].map(([k, v]) => `${k}=${v}`).join(";"));
  if (until !== void 0) {
    recur.until = untilTime(component, upper, until, floatingTime, named);
  }
  let property = component.getFirstProperty(lower);
  if (!property) {
    property = new ICAL2.Property(lower, component);
    component.addProperty(property);
  }
  property.resetType("recur");
  property.setValue(recur);
  return true;
}

// src/dateLists.ts
function instantKey(master, stamp) {
  const written = `as written ${stamp.kind} ${stamp.tzid ?? ""} ${stamp.wall}`;
  const frame = frameOf(master);
  if (!frame) {
    return written;
  }
  try {
    if (frame.form === "date") {
      return `day ${dayOf(wallIn(master, stamp, frame))}`;
    }
    if (stamp.kind === "date") {
      return `day ${stamp.wall}`;
    }
    if (frame.form === "floating") {
      return stamp.kind === "floating" ? `wall ${stamp.wall}` : written;
    }
    const instant = instantOf(master, stamp, frame);
    return instant === null ? written : `instant ${instant}`;
  } catch {
    return written;
  }
}
function dayKeyOf(master, stamp) {
  const frame = frameOf(master);
  if (!frame || frame.form === "date" || stamp.kind === "date") {
    return null;
  }
  if (stamp.kind === "floating" !== (frame.form === "floating")) {
    return null;
  }
  try {
    return `day ${dayOf(wallIn(master, stamp, frame))}`;
  } catch {
    return null;
  }
}
function lineKeys(master, property) {
  return propertyStamps(property).map((stamp) => instantKey(master, stamp));
}
function listKeys(master, name) {
  return new Set(master.getAllProperties(name).flatMap((property) => lineKeys(master, property)));
}
function holds(master, keys, stamp) {
  const day = dayKeyOf(master, stamp);
  return keys.has(instantKey(master, stamp)) || day !== null && keys.has(day);
}
function keepValues(master, line, keep) {
  const values = valuesOf(line);
  const kept = values.filter((_, i) => keep(i));
  if (!kept.length) {
    master.removeProperty(line);
  } else if (kept.length < values.length) {
    line.setValues(kept);
  }
}
var covers = (keys, g) => keys.has(g.key) || g.day !== null && keys.has(g.day);
var DateListEdit = class {
  /**
   * @param modes - lower-case list name ("exdate", "rdate") to its mode, for
   *   each list the call writes
   */
  constructor(master, modes, purpose = null) {
    this.master = master;
    this.modes = modes;
    this.purpose = purpose;
    this.held = new Set(master.getAllProperties());
  }
  apply() {
    const outcome = { addedExdates: [], givenExdates: [], written: /* @__PURE__ */ new Map() };
    for (const [name, mode] of this.modes) {
      const lines = this.master.getAllProperties(name);
      const fresh = lines.filter((line2) => !this.held.has(line2));
      if (!fresh.length) {
        continue;
      }
      const old = lines.filter((line2) => this.held.has(line2));
      const oldKeys = old.map((property) => lineKeys(this.master, property));
      const given = this.given(name, fresh);
      const [line, ...rest] = fresh;
      for (const extra of rest) {
        this.master.removeProperty(extra);
      }
      if (mode === "remove") {
        this.master.removeProperty(line);
        this.remove(name, old, oldKeys, given);
        continue;
      }
      const present = /* @__PURE__ */ new Set();
      if (mode === "add") {
        oldKeys.flat().forEach((key) => present.add(key));
      } else {
        const wanted = new Set(given.flatMap((g) => g.day === null ? [g.key] : [g.key, g.day]));
        old.forEach((property, n) => keepValues(this.master, property, (i) => {
          const key = oldKeys[n][i];
          return wanted.has(key) && Boolean(present.add(key));
        }));
      }
      const added = given.filter((g) => !covers(present, g));
      if (added.length) {
        line.setValues(added.map((g) => g.value));
        outcome.written.set(name, line);
      } else {
        this.master.removeProperty(line);
      }
      if (name === "exdate" && mode === "add") {
        outcome.addedExdates.push(...given.filter((g) => !present.has(g.key)));
        outcome.givenExdates.push(...given);
      }
    }
    return outcome;
  }
  /** The values the call gave for a list, each once */
  given(name, fresh) {
    const seen = /* @__PURE__ */ new Set();
    return fresh.flatMap((line) => {
      const values = valuesOf(line);
      return propertyStamps(line).flatMap((stamp, i) => {
        const key = instantKey(this.master, stamp);
        if (seen.has(key)) {
          return [];
        }
        seen.add(key);
        return [{
          key,
          day: dayKeyOf(this.master, stamp),
          value: values[i],
          stamp,
          label: `${name.toUpperCase()} ${icalForm(String(values[i]))}`
        }];
      });
    });
  }
  /**
   * Take values out of a list, each matched directly against the values held,
   * by instant (or as a date given as a date); refused, naming them, where the
   * list does not hold one. restoreOccurrences also takes a date of the
   * occurrence's day.
   */
  remove(name, old, oldKeys, given) {
    const upper = name.toUpperCase();
    const held = new Set(oldKeys.flat());
    const byDay = this.purpose === "restore";
    const missing = given.filter((g) => byDay ? !covers(held, g) : !held.has(g.key));
    if (missing.length) {
      const list = old.map((property) => property.toICALString()).join(", ");
      const values = missing.map((g) => icalForm(String(g.value))).join(", ");
      throw new UpdateFieldsError("NOT_IN_LIST", this.purpose === "restore" ? `${values} ${missing.length > 1 ? "are" : "is"} not cancelled: no EXDATE names ${missing.length > 1 ? "them" : "it"} (${list || "the series has no EXDATE"}). Give the original start of a cancelled occurrence` : `${missing.map((g) => g.label).join(", ")} ${missing.length > 1 ? "are" : "is"} not in the list (${list || `the object has no ${upper}`}), so there is nothing to remove. Give a value the list holds, at the same instant (in any zone)`, { remedy: "fix-value", property: upper });
    }
    const remove = new Set(given.flatMap((g) => g.day === null || !byDay ? [g.key] : [g.key, g.day]));
    old.forEach((property, n) => keepValues(this.master, property, (i) => !remove.has(oldKeys[n][i])));
  }
};

// src/series.ts
var DAY2 = 86400;
var JCAL = /^(\d{4,})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(Z)?)?$/i;
function stampOf(jcal, tzid, name) {
  const m = JCAL.exec(jcal);
  if (!m) {
    throw new UpdateFieldsError(
      "INVALID_VALUE",
      `the object's ${name} value "${jcal}" is not a date or date-time`,
      { remedy: "rewrite-object", property: name }
    );
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
  return valuesOf(property).map((v) => stampOf(String(Array.isArray(v) ? v[0] : v), tzid, property.name.toUpperCase()));
};
function recurOf(property) {
  const name = property.name.toUpperCase();
  let recur;
  try {
    recur = property.getFirstValue();
  } catch (error) {
    throw new UpdateFieldsError(
      "INVALID_RULE",
      `the object's ${name} cannot be read: ${error.message}`,
      { remedy: "rewrite-object", property: name }
    );
  }
  if (!(recur instanceof ICAL3.Recur)) {
    throw new UpdateFieldsError(
      "INVALID_RULE",
      `the object's ${name} cannot be read as a rule`,
      { remedy: "rewrite-object", property: name }
    );
  }
  return recur;
}
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
    throw new UpdateFieldsError("UNKNOWN_TZID", unknownZone(tzid), { remedy: "rewrite-object" });
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
      throw new UpdateFieldsError(
        "ZONE_MISMATCH",
        "it is in UTC, and a floating series has no zone to read it in",
        { remedy: "rewrite-object" }
      );
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
function instantOf(component, stamp, frame) {
  if (frame.form !== "utc" && frame.form !== "tzid") {
    return null;
  }
  if (stamp.kind === "utc") {
    return stamp.wall;
  }
  return stamp.kind === "tzid" ? zone(component, stamp.tzid).toUtc(stamp.wall) : null;
}
function occurrenceInstant(component, wall, frame) {
  return frame.form === "tzid" ? zone(component, frame.tzid).toUtc(wall) : wall;
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
    throw new UpdateFieldsError(
      "SERIES_MOVE_REFUSED",
      "it holds periods, which updateFields does not move",
      { remedy: "same-call" }
    );
  }
  const stamps = propertyStamps(property);
  if (property.type === "date" && move.from.form !== "date" && move.to.form !== "date") {
    const shift = dayOf(move.toWall) - dayOf(move.fromWall);
    if (move.toWall - move.fromWall !== shift) {
      throw new UpdateFieldsError(
        "SERIES_MOVE_REFUSED",
        "it is a date, a whole day, which cannot move by the time of day DTSTART moved",
        { remedy: "same-call" }
      );
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
    throw new UpdateFieldsError(
      "DST_AMBIGUOUS",
      `moved, it would be ${icalForm(jcalOf(utc, "utc"))}, which in "${to}" falls in the second pass of the hour the DST change shows twice, where ${icalForm(jcalOf(out, "floating"))} reads as the first`,
      { remedy: "rewrite-object" }
    );
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
  /**
   * Keep a rule the call does not change as the object spells it: ical.js
   * writes a rule back normalised, and one it cannot read (UNTIL=garbage)
   * mangled. False when its text could not be found.
   */
  keep(property) {
    if (this.changed.has(property)) {
      return true;
    }
    const text = this.texts.get(property);
    if (!text) {
      return false;
    }
    this.changed.set(property, text);
    return true;
  }
  /** Before serialising: tag each rewritten or kept rule so render() can find its line */
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
        out.push(ICAL3.helpers.foldline(`${line.head}:${line.parts.join(";")}`));
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
  const next = new ICAL3.Property([name, params, type, { ...value, ...changes }], component);
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
    throw new UpdateFieldsError("SERIES_MOVE_REFUSED", `the rule gives ${repeated.join(", ")} more than once, which RFC 5545 3.3.10 does not allow and clients read differently`, { remedy: "same-call" });
  }
  const unknown = unknownRuleParts(property);
  if (unknown.length) {
    throw new UpdateFieldsError("SERIES_MOVE_REFUSED", `the rule has ${unknown.join(", ")}, which updateFields would lose rewriting it`, { remedy: "same-call" });
  }
  const recur = recurOf(property);
  const until = stampOf(recur.until.toString(), void 0, property.name.toUpperCase());
  if (move.from.form === "tzid" && until.kind === "utc") {
    const old = zone(move.component, move.from.tzid);
    if (old.gapAlias(until.wall) !== null || old.ambiguity(old.fromUtc(until.wall))) {
      throw new UpdateFieldsError(
        "DST_AMBIGUOUS",
        `it lies at the DST change in "${move.from.tzid}", where the wall clock and the order of instants part, so moved on the wall clock it could let one occurrence too many or too few through`,
        { remedy: "same-call" }
      );
    }
  }
  if (until.kind === "date" !== (move.from.form === "date")) {
    throw new UpdateFieldsError(
      "SERIES_MOVE_REFUSED",
      `UNTIL is a ${until.kind === "date" ? "date" : "date-time"} next to a ${move.from.form === "date" ? "date" : "date-time"} DTSTART, so where it ends the series is not defined`,
      { remedy: "same-call" }
    );
  }
  const wall = move.from.form !== "date" && move.to.form === "date" ? dayOf(move.toWall) + Math.floor((wallIn(move.component, until, move.from) - move.fromWall) / DAY2) * DAY2 : moved(until, move);
  let untilValue;
  if (move.to.form === "date") {
    untilValue = jcalOf(wall, move.to);
  } else if (move.to.form === "tzid") {
    const target = zone(move.component, move.to.tzid);
    const ambiguity = target.ambiguity(wall) ?? (target.gapAlias(target.toUtc(wall)) !== null ? "gap" : null);
    if (ambiguity) {
      throw new UpdateFieldsError("DST_AMBIGUOUS", `moved, it would be ${icalForm(jcalOf(wall, "floating"))} in "${move.to.tzid}", at the DST change, where ${ambiguity === "gap" ? "the wall clock skips times" : "the wall clock shows an hour twice"} and its order and the order of instants part`, { remedy: "same-call" });
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
  return { frame, wall: propertyStamps(dtstart)[0].wall, text: dtstart.toICALString() };
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
var BoundUnavailable = class extends Error {
};
var HorizonReached = class extends Error {
};
var SeriesUnverifiable = class extends Error {
  constructor(message, source = null) {
    super(message);
    this.source = source;
  }
};
function bounded(iterator, budget, recur, horizon) {
  const cost = stepCost(recur);
  const it = iterator;
  const check = it.check_contracting_rules;
  if (typeof check !== "function") {
    throw new BoundUnavailable("ical.js no longer exposes the step a rule expansion can be bounded at");
  }
  it.check_contracting_rules = function(...args) {
    expansionWork.steps++;
    if ((budget.remaining -= cost) < 0) {
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
function expandWalls(master, until, budget, skipUnplaced = false) {
  const start = startOf(master);
  if (!start) {
    throw new SeriesUnverifiable("the series has no DTSTART");
  }
  const { frame } = start;
  const day = frame.form === "date";
  const norm = (wall) => day ? dayOf(wall) : wall;
  const timeOf = (wall) => day ? ICAL3.Time.fromDateString(jcalOf(wall, frame)) : ICAL3.Time.fromDateTimeString(jcalOf(wall, "floating"));
  const walls = /* @__PURE__ */ new Set();
  if (norm(start.wall) <= until) {
    walls.add(norm(start.wall));
  }
  try {
    for (const rdate of master.getAllProperties("rdate")) {
      for (const [i, stamp] of propertyStamps(rdate).entries()) {
        let wall;
        try {
          wall = norm(wallIn(master, stamp, frame));
        } catch (error) {
          if (skipUnplaced && error instanceof UpdateFieldsError && error.code === "ZONE_MISMATCH") {
            continue;
          }
          throw new SeriesUnverifiable(`RDATE ${icalForm(String(valuesOf(rdate)[i]))}: ${error.message}`, error);
        }
        if (wall <= until) {
          walls.add(wall);
        }
      }
    }
    for (const property of master.getAllProperties("rrule")) {
      const recur = recurOf(property).clone();
      if (recur.until) {
        recur.until = timeOf(norm(wallIn(
          master,
          stampOf(recur.until.toString(), void 0, property.name.toUpperCase()),
          frame
        )));
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
    if (error instanceof BoundUnavailable || error instanceof SeriesUnverifiable) {
      throw error;
    }
    if (error instanceof SeriesTooSparse) {
      return { walls, complete: false };
    }
    throw new SeriesUnverifiable(error.message, error);
  }
  return { walls, complete: true };
}
function expand(master, until) {
  const { walls, complete } = expandWalls(master, until, { remaining: WORK_BUDGET }, true);
  if (!complete) {
    const frame = frameOf(master);
    throw new SeriesTooSparse(walls.size > 200 ? `the override or EXDATE furthest ahead (${icalForm(jcalOf(until, frame))}) lies too far ahead to check within the work limit` : "the rule is too sparse to expand within the work limit");
  }
  return walls;
}
function occurrences(master, stamps, labels) {
  const frame = frameOf(master);
  if (!frame) {
    throw new SeriesUnverifiable("the series has no DTSTART");
  }
  const targets = targetWalls(master, frame, stamps, labels);
  const walls = expand(master, Math.max(0, ...targets.filter((t) => t !== null)));
  return namesOccurrence(master, frame, stamps, walls);
}
var namesNothing = (stamp, frame) => frame.form !== "date" && stamp.kind !== "date" && stamp.kind === "floating" !== (frame.form === "floating");
function targetWalls(master, frame, stamps, labels) {
  return stamps.map((stamp, i) => {
    if (namesNothing(stamp, frame)) {
      return null;
    }
    try {
      const wall = wallIn(master, stamp, frame);
      return frame.form === "date" ? dayOf(wall) : stamp.kind === "date" ? wall + DAY2 - 1 : wall;
    } catch (error) {
      throw new SeriesUnverifiable(`${labels[i]}: ${error.message}`, error);
    }
  });
}
function namesOccurrence(master, frame, stamps, walls) {
  const zoned = frame.form === "utc" || frame.form === "tzid";
  const instants = zoned ? new Set([...walls].map((wall) => occurrenceInstant(master, wall, frame))) : null;
  const days = new Set([...walls].map(dayOf));
  return stamps.map((stamp) => {
    if (frame.form === "date") {
      return walls.has(dayOf(wallIn(master, stamp, frame)));
    }
    if (stamp.kind === "date") {
      return days.has(dayOf(stamp.wall));
    }
    if (namesNothing(stamp, frame)) {
      return false;
    }
    if (!instants) {
      return walls.has(stamp.wall);
    }
    const instant = instantOf(master, stamp, frame);
    return instant !== null && instants.has(instant);
  });
}
function referenceStamps(refs) {
  return refs.map((ref) => {
    try {
      return propertyStamps(ref.property)[ref.index];
    } catch (error) {
      throw new SeriesUnverifiable(`${ref.label}: ${error.message}`, error);
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
function occurrenceForm(frame, example) {
  const value = jcalOf(example, frame);
  switch (frame.form) {
    case "tzid":
      return `the wall-clock time in "${frame.tzid}", like DTSTART (e.g. "${value}"), or the instant with "Z" or an offset`;
    case "utc":
      return `the time in UTC with "Z", like DTSTART (e.g. "${value}")`;
    case "floating":
      return `the local time without a zone, like DTSTART (e.g. "${value}")`;
    default:
      return `the date, like DTSTART (e.g. "${value}")`;
  }
}
function checkAddedExdates(master, added, cancel) {
  if (!added.length) {
    return;
  }
  const frame = frameOf(master);
  if (!frame) {
    throw new SeriesUnverifiable("the series has no DTSTART");
  }
  const targets = targetWalls(master, frame, added.map((a) => a.stamp), added.map((a) => a.label));
  let walls;
  try {
    walls = expand(master, Math.max(0, ...targets.filter((t) => t !== null)) + DAY2);
  } catch (error) {
    if (!(error instanceof SeriesTooSparse)) {
      throw error;
    }
    throw new UpdateFieldsError("CHECK_LIMIT_EXCEEDED", `Cannot verify that ${added.map((a) => a.label).join(", ")} names an occurrence of the series: ${error.message}. Rewrite the whole iCalendar object with the exclusions it should have`, { remedy: "rewrite-object", property: "EXDATE" });
  }
  const named = namesOccurrence(master, frame, added.map((a) => a.stamp), walls);
  const lost = added.filter((_, i) => !named[i]);
  if (!lost.length) {
    return;
  }
  const target = targets[added.indexOf(lost[0])];
  const sameDay = target === null ? void 0 : [...walls].filter((wall) => dayOf(wall) === dayOf(target)).sort((x, y) => x - y)[0];
  const first = Math.min(...walls);
  const series = ["dtstart", "rrule", "rdate"].flatMap((name) => master.getAllProperties(name)).map((property) => property.toICALString()).join(", ");
  const what = lost.map((a) => cancel ? icalForm(String(a.value)) : a.label).join(", ");
  const hint = sameDay !== void 0 ? `; that day it has one at ${icalForm(jcalOf(sameDay, frame))}` : "";
  throw new UpdateFieldsError(
    cancel ? "UNKNOWN_OCCURRENCE" : "UNMATCHED_EXDATE",
    `${what} ${lost.length > 1 ? "name" : "names"} no occurrence of the series (${series})${hint}, so ${cancel ? "there is nothing to cancel" : "it would exclude nothing"}. Give the original start of an occurrence as ${occurrenceForm(frame, sameDay ?? first)}`,
    { remedy: "fix-value", property: "EXDATE" }
  );
}
function settleGapTwins(master, outcome) {
  const frame = frameOf(master);
  if (!frame || frame.form !== "tzid" || !zoneOf(master, frame.tzid)) {
    return;
  }
  for (const [name, line] of outcome.written) {
    if (line.type === "period" || !master.getAllProperties(name).includes(line)) {
      continue;
    }
    const stamps = propertyStamps(line);
    const twins = stamps.map((stamp) => gapTwin(master, stamp, frame));
    const found = twins.filter((t) => t !== null);
    if (!found.length) {
      continue;
    }
    const walls = expand(master, Math.max(...found.map((t) => Math.max(t.wall, t.other))));
    const values = valuesOf(line);
    const clash = twins.map((t) => t !== null && walls.has(t.other) && (name === "rdate" || !walls.has(t.wall)));
    if (!clash.some(Boolean)) {
      continue;
    }
    if (name === "rdate") {
      const i = clash.indexOf(true);
      throw new UpdateFieldsError("DST_AMBIGUOUS", `RDATE ${icalForm(String(values[i]))} names the same instant as the occurrence at ${icalForm(jcalOf(twins[i].other, "floating"))} in "${frame.tzid}", a wall-clock time the DST change skips, which the series has already: leave it out, or give another time`, { remedy: "fix-value", property: "RDATE" });
    }
    const kept = values.filter((_, i) => !clash[i]);
    if (kept.length) {
      line.setValues(kept);
    } else {
      master.removeProperty(line);
    }
    const own = new ICAL3.Property("exdate", master);
    writeInstants(own, twins.filter((_, i) => clash[i]).map((t) => t.other), frame);
    master.addProperty(own);
  }
}
function inSeriesForm(master, line) {
  const frame = frameOf(master);
  if (!line || frame?.form !== "tzid" || !master.getAllProperties("exdate").includes(line)) {
    return;
  }
  const series = zoneOf(master, frame.tzid);
  if (!series) {
    return;
  }
  const stamps = propertyStamps(line);
  const walls = stamps.map((stamp) => {
    if (stamp.kind !== "utc") {
      return null;
    }
    const wall = series.fromUtc(stamp.wall);
    return series.toUtc(wall) === stamp.wall ? wall : null;
  });
  if (!walls.some((wall) => wall !== null)) {
    return;
  }
  const values = valuesOf(line);
  const rest = values.filter((_, i) => walls[i] === null);
  const own = new ICAL3.Property("exdate", master);
  writeInstants(own, walls.filter((wall) => wall !== null), frame);
  if (rest.length) {
    line.setValues(rest);
  } else {
    master.removeProperty(line);
  }
  master.addProperty(own);
}
function noSeries(lists) {
  return {
    finish: () => {
      lists?.apply();
    },
    render: (text) => text
  };
}
function beginSeriesEdit(calendar, master, written, source = null, lists = null) {
  const shapes = written.has("rrule") || written.has("rdate") || lists?.modes.get("rdate") === "remove";
  const failClosed = (error) => {
    if (error instanceof SeriesUnverifiable) {
      const message = `Cannot check that the overrides and EXDATEs still name occurrences of the series: ${error.message}. Rewrite the whole iCalendar object instead`;
      if (error.source === null) {
        return new UpdateFieldsError("SERIES_UNVERIFIABLE", message, { remedy: "rewrite-object" });
      }
      return wrapped(error.source, message, { remedy: "rewrite-object" });
    }
    if (error instanceof BoundUnavailable) {
      const plain = new Error(`Cannot check the series: ${error.message}`);
      plain.cause = error;
      return plain;
    }
    if (!(error instanceof SeriesTooSparse)) {
      return error;
    }
    const rule = master.getFirstProperty("rrule")?.toICALString() ?? "The rule";
    return shapes ? new UpdateFieldsError("CHECK_LIMIT_EXCEEDED", `Cannot check that the overrides and EXDATEs still name occurrences of the series: ${rule}: ${error.message}. Rewrite the whole iCalendar object instead`, { remedy: "rewrite-object" }) : new UpdateFieldsError(
      "CHECK_LIMIT_EXCEEDED",
      `Cannot check that moving DTSTART keeps the series' occurrences: ${rule}: ${error.message}. Give RRULE, UNTIL and EXDATE explicitly in the same call, or rewrite the whole iCalendar object`,
      { remedy: "same-call" }
    );
  };
  try {
    const edit = startSeriesEdit(calendar, master, written, source, lists, shapes);
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
function startSeriesEdit(calendar, master, written, source, lists, shapes) {
  if (!["vevent", "vtodo", "vjournal"].includes(master.name) || master.hasProperty("recurrence-id")) {
    return noSeries(lists);
  }
  if (written.has("recurrence-id")) {
    throw new UpdateFieldsError("RECURRENCE_ID_ON_MASTER", "RECURRENCE-ID cannot be written on the series master: it would turn the master into an override of a single instance (RFC 5545 3.8.4.4). updateFields edits the series; to change one instance, add or edit an override component (same UID, with RECURRENCE-ID) by rewriting the whole iCalendar object", { remedy: "rewrite-object", property: "RECURRENCE-ID" });
  }
  const replaced = new Set([...written].flatMap((name) => isDateListProperty(master, name) ? master.getAllProperties(name) : [master.getFirstProperty(name)]).filter(Boolean));
  const own = (name) => master.getAllProperties(name).filter((p) => !replaced.has(p));
  const uid = master.getFirstPropertyValue("uid");
  const overrides = (calendar?.getAllSubcomponents(master.name) ?? []).filter((c) => c !== master && c.hasProperty("recurrence-id") && c.getFirstPropertyValue("uid") === uid);
  const exdates = own("exdate");
  const rdates = own("rdate");
  const kept = master.getAllProperties().filter((p) => isRecurProperty(master, p.name) && !replaced.has(p));
  const rules = () => kept.filter((p) => recurOf(p).until);
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
  const shaping = SHAPING.filter((name) => written.has(name) || name === "rdate" && lists?.modes.get("rdate") === "remove");
  const ruleWritten = shapes;
  const ridOf = (c) => propertyStamps(c.getFirstProperty("recurrence-id"))[0];
  const exdateBefore = lists?.modes.has("exdate") ? listKeys(master, "exdate") : null;
  const excludedBefore = new Set(exdateBefore ? overrides.filter((c) => holds(master, exdateBefore, ridOf(c))) : []);
  const before = ruleWritten && references.length ? occurrences(master, referenceStamps(references), references.map((ref) => ref.label)) : [];
  const watched = references.filter((_, i) => before[i] === true);
  const start = written.has("dtstart") ? startOf(master) : null;
  const keepsRule = !["rrule", "exrule", "rdate"].some((name) => written.has(name));
  const texts = new RuleTexts(source, calendar, master);
  const removed = /* @__PURE__ */ new Set();
  const named = () => [
    ...master.getAllProperties("exdate"),
    ...master.getAllProperties("rdate"),
    ...overrides.filter((c) => !removed.has(c)).map((c) => c.getFirstProperty("recurrence-id"))
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
        for (const property of rules()) {
          const upper = property.name.toUpperCase();
          const until = recurOf(property).until.toICALString();
          try {
            moveUntil(property, move, texts);
          } catch (error) {
            throw wrapped(
              error,
              `DTSTART changed, and the existing ${upper} UNTIL=${until} cannot follow it (${error.message}): give ${upper}, with UNTIL, in the same call`,
              { remedy: "same-call", property: upper }
            );
          }
        }
        for (const property of [...exdates, ...rdates]) {
          const line = property.toICALString();
          try {
            moveInstants(property, move);
          } catch (error) {
            throw wrapped(
              error,
              `DTSTART changed, and the existing ${line} cannot follow it (${error.message}): give ${property.name.toUpperCase()} in the same call`,
              { remedy: "same-call", property: property.name.toUpperCase() }
            );
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
            throw wrapped(
              error,
              `DTSTART changed, and the override for ${line} cannot follow it (${error.message}): rewrite the whole iCalendar object with the override moved`,
              { remedy: "rewrite-object", property: "RECURRENCE-ID" }
            );
          }
        }
        if (keepsRule) {
          checkMove(master, move, start.text, now.text, texts);
        }
      }
      let watchedStamps = watched.length ? referenceStamps(watched) : [];
      let stillWatched = watched;
      if (lists) {
        const outcome = lists.apply();
        checkAddedExdates(master, outcome.addedExdates, lists.purpose === "cancel");
        settleGapTwins(master, outcome);
        if (lists.purpose === "cancel") {
          inSeriesForm(master, outcome.written.get("exdate"));
        }
        if (lists.purpose === "cancel") {
          const cancelled = new Set(outcome.givenExdates.map((g) => g.key));
          for (const override of overrides) {
            if (holds(master, cancelled, ridOf(override))) {
              calendar.removeSubcomponent(override);
              removed.add(override);
            }
          }
        }
        const exdatesNow = listKeys(master, "exdate");
        const keep = watched.map((ref, i) => ref.property.name === "recurrence-id" ? !removed.has(ref.property.parent) : holds(master, exdatesNow, watchedStamps[i]));
        stillWatched = watched.filter((_, i) => keep[i]);
        watchedStamps = watchedStamps.filter((_, i) => keep[i]);
        if (exdateBefore) {
          const after2 = exdatesNow;
          const hit = overrides.filter((c) => !removed.has(c) && !excludedBefore.has(c) && holds(master, after2, ridOf(c)));
          if (hit.length) {
            const ids = hit.map((c) => c.getFirstProperty("recurrence-id").toICALString()).join(", ");
            throw new UpdateFieldsError("ORPHANED_EXCEPTIONS", `EXDATE would exclude the occurrence ${hit.length > 1 ? "overrides replace" : "an override replaces"} (${ids}), so the override would silently stop applying (RFC 5545 3.8.4.4). Leave that occurrence out of EXDATE, or cancel it with cancelOccurrences, which removes the override too`, { remedy: "fix-value", property: "EXDATE" });
          }
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
          throw new UpdateFieldsError("DST_AMBIGUOUS", `${cause} is refused: ${twin.replace("%NAMES%", verb)}. Rewrite the whole iCalendar object with the values it should have`, { remedy: "rewrite-object" });
        }
      }
      for (const property of master.getAllProperties()) {
        if (kept.includes(property) && !texts.keep(property)) {
          recurOf(property);
        }
      }
      texts.mark();
      if (!stillWatched.length) {
        return;
      }
      const after = occurrences(master, watchedStamps, stillWatched.map((ref) => ref.label));
      const lost = stillWatched.filter((_, i) => after[i] === false);
      if (lost.length) {
        const what = shaping.filter((n) => n !== "dtstart").map((n) => n.toUpperCase()).join(" and ");
        const these = lost.length > 1 ? "these occurrences" : "this occurrence";
        const overridden = lost.some((ref) => ref.property.name === "recurrence-id");
        throw new UpdateFieldsError(
          "ORPHANED_EXCEPTIONS",
          `The new ${what} leaves ${lost.map((ref) => ref.label).join(", ")} naming no occurrence of the series, so ${lost.length > 1 ? "they" : "it"} would silently stop applying (RFC 5545 ${overridden ? "3.8.4.4, " : ""}3.8.5.1). ` + (overridden ? `Give RRULE (or RDATE) in the same call so the series still has ${these}, and the complete EXDATE list (list mode "replace") in the same call with the exclusions the new series should have; or rewrite the whole iCalendar object to move or remove the override` : `Give the complete EXDATE list (list mode "replace") in the same call with the exclusions the new series should have, or an RRULE (or RDATE) that keeps ${these}`),
          { remedy: "same-call", property: written.has("rrule") ? "RRULE" : "RDATE" }
        );
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
    const recur = recurOf(property);
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
    throw new UpdateFieldsError(
      "SERIES_MOVE_REFUSED",
      `Moving DTSTART (${from} to ${to}) does not move the whole series: ${property.toICALString()} ${why}, so the moved series would not have the same occurrences, each moved. Give ${upper} in the same call to fit the new start${suggestion ? ` (e.g. ${upper} "${suggestion}")` : ""}; to start the series later without moving it, give RRULE, UNTIL and EXDATE explicitly, or rewrite the whole iCalendar object`,
      { remedy: "same-call", property: upper, ...suggestion ? { suggestion } : {} }
    );
  }
}
function checkDatesOnly(master, move, properties) {
  const timeOfDay = move.fromWall - dayOf(move.fromWall);
  for (const property of properties) {
    for (const stamp of propertyStamps(property)) {
      const wall = stamp.kind === "date" ? null : wallIn(master, stamp, move.from);
      if (wall === null || wall - dayOf(wall) !== timeOfDay) {
        const line = property.toICALString();
        throw new UpdateFieldsError("SERIES_MOVE_REFUSED", `DTSTART changed to a date, and ${line} is ${wall === null ? "a date already" : "not at the series' time of day"}, so as a date it could name an occurrence it did not name before: give ${property.name === "recurrence-id" ? "the override" : property.name.toUpperCase()} as dates by rewriting the whole iCalendar object`, { remedy: "rewrite-object", property: property.name.toUpperCase() });
      }
    }
  }
}

// src/vtimezone.ts
import ICAL4 from "ical.js";
var DAY3 = 86400;
var LAST_SCANNED_YEAR = 2045;
var MIN_RUN = 3;
var SCAN_STEP = 50;
var SETTLED_YEARS = 10;
var SCAN_LIMIT = 2300;
var scans = /* @__PURE__ */ new Map();
function changesBetween(offsetAt, start, end) {
  const changes = [];
  let t = start;
  let offset = offsetAt(start);
  while (t < end) {
    const next = Math.min(t + DAY3, end);
    if (offsetAt(next) === offset) {
      t = next;
      continue;
    }
    let lo = t;
    let hi = next;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (offsetAt(mid) === offset) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    const to = offsetAt(hi);
    changes.push({ at: hi, from: offset, to });
    t = hi;
    offset = to;
  }
  return changes;
}
function scan(tzid, offsetAt, start, end) {
  let known = scans.get(tzid);
  if (!known) {
    known = { start, end, initial: offsetAt(start), changes: changesBetween(offsetAt, start, end) };
  } else {
    if (start < known.start) {
      known = {
        ...known,
        start,
        initial: offsetAt(start),
        changes: [...changesBetween(offsetAt, start, known.start), ...known.changes]
      };
    }
    if (end > known.end) {
      known = { ...known, end, changes: [...known.changes, ...changesBetween(offsetAt, known.end, end)] };
    }
  }
  scans.set(tzid, known);
  const before = known.changes.filter((c) => c.at <= start);
  return {
    start,
    end,
    initial: before.length ? before[before.length - 1].to : known.initial,
    changes: known.changes.filter((c) => c.at > start && c.at <= end)
  };
}
function onsetOf(change) {
  const local = change.at + change.from;
  const f = fieldsOf(local);
  const day = Math.floor(local / DAY3) * DAY3;
  return {
    change,
    local,
    year: f.year,
    month: f.month,
    day: f.day,
    weekday: new Date(local * 1e3).getUTCDay(),
    back: (day - wallOf(f.year + 1, 1, 1)) / DAY3,
    time: local - day,
    up: change.to > change.from
  };
}
var WEEKDAYS2 = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
var daysIn = (year, month) => fieldsOf(wallOf(year, month + 1, 1) - DAY3).day;
var weekdayAt = (wall) => new Date(wall * 1e3).getUTCDay();
var firstOnOrAfter = (year, month, from, weekday) => from + (weekday - weekdayAt(wallOf(year, month, from)) + 7) % 7;
var firstOnOrAfterBack = (year, from, weekday) => from + (weekday - weekdayAt(wallOf(year + 1, 1, 1) + from * DAY3) + 7) % 7;
var range = (from) => Array.from({ length: 7 }, (_, i) => from + i).join(",");
function rulesFor(o) {
  const out = [];
  const month = `BYMONTH=${o.month}`;
  const wd = WEEKDAYS2[o.weekday];
  if (o.day + 7 > daysIn(o.year, o.month)) {
    out.push(`${month};BYDAY=-1${wd}`);
  }
  for (const from of [1, 8, 15, 22]) {
    if (firstOnOrAfter(o.year, o.month, from, o.weekday) === o.day) {
      out.push(`${month};BYDAY=${(from + 6) / 7}${wd}`);
    }
  }
  const shortest = o.month === 2 ? 28 : daysIn(2001, o.month);
  for (let from = Math.max(1, o.day - 6); from <= o.day && from + 6 <= shortest; from++) {
    if (firstOnOrAfter(o.year, o.month, from, o.weekday) === o.day) {
      out.push(`${month};BYMONTHDAY=${range(from)};BYDAY=${wd}`);
    }
  }
  out.push(`${month};BYMONTHDAY=${o.day}`);
  if (o.month >= 3) {
    for (let from = o.back - 6; from <= o.back && from + 6 <= -1; from++) {
      if (firstOnOrAfterBack(o.year, from, o.weekday) === o.back) {
        out.push(`BYYEARDAY=${range(from)};BYDAY=${wd}`);
      }
    }
  }
  return out;
}
var signature = (o) => `${o.time}|${o.change.from}|${o.change.to}`;
var RuleSet = class {
  constructor() {
    this.candidates = null;
    this.sig = "";
  }
  /** the rules if `onset` is added too, without adding it; empty when none */
  with(onset) {
    if (this.candidates === null) {
      return rulesFor(onset);
    }
    if (signature(onset) !== this.sig) {
      return [];
    }
    const own = new Set(rulesFor(onset));
    return this.candidates.filter((rule) => own.has(rule));
  }
  add(onset, rules) {
    this.sig = signature(onset);
    this.candidates = rules;
  }
};
function runsOf(onsets) {
  const byYear = /* @__PURE__ */ new Map();
  for (const onset of onsets) {
    const list = byYear.get(onset.year);
    if (list) {
      list.push(onset);
    } else {
      byYear.set(onset.year, [onset]);
    }
  }
  const pair = (year) => {
    const list = byYear.get(year);
    if (!list || list.length !== 2 || list[0].up === list[1].up) {
      return null;
    }
    return list[0].up ? { up: list[0], down: list[1] } : { up: list[1], down: list[0] };
  };
  const years = [...byYear.keys()].sort((a, b) => a - b);
  const runs = [];
  const inRun = /* @__PURE__ */ new Set();
  for (let i = 0; i < years.length; ) {
    const ups = [];
    const downs = [];
    const upRules = new RuleSet();
    const downRules = new RuleSet();
    let rules = null;
    let j = i;
    for (; j < years.length; j++) {
      const p = pair(years[j]);
      if (!p || j > i && years[j] !== years[j - 1] + 1) {
        break;
      }
      const up = upRules.with(p.up);
      const down = downRules.with(p.down);
      if (!up.length || !down.length) {
        break;
      }
      upRules.add(p.up, up);
      downRules.add(p.down, down);
      ups.push(p.up);
      downs.push(p.down);
      rules = [up[0], down[0]];
    }
    if (rules && ups.length >= MIN_RUN) {
      runs.push({ ups, downs, upRule: rules[0], downRule: rules[1] });
      [...ups, ...downs].forEach((o) => inRun.add(o));
      i = j;
    } else {
      i = Math.max(j, i + 1);
    }
  }
  return { runs, single: onsets.filter((o) => !inRun.has(o)) };
}
var pad2 = (n, width = 2) => String(n).padStart(width, "0");
var icalLocal = (wall) => {
  const f = fieldsOf(wall);
  return `${pad2(f.year, 4)}${pad2(f.month)}${pad2(f.day)}T${pad2(f.hour)}${pad2(f.minute)}${pad2(f.second)}`;
};
var icalOffset = (seconds) => {
  const abs = Math.abs(seconds);
  return `${seconds < 0 ? "-" : "+"}${pad2(Math.floor(abs / 3600))}${pad2(Math.floor(abs / 60) % 60)}`;
};
var NAME_LOCALES = ["en-US", "en-GB", "en-AU", "en-IN", "en-NZ", "en-CA", "en-IE", "en-ZA"];
function namer(tzid) {
  const formats = /* @__PURE__ */ new Map();
  return (utc, offset) => {
    for (const locale of NAME_LOCALES) {
      let format = formats.get(locale);
      if (!format) {
        format = new Intl.DateTimeFormat(locale, { timeZone: tzid, timeZoneName: "short" });
        formats.set(locale, format);
      }
      const name = format.formatToParts(new Date(utc * 1e3)).find((p) => p.type === "timeZoneName")?.value ?? "";
      if (/^[A-Z]{2,6}$/.test(name)) {
        return name;
      }
    }
    const text = icalOffset(offset);
    return text.endsWith("00") ? text.slice(0, 3) : text;
  };
}
function render(tzid, observances) {
  const name = namer(tzid);
  const sorted = [...observances].sort((a, b) => a.start - b.start || a.kind.localeCompare(b.kind));
  return ["BEGIN:VTIMEZONE", `TZID:${tzid}`, ...sorted.flatMap((o) => [
    `BEGIN:${o.kind}`,
    `DTSTART:${icalLocal(o.start)}`,
    `TZOFFSETFROM:${icalOffset(o.from)}`,
    `TZOFFSETTO:${icalOffset(o.to)}`,
    `TZNAME:${name(o.at, o.to)}`,
    ...o.lines,
    `END:${o.kind}`
  ]), "END:VTIMEZONE"];
}
function observancesOf(found, rules, lastYear) {
  const onsets = found.changes.map(onsetOf);
  const parts = rules ? runsOf(onsets) : { runs: [], single: onsets };
  const runs = [...parts.runs];
  let single = [...parts.single];
  const last = runs[runs.length - 1];
  const open = Boolean(last && Math.max(last.ups[last.ups.length - 1].year, last.downs[last.downs.length - 1].year) >= lastYear);
  let final = null;
  if (!open && onsets.length) {
    final = onsets[onsets.length - 1];
    single = single.filter((o) => o !== final);
    if (last && (last.ups.includes(final) || last.downs.includes(final))) {
      const ups = last.ups.filter((o) => o !== final);
      const downs = last.downs.filter((o) => o !== final);
      runs.pop();
      if (ups.length && downs.length) {
        runs.push({ ...last, ups, downs });
      } else {
        single.push(...ups, ...downs);
      }
    }
  }
  const firstUp = onsets[0]?.up;
  const out = [{
    kind: firstUp === void 0 || firstUp ? "STANDARD" : "DAYLIGHT",
    from: found.initial,
    to: found.initial,
    start: found.start + found.initial,
    at: found.start,
    lines: []
  }];
  runs.forEach((run, i) => {
    const isOpen = open && i === runs.length - 1;
    for (const [list, rule] of [[run.ups, run.upRule], [run.downs, run.downRule]]) {
      const end = list[list.length - 1];
      const until = isOpen ? "" : `;UNTIL=${icalLocal(end.change.at)}Z`;
      out.push({
        kind: list[0].up ? "DAYLIGHT" : "STANDARD",
        from: list[0].change.from,
        to: list[0].change.to,
        start: list[0].local,
        at: list[0].change.at,
        lines: [`RRULE:FREQ=YEARLY;${rule}${until}`]
      });
    }
  });
  const groups = /* @__PURE__ */ new Map();
  for (const onset of single.sort((a, b) => a.local - b.local)) {
    const key = `${onset.up}|${onset.change.from}|${onset.change.to}`;
    groups.set(key, [...groups.get(key) ?? [], onset]);
  }
  for (const group of groups.values()) {
    const [first] = group;
    out.push({
      kind: first.up ? "DAYLIGHT" : "STANDARD",
      from: first.change.from,
      to: first.change.to,
      start: first.local,
      at: first.change.at,
      lines: group.length > 1 ? group.map((o) => `RDATE:${icalLocal(o.local)}`) : []
    });
  }
  if (final) {
    for (const kind of ["STANDARD", "DAYLIGHT"]) {
      out.push({ kind, from: final.change.from, to: final.change.to, start: final.local, at: final.change.at, lines: [] });
    }
  }
  return out;
}
function settled(found, endYear) {
  const onsets = found.changes.map(onsetOf);
  const tail = onsets.filter((o) => o.year > endYear - SETTLED_YEARS);
  if (!tail.length) {
    return true;
  }
  const { runs } = runsOf(onsets);
  const last = runs[runs.length - 1];
  return Boolean(last && tail.every((o) => last.ups.includes(o) || last.downs.includes(o)));
}
function matches(vtimezone, found) {
  const zone2 = vtimezoneZone(vtimezone);
  const points = [[found.start, found.initial]];
  let previous = found.start;
  let offset = found.initial;
  const last = found.changes.length ? found.changes[found.changes.length - 1].to : found.initial;
  for (const change of [...found.changes, { at: found.end, from: last, to: last }]) {
    points.push([Math.floor((previous + change.at) / 2), offset], [change.at - 1, change.from], [change.at, change.to]);
    previous = change.at;
    offset = change.to;
  }
  return points.every(([utc, expected]) => zone2.offsetAt(utc) === expected);
}
function vtimezoneFor(tzid, firstYear, lastYear) {
  const zone2 = ianaZone(tzid);
  if (!zone2) {
    throw new UpdateFieldsError("UNKNOWN_TZID", `"${tzid}" is no IANA time zone`, { remedy: "fix-value" });
  }
  const local = wallOf(firstYear - 1, 1, 1);
  const start = local - zone2.offsetAt(local);
  void lastYear;
  if (firstYear < 1800 && zone2.offsetAt(wallOf(firstYear, 1, 1)) % 60 !== 0) {
    throw new UpdateFieldsError(
      "UNSUPPORTED_VTIMEZONE",
      `"${tzid}" was on local mean time in ${firstYear}, an offset in seconds that iCalendar readers cannot read: give values in UTC, or from the year standard time began`,
      { remedy: "fix-value" }
    );
  }
  let endYear = LAST_SCANNED_YEAR;
  let found;
  for (; ; ) {
    const endLocal = wallOf(endYear + 1, 1, 1);
    found = scan(tzid, zone2.offsetAt, start, endLocal - zone2.offsetAt(endLocal));
    if (endYear + SCAN_STEP > SCAN_LIMIT || settled(found, endYear)) {
      break;
    }
    endYear += SCAN_STEP;
  }
  const odd = (offset) => offset % 60 !== 0;
  const lastOdd = found.changes.reduce((last, change, i) => odd(change.from) ? i : last, -1);
  if (lastOdd >= 0 && found.changes[lastOdd].at <= wallOf(firstYear, 1, 1) - DAY3) {
    const resume = found.changes[lastOdd].at;
    found = { ...found, start: resume, initial: found.changes[lastOdd].to, changes: found.changes.slice(lastOdd + 1) };
  }
  if (odd(found.initial) || found.changes.some((change) => odd(change.to))) {
    const end = lastOdd >= 0 ? found.changes[lastOdd] : null;
    const since = end ? icalLocal(end.at + end.to).slice(0, 8) : null;
    throw new UpdateFieldsError("UNSUPPORTED_VTIMEZONE", `"${tzid}" was on local mean time, an offset in seconds that iCalendar readers cannot read${since ? ` before ${since}` : ""}: give values in UTC${since ? ` or from ${since} on` : ""}`, { remedy: "fix-value" });
  }
  for (const rules of [true, false]) {
    const text = ["BEGIN:VCALENDAR", ...render(tzid, observancesOf(found, rules, endYear)), "END:VCALENDAR"].join("\r\n");
    const vtimezone = new ICAL4.Component(ICAL4.parse(text)).getFirstSubcomponent("vtimezone");
    if (matches(vtimezone, found)) {
      return vtimezone;
    }
  }
  throw new Error(`the VTIMEZONE generated for "${tzid}" does not match the time zone data`);
}
function generateVtimezone(tzid, range2) {
  const from = range2?.from;
  const to = range2?.to ?? from;
  if (typeof tzid !== "string" || !Number.isInteger(from) || !Number.isInteger(to) || to < from) {
    throw new UpdateFieldsError("INVALID_INPUT", "generateVtimezone takes an IANA zone name and { from, to? }, integer years with from <= to", { remedy: "fix-value" });
  }
  const name = ianaZoneName(tzid);
  if (!name) {
    throw new UpdateFieldsError("UNKNOWN_TZID", `"${tzid}" is no IANA time zone`, { remedy: "fix-value" });
  }
  return vtimezoneFor(name, from, to).toString();
}
function valuesIn(calendar, tzid) {
  const walls = [];
  const years = [];
  const add = (value, list) => {
    const m = /^(\d{4,})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2}))?/.exec(String(value));
    if (!m) {
      return;
    }
    const wall = wallOf(...[1, 2, 3, 4, 5, 6].map((i) => Number(m[i] ?? 0)));
    (list === "walls" ? walls : years).push(list === "walls" ? wall : Number(m[1]));
  };
  const visit = (component) => {
    if (component.name === "vtimezone") {
      return;
    }
    for (const property of component.getAllProperties()) {
      if (property.getParameter("tzid") === tzid) {
        for (const value of property.toJSON().slice(3)) {
          (Array.isArray(value) ? value : [value]).forEach((v) => add(v, "walls"));
        }
      }
    }
    if (component.getFirstProperty("dtstart")?.getParameter("tzid") === tzid) {
      for (const name of ["rrule", "exrule"]) {
        for (const property of component.getAllProperties(name)) {
          const until = property.toJSON()[3]?.until;
          if (until !== void 0) {
            add(until, "years");
          }
        }
      }
    }
    component.getAllSubcomponents().forEach(visit);
  };
  visit(calendar);
  return { walls, years };
}
function coverageStart(vtimezone) {
  const starts = vtimezone.getAllSubcomponents().map((o) => o.getFirstPropertyValue("dtstart")).filter((t) => Boolean(t)).map((t) => wallOf(t.year, t.month, t.day, t.hour, t.minute, t.second));
  return starts.length ? Math.min(...starts) : null;
}
function place(calendar, vtimezone, replacing) {
  const all = [...calendar.getAllSubcomponents()];
  const at = replacing ? all.indexOf(replacing) : all.findIndex((c) => c.name !== "vtimezone");
  const next = replacing ? all.map((c) => c === replacing ? vtimezone : c) : [...all.slice(0, at < 0 ? all.length : at), vtimezone, ...at < 0 ? [] : all.slice(at)];
  calendar.removeAllSubcomponents();
  next.forEach((c) => calendar.addSubcomponent(c));
}
function ensureVtimezone(calendar, tzid) {
  if (calendar.name !== "vcalendar") {
    return;
  }
  const { walls, years } = valuesIn(calendar, tzid);
  if (!walls.length) {
    return;
  }
  const firstYear = fieldsOf(Math.min(...walls)).year;
  const lastYear = Math.max(fieldsOf(Math.max(...walls)).year, ...years);
  const existing = vtimezoneIn(calendar, tzid);
  if (!existing) {
    place(calendar, vtimezoneFor(tzid, firstYear, lastYear), null);
    return;
  }
  const start = coverageStart(existing);
  const earliest = Math.min(...walls);
  if (start === null || earliest >= start) {
    return;
  }
  const generatedFrom = fieldsOf(start).year + 1;
  let ours = false;
  try {
    ours = Boolean(ianaZone(tzid)) && vtimezoneFor(tzid, generatedFrom, generatedFrom).toString() === existing.toString();
  } catch {
    ours = false;
  }
  if (!ours) {
    throw new UpdateFieldsError(
      "UNSUPPORTED_VTIMEZONE",
      `the object's VTIMEZONE "${tzid}" starts at ${icalLocal(start)}, after ${icalLocal(earliest)}, a value in that zone; readers (ical.js among them) do not read a time before a VTIMEZONE's first observance correctly, and this VTIMEZONE is not one updateFields generated, so it is not rewritten: rewrite the whole object with a VTIMEZONE that covers the value`,
      { remedy: "rewrite-object" }
    );
  }
  place(calendar, vtimezoneFor(tzid, Math.min(firstYear, generatedFrom), Math.max(lastYear, generatedFrom)), existing);
}

// src/updateFields.ts
function describe(value) {
  if (value === null || value === void 0) {
    return String(value);
  }
  if (Array.isArray(value)) {
    return "an array";
  }
  const type = typeof value;
  return `${/^[aeiou]/.test(type) ? "an" : "a"} ${type}`;
}
function componentType(type) {
  const name = typeof type === "string" ? type.toLowerCase() : "";
  if (!COMPONENT_TYPES.includes(name)) {
    throw new UpdateFieldsError(
      "INVALID_TYPE",
      `Invalid type "${String(type)}": use "vevent", "vtodo" or "vjournal"`,
      { remedy: "fix-value" }
    );
  }
  return name;
}
var LISTS = ["EXDATE", "RDATE"];
var MODES = ["replace", "add", "remove"];
function listModes(value) {
  if (value === void 0) {
    return /* @__PURE__ */ new Map();
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new UpdateFieldsError(
      "INVALID_INPUT",
      `Invalid lists: give an object of list modes, e.g. { EXDATE: 'add' }, not ${describe(value)}`,
      { remedy: "fix-value" }
    );
  }
  return new Map(Object.entries(value).map(([name, mode]) => {
    const upper = name.toUpperCase();
    if (!LISTS.includes(upper)) {
      throw new UpdateFieldsError(
        "INVALID_INPUT",
        `Invalid lists entry "${name}": only ${LISTS.join(" and ")} are lists of dates`,
        { remedy: "fix-value", property: upper }
      );
    }
    if (!MODES.includes(mode)) {
      throw new UpdateFieldsError("INVALID_INPUT", `Invalid list mode for ${upper}: ${typeof mode === "string" ? `"${mode}"` : describe(mode)}; use "replace", "add" or "remove"`, { remedy: "fix-value", property: upper });
    }
    return [upper.toLowerCase(), mode];
  }));
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
    throw new UpdateFieldsError(
      "NO_MASTER",
      `This object holds ${all.length} ${type2.toUpperCase()} instances (each with a RECURRENCE-ID) and no master, so a field update cannot tell which one is meant. Edit the instance by rewriting the whole iCalendar object instead`,
      { remedy: "rewrite-object" }
    );
  }
  const held = [...new Set(calendar.getAllSubcomponents().map((c) => String(c.name).toUpperCase()))];
  throw new UpdateFieldsError("COMPONENT_NOT_FOUND", `No ${types.map((t) => t.toUpperCase()).join(", ")} found in VCALENDAR ` + (held.length ? `(it holds: ${held.join(", ")})` : "(it holds no components)"), { remedy: "fix-value" });
}
function namedZone(root, zone2) {
  if (vtimezoneIn(root, zone2)) {
    return { utc: false, tzid: zone2 };
  }
  const name = ianaZoneName(zone2);
  if (!name) {
    throw new UpdateFieldsError(
      "UNKNOWN_TZID",
      `zone "${zone2}" is no IANA time zone (e.g. "Europe/Berlin", "America/New_York") and the object has no VTIMEZONE of that name` + (/^[+-]\d/.test(zone2.trim()) ? '; for a fixed offset give the values with it ("2026-10-26T18:00:00+02:00") instead' : ""),
      { remedy: "fix-value" }
    );
  }
  return isUtcZone(name) ? { utc: true, tzid: name } : { utc: false, tzid: name };
}
function momentOf(component, name) {
  const property = component.getFirstProperty(name);
  if (!property || property.type === "date") {
    return null;
  }
  const m = /^(\d{4,})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z)?$/i.exec(String(property.toJSON()[3]));
  if (!m) {
    return null;
  }
  const wall = wallOf(...[1, 2, 3, 4, 5, 6].map((i) => Number(m[i])));
  const tzid = property.getParameter("tzid");
  if (m[7]) {
    return { wall, utc: wall, frame: "utc" };
  }
  if (typeof tzid === "string" && tzid) {
    const zone2 = zoneOf(component, tzid);
    return { wall, utc: zone2 ? zone2.toUtc(wall) : null, frame: `tzid:${tzid}` };
  }
  return { wall, utc: null, frame: "floating" };
}
var wallText = (wall) => {
  const f = fieldsOf(wall);
  return `${pad(f.year, 4)}-${pad(f.month)}-${pad(f.day)}T${pad(f.hour)}:${pad(f.minute)}:${pad(f.second)}`;
};
function updateFields(calendarObject, fields, options = {}) {
  return editFields(calendarObject, fields, options, null);
}
function editFields(calendarObject, fields, options, purpose) {
  const icalString = typeof calendarObject === "string" ? calendarObject : calendarObject !== null && typeof calendarObject === "object" ? calendarObject.data : void 0;
  if (!icalString || typeof icalString !== "string") {
    throw new UpdateFieldsError(
      "INVALID_INPUT",
      'Invalid input: calendarObject must be a string or object with "data" field',
      { remedy: "fix-value" }
    );
  }
  if (fields === null || typeof fields !== "object" || Array.isArray(fields)) {
    throw new UpdateFieldsError(
      "INVALID_INPUT",
      `Invalid input: fields must be an object of property names and string values, not ${describe(fields)}`,
      { remedy: "fix-value" }
    );
  }
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value !== "string") {
      throw new UpdateFieldsError(
        "INVALID_VALUE",
        `${key.toUpperCase()}: the value must be a string, not ${describe(value)}`,
        { remedy: "fix-value", property: key.toUpperCase() }
      );
    }
  }
  if (options === null || typeof options !== "object") {
    throw new UpdateFieldsError(
      "INVALID_INPUT",
      `Invalid input: options must be an object, not ${describe(options)}`,
      { remedy: "fix-value" }
    );
  }
  const floatingTime = options.floatingTime ?? "keep";
  if (floatingTime !== "keep" && floatingTime !== "local") {
    throw new UpdateFieldsError(
      "INVALID_FLOATING_TIME",
      `Invalid floatingTime "${floatingTime}": use "keep" or "local"`,
      { remedy: "fix-value" }
    );
  }
  const absoluteTime = options.absoluteTime ?? "as-given";
  if (absoluteTime !== "as-given" && absoluteTime !== "keep-zone") {
    throw new UpdateFieldsError(
      "INVALID_ABSOLUTE_TIME",
      `Invalid absoluteTime "${absoluteTime}": use "as-given" or "keep-zone"`,
      { remedy: "fix-value" }
    );
  }
  const type = options.type === void 0 ? void 0 : componentType(options.type);
  const modes = listModes(options.lists);
  if (options.zone !== void 0) {
    if (typeof options.zone !== "string" || options.zone.trim() === "") {
      throw new UpdateFieldsError(
        "INVALID_INPUT",
        `Invalid input: zone must be an IANA time zone name such as "Europe/Berlin", not ${typeof options.zone === "string" ? "an empty string" : describe(options.zone)}`,
        { remedy: "fix-value" }
      );
    }
    if (options.floatingTime !== void 0) {
      throw new UpdateFieldsError(
        "INVALID_FLOATING_TIME",
        `floatingTime "${floatingTime}" cannot be combined with zone: with zone "${options.zone}" a time without a zone is wall clock in that zone; leave out floatingTime`,
        { remedy: "fix-value" }
      );
    }
    if (absoluteTime === "as-given" && options.absoluteTime !== void 0) {
      throw new UpdateFieldsError(
        "INVALID_ABSOLUTE_TIME",
        `absoluteTime "as-given" (write as UTC) cannot be combined with zone: with zone "${options.zone}" an instant is written as its wall-clock time in that zone; leave out absoluteTime`,
        { remedy: "fix-value" }
      );
    }
  }
  let jcalData;
  let component;
  try {
    jcalData = ICAL5.parse(icalString);
  } catch (error) {
    throw new UpdateFieldsError(
      "INVALID_ICALENDAR",
      `Failed to parse iCal data: ${error.message}`,
      { remedy: "rewrite-object", cause: error }
    );
  }
  if (Array.isArray(jcalData) && Array.isArray(jcalData[0])) {
    throw new UpdateFieldsError("INVALID_INPUT", `Invalid input: the text holds ${jcalData.length} top-level components; give one VCALENDAR or VCARD per call`, { remedy: "fix-value" });
  }
  try {
    component = new ICAL5.Component(jcalData);
  } catch (error) {
    throw new UpdateFieldsError(
      "INVALID_ICALENDAR",
      `Failed to parse iCal data: ${error.message}`,
      { remedy: "rewrite-object", cause: error }
    );
  }
  if (type && component.name !== "vcalendar" && component.name !== type) {
    const name = String(component.name).toUpperCase();
    throw new UpdateFieldsError(
      "WRONG_OBJECT_KIND",
      component.name === "vcard" ? `type "${type}" applies to an iCalendar object, but this is a VCARD` : `type "${type}" asks for a ${type.toUpperCase()}, but this object is a bare ${name}`,
      { remedy: component.name === "vcard" ? "none" : "fix-value" }
    );
  }
  const actualComponent = component.name === "vcalendar" ? seriesMaster(component, type) : component;
  const zone2 = options.zone === void 0 ? null : namedZone(component, options.zone.trim());
  const isEvent = ["vevent", "vtodo", "vjournal"].includes(actualComponent.name);
  const entries = Object.entries(fields).sort(
    ([a], [b]) => Number(b.toLowerCase() === "dtstart") - Number(a.toLowerCase() === "dtstart")
  );
  const lists = new Map(entries.map(([key]) => key.toLowerCase()).filter((name) => isDateListProperty(actualComponent, name)).map((name) => [name, modes.get(name) ?? "replace"]));
  const written = new Set(entries.map(([key]) => key.toLowerCase()).filter((name) => (lists.get(name) ?? "replace") === "replace"));
  const listEdit = lists.size ? new DateListEdit(actualComponent, lists, purpose) : null;
  const series = beginSeriesEdit(
    component.name === "vcalendar" ? component : null,
    actualComponent,
    written,
    icalString,
    listEdit
  );
  const ends = zone2 && isEvent && written.has("dtstart") ? ["dtend", "due"].filter((name) => !written.has(name)).flatMap((name) => {
    const start2 = momentOf(actualComponent, "dtstart");
    const end = momentOf(actualComponent, name);
    if (!start2 || !end) {
      return [];
    }
    if (start2.frame === end.frame) {
      return [{ name, length: end.wall - start2.wall, elapsed: false }];
    }
    return start2.utc !== null && end.utc !== null ? [{ name, length: end.utc - start2.utc, elapsed: true }] : [];
  }) : [];
  for (const [key, value] of entries) {
    if (!setDateValue(
      actualComponent,
      key,
      value,
      floatingTime,
      absoluteTime,
      zone2,
      lists.get(key.toLowerCase()) === "remove"
    ) && !setRecurValue(actualComponent, key, value, floatingTime, zone2)) {
      actualComponent.updatePropertyWithValue(key.toLowerCase(), value);
    }
  }
  const start = ends.length ? momentOf(actualComponent, "dtstart") : null;
  for (const { name, length, elapsed } of start ? ends : []) {
    const value = elapsed && start.utc !== null ? `${wallText(start.utc + length)}Z` : wallText(start.wall + length);
    setDateValue(actualComponent, name, value, floatingTime, absoluteTime, zone2);
  }
  series.finish();
  if (zone2 && isEvent && ["dtstart", "dtend", "due"].some((name) => written.has(name))) {
    const begin = momentOf(actualComponent, "dtstart");
    for (const name of ["dtend", "due"]) {
      const end = momentOf(actualComponent, name);
      const before = begin && end && (begin.utc !== null && end.utc !== null ? end.utc < begin.utc : begin.frame === end.frame && end.wall < begin.wall);
      if (before) {
        const upper = name.toUpperCase();
        throw new UpdateFieldsError("END_BEFORE_START", `${upper} ${wallText(end.wall)} would lie before DTSTART ${wallText(begin.wall)}: give ${upper} after the start`, { remedy: "fix-value", property: upper });
      }
    }
  }
  if (zone2 && !zone2.utc && [...written, ...ends.map((e) => e.name)].some((name) => actualComponent.getAllProperties(name).some((p) => p.getParameter("tzid") === zone2.tzid))) {
    ensureVtimezone(component, zone2.tzid);
  }
  return series.render(component.toString());
}

// src/occurrences.ts
function idList(ids, what) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new UpdateFieldsError("INVALID_INPUT", `${what} needs a non-empty list of occurrence starts, e.g. ["2026-12-24T10:00:00"]`, { remedy: "fix-value" });
  }
  for (const id of ids) {
    if (typeof id !== "string" || id.trim() === "" || id.includes(",")) {
      throw new UpdateFieldsError("INVALID_INPUT", `${what}: each occurrence is one date or date-time string, not ${typeof id === "string" ? `"${id}"` : id === null ? "null" : typeof id}`, { remedy: "fix-value" });
    }
  }
  return ids.join(",");
}
function cancelOccurrences(calendarObject, ids, options = {}) {
  return editFields(
    calendarObject,
    { EXDATE: idList(ids, "cancelOccurrences") },
    { type: options?.type, lists: { EXDATE: "add" } },
    "cancel"
  );
}
function restoreOccurrences(calendarObject, ids, options = {}) {
  return editFields(
    calendarObject,
    { EXDATE: idList(ids, "restoreOccurrences") },
    { type: options?.type, lists: { EXDATE: "remove" } },
    "restore"
  );
}

// src/timezone.ts
import ICAL6 from "ical.js";
var invalid = (message) => new UpdateFieldsError("INVALID_VALUE", message, { remedy: "fix-value" });
function instantOf2(instant) {
  if (instant instanceof Date) {
    if (Number.isNaN(instant.getTime())) {
      throw invalid("the instant is an invalid Date");
    }
    return Math.floor(instant.getTime() / 1e3);
  }
  const value = parseDateValue(instant);
  if (value.kind !== "utc") {
    throw invalid(`"${instant}" names no instant: give it with Z or an offset, e.g. "2026-10-26T18:00:00Z"`);
  }
  const [y, mo, d, h, mi, sec] = value.jcal.match(/\d+/g).map(Number);
  return wallOf(y, mo, d, h, mi, sec);
}
function wallOfText(wallTime) {
  const value = parseDateValue(wallTime);
  if (value.kind !== "floating") {
    throw invalid(`"${wallTime}" is no wall-clock time: give it without a zone, e.g. "2026-10-26T18:00:00"`);
  }
  const [y, mo, d, h, mi, s] = value.jcal.match(/\d+/g).map(Number);
  return wallOf(y, mo, d, h, mi, s);
}
var pad3 = (n, width = 2) => String(n).padStart(width, "0");
var wallText2 = (wall) => {
  const f = fieldsOf(wall);
  return `${pad3(f.year, 4)}-${pad3(f.month)}-${pad3(f.day)}T${pad3(f.hour)}:${pad3(f.minute)}:${pad3(f.second)}`;
};
function rootOf(source) {
  if (typeof source === "string") {
    try {
      return new ICAL6.Component(ICAL6.parse(source));
    } catch (error) {
      throw new UpdateFieldsError(
        "INVALID_ICALENDAR",
        `Failed to parse iCal data: ${error.message}`,
        { remedy: "rewrite-object", cause: error }
      );
    }
  }
  let root = source;
  while (root.parent) {
    root = root.parent;
  }
  return new ICAL6.Component(root.toJSON());
}
function converter(tzid, zone2, source) {
  return {
    tzid,
    source,
    offsetAt: (instant) => zone2.offsetAt(instantOf2(instant)),
    toWallTime: (instant) => wallText2(zone2.fromUtc(instantOf2(instant))),
    toInstant: (wallTime) => new Date(zone2.toUtc(wallOfText(wallTime)) * 1e3),
    ambiguity: (wallTime) => zone2.ambiguity(wallOfText(wallTime))
  };
}
function resolveZone(tzid, source) {
  if (typeof tzid !== "string" || !tzid) {
    return null;
  }
  if (source !== void 0) {
    const root = rootOf(source);
    const vtimezone = root.name === "vtimezone" ? root.getFirstPropertyValue("tzid") === tzid ? root : null : vtimezoneIn(root, tzid);
    if (vtimezone) {
      return converter(tzid, vtimezoneZone(vtimezone), "vtimezone");
    }
  }
  const name = ianaZoneName(tzid);
  const zone2 = name ? ianaZone(name) : null;
  return zone2 ? converter(name, zone2, "iana") : null;
}
function resolvePropertyZone(property) {
  const tzid = property.getParameter("tzid");
  if (typeof tzid !== "string" || !tzid) {
    return null;
  }
  return resolveZone(tzid, property.parent ?? void 0);
}

// src/expand.ts
import ICAL7 from "ical.js";
function createRecurrenceBudget(units = WORK_BUDGET) {
  if (!Number.isFinite(units) || units < 0) {
    throw new UpdateFieldsError(
      "INVALID_INPUT",
      `a recurrence budget is a non-negative number of units, not ${units}`,
      { remedy: "fix-value" }
    );
  }
  return { remaining: units };
}
function boundIn(master, frame, bound, label) {
  let utc = null;
  let wall;
  if (bound instanceof Date) {
    if (Number.isNaN(bound.getTime())) {
      throw new UpdateFieldsError("INVALID_VALUE", `${label} is an invalid Date`, { remedy: "fix-value" });
    }
    utc = Math.floor(bound.getTime() / 1e3);
    wall = utc;
  } else {
    let value;
    try {
      value = parseDateValue(bound);
    } catch (error) {
      throw wrapped(error, `${label}: ${error.message}`);
    }
    const [y, mo, d, h, mi, s] = value.jcal.match(/\d+/g).map(Number);
    wall = wallOf(y, mo, d, h ?? 0, mi ?? 0, s ?? 0);
    utc = value.kind === "utc" ? wall : null;
  }
  if (utc !== null && frame.form === "tzid") {
    const zone2 = zoneOf(master, frame.tzid);
    if (!zone2) {
      throw new UpdateFieldsError("UNKNOWN_TZID", `the series' zone "${frame.tzid}" has no VTIMEZONE in the object and is no IANA time zone`, { remedy: "rewrite-object" });
    }
    return zone2.fromUtc(utc);
  }
  return wall;
}
function timeIn(master, wall, kind, tzid) {
  const value = jcalOf(wall, kind === "tzid" ? "floating" : kind);
  let instant = null;
  if (kind === "utc") {
    instant = wall;
  } else if (kind === "tzid" && tzid) {
    instant = zoneOf(master, tzid)?.toUtc(wall) ?? null;
  }
  return { value, tzid: kind === "tzid" ? tzid : null, instant: instant === null ? null : new Date(instant * 1e3).toISOString() };
}
var frameKind = (frame) => frame.form;
var frameTzid = (frame) => frame.form === "tzid" ? frame.tzid : null;
function ownTime(master, property) {
  const [stamp] = propertyStamps(property);
  return timeIn(master, stamp.wall, stamp.kind, stamp.tzid ?? null);
}
function endOf(master, frame, startWall) {
  const dtstart = master.getFirstProperty("dtstart");
  const [start] = propertyStamps(dtstart);
  for (const name of ["dtend", "due"]) {
    const property = master.getFirstProperty(name);
    if (property) {
      const [end] = propertyStamps(property);
      const length2 = wallIn(master, end, frame) - start.wall;
      const wall = startWall + length2;
      if (end.kind === "tzid" && frame.form === "tzid" && end.tzid !== frame.tzid) {
        const instant = zoneOf(master, frame.tzid).toUtc(wall);
        const own = zoneOf(master, end.tzid);
        return own ? timeIn(master, own.fromUtc(instant), "tzid", end.tzid) : null;
      }
      return timeIn(master, wall, frameKind(frame), frameTzid(frame));
    }
  }
  const length = durationOf(master);
  return length === null ? null : timeIn(master, startWall + length, frameKind(frame), frameTzid(frame));
}
function durationOf(component) {
  const duration = component.getFirstPropertyValue("duration");
  if (!duration || typeof duration.toSeconds !== "function") {
    return null;
  }
  const days = (duration.weeks ?? 0) * 7 + (duration.days ?? 0);
  const seconds = (duration.hours ?? 0) * 3600 + (duration.minutes ?? 0) * 60 + (duration.seconds ?? 0);
  return (duration.isNegative ? -1 : 1) * (days * 86400 + seconds);
}
function overrideEnd(master, frame, override, start) {
  const own = override.getFirstProperty("dtend") ?? override.getFirstProperty("due");
  if (own) {
    return ownTime(master, own);
  }
  let length = durationOf(override);
  if (length === null) {
    const dtstart = master.getFirstProperty("dtstart");
    const end = master.getFirstProperty("dtend") ?? master.getFirstProperty("due");
    length = end ? wallIn(master, propertyStamps(end)[0], frame) - propertyStamps(dtstart)[0].wall : durationOf(master);
  }
  return length === null ? null : timeIn(master, start.wall + length, start.kind, start.tzid ?? null);
}
function expandOccurrences(calendarObject, options) {
  const { budget, until } = options ?? {};
  if (!budget || typeof budget.remaining !== "number") {
    throw new UpdateFieldsError(
      "INVALID_INPUT",
      "expandOccurrences needs options.budget (see createRecurrenceBudget)",
      { remedy: "fix-value" }
    );
  }
  const limit = options.limit ?? 1e3;
  if (!Number.isInteger(limit) || limit < 0) {
    throw new UpdateFieldsError(
      "INVALID_INPUT",
      `options.limit must be a non-negative integer, not ${limit}`,
      { remedy: "fix-value" }
    );
  }
  let root;
  if (calendarObject && typeof calendarObject.toJSON === "function" && typeof calendarObject.getAllSubcomponents === "function") {
    root = new ICAL7.Component(calendarObject.toJSON());
  } else {
    const text = typeof calendarObject === "string" ? calendarObject : calendarObject?.data;
    if (typeof text !== "string") {
      throw new UpdateFieldsError("INVALID_INPUT", 'expandOccurrences takes iCalendar text, an object with "data", or an ICAL.Component', { remedy: "fix-value" });
    }
    try {
      root = new ICAL7.Component(ICAL7.parse(text));
    } catch (error) {
      throw new UpdateFieldsError(
        "INVALID_ICALENDAR",
        `Failed to parse iCal data: ${error.message}`,
        { remedy: "rewrite-object", cause: error }
      );
    }
  }
  const master = root.name === "vcalendar" ? seriesMaster(root, options.type) : root;
  const frame = frameOf(master);
  if (!frame) {
    return { occurrences: [], complete: true, stoppedBy: null };
  }
  const norm = (wall) => frame.form === "date" ? dayOf(wall) : wall;
  const end = boundIn(master, frame, until, "until");
  const start = options.from === void 0 ? -Infinity : boundIn(master, frame, options.from, "from");
  let found;
  const zoned = frame.form === "utc" || frame.form === "tzid";
  const excludedInstants = /* @__PURE__ */ new Set();
  const excludedDays = /* @__PURE__ */ new Set();
  const excludedWalls = /* @__PURE__ */ new Set();
  const excluded = (wall) => excludedDays.has(dayOf(wall)) || (zoned ? excludedInstants.has(occurrenceInstant(master, wall, frame)) : excludedWalls.has(wall));
  const overrides = /* @__PURE__ */ new Map();
  try {
    found = expandWalls(master, end - 1, budget);
    for (const stamp of master.getAllProperties("exdate").filter((p) => p.type !== "period").flatMap(propertyStamps)) {
      if (frame.form === "date") {
        excludedDays.add(dayOf(wallIn(master, stamp, frame)));
      } else if (stamp.kind === "date") {
        excludedDays.add(dayOf(stamp.wall));
      } else if (zoned) {
        const instant = instantOf(master, stamp, frame);
        if (instant !== null) {
          excludedInstants.add(instant);
        }
      } else if (stamp.kind === "floating") {
        excludedWalls.add(stamp.wall);
      }
    }
    const uid = master.getFirstPropertyValue("uid");
    for (const c of root.name === "vcalendar" ? root.getAllSubcomponents(master.name) : []) {
      const rid = c.getFirstProperty("recurrence-id");
      if (c !== master && rid && c.getFirstPropertyValue("uid") === uid) {
        overrides.set(norm(wallIn(master, propertyStamps(rid)[0], frame)), c);
      }
    }
  } catch (error) {
    if (error instanceof SeriesUnverifiable) {
      throw error.source instanceof UpdateFieldsError ? error.source : wrapped(error.source ?? error, `the series cannot be expanded: ${error.message}`);
    }
    throw error;
  }
  const occurrences2 = [];
  let limited = false;
  for (const wall of [...found.walls].sort((a, b) => a - b)) {
    if (wall < norm(start) || excluded(wall)) {
      continue;
    }
    if (occurrences2.length === limit) {
      limited = true;
      break;
    }
    const override = overrides.get(wall);
    const recurrenceId = timeIn(master, wall, frameKind(frame), frameTzid(frame));
    if (override) {
      const own = override.getFirstProperty("dtstart");
      const start2 = own ? propertyStamps(own)[0] : { wall, kind: frameKind(frame), ...frame.form === "tzid" ? { tzid: frame.tzid } : {} };
      occurrences2.push({
        recurrenceId,
        start: own ? ownTime(master, own) : recurrenceId,
        end: overrideEnd(master, frame, override, start2),
        overridden: true
      });
    } else {
      occurrences2.push({ recurrenceId, start: recurrenceId, end: endOf(master, frame, wall), overridden: false });
    }
  }
  const complete = found.complete && !limited;
  return { occurrences: occurrences2, complete, stoppedBy: complete ? null : !found.complete ? "budget" : "limit" };
}
export {
  UPDATE_FIELDS_ERROR_CODES,
  UpdateFieldsError,
  cancelOccurrences,
  createRecurrenceBudget,
  expandOccurrences,
  generateVtimezone,
  isUpdateFieldsError,
  parseDateValue,
  resolvePropertyZone,
  resolveZone,
  restoreOccurrences,
  seriesMaster,
  updateFields
};
