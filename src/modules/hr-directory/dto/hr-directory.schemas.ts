import { z } from "zod";

export const listEmployeesSchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  search: z.string().optional(),
  q: z.string().optional(),
});

export const availabilitySchema = z.object({
  userIds: z.string().optional(),
});

export const findExpertSchema = z.object({
  skill: z.string().min(1),
  department: z.string().optional(),
  role: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const headcountSchema = z.object({
  groupBy: z.enum(["department", "role", "branch"]).default("department"),
});

export const createTeamEventSchema = z
  .object({
    title: z.string().min(2).max(200),
    description: z.string().max(2000).optional(),
    type: z
      .enum(["TEAM_BUILDING", "OFFSITE", "CELEBRATION", "WORKSHOP", "SPORTS", "OTHER"])
      .optional()
      .default("TEAM_BUILDING"),
    date: z.string().optional(),
    startDate: z.string().optional(),
    time: z.string().optional(),
    location: z.string().max(200).optional(),
    maxParticipants: z.number().int().positive().optional(),
  })
  .refine((d) => !!(d.date || d.startDate), { message: "Event date is required" });

export const createAssetReturnSchema = z.object({
  userId: z.string().min(1),
  assetId: z.number().int().positive().optional(),
  assetName: z.string().min(1, "Asset name is required"),
  notes: z.string().optional(),
});

export const patchAssetReturnSchema = z.object({
  status: z.enum(["RETURNED", "DAMAGED", "LOST"]).default("RETURNED"),
  condition: z.string().optional(),
  notes: z.string().optional(),
});

export const createDeviceSchema = z.object({
  userId: z.string().min(1, "Employee is required"),
  deviceType: z.string().min(1, "Device type is required"),
  deviceName: z
    .string()
    .min(2, "Device name must be at least 2 characters")
    .max(100, "Device name is too long")
    .refine((v) => v === v.trim(), "Device name must not have leading or trailing spaces")
    .refine((v) => !/\s{2,}/.test(v), "Device name cannot have consecutive spaces")
    .refine((v) => /[a-zA-Z]/.test(v), "Device name must contain at least one letter"),
  serialNumber: z
    .string()
    .min(3, "Serial number must be at least 3 characters")
    .max(100, "Serial number is too long")
    .refine((v) => /[a-zA-Z0-9]/.test(v.trim()), "Serial number must contain alphanumeric characters"),
  brand: z
    .string()
    .min(1, "Brand is required")
    .max(100, "Brand is too long")
    .refine((v) => /[a-zA-Z]/.test(v.trim()), "Brand must contain at least one letter"),
  model: z.string().min(1, "Model is required").max(100, "Model is too long"),
  notes: z.string().max(500).optional(),
  assignedDate: z.string().optional(),
});

export const patchDeviceSchema = z.object({
  userId: z.string().optional(),
  deviceType: z.string().optional(),
  deviceName: z.string().optional(),
  serialNumber: z.string().optional(),
  brand: z.string().optional(),
  model: z.string().optional(),
  notes: z.string().optional(),
  status: z.enum(["ACTIVE", "INACTIVE", "LOST", "RETURNED"]).optional(),
  returnDate: z.string().optional(),
});

export const createAssetSchema = z.object({
  name: z
    .string()
    .min(2, "Asset name must be at least 2 characters")
    .max(100, "Asset name is too long")
    .refine((v) => v === v.trim(), "Asset name must not have leading or trailing spaces")
    .refine((v) => !/\s{2,}/.test(v), "Asset name cannot have consecutive spaces")
    .refine((v) => /[a-zA-Z]/.test(v), "Asset name must contain at least one letter")
    .refine((v) => !/^[\d\s]+$/.test(v), "Asset name cannot be numeric only")
    .refine(
      (v) => !/[!@#$%^&*()\-_=+\[\]{};:'",.<>?/\\|`~]{2,}/.test(v),
      "Asset name cannot contain multiple consecutive special characters",
    ),
  type: z.string().min(1, "Type is required"),
  brand: z
    .string()
    .min(1, "Brand is required")
    .max(100, "Brand is too long")
    .refine((v) => /[a-zA-Z]/.test(v.trim()), "Brand must contain at least one letter"),
  model: z.string().min(1, "Model is required").max(100, "Model is too long"),
  serialNumber: z
    .string()
    .min(3, "Serial number must be at least 3 characters")
    .max(100, "Serial number is too long")
    .refine((v) => /[a-zA-Z0-9]/.test(v.trim()), "Serial number must contain alphanumeric characters"),
  purchaseDate: z.string().optional(),
  purchaseCost: z.number().optional(),
  location: z.string().optional(),
  notes: z.string().max(500).optional(),
});

export const assignAssetSchema = z.object({
  assetId: z.number(),
  assignedTo: z.string().nullable(),
});

export const patchAssetSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  type: z.string().min(1).optional(),
  brand: z.string().min(1).max(100).optional(),
  model: z.string().min(1).max(100).optional(),
  serialNumber: z.string().min(3).max(100).optional(),
  assignedTo: z.string().nullable().optional(),
  status: z.enum(["AVAILABLE", "ASSIGNED", "MAINTENANCE", "RETIRED"]).optional(),
  purchaseDate: z.string().optional(),
  purchaseCost: z.number().optional(),
  location: z.string().optional(),
  notes: z.string().optional(),
});

export const createBgvSchema = z.object({
  userId: z.string().min(1),
  type: z.string().min(1, "Verification type is required"),
  provider: z.string().optional(),
  referenceNumber: z.string().optional(),
  notes: z.string().max(1000).optional(),
});

export const updateBgvSchema = z.object({
  id: z.number().int().positive(),
  status: z.enum(["PENDING", "IN_PROGRESS", "PASSED", "FAILED"]).optional(),
  result: z.string().max(500).optional(),
  notes: z.string().max(1000).optional(),
});

export type ListEmployeesInput = z.infer<typeof listEmployeesSchema>;
export type AvailabilityInput = z.infer<typeof availabilitySchema>;
export type FindExpertInput = z.infer<typeof findExpertSchema>;
export type HeadcountInput = z.infer<typeof headcountSchema>;
export type CreateTeamEventInput = z.infer<typeof createTeamEventSchema>;
export type CreateAssetReturnInput = z.infer<typeof createAssetReturnSchema>;
export type PatchAssetReturnInput = z.infer<typeof patchAssetReturnSchema>;
export type CreateDeviceInput = z.infer<typeof createDeviceSchema>;
export type PatchDeviceInput = z.infer<typeof patchDeviceSchema>;
export type CreateBgvInput = z.infer<typeof createBgvSchema>;
export type UpdateBgvInput = z.infer<typeof updateBgvSchema>;
export type CreateAssetInput = z.infer<typeof createAssetSchema>;
export type AssignAssetInput = z.infer<typeof assignAssetSchema>;
export type PatchAssetInput = z.infer<typeof patchAssetSchema>;
