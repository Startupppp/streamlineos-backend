import { z } from "zod";
import { optionalPageSizeField } from "../../../common/pagination/list-query.schema";

const LEAD_SORTABLE = ["name", "email", "company", "status", "priority", "source", "score", "potentialValue", "createdAt"] as const;

export const listSchema = z.object({
  status: z.string().optional(),
  priority: z.string().optional(),
  source: z.string().optional(),
  assignedToId: z.string().optional(),
  search: z.string().optional(),
  sortBy: z.enum(LEAD_SORTABLE).optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
  cursor: z.string().optional(),
  limit: optionalPageSizeField(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
}).strict();

export const createSchema = z.object({
  name: z.string().min(1),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().optional(),
  whatsappNumber: z.string().optional(),
  source: z.string().default("other"),
  campaignId: z.number().optional(),
  investmentInterest: z.string().optional(),
  potentialValue: z.string().optional(),
  notes: z.string().optional(),
  company: z.string().optional(),
  designation: z.string().optional(),
  city: z.string().optional(),
  referredBy: z.string().optional(),
  tags: z.array(z.string()).optional(),
  assignedToId: z.string().optional(),
  priority: z.string().default("WARM"),
}).strict();

export const LEAD_QUALIFICATION_FIELD = "bantQualification";

export const leadQualificationSchema = z.object({
  budget: z.boolean(),
  authority: z.boolean(),
  need: z.boolean(),
  timeline: z.boolean(),
  notes: z.string().max(5000),
}).strict();

export const updateSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().optional(),
  whatsappNumber: z.string().optional(),
  source: z.string().optional(),
  campaignId: z.number().optional(),
  investmentInterest: z.string().optional(),
  potentialValue: z.string().optional(),
  notes: z.string().optional(),
  company: z.string().optional(),
  designation: z.string().optional(),
  city: z.string().optional(),
  tags: z.array(z.string()).optional(),
  lostReason: z.string().optional(),
  priority: z.string().optional(),
  qualification: leadQualificationSchema.optional(),
}).strict();

export const ingestSchema = z
  .object({
    name: z.string().min(1).optional(),
    email: z.string().email().optional(),
    phone: z.string().optional(),
    company: z.string().optional(),
    source: z.string().optional(),
    notes: z.string().optional(),
  }).strict()
  .superRefine((d, ctx) => {
    if (!d.name && !d.email && !d.phone)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "At least one of name, email, or phone is required" });
  });

export type ListInput = z.infer<typeof listSchema>;
export type CreateInput = z.infer<typeof createSchema>;
export type UpdateInput = z.infer<typeof updateSchema>;
export type LeadQualification = z.infer<typeof leadQualificationSchema>;
export type IngestInput = z.infer<typeof ingestSchema>;
