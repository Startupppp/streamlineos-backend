import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { successSchema } from "../../../../common/openapi/response-envelopes";

export { successSchema };

export const auditLogRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  actorMembershipId: z.number().int().nullable(),
  entityType: z.string(),
  entityId: z.string(),
  action: z.string(),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: wireDate(),
});

export const auditLogPageSchema = z.object({
  data: z.array(auditLogRowSchema),
  pageInfo: z.object({ limit: z.number().int(), hasMore: z.boolean(), nextCursor: z.string().nullable() }),
});

export const hrFieldDefSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  entityType: z.string(),
  name: z.string(),
  key: z.string(),
  fieldType: z.string(),
  options: z.array(z.object({ label: z.string(), value: z.string() })).nullable(),
  settings: z.record(z.string(), z.unknown()).nullable(),
  isSensitive: z.boolean(),
  isRequired: z.boolean(),
  isActive: z.boolean(),
  displayOrder: z.number().int(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const customFieldEntityValuesSchema = z.array(
  z.object({
    definition: hrFieldDefSchema,
    value: z.unknown(),
  }),
);

export const customFieldFilterIdsSchema = z.object({ ids: z.array(z.number().int()) });

export const effectiveChangeRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  employmentId: z.number().int(),
  changeType: z.string(),
  oldValue: z.record(z.string(), z.unknown()).nullable(),
  newValue: z.record(z.string(), z.unknown()).nullable(),
  effectiveFrom: z.string(),
  effectiveTo: z.string(),
  status: z.string(),
  approvedByMembershipId: z.number().int().nullable(),
  approvedAt: nullableWireDate(),
  appliedAt: nullableWireDate(),
  notes: z.string().nullable(),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const effectiveChangePageSchema = z.object({
  data: z.array(effectiveChangeRowSchema),
  pagination: z.object({ limit: z.number().int(), hasMore: z.boolean(), nextCursor: z.string().nullable() }),
});

export const applyDueChangesResponseSchema = z.object({
  applied: z.number().int(),
  hasMore: z.boolean(),
});

export const orgLocationSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  name: z.string(),
  type: z.string(),
  address: z.string().nullable(),
  latitude: z.string().nullable(),
  longitude: z.string().nullable(),
  status: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
});

export const orgTeamSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  name: z.string(),
  code: z.string().nullable(),
  description: z.string().nullable(),
  status: z.string(),
  departmentId: z.string().nullable(),
  leadUserId: z.string().nullable(),
  capacity: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
  departmentName: z.string().nullable().optional(),
});

export const jobRoleRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  code: z.string().nullable(),
  description: z.string().nullable(),
  isActive: z.boolean(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const jobLevelRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  code: z.string().nullable(),
  grade: z.string().nullable(),
  rank: z.number().int(),
  description: z.string().nullable(),
  isActive: z.boolean(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const headcountItemSchema = z.object({
  groupId: z.union([z.string(), z.number().int()]).nullable(),
  groupName: z.string().nullable(),
  headcount: z.number().int(),
});

export const personRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userId: z.string().nullable(),
  organizationPersonId: z.string().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  workEmail: z.string().nullable(),
  phone: z.string().nullable(),
  gender: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const personListPageSchema = z.object({
  data: z.array(personRowSchema),
  pageInfo: z.object({ limit: z.number().int(), hasMore: z.boolean(), nextCursor: z.string().nullable() }),
});

export const backfillResponseSchema = z.object({
  createdPeople: z.number().int(),
  createdEmployments: z.number().int(),
  skipped: z.number().int(),
});

export const employmentRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  personId: z.number().int(),
  employeeNumber: z.string(),
  lifecycleStatus: z.string(),
  workerType: z.string(),
  departmentId: z.string().nullable(),
  jobRoleId: z.number().int().nullable(),
  jobLevelId: z.number().int().nullable(),
  employmentTypeId: z.number().int().nullable(),
  locationId: z.string().nullable(),
  designation: z.string().nullable(),
  joiningDate: z.string().nullable(),
  probationEndDate: z.string().nullable(),
  confirmationDate: z.string().nullable(),
  noticeStartDate: z.string().nullable(),
  expectedLastDay: z.string().nullable(),
  lastWorkingDay: z.string().nullable(),
  isPrimary: z.boolean(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const employmentListPageSchema = z.object({
  data: z.array(employmentRowSchema),
  pageInfo: z.object({ limit: z.number().int(), hasMore: z.boolean(), nextCursor: z.string().nullable() }),
});

export const employmentByUserIdSchema = z.object({
  id: z.number().int(),
  personId: z.number().int(),
  employeeNumber: z.string(),
  lifecycleStatus: z.string(),
  workerType: z.string(),
  departmentId: z.string().nullable(),
  designation: z.string().nullable(),
  joiningDate: z.string().nullable(),
  probationEndDate: z.string().nullable(),
  confirmationDate: z.string().nullable(),
  isPrimary: z.boolean(),
  personFirstName: z.string().nullable(),
  personLastName: z.string().nullable(),
  personWorkEmail: z.string().nullable(),
});

export const timelinePageSchema = z.object({
  data: z.array(z.record(z.string(), z.unknown())),
  pageInfo: z.object({ limit: z.number().int(), hasMore: z.boolean(), nextCursor: z.string().nullable() }),
});

export const effectiveChangeCursorPageSchema = z.object({
  data: z.array(effectiveChangeRowSchema),
  pagination: z.object({ limit: z.number().int(), hasMore: z.boolean(), nextCursor: z.string().nullable() }),
});

export const sensitiveRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  employmentId: z.number().int(),
  salaryAmountCents: z.number().nullable(),
  salaryCurrency: z.string().nullable(),
  salaryFrequency: z.string().nullable(),
  bankDetails: z.record(z.string(), z.unknown()).nullable(),
  taxId: z.string().nullable(),
  panNumber: z.string().nullable(),
  nationalId: z.string().nullable(),
  passportNumber: z.string().nullable(),
  passportExpiry: z.string().nullable(),
  visaType: z.string().nullable(),
  visaExpiry: z.string().nullable(),
  medicalNotes: z.string().nullable(),
  bloodGroup: z.string().nullable(),
  disciplinaryRecords: z.array(z.record(z.string(), z.unknown())).nullable(),
  grievanceRecords: z.array(z.record(z.string(), z.unknown())).nullable(),
  bgvStatus: z.string().nullable(),
  bgvCompletedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
}).nullable();
