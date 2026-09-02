import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../../common/pagination/list-query.schema";
import { queryBoolean } from "../../../../common/validation/query-boolean";

export const listVendorsSchema = z.object({
  search: z.string().trim().max(200).optional(),
  isActive: queryBoolean.optional(),
  page: pageNumberField,
  limit: pageSizeField(50, 100),
}).strict();
export type ListVendorsInput = z.infer<typeof listVendorsSchema>;

export const createVendorSchema = z.object({
  name: z.string().trim().min(1).max(255),
  code: z.string().trim().min(1).max(50).optional(),
  clientId: z.number().int().positive().optional(),
  email: z.string().email().optional(),
  phone: z.string().trim().max(30).optional(),
  address: z.string().trim().max(500).optional(),
  gstin: z.string().trim().max(20).optional(),
  leadTimeDays: z.number().int().min(0).default(7),
  paymentTermsDays: z.number().int().min(0).default(30),
  currency: z.string().length(3).default("INR"),
  notes: z.string().trim().max(2000).optional(),
}).strict();
export type CreateVendorInput = z.infer<typeof createVendorSchema>;

export const updateVendorSchema = createVendorSchema.partial().extend({
  isActive: z.boolean().optional(),
}).strict();
export type UpdateVendorInput = z.infer<typeof updateVendorSchema>;
