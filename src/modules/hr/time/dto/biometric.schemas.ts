import { z } from "zod";

export const createDeviceSchema = z.object({
  name: z.string().min(1).max(100),
  ipAddress: z.string().min(1).max(45),
  port: z.number().int().positive().optional(),
  vendor: z.string().max(100).optional(),
  location: z.string().max(200).optional(),
});

export const updateDeviceSchema = createDeviceSchema.partial();

export type CreateDeviceInput = z.infer<typeof createDeviceSchema>;
export type UpdateDeviceInput = z.infer<typeof updateDeviceSchema>;
