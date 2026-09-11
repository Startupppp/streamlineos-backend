import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

const nodeStatus = z.enum(["ACTIVE", "DISABLED", "ARCHIVED"]);
const code = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{2,20}$/, "Code must be 2–20 uppercase alphanumeric characters");

const orgNodeName = z
  .string()
  .trim()
  .min(1, "Name is required")
  .max(100)
  .refine((v) => /[\p{L}\p{N}]/u.test(v), {
    message: "Name must contain at least one letter or number",
  });

const optionalOrgNodeName = orgNodeName.optional();

export const createBusinessUnitSchema = z
  .object({
    name: orgNodeName,
    code,
    description: z.string().trim().max(500).optional(),
  })
  .strict();

export type CreateBusinessUnitInput = z.infer<typeof createBusinessUnitSchema>;

export const updateBusinessUnitSchema = z
  .object({
    name: optionalOrgNodeName,
    code: code.optional(),
    description: z.string().trim().max(500).optional().nullable(),
    status: nodeStatus.optional(),
  })
  .strict();

export type UpdateBusinessUnitInput = z.infer<typeof updateBusinessUnitSchema>;

export const createOrgBranchSchema = z
  .object({
    name: orgNodeName,
    code,
    businessUnitId: z.string().uuid().optional(),
    managerUserId: z.string().optional(),
    address: z.string().trim().max(500).optional(),
    city: z.string().trim().max(100).optional(),
    state: z.string().trim().max(100).optional(),
    country: z.string().trim().max(100).optional(),
    postalCode: z.string().trim().max(20).optional(),
    phone: z.string().trim().max(30).optional(),
    email: z.string().email().optional().or(z.literal("")),
  })
  .strict();

export type CreateOrgBranchInput = z.infer<typeof createOrgBranchSchema>;

export const updateOrgBranchSchema = z
  .object({
    name: optionalOrgNodeName,
    code: code.optional(),
    businessUnitId: z.string().uuid().optional().nullable(),
    managerUserId: z.string().optional().nullable(),
    address: z.string().trim().max(500).optional().nullable(),
    city: z.string().trim().max(100).optional().nullable(),
    state: z.string().trim().max(100).optional().nullable(),
    country: z.string().trim().max(100).optional().nullable(),
    postalCode: z.string().trim().max(20).optional().nullable(),
    phone: z.string().trim().max(30).optional().nullable(),
    email: z.string().email().or(z.literal("")).optional().nullable(),
    status: nodeStatus.optional(),
  })
  .strict();

export type UpdateOrgBranchInput = z.infer<typeof updateOrgBranchSchema>;

export const createOrgDepartmentSchema = z
  .object({
    name: orgNodeName,
    code,
    branchId: z.string().uuid().optional(),
    headUserId: z.string().optional(),
    description: z.string().trim().max(500).optional(),
  })
  .strict();

export type CreateOrgDepartmentInput = z.infer<typeof createOrgDepartmentSchema>;

export const updateOrgDepartmentSchema = z
  .object({
    name: optionalOrgNodeName,
    code: code.optional(),
    branchId: z.string().uuid().optional().nullable(),
    headUserId: z.string().optional().nullable(),
    description: z.string().trim().max(500).optional().nullable(),
    status: nodeStatus.optional(),
  })
  .strict();

export type UpdateOrgDepartmentInput = z.infer<typeof updateOrgDepartmentSchema>;

export const createOrgTeamSchema = z
  .object({
    name: orgNodeName,
    code,
    departmentId: z.string().uuid(),
    leadUserId: z.string().optional(),
    description: z.string().trim().max(500).optional(),
    capacity: z.number().int().min(1).max(9999).optional(),
  })
  .strict();

export type CreateOrgTeamInput = z.infer<typeof createOrgTeamSchema>;

export const updateOrgTeamSchema = z
  .object({
    name: optionalOrgNodeName,
    code: code.optional(),
    departmentId: z.string().uuid().optional(),
    leadUserId: z.string().optional().nullable(),
    description: z.string().trim().max(500).optional().nullable(),
    capacity: z.number().int().min(1).max(9999).optional().nullable(),
    status: nodeStatus.optional(),
  })
  .strict();

export type UpdateOrgTeamInput = z.infer<typeof updateOrgTeamSchema>;

export const createOrgLocationSchema = z
  .object({
    name: orgNodeName,
    type: z.enum(["OFFICE", "WAREHOUSE", "STORE", "FACTORY", "REMOTE"]).default("OFFICE"),
    address: z.string().trim().max(500).optional(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
  })
  .strict();

export type CreateOrgLocationInput = z.infer<typeof createOrgLocationSchema>;

export const updateOrgLocationSchema = z
  .object({
    name: optionalOrgNodeName,
    type: z.enum(["OFFICE", "WAREHOUSE", "STORE", "FACTORY", "REMOTE"]).optional(),
    address: z.string().trim().max(500).optional().nullable(),
    latitude: z.number().min(-90).max(90).optional().nullable(),
    longitude: z.number().min(-180).max(180).optional().nullable(),
    status: nodeStatus.optional(),
  })
  .strict();

export type UpdateOrgLocationInput = z.infer<typeof updateOrgLocationSchema>;

export const createCostCenterSchema = z
  .object({
    code,
    name: orgNodeName,
    description: z.string().trim().max(500).optional(),
  })
  .strict();

export type CreateCostCenterInput = z.infer<typeof createCostCenterSchema>;

export const updateCostCenterSchema = z
  .object({
    code: code.optional(),
    name: optionalOrgNodeName,
    description: z.string().trim().max(500).optional().nullable(),
    status: nodeStatus.optional(),
  })
  .strict();

export type UpdateCostCenterInput = z.infer<typeof updateCostCenterSchema>;

export const listQuerySchema = z
  .object({
    cursor: z.string().min(1).max(2048).optional(),
    limit: pageSizeField(20),
    search: z.string().trim().optional(),
    status: z
      .enum(["ACTIVE", "DISABLED", "ARCHIVED", "CURRENT"])
      .optional(),
  })
  .strict();

export type ListQueryInput = z.infer<typeof listQuerySchema>;

// `status` is omitted, not defaulted: the options read pins ACTIVE, so a holder of `branch:view` cannot widen a dropdown into the archived units the settings surface owns.
export const branchOptionsQuerySchema = listQuerySchema
  .omit({ status: true })
  .strict();

export type BranchOptionsQueryInput = z.infer<typeof branchOptionsQuerySchema>;

export const dependencyPreviewParamsSchema = z
  .object({
    unitKind: z.enum([
      "BUSINESS_UNIT",
      "BRANCH",
      "DEPARTMENT",
      "TEAM",
      "LOCATION",
      "COST_CENTER",
    ]),
    unitId: z.string().uuid(),
  })
  .strict();

export type DependencyPreviewParamsInput = z.infer<
  typeof dependencyPreviewParamsSchema
>;

