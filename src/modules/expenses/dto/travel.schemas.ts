import { z } from "zod";

const MONEY_RE = /^\d+(\.\d{1,2})?$/;
const MAX_MONEY = 999_999_999.99;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Purpose/destination: require real text, not symbol-only junk like (*^*( */
const TEXT_CHARS_RE = /^[\p{L}\p{N}\s'.,&\-()/:;#+]+$/u;
const CONSECUTIVE_SPECIAL_RE = /[^\p{L}\p{N}\s]{2,}/u;

function hasLetterOrDigit(value: string): boolean {
  return /[\p{L}\p{N}]/u.test(value);
}

function isMeaningfulTravelText(value: string): boolean {
  const trimmed = value.trim().replace(/\s+/g, " ");
  return (
    trimmed.length >= 2 &&
    hasLetterOrDigit(trimmed) &&
    TEXT_CHARS_RE.test(trimmed) &&
    !CONSECUTIVE_SPECIAL_RE.test(trimmed)
  );
}

const optionalMoneySchema = z
  .string()
  .optional()
  .transform((v) => {
    const t = v?.trim();
    return t ? t : undefined;
  })
  .superRefine((v, ctx) => {
    if (v === undefined) return;
    if (!MONEY_RE.test(v)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Enter a valid amount (e.g. 100 or 100.50)",
      });
      return;
    }
    if (Number(v) > MAX_MONEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Amount cannot exceed 999,999,999.99",
      });
    }
  });

const meaningfulText = (field: string, max: number) =>
  z
    .string()
    .trim()
    .min(1, `${field} is required`)
    .max(max, `${field} must be at most ${max} characters`)
    .refine(isMeaningfulTravelText, {
      message: `${field} must include letters or numbers and cannot be only special characters`,
    });

export const createTravelRequestSchema = z
  .object({
    purpose: meaningfulText("Purpose", 500),
    destination: meaningfulText("Destination", 255),
    departureDate: z
      .string()
      .min(1, "Departure date is required")
      .regex(DATE_RE, "Invalid departure date"),
    returnDate: z
      .string()
      .min(1, "Return date is required")
      .regex(DATE_RE, "Invalid return date"),
    flightRequired: z.boolean().default(false),
    hotelRequired: z.boolean().default(false),
    advanceRequired: z.boolean().default(false),
    advanceAmount: optionalMoneySchema,
    estimatedCost: optionalMoneySchema,
    perDiem: optionalMoneySchema,
    itinerary: z
      .array(
        z.object({
          date: z.string().min(1).regex(DATE_RE, "Invalid itinerary date"),
          activity: z.string().trim().min(1).max(500),
          location: z.string().trim().min(1).max(255),
        }),
      )
      .default([]),
  })
  .superRefine((data, ctx) => {
    if (data.departureDate && data.returnDate && data.returnDate < data.departureDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Return date must be on or after departure date",
        path: ["returnDate"],
      });
    }
  });

export const rejectTravelRequestSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
});

export type CreateTravelRequestInput = z.infer<typeof createTravelRequestSchema>;
export type RejectTravelRequestInput = z.infer<typeof rejectTravelRequestSchema>;
