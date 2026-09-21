import { z } from "zod";
import { genderEnum } from "../../../../db/schema";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";
import { canonicalEmailSchema } from "../../../users/dto/users.schemas";

function isSuppliedOrParseableDate(value: string | undefined): boolean {
  if (!value) return true;
  return !Number.isNaN(new Date(value).getTime());
}

export const listEmployeesSchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: pageSizeField(20, 100),
  search: z.string().optional(),
  q: z.string().optional(),
  departmentId: z.string().min(1).optional(),
  /** "true" | "false" | "all" — default active-only for directory */
  isActive: z.enum(["true", "false", "all"]).optional().default("true"),
  /** Org/job role on the user record (e.g. ENGINEERING, HR). Omit for all roles. */
  role: z.string().min(1).max(64).optional(),
}).strict();

export const availabilitySchema = z.object({
  userIds: z.string().optional(),
}).strict();

export const findExpertSchema = z.object({
  skill: z.string().min(1),
  department: z.string().optional(),
  role: z.string().optional(),
  limit: pageSizeField(20, 50),
}).strict();

export const skillsMatrixQuerySchema = z
  .object({
    cursor: z.string().min(1).max(2048).optional(),
    limit: pageSizeField(20, 50),
  })
  .strict();

export const headcountSchema = z.object({
  groupBy: z.enum(["department", "role", "branch"]).default("department"),
}).strict();

export const orgChartQuerySchema = z
  .object({
    parentId: z.string().min(1).max(128).optional(),
    search: z.string().trim().min(2).max(100).optional(),
    cursor: z.string().min(1).max(2048).optional(),
    limit: pageSizeField(20, 50),
  })
  .strict()
  .superRefine((query, ctx) => {
    if (query.parentId && query.search) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "parentId and search cannot be combined",
        path: ["search"],
      });
    }
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
  }).strict()
  .refine((d) => !!(d.date || d.startDate), { message: "Event date is required" });

export const ASSET_RETURN_CONDITIONS = ["Good", "Fair", "Poor"] as const;

export const createAssetReturnSchema = z.object({
  userId: z.string().min(1),
  assetId: z.number().int().positive().optional(),
  assetName: z.string().min(1, "Asset name is required"),
  condition: z.enum(ASSET_RETURN_CONDITIONS).optional(),
  notes: z.string().trim().max(1000, "Notes must be at most 1000 characters").optional(),
}).strict();

export const patchAssetReturnSchema = z.object({
  status: z.enum(["RETURNED", "DAMAGED", "LOST"]).default("RETURNED"),
  condition: z.enum(ASSET_RETURN_CONDITIONS).optional(),
  notes: z.string().trim().max(500).optional(),
}).strict();

export const createDeviceSchema = z.object({
  userId: z.string().min(1, "Employee is required"),
  deviceType: z.string().min(1, "Device type is required"),
  deviceName: z
    .string()
    .trim()
    .min(1, "Device name is required")
    .max(100, "Device name is too long"),
  serialNumber: z
    .string()
    .trim()
    .min(1, "Serial number is required")
    .max(100, "Serial number is too long"),
  brand: z.string().trim().min(1, "Brand is required").max(100, "Brand is too long"),
  model: z.string().trim().min(1, "Model is required").max(100, "Model is too long"),
  notes: z.string().max(500).optional(),
  assignedDate: z.string().optional(),
}).strict();

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
}).strict();

export const listAssetsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(20, 100),
  status: z.enum(["AVAILABLE", "ASSIGNED", "MAINTENANCE", "RETIRED"]).optional(),
}).strict();

export const createAssetSchema = z.object({
  name: z.string().trim().min(1, "Asset name is required").max(100, "Asset name is too long"),
  type: z.string().min(1, "Type is required"),
  brand: z.string().trim().min(1, "Brand is required").max(100, "Brand is too long"),
  model: z.string().trim().min(1, "Model is required").max(100, "Model is too long"),
  serialNumber: z.string().trim().min(1, "Serial number is required").max(100, "Serial number is too long"),
  purchaseDate: z.string().optional(),
  purchaseCost: z.number().optional(),
  location: z.string().optional(),
  notes: z.string().max(500).optional(),
}).strict();

export const assignAssetSchema = z.object({
  assetId: z.number(),
  assignedTo: z.string().nullable(),
}).strict();

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
}).strict();

export const createBgvSchema = z.object({
  userId: z.string().min(1, "Employee is required"),
  type: z.string().min(1, "Verification type is required"),
  provider: z
    .string()
    .max(200, "Provider name must be 200 characters or fewer")
    .refine((v) => v.trim().length > 0, "Provider name cannot be blank")
    .optional(),
  referenceNumber: z
    .string()
    .max(100, "Reference number must be 100 characters or fewer")
    .refine((v) => v.trim().length > 0, "Reference number cannot be blank")
    .refine(
      (v) => /^[a-zA-Z0-9_/-]+$/.test(v.trim()),
      "Reference number may only contain letters, digits, hyphens, underscores, and forward slashes",
    )
    .optional(),
  notes: z.string().max(1000, "Notes must be 1000 characters or fewer").optional(),
}).strict();

