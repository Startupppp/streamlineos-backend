import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../../common/pagination/list-query.schema";

const paginationSchema = z.object({
  page: pageNumberField,
  limit: pageSizeField(20, 100),
});

const cursorListFields = {
  cursor: z.string().trim().min(1).max(2048).optional(),
  limit: pageSizeField(20),
};

export const listPeopleSchema = z
  .object({
    ...cursorListFields,
    search: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export const listEmploymentsSchema = z
  .object(cursorListFields)
  .strict();

export const createPersonSchema = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().max(100).default(""),
  workEmail: z.string().email(),
  personalEmail: z.string().email().optional(),
  phone: z.string().optional(),
  dateOfBirth: z.string().optional(),
  gender: z.string().optional(),
  nationality: z.string().optional(),
  address: z.object({
    line1: z.string().optional(),
    line2: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    country: z.string().optional(),
    postalCode: z.string().optional(),
  }).optional(),
  emergencyContact: z.object({
    name: z.string().optional(),
    relationship: z.string().optional(),
    phone: z.string().optional(),
  }).optional(),
  avatarUrl: z.string().url().optional(),
});

export const updatePersonSchema = createPersonSchema.partial();

export const createEmploymentSchema = z.object({
  personId: z.number().int().positive(),
  employeeNumber: z.string().min(1).max(50),
  lifecycleStatus: z.enum([
    "CANDIDATE", "PRE_JOINING", "ONBOARDING", "ACTIVE", "PROBATION",
    "CONFIRMED", "NOTICE", "EXITED", "ALUMNI", "SUSPENDED",
  ]).default("ACTIVE"),
  workerType: z.enum([
    "FULL_TIME", "PART_TIME", "CONTRACTOR", "CONSULTANT",
    "INTERN", "TEMPORARY", "AGENCY", "FREELANCER",
  ]).default("FULL_TIME"),
  departmentId: z.string().uuid().optional(),
  jobRoleId: z.number().int().positive().optional(),
  jobLevelId: z.number().int().positive().optional(),
  employmentTypeId: z.number().int().positive().optional(),
  locationId: z.string().uuid().optional(),
  designation: z.string().max(200).optional(),
  joiningDate: z.string().optional(),
  probationEndDate: z.string().optional(),
});

export const updateEmploymentSchema = createEmploymentSchema.partial().omit({ personId: true });

export const transitionStatusSchema = z.object({
  toStatus: z.enum([
    "CANDIDATE", "PRE_JOINING", "ONBOARDING", "ACTIVE", "PROBATION",
    "CONFIRMED", "NOTICE", "EXITED", "ALUMNI", "SUSPENDED",
  ]),
  reason: z.string().max(500).optional(),
  notes: z.string().max(2000).optional(),
  effectiveDate: z.string().optional(),
});

const businessDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const effectiveChangeBaseSchema = z.object({
  employmentId: z.number().int().positive(),
  effectiveFrom: businessDateSchema,
  effectiveTo: businessDateSchema.optional(),
  notes: z.string().max(2000).optional(),
});

export const createEffectiveDateChangeSchema = z
  .discriminatedUnion("changeType", [
    effectiveChangeBaseSchema.extend({
      changeType: z.literal("department"),
      newValue: z.object({ departmentId: z.string().uuid() }).strict(),
    }),
    effectiveChangeBaseSchema.extend({
      changeType: z.literal("manager"),
      newValue: z.object({ managerEmploymentId: z.number().int().positive() }).strict(),
    }),
    effectiveChangeBaseSchema.extend({
      changeType: z.literal("location"),
      newValue: z.object({ locationId: z.string().uuid() }).strict(),
    }),
    effectiveChangeBaseSchema.extend({
      changeType: z.literal("designation"),
      newValue: z.object({ designation: z.string().trim().min(1).max(200) }).strict(),
    }),
    effectiveChangeBaseSchema.extend({
      changeType: z.literal("job_level"),
      newValue: z.object({ jobLevelId: z.number().int().positive() }).strict(),
    }),
    effectiveChangeBaseSchema.extend({
      changeType: z.literal("compensation"),
      newValue: z.object({ salaryCents: z.number().int().min(0) }).strict(),
    }),
  ])
  .superRefine((value, context) => {
    if (value.effectiveTo && value.effectiveTo <= value.effectiveFrom) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["effectiveTo"],
        message: "Effective end date must be after the start date",
      });
    }
  });

