import { z } from "zod";

export const listVendorsSchema = z.object({
  search: z.string().trim().max(200).optional(),
  isActive: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListVendorsInput = z.infer<typeof listVendorsSchema>;

export const createVendorSchema = z.object({
  name: z.string().trim().min(1).max(255),
  code: z.string().trim().min(1).max(50),
  clientId: z.number().int().positive().optional(),
  email: z.string().email().optional(),
  phone: z.string().trim().max(30).optional(),
  address: z.string().trim().max(500).optional(),
  gstin: z.string().trim().max(20).optional(),
  leadTimeDays: z.number().int().min(0).default(7),
  paymentTermsDays: z.number().int().min(0).default(30),
  currency: z.string().length(3).default("INR"),
  notes: z.string().trim().max(2000).optional(),
});
export type CreateVendorInput = z.infer<typeof createVendorSchema>;

export const updateVendorSchema = createVendorSchema.partial();
export type UpdateVendorInput = z.infer<typeof updateVendorSchema>;
