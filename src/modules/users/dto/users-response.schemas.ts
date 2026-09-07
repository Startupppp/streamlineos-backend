import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../common/openapi/response-envelopes";

/**
 * Response contracts for `UsersController` handlers.
 *
 * Derived from service implementations and Drizzle projections.
 * NOT `.strict()`: extra response fields are backward-compatible.
 */

const successResponseSchema = z.object({ success: z.literal(true) });

// ─── Audit log shared shape ────────────────────────────────────────────────

const auditLogItemSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  userId: z.string(),
  actorUserId: z.string().nullable(),
  action: z.string(),
  resourceType: z.string().nullable(),
  resourceId: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  ipAddress: z.string().nullable(),
  createdAt: wireDate(),
});

const auditLogPaginationSchema = z.object({
  limit: z.number().int(),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});

const auditLogResponseSchema = z.object({
  data: z.array(auditLogItemSchema),
  pagination: auditLogPaginationSchema,
});

// ─── User list item ────────────────────────────────────────────────────────

const userListItemSchema = z.object({
  membershipId: z.number().int(),
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  image: z.string().nullable(),
  role: z.string(),
  isOwner: z.boolean(),
  emailVerified: z.boolean().nullable(),
  phone: z.string().nullable(),
  createdAt: wireDate(),
  joinedAt: wireDate(),
  lastSeenAt: nullableWireDate(),
  teams: z.array(z.string()),
  departmentId: z.string().nullable(),
  branchId: z.string().nullable(),
  designation: z.string().nullable(),
  isActive: z.boolean(),
  userStatus: z.string(),
  archivedAt: nullableWireDate(),
});

/** `UsersService.listUsers` — v1, includes employment fields. */
export const userListResponseSchema = cursorPageSchema(userListItemSchema);

/** `UsersService.listUsers` → `toUserIdentityPage` — v2, drops 4 employment fields. */
export const userIdentityListResponseSchema = cursorPageSchema(
  userListItemSchema.omit({ designation: true, departmentId: true, branchId: true }),
);

// ─── Single user ───────────────────────────────────────────────────────────

const userDetailSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string(),
  emailVerified: z.boolean().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  image: z.string().nullable(),
  role: z.string(),
  isOwner: z.boolean(),
  phone: z.string().nullable(),
  whatsappNumber: z.string().nullable(),
  whatsappSameAsPhone: z.boolean(),
  team: z.string().nullable(),
  emergencyContact: z.record(z.string(), z.unknown()).nullable(),
  bio: z.string().nullable(),
  linkedinUrl: z.string().nullable(),
  twitterUrl: z.string().nullable(),
  githubUrl: z.string().nullable(),
  websiteUrl: z.string().nullable(),
  totpEnabled: z.boolean(),
  dateOfBirth: z.string().nullable(),
  gender: z.string().nullable(),
  onboardingDocStatus: z.string().nullable(),
  onboardingCompletedAt: nullableWireDate(),
  invitedAt: nullableWireDate(),
  activatedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  isProfilePictureRequired: z.boolean(),
  memberRole: z.string(),
  joinedAt: wireDate(),
  departmentId: z.string().nullable(),
  designation: z.string().nullable(),
  employeeId: z.string().nullable(),
  reportingTo: z.string().nullable(),
  joiningDate: z.string().nullable(),
  branchId: z.string().nullable(),
  isActive: z.boolean(),
  userStatus: z.string(),
  archivedAt: nullableWireDate(),
});

/** `UsersService.getUser` — v1, includes employment fields. */
export const userDetailResponseSchema = userDetailSchema;

/** `UsersService.getUser` → `toUserIdentity` — v2, drops 4 employment fields. */
export const userIdentityResponseSchema = userDetailSchema.omit({
  designation: true,
  departmentId: true,
  branchId: true,
  reportingTo: true,
});

// ─── Stats ─────────────────────────────────────────────────────────────────

/** `UserOpsService.getStats` */
export const userStatsResponseSchema = z.object({
  total: z.number().int(),
  active: z.number().int(),
  suspended: z.number().int(),
  archived: z.number().int(),
  pendingInvitations: z.number().int(),
  newThisMonth: z.number().int(),
});

// ─── Invitation list ───────────────────────────────────────────────────────

const invitationItemSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: z.string(),
  expiresAt: wireDate(),
  acceptedAt: nullableWireDate(),
  createdAt: wireDate(),
  status: z.string(),
  revokedAt: nullableWireDate(),
  declinedAt: nullableWireDate(),
  deliveryFailed: z.boolean(),
});

/** `InvitationsReadService.listPaginated` */
export const invitationListResponseSchema = cursorPageSchema(invitationItemSchema);

// ─── Invitation mutations ──────────────────────────────────────────────────

/** `InvitationCreateService.invite` (InvitationMutationResult) */
export const inviteUserResponseSchema = z.object({
  success: z.literal(true),
  invitationId: z.string(),
  organizationName: z.string(),
  resent: z.boolean(),
});

/** `InvitationCreateService.bulkInvite` */
export const bulkInviteResponseSchema = z.object({
  results: z.array(
    z.object({
      email: z.string(),
      success: z.boolean(),
      invitationId: z.string().optional(),
      error: z.string().optional(),
    }),
  ),
});

