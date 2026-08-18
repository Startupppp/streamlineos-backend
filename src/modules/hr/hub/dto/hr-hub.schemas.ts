import { z } from "zod";

function isCalendarDate(value: string): boolean {
  const [year, month, day] = value.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) return false;

  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

export const hrHubQuerySchema = z
  .object({
    today: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD format")
      .refine(isCalendarDate, "Enter a valid calendar date"),
  })
  .strict();

export type HrHubQuery = z.infer<typeof hrHubQuerySchema>;
