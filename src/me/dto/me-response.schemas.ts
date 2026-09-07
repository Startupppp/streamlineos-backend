import { z } from "zod";
import { wireDate, nullableWireDate } from "../../common/openapi/wire-types";
import { successSchema } from "../../common/openapi/response-envelopes";

const dataScopeSchema = z.enum(["all", "team", "own", "none"]);

const principalSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("human-session"),
    membershipId: z.number().int(),
    isOrgOwner: z.boolean(),
  }),
  z.object({ kind: z.literal("account-only") }),
  z.object({
    kind: z.literal("personal-token"),
    membershipId: z.number().int(),
    isOrgOwner: z.boolean(),
    tokenId: z.string(),
    ceiling: z.array(z.string()),
  }),
  z.object({
    kind: z.literal("agent-token"),
    issuerMembershipId: z.number().int(),
    tokenId: z.number().int(),
    ceiling: z.array(z.string()),
  }),
  z.object({
    kind: z.literal("system-job"),
    jobId: z.string(),
    ceiling: z.array(z.string()),
  }),
]);

export const meResponseSchema = z.object({
  userId: z.string(),
  orgId: z.string(),
  role: z.string(),
  isOrgOwner: z.boolean(),
  sessionId: z.string(),
  tokenScopes: z.array(z.string()).nullable(),
  principal: principalSchema,
});

export const accessSnapshotSchema = z.object({
  scopes: z.record(z.string(), dataScopeSchema),
  modules: z.record(z.string(), z.boolean()),
  isOrgOwner: z.boolean(),
  canManageOrganizationMembership: z.boolean(),
  mfa: z.object({ enforced: z.boolean(), satisfied: z.boolean() }),
  version: z.number().int(),
});

export const orgDisplaySchema = z.object({
  currency: z.string(),
  locale: z.string(),
});

const bankDetailsSchema = z.object({
  accountNumber: z.string(),
  bankName: z.string(),
  branch: z.string(),
  ifsc: z.string(),
  accountHolder: z.string(),
  pfUanNumber: z.string().optional(),
  esiIpNumber: z.string().optional(),
  bankCountry: z.string().optional(),
  routingCode: z.string().optional(),
  iban: z.string().optional(),
  swift: z.string().optional(),
  scheme: z.string().optional(),
  statutory: z.record(z.string(), z.string()).optional(),
});

export const profileResponseSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string(),
  emailVerified: nullableWireDate(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  gender: z.enum(["MALE", "FEMALE", "OTHER"]).nullable(),
  dateOfBirth: z.string().nullable(),
  image: z.string().nullable(),
  phone: z.string().nullable(),
  whatsappNumber: z.string().nullable(),
  whatsappSameAsPhone: z.boolean(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  isActive: z.boolean(),
  userStatus: z.string(),
  invitedAt: nullableWireDate(),
  activatedAt: nullableWireDate(),
  archivedAt: nullableWireDate(),
  deletedAt: nullableWireDate(),
  emergencyContact: z
    .object({
      name: z.string(),
      relation: z.string(),
      phone: z.string(),
      email: z.string().optional(),
    })
    .nullable(),
  totpEnabled: z.boolean(),
  isProfilePictureRequired: z.boolean(),
  bio: z.string().nullable(),
  linkedinUrl: z.string().nullable(),
  twitterUrl: z.string().nullable(),
  githubUrl: z.string().nullable(),
  websiteUrl: z.string().nullable(),
  onboardingDocStatus: z.enum(["PENDING", "IN_PROGRESS", "SUBMITTED", "APPROVED"]),
  onboardingCompletedAt: nullableWireDate(),
  lastActiveOrgId: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  taxId: z.string().nullable(),
  bankDetails: bankDetailsSchema.nullable(),
});

const loginHistoryItemSchema = z.object({
  id: z.string(),
  userId: z.string(),
  orgId: z.string().nullable(),
  event: z.string(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  country: z.string().nullable(),
  city: z.string().nullable(),
  success: z.boolean(),
  failureReason: z.string().nullable(),
  deviceId: z.string().nullable(),
  createdAt: wireDate(),
  browser: z.string(),
  os: z.string().nullable(),
  platform: z.string().nullable(),
});

export const loginHistoryResponseSchema = z.object({
  data: z.array(loginHistoryItemSchema),
  total: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
});

export const authAnalyticsSchema = z.object({
  loginsToday: z.number().int(),
  failedLoginsLast7Days: z.number().int(),
  activeSessions: z.number().int(),
});

export { successSchema as updateProfileResponseSchema };
