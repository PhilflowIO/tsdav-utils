// src/updateFields.ts
import ICAL from "ical.js";
function updateFields(calendarObject, fields) {
  const icalString = typeof calendarObject === "string" ? calendarObject : calendarObject.data;
  if (!icalString) {
    throw new Error('Invalid input: calendarObject must be a string or object with "data" field');
  }
  let jcalData;
  let component;
  try {
    jcalData = ICAL.parse(icalString);
    component = new ICAL.Component(jcalData);
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
export {
  updateFields
};