const TERMINAL_BGV_STATUSES = ["PASSED", "FAILED"] as const;

export const updateBgvSchema = z
  .object({
    id: z.number().int().positive(),
    status: z.enum(["PENDING", "IN_PROGRESS", "PASSED", "FAILED"]).optional(),
    result: z
      .string()
      .max(500, "Result must be 500 characters or fewer")
      .refine((v) => v.trim().length > 0, "Result cannot be blank")
      .optional(),
    notes: z.string().max(1000, "Notes must be 1000 characters or fewer").optional(),
  }).strict()
  .superRefine((data, ctx) => {
    if (
      data.status !== undefined &&
      (TERMINAL_BGV_STATUSES as readonly string[]).includes(data.status) &&
      (!data.result || data.result.trim().length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["result"],
        message: "Result is required when setting status to Passed or Failed",
      });
    }
  });

const MIN_AGE_MS = 16 * 365.25 * 24 * 60 * 60 * 1000;

export const updateEmployeeSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    firstName: z.string().trim().min(1).max(100).optional(),
    lastName: z.string().trim().min(1).max(100).optional(),
    designation: z.string().max(200).optional(),
    departmentId: z.string().optional(),
    phone: z.string().optional(),
    image: z.string().optional(),
    isActive: z.boolean().optional(),
    gender: z.enum(genderEnum.enumValues).optional(),
    skills: z.array(z.string()).optional(),
    bio: z.string().max(500).optional(),
    linkedinUrl: z.string().url().optional().or(z.literal("")),
    twitterUrl: z.string().url().optional().or(z.literal("")),
    githubUrl: z.string().url().optional().or(z.literal("")),
    websiteUrl: z.string().url().optional().or(z.literal("")),
    joiningDate: z
      .string()
      .optional()
      .refine(isSuppliedOrParseableDate, "Joining date must be a valid date"),
    reportingTo: z.string().nullable().optional(),
  })
  .strict();

const REPORTS_TO_REQUIRED_MESSAGE =
  "Reports to is required. Choose a reporting manager, or mark the role as top-level with a reason.";

function requireReportsTo(
  value: { reportingManagerUserId?: string; reportingManagerEmail?: string; topLevelRole?: boolean; topLevelRoleReason?: string },
  ctx: z.RefinementCtx,
): void {
  const hasManager = Boolean(value.reportingManagerUserId || value.reportingManagerEmail);
  if (hasManager && value.topLevelRole) {
    ctx.addIssue({
      code: "custom",
      message: "A top-level role cannot also have a reporting manager.",
      path: ["topLevelRole"],
    });
    return;
  }
  if (!hasManager && !value.topLevelRole) {
    ctx.addIssue({ code: "custom", message: REPORTS_TO_REQUIRED_MESSAGE, path: ["reportingManagerUserId"] });
    return;
  }
  if (value.topLevelRole && !value.topLevelRoleReason?.trim()) {
    ctx.addIssue({
      code: "custom",
      message: "Explain why this role has no reporting manager.",
      path: ["topLevelRoleReason"],
    });
  }
}

export const onboardEmployeeFieldsSchema = z.object({
  reportingManagerUserId: z.string().trim().min(1).max(128).optional(),
  topLevelRole: z.boolean().optional(),
  topLevelRoleReason: z.string().trim().max(500).optional(),
  firstName: z
    .string()
    .trim()
    .min(1, "First name is required")
    .max(100, "First name must be at most 100 characters"),
  lastName: z
    .string()
    .trim()
    .min(1, "Last name is required")
    .max(100, "Last name must be at most 100 characters"),
  email: canonicalEmailSchema,
  phone: z.string().optional(),
  whatsappSameAsPhone: z.boolean().optional(),
  whatsappNumber: z.string().optional(),
  gender: z.enum(genderEnum.enumValues).optional(),
  designation: z
    .string()
    .trim()
    .min(1, "Designation is required")
    .max(200, "Designation must be at most 200 characters"),
  departmentId: z.string().optional(),
  role: z.string().optional(),
  employeeId: z.string().optional(),
  attachToExistingMember: z.boolean().optional(),
  joiningDate: z
    .string()
    .optional()
    .refine(isSuppliedOrParseableDate, "Joining date must be a valid date"),
  dateOfBirth: z
    .string()
    .optional()
    .refine((val) => {
      if (!val) return true;
      const dob = new Date(val);
      return !isNaN(dob.getTime()) && dob < new Date();
    }, "Date of birth cannot be in the future")
    .refine((val) => {
      if (!val) return true;
      const dob = new Date(val);
      return !isNaN(dob.getTime()) && Date.now() - dob.getTime() >= MIN_AGE_MS;
    }, "Employee must be at least 16 years old"),
  taxId: z.string().optional(),
  monthlySalary: z.number().min(0, "Salary cannot be negative").max(9_999_999, "Salary exceeds maximum").optional(),
  salaryStructureTemplateId: z.number().int().positive().optional(),
  bankDetails: z
    .object({
      accountNumber: z.string().optional(),
      bankName: z.string().optional(),
      branch: z.string().optional(),
      ifsc: z.string().optional(),
      accountHolder: z.string().optional(),
      pfUanNumber: z
        .string()
        .regex(/^\d{12}$/, "UAN must be 12 digits")
        .optional()
        .or(z.literal("")),
      esiIpNumber: z
        .string()
        .max(20)
        .optional()
        .or(z.literal("")),
    })
    .optional(),
}).strict();

