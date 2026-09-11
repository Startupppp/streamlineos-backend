import { z } from "zod";

export const createZoneSchema = z.object({
  name: z.string().min(1).max(100),
  lat: z.string().min(1),
  lng: z.string().min(1),
  radiusMeters: z.number().int().positive().optional(),
});

export const updateZoneSchema = createZoneSchema.partial();

export type CreateZoneInput = z.infer<typeof createZoneSchema>;
export type UpdateZoneInput = z.infer<typeof updateZoneSchema>;
