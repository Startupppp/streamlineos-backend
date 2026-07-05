import { z } from "zod";

export const createCalendarEventSchema = z.object({
  type: z.string(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  title: z.string().min(1).max(200),
  month: z.string().optional(),
});

export const patchCalendarEventSchema = createCalendarEventSchema.partial();

export const accountingMappingCreateSchema = z.object({
  componentId: z.number().int().optional(),
  category: z.string().optional(),
  ledgerName: z.string().min(1),
  costCenterSource: z.string().optional(),
  notes: z.string().optional(),
}).superRefine((data, ctx) => {
  const hasComponent = data.componentId !== undefined;
  const hasCategory = data.category !== undefined;
  if (hasComponent === hasCategory) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Exactly one of componentId or category must be provided",
      path: [],
    });
  }
});

export const accountingMappingUpdateSchema = z.object({
  componentId: z.number().int().nullable().optional(),
  category: z.string().nullable().optional(),
  ledgerName: z.string().min(1).optional(),
  costCenterSource: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

export const essBankSchema = z.object({
  accountNumber: z.string().min(8).max(34),
  bankName: z.string().min(1).max(100),
  branch: z.string().min(1).max(100),
  ifsc: z.string().max(50).optional(),
  code: z.string().max(50).optional(),
  accountHolder: z.string().min(1).max(100),
  accountHolderName: z.string().max(100).optional(),
  pfUanNumber: z.string().max(30).optional(),
  bankCountry: z.string().length(2).toUpperCase().optional(),
}).superRefine((data, ctx) => {
  const effectiveCode = data.code ?? data.ifsc ?? "";
  if (!effectiveCode) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Bank code (IFSC / routing / sort code / IBAN) is required",
      path: ["code"],
    });
  }
});

export type CreateCalendarEvent = z.infer<typeof createCalendarEventSchema>;
export type PatchCalendarEvent = z.infer<typeof patchCalendarEventSchema>;
export type AccountingMappingCreate = z.infer<typeof accountingMappingCreateSchema>;
export type AccountingMappingUpdate = z.infer<typeof accountingMappingUpdateSchema>;
export type EssBank = z.output<typeof essBankSchema>;
