import { z } from "zod";

export const listSchema = z.object({
  search: z.string().optional(),
  source: z.string().optional(),
  organizationId: z.coerce.number().optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
  offset: z.coerce.number().min(0).optional(),
});

export const searchSchema = z.object({
  q: z.string().min(2).max(100),
});

export const createSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().optional(),
  title: z.string().optional(),
  department: z.string().optional(),
  company: z.string().optional(),
  organizationId: z.number().optional(),
  linkedinUrl: z.string().optional(),
  twitterUrl: z.string().optional(),
  websiteUrl: z.string().optional(),
  leadId: z.number().optional(),
  dealId: z.number().optional(),
  tags: z.array(z.string()).default([]),
});

export const updateSchema = z.object({
  name: z.string().optional(),
  email: z.string().email().nullable().optional(),
  phone: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  department: z.string().nullable().optional(),
  company: z.string().nullable().optional(),
  organizationId: z.number().nullable().optional(),
  linkedinUrl: z.string().nullable().optional(),
  twitterUrl: z.string().nullable().optional(),
  websiteUrl: z.string().nullable().optional(),
  avatarUrl: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  leadId: z.number().nullable().optional(),
  dealId: z.number().nullable().optional(),
});

export type ListInput = z.infer<typeof listSchema>;
export type SearchInput = z.infer<typeof searchSchema>;
export type CreateInput = z.infer<typeof createSchema>;
export type UpdateInput = z.infer<typeof updateSchema>;
