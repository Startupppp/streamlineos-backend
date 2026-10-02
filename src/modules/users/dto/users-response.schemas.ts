import { z } from "zod";
import {
  wireDate,
  nullableWireDate,
  nullableWireTimestamp,
} from "../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../common/openapi/response-envelopes";

/**
 * Response contracts for the administration surface of `UsersController` —
 * `UsersService`, `UserOpsService` and the invitation services.
 *
 * Derived from service implementations and Drizzle projections.
 * NOT `.strict()`: extra response fields are backward-compatible.
 */

const successResponseSchema = z.object({ success: z.literal(true) });

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
  lastSeenAt: nullableWireTimestamp(),
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
  deliveryMode: z.enum(["background", "enqueue"]),
  results: z.array(
    z.object({
      email: z.string(),
      originalEmail: z.string(),
      success: z.boolean(),
      invitationId: z.string().optional(),
      isDuplicate: z.boolean().optional(),
      error: z.string().optional(),
      deliveryQueued: z.boolean().optional(),
    }),
  ),
});

/** `InvitationLifecycleService.resend` / `changeRole` / `cancel` */
export const invitationMutationResponseSchema = successResponseSchema;

export const invitationJoinLinkResponseSchema = z.object({
  joinUrl: z.string(),
  email: z.string(),
  expiresAt: z.union([z.string(), z.date()]),
});

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

// ─── Signin link ───────────────────────────────────────────────────────────

/** `UserOpsService.sendSigninLink` */
export const sendSigninLinkResponseSchema = z.object({
  success: z.literal(true),
  email: z.string(),
});