export const listEffectiveDateChangesSchema = z.object({
  cursor: z.string().trim().min(1).max(2048).optional(),
  limit: pageSizeField(20, 100),
  employmentId: z.coerce.number().int().positive().optional(),
  changeType: z.enum([
    "department", "manager", "location", "designation", "job_level",
    "employment_type", "compensation", "work_schedule", "policy_assignment",
  ]).optional(),
  status: z.enum(["draft", "approved", "applied"]).optional(),
}).strict();

export const applyDueChangesSchema = z
  .object({
    asOfDate: businessDateSchema.optional(),
    limit: pageSizeField(50),
  })
  .strict();

export const listTimelineSchema = z
  .object({
    cursor: z.string().trim().min(1).max(2048).optional(),
    limit: pageSizeField(20),
  })
  .strict();

export const updateSensitiveSchema = z.object({
  salaryAmountCents: z.number().int().min(0).optional(),
  salaryCurrency: z.string().max(3).optional(),
  salaryFrequency: z.string().optional(),
  bankDetails: z.object({
    accountNumber: z.string().optional(),
    bankName: z.string().optional(),
    branch: z.string().optional(),
    ifsc: z.string().optional(),
    swift: z.string().optional(),
    accountHolder: z.string().optional(),
    pfUanNumber: z
      .string()
      .regex(/^\d{12}$/, "UAN must be 12 digits")
      .optional()
      .or(z.literal("")),
    esiIpNumber: z.string().max(20).optional().or(z.literal("")),
    iban: z.string().optional(),
    routingNumber: z.string().optional(),
  }).optional(),
  taxId: z.string().optional(),
  panNumber: z.string().optional(),
  nationalId: z.string().optional(),
  passportNumber: z.string().optional(),
  passportExpiry: z.string().optional(),
  visaType: z.string().optional(),
  visaExpiry: z.string().optional(),
  medicalNotes: z.string().optional(),
  bloodGroup: z.string().optional(),
  bgvStatus: z.string().optional(),
});

export const listAuditLogsSchema = z.object({
  entityType: z.string().optional(),
  entityId: z.string().optional(),
  actorId: z.string().optional(),
  action: z.string().optional(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
  cursor: z.string().min(1).optional(),
  limit: pageSizeField(20, 100),
});

export const historyTypeSchema = z.object({
  type: z.enum(["manager", "department"]),
  cursor: z.string().trim().min(1).max(2048).optional(),
  limit: pageSizeField(20, 100),
}).strict();

export type CreatePersonInput = z.infer<typeof createPersonSchema>;
export type UpdatePersonInput = z.infer<typeof updatePersonSchema>;
export type ListPeopleInput = z.infer<typeof listPeopleSchema>;
export type CreateEmploymentInput = z.infer<typeof createEmploymentSchema>;
export type UpdateEmploymentInput = z.infer<typeof updateEmploymentSchema>;
export type ListEmploymentsInput = z.infer<typeof listEmploymentsSchema>;
export type TransitionStatusInput = z.infer<typeof transitionStatusSchema>;
export type CreateEffectiveDateChangeInput = z.infer<typeof createEffectiveDateChangeSchema>;
export type ListEffectiveDateChangesInput = z.infer<typeof listEffectiveDateChangesSchema>;
export type ApplyDueChangesInput = z.infer<typeof applyDueChangesSchema>;
export type ListTimelineInput = z.infer<typeof listTimelineSchema>;
export type UpdateSensitiveInput = z.infer<typeof updateSensitiveSchema>;
export type ListAuditLogsInput = z.infer<typeof listAuditLogsSchema>;
export type HistoryTypeInput = z.infer<typeof historyTypeSchema>;
