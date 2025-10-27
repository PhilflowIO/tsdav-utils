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
  updateFields: () => updateFields
});
module.exports = __toCommonJS(index_exports);

// src/updateFields.ts
var import_ical = __toESM(require("ical.js"));
function updateFields(calendarObject, fields) {
  const icalString = typeof calendarObject === "string" ? calendarObject : calendarObject.data;
  if (!icalString) {
    throw new Error('Invalid input: calendarObject must be a string or object with "data" field');
  }
  let jcalData;
  let component;
  try {
    jcalData = import_ical.default.parse(icalString);
    component = new import_ical.default.Component(jcalData);
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
  for (const [key, value] of Object.entries(fields)) {
    actualComponent.updatePropertyWithValue(key.toLowerCase(), value);
  }
  return component.toString();
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  updateFields
});
