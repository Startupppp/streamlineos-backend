import { z } from "zod";
import {
  wireDate,
  nullableWireDate,
  wireTimestamp,
  nullableWireTimestamp,
} from "../../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../../common/openapi/response-envelopes";

/**
 * Response contract for `OrganizationController` handlers.
 *
 * Derived from service implementations and Drizzle projections.
 * NOT `.strict()`: extra response fields are backward-compatible.
 */

/** Shared `{ success: true }` result. */
const successResponseSchema = z.object({ success: z.literal(true) });

/** `InvitationsReadService.validate` */
export const invitationValidateResponseSchema = z.object({
  email: z.string(),
  organizationName: z.string(),
  role: z.string(),
  userExists: z.boolean(),
});

/** `OrgProfileService.listUserOrganizations` */
export const orgListResponseSchema = z.array(z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  role: z.string(),
  joinedAt: wireDate(),
}));

/** `OrgLifecycleService.listArchivedOwnedOrganizations` */
export const archivedOrgListResponseSchema = z.array(z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
}));

/** `OrgProfileService.createOrganization` */
export const createOrgResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
});

/** `OrgProfileService.switchOrg` */
export const switchOrgResponseSchema = z.object({
  orgId: z.string(),
  name: z.string(),
  slug: z.string(),
  role: z.string(),
});

/** `OrgMembershipService.listMembers` — cursor-paged member list. */
const orgMemberRowSchema = z.object({
  membershipId: z.number().int(),
  userId: z.string(),
  role: z.string(),
  joinedAt: wireDate(),
  name: z.string().nullable(),
  email: z.string(),
  image: z.string().nullable(),
  totpEnabled: z.boolean(),
});

export const orgMembersListResponseSchema = cursorPageSchema(orgMemberRowSchema);

/** `OrgMembershipService.updateMemberRole` */
export const updateMemberRoleResponseSchema = successResponseSchema;

/** `OrgMembershipStatusService.suspendMember` / `reactivateMember` */
export const memberStatusMutationResponseSchema = successResponseSchema;

/** `OrganizationSettingsService.getSettings` — org row spread with computed extras. */
export const orgSettingsResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  logo: z.string().nullable(),
  website: z.string().nullable(),
  industry: z.string().nullable(),
  region: z.string().nullable(),
  timezone: z.string(),
  currency: z.string(),
  fiscalYearStart: z.number().int(),
  settings: z.record(z.string(), z.unknown()).nullable(),
  billingEmail: z.string().nullable(),
  address: z.object({
    line1: z.string().optional(),
    line2: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    country: z.string().optional(),
    postalCode: z.string().optional(),
  }).nullable(),
  mfaEnforced: z.boolean(),
  maxConcurrentSessions: z.number().int().nullable(),
  ownerMembershipId: z.number().int(),
  onboardingCompletedAt: nullableWireTimestamp(),
  status: z.string(),
  statusV2: z.string().nullable(),
  purgeScheduledAt: nullableWireTimestamp(),
  purgeScheduledBy: z.string().nullable(),
  purgeJobId: z.string().nullable(),
  purgedAt: nullableWireTimestamp(),
  purgeReason: z.string().nullable(),
  deletedAt: nullableWireTimestamp(),
  companySize: z.string().nullable(),
  country: z.string().nullable(),
  legalName: z.string().nullable(),
  orgCode: z.string().nullable(),
  registrationNumber: z.string().nullable(),
  taxNumber: z.string().nullable(),
  supportEmail: z.string().nullable(),
  supportPhone: z.string().nullable(),
  favicon: z.string().nullable(),
  secondaryColor: z.string().nullable(),
  businessHours: z.record(z.string(), z.object({
    open: z.string(),
    close: z.string(),
    enabled: z.boolean(),
  })).nullable(),
  createdAt: wireTimestamp(),
  updatedAt: wireTimestamp(),
  allowedEmailDomains: z.array(z.string()),
  primaryColor: z.string().nullable(),
  loginBgUrl: z.string().nullable(),
  ipAllowlist: z.array(z.unknown()),
  directoryPublic: z.boolean(),
});

/** `OrganizationSettingsService.updateSettings` / `updateSecuritySettings` */
export const updateOrgSettingsResponseSchema = successResponseSchema;

/** `InvitationAcceptanceService.accept` */
export const acceptInvitationResponseSchema = z.object({
  ok: z.literal(true),
  autoLoginToken: z.string(),
});

/** `InvitationAcceptanceService.decline` */
export const declineInvitationResponseSchema = z.object({
  ok: z.literal(true),
});

/** A custom domain row — `orgCustomDomains` projection via `select()`. */
const customDomainItemSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  domain: z.string(),
  verificationToken: z.string(),
  verifiedAt: nullableWireDate(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
});

/** `OrgCustomDomainsService.listCustomDomains` */
export const customDomainListResponseSchema = z.array(customDomainItemSchema);

/** `OrgCustomDomainsService.addCustomDomain` */
export const addCustomDomainResponseSchema = customDomainItemSchema;

/** `OrgCustomDomainsService.verifyCustomDomain` */
export const verifyCustomDomainResponseSchema = z.object({
  success: z.literal(true),
  verified: z.literal(true),
});

/** A holiday row — `orgHolidays` projection via `select()`. `date` is a SQL date column → string. */
const holidayItemSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  name: z.string(),
  date: z.string(),
  recurring: z.boolean(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
});

/** `OrgHolidaysService.listHolidays` */
export const holidayListResponseSchema = z.array(holidayItemSchema);

/** `OrgHolidaysService.createHoliday` */
export const createHolidayResponseSchema = holidayItemSchema;

/** `OrgLifecycleService.archiveOrg` */
export const archiveOrgResponseSchema = z.object({
  success: z.literal(true),
  nextOrgId: z.string().nullable(),
});

/** `OrgLifecycleService.restoreOrg` */
export const restoreOrgResponseSchema = z.object({
  success: z.literal(true),
  orgId: z.string(),
});

/** `OrgMemberDepartureService.leaveOrg` */
export const leaveOrgResponseSchema = successResponseSchema;

/** `OrgPurgeService.deleteOrg` */
export const deleteOrgResponseSchema = z.object({
  success: z.literal(true),
  nextOrgId: z.string().nullable(),
});

/** `OrgPurgeService.schedulePurge` */
export const schedulePurgeResponseSchema = z.object({
  success: z.literal(true),
  purgeJobId: z.string(),
  purgeScheduledAt: wireDate(),
});

/** `OrgPurgeService.cancelPurge` */
export const cancelPurgeResponseSchema = successResponseSchema;

/** `OrganizationLegalHoldService.place` */
export const placeLegalHoldResponseSchema = successResponseSchema;

/** A legal hold entry returned by `listActive`. `placedAt` is a timestamp → wireDate(). */
const legalHoldItemSchema = z.object({
  holdId: z.string(),
  orgId: z.string(),
  reason: z.string(),
  placedBy: z.string(),
  placedAt: wireDate(),
});

/** `OrganizationLegalHoldService.listActive` */
export const legalHoldListResponseSchema = z.array(legalHoldItemSchema);

/** `OrganizationLegalHoldService.release` */
export const releaseLegalHoldResponseSchema = successResponseSchema;
