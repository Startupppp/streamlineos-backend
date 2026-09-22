import { z } from "zod";

function coordinate(limit: number) {
  return z
    .string()
    .trim()
    .min(1)
    .refine((value) => Number.isFinite(Number(value)), { message: "Coordinate must be a number", abort: true })
    .refine((value) => Math.abs(Number(value)) <= limit, { message: `Coordinate must be between -${limit} and ${limit}` });
}

export const createZoneSchema = z.object({
  name: z.string().min(1).max(100),
  lat: coordinate(90),
  lng: coordinate(180),
  radiusMeters: z.number().int().positive().optional(),
});

export const updateZoneSchema = createZoneSchema.partial();

export type CreateZoneInput = z.infer<typeof createZoneSchema>;
export type UpdateZoneInput = z.infer<typeof updateZoneSchema>;
