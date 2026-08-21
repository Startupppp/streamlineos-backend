import { z } from "zod";

export const listPeopleQuerySchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
}).strict();

export const createPersonSchema = z.object({
  firstName: z.string().min(1).max(255),
  lastName: z.string().min(1).max(255),
  workEmail: z.string().email().optional(),
  personalEmail: z.string().email().optional(),
  phone: z.string().max(50).optional(),
  userId: z.string().uuid().optional(),
  organizationMembershipId: z.coerce.number().int().positive().optional(),
});

export const updatePersonSchema = z.object({
  firstName: z.string().min(1).max(255).optional(),
  lastName: z.string().min(1).max(255).optional(),
  displayName: z.string().max(255).nullish(),
  preferredName: z.string().max(255).nullish(),
  workEmail: z.string().email().nullish(),
  personalEmail: z.string().email().nullish(),
  phone: z.string().max(50).nullish(),
  whatsappNumber: z.string().max(50).nullish(),
  avatarUrl: z.string().url().nullish(),
  dateOfBirth: z.string().date().nullish(),
  gender: z.string().max(50).nullish(),
  nationality: z.string().max(100).nullish(),
  timezone: z.string().max(100).nullish(),
  languageCode: z.string().max(10).nullish(),
  linkedinUrl: z.string().url().nullish(),
  githubUrl: z.string().url().nullish(),
  bio: z.string().nullish(),
  userId: z.string().uuid().nullish(),
  organizationMembershipId: z.coerce.number().int().positive().nullish(),
});

export type ListPeopleQuery = z.infer<typeof listPeopleQuerySchema>;
export type CreatePersonInput = z.infer<typeof createPersonSchema>;
export type UpdatePersonInput = z.infer<typeof updatePersonSchema>;

const workerStatusValues = ["ACTIVE", "INACTIVE", "EXITED"] as const;
const workerTypeValues = [
  "FULL_TIME",
  "PART_TIME",
  "CONTRACTOR",
  "CONSULTANT",
  "INTERN",
  "TEMPORARY",
  "AGENCY",
  "FREELANCER",
] as const;

export const listWorkersQuerySchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(workerStatusValues).optional(),
  search: z.string().optional(),
  organizationPersonId: z.string().uuid().optional(),
}).strict();

export const createWorkerSchema = z
  .object({
    organizationPersonId: z.string().uuid().optional(),
    memberUserId: z.string().trim().min(1).max(128).optional(),
    workerNumber: z.string().max(100).optional(),
    isPayee: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    const subjectCount = Number(Boolean(value.organizationPersonId)) +
      Number(Boolean(value.memberUserId));
    if (subjectCount !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["organizationPersonId"],
        message: "Select exactly one person or organization member",
      });
    }
  });

export const createEngagementSchema = z
  .object({
    workerId: z.string().uuid(),
    startsOn: z.string().date(),
    endsOn: z.string().date().optional(),
    workerType: z.enum(workerTypeValues),
    isPrimary: z.boolean().optional(),
    designation: z.string().max(255).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.endsOn && value.endsOn <= value.startsOn) {
      context.addIssue({
        code: "custom",
        path: ["endsOn"],
        message: "End date must be after the start date",
      });
    }
  });

export const updateEngagementSchema = z.object({
  expectedVersion: z.coerce.number().int().positive(),
  startsOn: z.string().date().optional(),
  endsOn: z.string().date().nullish(),
  workerType: z.enum(workerTypeValues).optional(),
  isPrimary: z.boolean().optional(),
  designation: z.string().max(255).nullish(),
  departmentId: z.string().uuid().nullish(),
  businessUnitId: z.string().uuid().nullish(),
  branchId: z.string().uuid().nullish(),
  locationId: z.string().uuid().nullish(),
  teamId: z.string().uuid().nullish(),
  managerEngagementId: z.string().uuid().nullish(),
  jobRoleId: z.coerce.number().int().positive().nullish(),
  jobLevelId: z.coerce.number().int().positive().nullish(),
  employmentTypeId: z.coerce.number().int().positive().nullish(),
  probationEndsOn: z.string().date().nullish(),
  noticePeriodDays: z.coerce.number().int().min(0).nullish(),
}).strict();

export const terminateEngagementSchema = z.object({
  expectedVersion: z.coerce.number().int().positive(),
  terminationReason: z.string().max(500).optional(),
  terminationNotes: z.string().optional(),
  endsOn: z.string().date().optional(),
}).strict();

export type ListWorkersQuery = z.infer<typeof listWorkersQuerySchema>;
export type CreateWorkerInput = z.infer<typeof createWorkerSchema>;
export type CreateEngagementInput = z.infer<typeof createEngagementSchema>;
export type UpdateEngagementInput = z.infer<typeof updateEngagementSchema>;
export type TerminateEngagementInput = z.infer<typeof terminateEngagementSchema>;
