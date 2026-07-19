import { z } from "zod";

const ipAddressSchema = z
  .string()
  .trim()
  .min(1, "IP address is required")
  .regex(
    /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/,
    "Enter a valid IPv4 address (e.g. 192.168.1.10)",
  );

const deviceNameSchema = z
  .string()
  .trim()
  .min(1, "Device name is required")
  .max(150, "Device name must be at most 150 characters");

export const createBiometricDeviceSchema = z.object({
  name: deviceNameSchema,
  ipAddress: ipAddressSchema,
  port: z.coerce.number().int().min(1).max(65535).optional(),
  vendor: z.string().trim().max(100, "Vendor must be at most 100 characters").optional(),
  location: z.string().trim().max(200, "Location must be at most 200 characters").optional(),
});

export const updateBiometricDeviceSchema = z.object({
  name: deviceNameSchema.optional(),
  ipAddress: ipAddressSchema.optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  vendor: z.string().trim().max(100, "Vendor must be at most 100 characters").optional(),
  location: z.string().trim().max(200, "Location must be at most 200 characters").optional(),
});

export type CreateBiometricDeviceInput = z.infer<typeof createBiometricDeviceSchema>;
export type UpdateBiometricDeviceInput = z.infer<typeof updateBiometricDeviceSchema>;
