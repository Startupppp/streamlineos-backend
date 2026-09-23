import { z } from "zod";

export const DECIMAL_STRING_PATTERN = /^\d+(\.\d{1,2})?$/;

export const decimalString = z
  .string()
  .trim()
  .regex(DECIMAL_STRING_PATTERN, "Must be a valid decimal number");

export const optionalDecimalString = z.preprocess((value) => {
  if (value === null) return undefined;
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}, decimalString.optional());

export const optionalNonEmptyString = z.preprocess((value) => {
  if (value === null) return undefined;
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}, z.string().optional());
