import { z } from "zod";

const customer360SectionSchema = z.object({
  items: z.array(z.unknown()),
  total: z.number().int(),
});

export const customer360Schema = z.object({
  contacts: customer360SectionSchema.optional(),
  leads: customer360SectionSchema.optional(),
  deals: customer360SectionSchema.optional(),
  quotes: customer360SectionSchema.optional(),
  invoices: customer360SectionSchema.optional(),
  payments: customer360SectionSchema.optional(),
  supportTickets: customer360SectionSchema.optional(),
  surveys: customer360SectionSchema.optional(),
  activities: customer360SectionSchema.optional(),
  projects: customer360SectionSchema.optional(),
  signedDocuments: customer360SectionSchema.optional(),
});

export const customer360TimelineSchema = z.object({
  items: z.array(z.unknown()),
  nextCursor: z.string().nullable(),
});
