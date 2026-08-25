import { z } from "zod";

const partyTypeValues = ["CUSTOMER", "VENDOR", "PARTNER", "BOTH"] as const;

export const listPartiesQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
  role: z.string().trim().min(1).optional(),
  partyType: z.enum(partyTypeValues).optional(),
  search: z.string().optional(),
});

export const createPartySchema = z.object({
  name: z.string().min(1).max(255),
  partyType: z.enum(partyTypeValues).optional(),
  legalName: z.string().max(255).optional(),
  displayName: z.string().max(255).optional(),
  taxNumber: z.string().max(100).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(50).optional(),
  website: z.string().url().optional(),
  notes: z.string().optional(),
});

export const updatePartySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  partyType: z.enum(partyTypeValues).optional(),
  legalName: z.string().max(255).nullish(),
  displayName: z.string().max(255).nullish(),
  taxNumber: z.string().max(100).nullish(),
  email: z.string().email().nullish(),
  phone: z.string().max(50).nullish(),
  website: z.string().url().nullish(),
  notes: z.string().nullish(),
  status: z.string().max(50).optional(),
});

export const createContactSchema = z.object({
  partyId: z.string().uuid(),
  firstName: z.string().min(1).max(255),
  lastName: z.string().max(255).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(50).optional(),
  title: z.string().max(255).optional(),
  isPrimary: z.boolean().optional(),
});

export const updateContactSchema = z.object({
  firstName: z.string().min(1).max(255).optional(),
  lastName: z.string().max(255).nullish(),
  email: z.string().email().nullish(),
  phone: z.string().max(50).nullish(),
  title: z.string().max(255).nullish(),
  isPrimary: z.boolean().optional(),
});

export type ListPartiesQuery = z.infer<typeof listPartiesQuerySchema>;
export type CreatePartyInput = z.infer<typeof createPartySchema>;
export type UpdatePartyInput = z.infer<typeof updatePartySchema>;
export type CreateContactInput = z.infer<typeof createContactSchema>;
export type UpdateContactInput = z.infer<typeof updateContactSchema>;
