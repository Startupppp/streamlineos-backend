import { z } from "zod";
import { RRule } from "rrule";

export function isValidRrule(value: string): boolean {
  try {
    RRule.fromString(value);
    return true;
  } catch {
    return false;
  }
}

export const upsertOccurrenceExceptionSchema = z.object({
  modifiedTitle: z.string().min(2).max(100).optional(),
  modifiedStart: z.string().datetime().optional(),
  modifiedEnd: z.string().datetime().optional(),
}).strict().refine(
  (v) => {
    if (v.modifiedStart !== undefined && v.modifiedEnd !== undefined) {
      return new Date(v.modifiedEnd) > new Date(v.modifiedStart);
    }
    return true;
  },
  { message: "modifiedEnd must be after modifiedStart", path: ["modifiedEnd"] },
);

export type UpsertOccurrenceExceptionInput = z.infer<typeof upsertOccurrenceExceptionSchema>;
