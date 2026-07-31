import { z } from "zod";

const latSchema = z
  .string()
  .trim()
  .regex(/^-?\d{1,3}(\.\d{1,7})?$/, "Enter a valid latitude")
  .refine((v) => Number(v) >= -90 && Number(v) <= 90, "Latitude must be between -90 and 90");

const lngSchema = z
  .string()
  .trim()
  .regex(/^-?\d{1,3}(\.\d{1,7})?$/, "Enter a valid longitude")
  .refine((v) => Number(v) >= -180 && Number(v) <= 180, "Longitude must be between -180 and 180");

const nameSchema = z
  .string()
  .trim()
  .min(1, "Geofence name is required")
  .max(150, "Geofence name must be at most 150 characters");

export const createGeofenceSchema = z.object({
  name: nameSchema,
  lat: latSchema,
  lng: lngSchema,
  radiusMeters: z.coerce.number().int().min(10, "Radius must be at least 10 meters").max(50_000, "Radius must be at most 50,000 meters").optional(),
});

export const updateGeofenceSchema = z.object({
  name: nameSchema.optional(),
  lat: latSchema.optional(),
  lng: lngSchema.optional(),
  radiusMeters: z.coerce.number().int().min(10, "Radius must be at least 10 meters").max(50_000, "Radius must be at most 50,000 meters").optional(),
  isActive: z.boolean().optional(),
});

export type CreateGeofenceInput = z.infer<typeof createGeofenceSchema>;
export type UpdateGeofenceInput = z.infer<typeof updateGeofenceSchema>;