export const onboardEmployeeSchema = onboardEmployeeFieldsSchema.superRefine(requireReportsTo);

export const createAccessRequestSchema = z.object({
  employeeId: z.string().min(1, "Employee is required"),
  systemName: z.string().min(1, "System name is required").max(200),
  accessLevel: z.string().min(1, "Access level is required").max(100),
}).strict();

export const patchAccessRequestSchema = z.object({
  status: z.enum(["requested", "granted", "revoked"]),
  grantedBy: z.string().optional(),
}).strict();

export const listAccessRequestsQuerySchema = z.object({
  employeeId: z.string().min(1).max(128).optional(),
}).strict();

/** Row shape for spreadsheet bulk onboard — department can be an org department id or a name. */
export const bulkOnboardEmployeeRowSchema = onboardEmployeeFieldsSchema
  .omit({ attachToExistingMember: true })
  .extend({
    department: z.string().trim().min(1).optional(),
    reportingManagerEmail: canonicalEmailSchema.optional(),
  })
  .superRefine((row, ctx) => {
    if (row.departmentId == null && !row.department) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "department or departmentId is required",
        path: ["department"],
      });
    }
    requireReportsTo(row, ctx);
  });

export const bulkOnboardEmployeesSchema = z.object({
  employees: z
    .array(bulkOnboardEmployeeRowSchema)
    .min(1, "At least one employee is required")
    .max(100, "You can onboard at most 100 employees per upload"),
}).strict();

export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>;
export type OnboardEmployeeInput = z.infer<typeof onboardEmployeeSchema>;
export type BulkOnboardEmployeeRow = z.infer<typeof bulkOnboardEmployeeRowSchema>;
export type BulkOnboardEmployeesInput = z.infer<typeof bulkOnboardEmployeesSchema>;
export type ListEmployeesInput = z.infer<typeof listEmployeesSchema>;
export type AvailabilityInput = z.infer<typeof availabilitySchema>;
export type FindExpertInput = z.infer<typeof findExpertSchema>;
export type SkillsMatrixQueryInput = z.infer<typeof skillsMatrixQuerySchema>;
export type HeadcountInput = z.infer<typeof headcountSchema>;
export type OrgChartQueryInput = z.infer<typeof orgChartQuerySchema>;
export type CreateTeamEventInput = z.infer<typeof createTeamEventSchema>;
export type CreateAssetReturnInput = z.infer<typeof createAssetReturnSchema>;
export type PatchAssetReturnInput = z.infer<typeof patchAssetReturnSchema>;
export type CreateDeviceInput = z.infer<typeof createDeviceSchema>;
export type PatchDeviceInput = z.infer<typeof patchDeviceSchema>;
export type CreateBgvInput = z.infer<typeof createBgvSchema>;
export type UpdateBgvInput = z.infer<typeof updateBgvSchema>;
export type ListAssetsQueryInput = z.infer<typeof listAssetsQuerySchema>;
export type CreateAssetInput = z.infer<typeof createAssetSchema>;
export type AssignAssetInput = z.infer<typeof assignAssetSchema>;
export type PatchAssetInput = z.infer<typeof patchAssetSchema>;
export type CreateAccessRequestInput = z.infer<typeof createAccessRequestSchema>;
export type PatchAccessRequestInput = z.infer<typeof patchAccessRequestSchema>;
export type ListAccessRequestsQueryInput = z.infer<typeof listAccessRequestsQuerySchema>;

export const employeeUserQuerySchema = z.object({
  userId: z.string().min(1).optional(),
}).strict();
export type EmployeeUserQueryInput = z.infer<typeof employeeUserQuerySchema>;
