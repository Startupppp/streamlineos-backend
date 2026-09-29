import { z } from "zod";

const CALENDAR_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

export const calendarDate = z
  .string()
  .trim()
  .regex(CALENDAR_DATE_RE, "Date must be an ISO calendar date (YYYY-MM-DD)");

export const optionalCalendarDate = z
  .literal("")
  .or(calendarDate)
  .optional()
  .transform((v) => (v === "" ? undefined : v));

export const clearableCalendarDate = z
  .literal("")
  .or(calendarDate)
  .nullable()
  .optional()
  .transform((v) => (v === "" ? null : v));

export const instant = z
  .string()
  .trim()
  .regex(INSTANT_RE, "Must be an ISO date or date-time");

export const optionalInstant = z
  .literal("")
  .or(instant)
  .optional()
  .transform((v) => (v === "" ? undefined : v));

export const clearableInstant = z
  .literal("")
  .or(instant)
  .nullable()
  .optional()
  .transform((v) => (v === "" ? null : v));
