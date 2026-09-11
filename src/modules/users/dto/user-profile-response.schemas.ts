import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../common/openapi/response-envelopes";

/**
 * Response contracts for the per-person surface of `UsersController` —
 * `UserProfileService` and `UserActivityService`.
 *
 * NOT `.strict()`: extra response fields are backward-compatible.
 */

const successResponseSchema = z.object({ success: z.literal(true) });

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

/** `UserActivityService.getAuditLog` / `getUserAuditLog` / `getUserActivity` */
export const userAuditLogResponseSchema = auditLogResponseSchema;

/** `UserActivityService.getAuditLog` (org-level) */
export const orgAuditLogResponseSchema = auditLogResponseSchema;

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
