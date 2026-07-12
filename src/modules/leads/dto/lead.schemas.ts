import { z } from "zod";

const LEAD_SORTABLE = ["name", "email", "company", "status", "priority", "source", "score", "potentialValue", "createdAt"] as const;

export const listSchema = z.object({
  status: z.string().optional(),
  priority: z.string().optional(),
  source: z.string().optional(),
  assignedToId: z.string().optional(),
  search: z.string().optional(),
  sortBy: z.enum(LEAD_SORTABLE).optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
  page: z.coerce.number().min(1).optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
});

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
});

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
});

export const ingestSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  company: z.string().optional(),
  source: z.string().optional(),
  notes: z.string().optional(),
});

export type ListInput = z.infer<typeof listSchema>;
export type CreateInput = z.infer<typeof createSchema>;
export type UpdateInput = z.infer<typeof updateSchema>;
export type IngestInput = z.infer<typeof ingestSchema>;