/** `InvitationLifecycleService.resend` / `changeRole` / `cancel` */
export const invitationMutationResponseSchema = successResponseSchema;

// ─── Create / update / delete user ─────────────────────────────────────────

/** `UsersService.createUser` */
export const createUserResponseSchema = z.object({
  userId: z.string(),
  created: z.boolean(),
});

/** `UsersService.updateUser` / `updateUserStatus` / `deleteUser` */
export const userMutationResponseSchema = successResponseSchema;

// ─── Bulk operations ───────────────────────────────────────────────────────

const bulkStatusResultItemSchema = z.object({
  userId: z.string(),
  success: z.boolean(),
  error: z.string().optional(),
});

/** `UserOpsService.bulkSuspend` / `bulkArchive` / `bulkRestore` */
export const bulkStatusResponseSchema = z.object({
  results: z.array(bulkStatusResultItemSchema),
  succeeded: z.number().int(),
  failed: z.number().int(),
});

/** `UserOpsService.bulkUpdateUsers` */
export const bulkUpdateResponseSchema = z.object({
  success: z.literal(true),
  updated: z.number().int(),
});

/** `UserOpsService.importUsers` */
export const importUsersResponseSchema = z.object({
  results: z.array(
    z.object({
      email: z.string(),
      success: z.boolean(),
      invitationId: z.string().optional(),
      error: z.string().optional(),
    }),
  ),
  succeeded: z.number().int(),
  failed: z.number().int(),
  total: z.number().int(),
});

// ─── Sessions ──────────────────────────────────────────────────────────────

const sessionItemSchema = z.object({
  id: z.string(),
  userId: z.string(),
  userAgent: z.string().nullable(),
  ipAddress: z.string().nullable(),
  isRevoked: z.boolean(),
  lastActive: wireDate(),
  deviceId: z.string().nullable(),
  expiresAt: nullableWireDate(),
  createdAt: wireDate(),
  browser: z.string(),
  os: z.string().nullable(),
  platform: z.string().nullable(),
});

/** `UserProfileService.getUserSessions` — sessions array with clientInfo. */
export const userSessionsResponseSchema = z.array(sessionItemSchema);

/** `UserProfileService.revokeSession` / `revokeAllSessions` */
export const revokeSessionResponseSchema = successResponseSchema;

// ─── Preferences ───────────────────────────────────────────────────────────

/** `UserProfileService.getPreferences` — DB row or in-memory defaults. */
export const userPreferencesResponseSchema = z.object({
  userId: z.string(),
  theme: z.string(),
  language: z.string(),
  timezone: z.string(),
  dateFormat: z.string(),
  timeFormat: z.string(),
  numberFormat: z.string().nullable(),
  weekStartDay: z.string().nullable(),
  notificationPreferences: z.record(z.string(), z.unknown()),
  dashboardPreferences: z.record(z.string(), z.unknown()),
  updatedAt: wireDate().optional(),
});

/** `UserProfileService.updatePreferences` */
export const updatePreferencesResponseSchema = successResponseSchema;

// ─── Login history ─────────────────────────────────────────────────────────

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

/** `UserProfileService.getLoginHistory` */
export const loginHistoryResponseSchema = cursorPageSchema(loginHistoryItemSchema);

// ─── Membership ────────────────────────────────────────────────────────────

/** `UserProfileService.getMembership` */
export const userMembershipResponseSchema = z.object({
  userId: z.string(),
  orgId: z.string(),
  businessUnitId: z.string().nullable(),
  branchId: z.string().nullable(),
  departmentId: z.string().nullable(),
  teamId: z.string().nullable(),
  managerUserId: z.string().nullable(),
});

/** `UserProfileService.updateMembership` */
export const updateMembershipResponseSchema = successResponseSchema;

// ─── Signin link ───────────────────────────────────────────────────────────

/** `UserOpsService.sendSigninLink` */
export const sendSigninLinkResponseSchema = z.object({
  success: z.literal(true),
  email: z.string(),
});

// ─── Audit log handlers ────────────────────────────────────────────────────

/** `UserActivityService.getAuditLog` / `getUserAuditLog` / `getUserActivity` */
export const userAuditLogResponseSchema = auditLogResponseSchema;

// ─── Data export ───────────────────────────────────────────────────────────

/**
 * `UserProfileService.exportUserData` — composite export object.
 * Uses loose schemas for nested structures (sessions, login history, audit log)
 * which are already typed by their own schemas above.
 */
export const exportUserDataResponseSchema = z.object({
  subject: z.object({
    id: z.string(),
    email: z.string(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    phone: z.string().nullable(),
    image: z.string().nullable(),
    emailVerified: z.boolean().nullable(),
    createdAt: wireDate(),
    designation: z.string().nullable(),
  }),
  membership: userMembershipResponseSchema,
  preferences: userPreferencesResponseSchema,
  sessions: z.array(z.record(z.string(), z.unknown())),
  loginHistory: z.record(z.string(), z.unknown()),
  auditLog: z.record(z.string(), z.unknown()),
  coverage: z.object({
    includes: z.array(z.string()),
    excludes: z.array(z.string()),
    historyRowCap: z.number().int(),
  }),
});

// ─── Org audit log ─────────────────────────────────────────────────────────

/** `UserActivityService.getAuditLog` (org-level) */
export const orgAuditLogResponseSchema = auditLogResponseSchema;
