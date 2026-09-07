import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";

const accountAccessSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("MEMBER") }),
  z.object({
    state: z.literal("INVITED"),
    invitationId: z.string(),
    invitationStatus: z.enum(["PENDING", "EXPIRED"]),
    email: z.string(),
    role: z.string(),
    expiresAt: wireDate(),
  }),
  z.object({ state: z.literal("NONE") }),
]);

const directoryPersonSchema = z.object({
  organizationPersonId: z.string(),
  organizationId: z.string(),
  userId: z.string().nullable(),
  organizationMembershipId: z.number().int().nullable(),
  firstName: z.string(),
  lastName: z.string().nullable(),
  displayName: z.string().nullable(),
  preferredName: z.string().nullable(),
  workEmail: z.string().nullable(),
  personalEmail: z.string().nullable(),
  phone: z.string().nullable(),
  whatsappNumber: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  timezone: z.string().nullable(),
  languageCode: z.string().nullable(),
  linkedinUrl: z.string().nullable(),
  githubUrl: z.string().nullable(),
  bio: z.string().nullable(),
  deletedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  accountAccess: accountAccessSchema,
});

const listPeoplePageInfoSchema = z.object({
  limit: z.number().int(),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});

export const listPeopleSchema = z.object({
  data: z.array(directoryPersonSchema),
  pageInfo: listPeoplePageInfoSchema,
});

export const personSchema = directoryPersonSchema;

const workerItemSchema = z.object({
  workerId: z.string(),
  organizationId: z.string(),
  organizationPersonId: z.string(),
  workerNumber: z.string().nullable(),
  status: z.string(),
  isPayee: z.boolean(),
  deletedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  firstName: z.string(),
  lastName: z.string().nullable(),
  displayName: z.string().nullable(),
  workEmail: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  userId: z.string().nullable(),
});

export const listWorkersSchema = z.object({
  data: z.array(workerItemSchema),
  pageInfo: listPeoplePageInfoSchema,
});

export const workerDetailSchema = workerItemSchema;

const workerEngagementRowSchema = z.object({
  workerEngagementId: z.string(),
  organizationId: z.string(),
  workerId: z.string(),
  startsOn: z.string(),
  endsOn: z.string().nullable(),
  workerType: z.string(),
  status: z.string(),
  isPrimary: z.boolean(),
  departmentId: z.string().nullable(),
  businessUnitId: z.string().nullable(),
  branchId: z.string().nullable(),
  locationId: z.string().nullable(),
  teamId: z.string().nullable(),
  managerEngagementId: z.string().nullable(),
  designation: z.string().nullable(),
  jobRoleId: z.number().int().nullable(),
  jobLevelId: z.number().int().nullable(),
  employmentTypeId: z.number().int().nullable(),
  probationEndsOn: z.string().nullable(),
  noticePeriodDays: z.number().int().nullable(),
  terminationReason: z.string().nullable(),
  terminationNotes: z.string().nullable(),
  stateReason: z.string().nullable(),
  lastStateEventId: z.number().nullable(),
  rowVersion: z.number().int(),
  createdByMembershipId: z.number().int().nullable(),
  updatedByMembershipId: z.number().int().nullable(),
  archivedAt: nullableWireDate(),
  archivedByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const engagementRowSchema = workerEngagementRowSchema;

export const engagementListSchema = z.array(workerEngagementRowSchema);

const employmentFactsItemSchema = z.object({
  userId: z.string(),
  employmentId: z.number().int().nullable(),
  employeeNumber: z.string().nullable(),
  designation: z.string().nullable(),
  joiningDate: z.string().nullable(),
  departmentId: z.string().nullable(),
  locationId: z.string().nullable(),
  managerUserId: z.string().nullable(),
});

export const employmentFactsListSchema = z.object({
  data: z.array(employmentFactsItemSchema),
});
