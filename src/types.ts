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

/**
 * How a date-time without a zone ("2026-10-26T18:00:00") is written.
 * - "keep": as a floating time, which RFC 5545 3.3.5 allows (default)
 * - "local": read in the host timezone and written as UTC
 */
export type FloatingTime = 'keep' | 'local';

export interface UpdateFieldsOptions {
  floatingTime?: FloatingTime;
}
