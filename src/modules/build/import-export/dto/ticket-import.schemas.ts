import { z } from "zod";
import { refineDueOnOrAfterStart } from "../../core";

export const TICKET_IMPORT_FIELDS = [
  "title",
  "description",
  "type",
  "status",
  "priority",
  "startDate",
  "dueDate",
  "points",
  "storyPoints",
  "estimate",
  "completionPercentage",
  "clientVisible",
  "link",
] as const;

const NUMBER_FIELDS = new Set<string>([
  "points",
  "storyPoints",
  "estimate",
  "completionPercentage",
]);

const BOOLEAN_FIELDS = new Set<string>(["clientVisible"]);

const TRUE_LITERALS = new Set(["true", "yes", "y", "1"]);

const BOOLEAN_LITERALS = new Set(["true", "yes", "y", "1", "false", "no", "n", "0"]);

function isRealCalendarDate(value: string): boolean {
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a date formatted YYYY-MM-DD")
  .refine(isRealCalendarDate, "Not a real calendar date");

export const ticketImportRowSchema = z
  .object({
    title: z
      .string({ error: "Title is required" })
      .trim()
      .min(1, "Title is required")
      .min(3, "Title must be at least 3 characters")
      .max(500)
      .refine((value) => /[a-zA-Z0-9]/.test(value), {
        message: "Title must contain at least one letter or number",
      }),
    description: z.string().max(10_000).nullable().optional(),
    type: z.enum(["EPIC", "STORY", "TASK", "BUG"]).optional(),
    status: z.string().trim().min(1).max(100).optional(),
    priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
    startDate: isoDate.nullable().optional(),
    dueDate: isoDate.nullable().optional(),
    points: z.number().int().min(0).max(1000).nullable().optional(),
    storyPoints: z.number().int().min(0).max(1000).nullable().optional(),
    estimate: z.number().int().min(0).max(100_000).nullable().optional(),
    completionPercentage: z.number().int().min(0).max(100).optional(),
    clientVisible: z.boolean().optional(),
    link: z.string().url().max(2000).nullable().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    refineDueOnOrAfterStart(data, ctx);
  });

export type TicketImportRow = z.infer<typeof ticketImportRowSchema>;

interface FieldCoercionError {
  field: string;
  message: string;
}

export interface CoercedRow {
  values: Record<string, unknown>;
  errors: FieldCoercionError[];
}

export function coerceImportValues(raw: Record<string, unknown>): CoercedRow {
  const values: Record<string, unknown> = {};
  const errors: FieldCoercionError[] = [];

  for (const [field, original] of Object.entries(raw)) {
    const value = typeof original === "string" ? original.trim() : original;
    if (value === "" || value === undefined) continue;

    if (NUMBER_FIELDS.has(field) && typeof value === "string") {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        errors.push({ field, message: `"${value}" is not a number` });
        continue;
      }
      values[field] = parsed;
      continue;
    }

    if (BOOLEAN_FIELDS.has(field) && typeof value === "string") {
      const literal = value.toLowerCase();
      if (!BOOLEAN_LITERALS.has(literal)) {
        errors.push({ field, message: `"${value}" is not true or false` });
        continue;
      }
      values[field] = TRUE_LITERALS.has(literal);
      continue;
    }

    values[field] = value;
  }

  return { values, errors };
}

export function issueField(issue: z.core.$ZodIssue): string | null {
  if (issue.code === "unrecognized_keys") return issue.keys[0] ?? null;
  const [head] = issue.path;
  return typeof head === "string" ? head : null;
}

export function issueMessage(issue: z.core.$ZodIssue): string {
  if (issue.code === "unrecognized_keys")
    return `"${issue.keys.join('", "')}" is not an importable field`;
  return issue.message;
}
