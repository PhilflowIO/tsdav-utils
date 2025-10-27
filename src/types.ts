/**
 * Generic field update map
 * Any iCal property name → any string value
 */
export interface FieldUpdates {
  [key: string]: string;
}

/**
 * Calendar object input (flexible)
 * Accepts tsdav output format or raw iCal string
 */
export type CalendarObjectInput = string | {
  data: string;
  [key: string]: any; // Allow other tsdav properties
};
