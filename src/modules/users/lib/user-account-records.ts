import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { loginHistory, userPreferences, userSessions } from "../../../db/schema";
import type { SessionsService } from "../../sessions/sessions.service";
import type {
  ListLoginHistoryInput,
  UpdatePreferencesInput,
} from "../dto/users.schemas";
import { withClientInfo } from "../../../common/http/parse-user-agent";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { keysetBefore } from "../../../common/pagination/keyset";

/**
 * The records that belong to a person's ACCOUNT rather than to their place in an
 * organisation: their sessions, their sign-in history and their preferences.
 *
 * The seam is a property of the tables, and it is the security-relevant one.
 * `user_sessions`, `login_history` and `user_preferences` are keyed by `user_id`
 * alone — none of them has an `org_id` column, because a person has one account
 * however many organisations they belong to. So every query in this file is
 * tenant-blind by construction, and the ONLY thing that scopes it to the caller's
 * organisation is `deps.assertMember`, run first in every function. Remove that
 * line from any one of them and an admin in one tenant can read, or revoke, the
 * sessions of somebody who is only a member of another. The placement half that
 * stayed in `user-profile.service.ts` is different in kind: it reads and writes
 * org-scoped tables that carry their own `org_id` predicates.
 *
 * `assertMember` is private to the service and is passed in bound rather than
 * exported, so this file cannot be imported and called without a gate.
 *
 * Bodies are moved verbatim, DB call order included:
 * `sessions-admin-revoke.spec.ts` mocks the select → update → publish sequence of
 * the revocation paths, and `user-profile-tenant-isolation.spec.ts` stubs the
 * membership probe that must come first.
 */

export interface UserAccountRecordDeps {
  readonly db: Db;
  readonly audit: AuditService;
  readonly sessions: Pick<SessionsService, "publishRevocations">;
  /**
   * `UserProfileService.assertMember`, bound: throws `NotFoundException` unless
   * `userId` is a member of `orgId`. The only tenant boundary these reads have.
   */
  readonly assertMember: (orgId: string, userId: string) => Promise<void>;
}

export async function getUserSessions(
  deps: UserAccountRecordDeps,
  orgId: string,
  userId: string,
) {
  await deps.assertMember(orgId, userId);
  const rows = await deps.db
    .select()
    .from(userSessions)
    .where(
      and(eq(userSessions.userId, userId), eq(userSessions.isRevoked, false)),
    )
    .orderBy(desc(userSessions.createdAt))
    .limit(50);
  return rows.map(withClientInfo);
}

export async function revokeSession(
  deps: UserAccountRecordDeps,
  orgId: string,
  userId: string,
  sessionId: string,
  actorUserId: string,
) {
  await deps.assertMember(orgId, userId);
  await deps.db
    .update(userSessions)
    .set({ isRevoked: true })
    .where(
      and(eq(userSessions.id, sessionId), eq(userSessions.userId, userId)),
    );
  await deps.sessions.publishRevocations([sessionId]);
  deps.audit.log({
    action: "user.session.revoked",
    userId: actorUserId,
    orgId,
    targetId: userId,
    targetType: "user",
    metadata: { sessionId },
  });
  return { success: true };
}

export async function revokeAllSessions(
  deps: UserAccountRecordDeps,
  orgId: string,
  userId: string,
  actorUserId: string,
) {
  await deps.assertMember(orgId, userId);
  const active = await deps.db
    .select({ id: userSessions.id })
    .from(userSessions)
    .where(
      and(eq(userSessions.userId, userId), eq(userSessions.isRevoked, false)),
    );
  await deps.db
    .update(userSessions)
    .set({ isRevoked: true })
    .where(eq(userSessions.userId, userId));
  await deps.sessions.publishRevocations(active.map((session) => session.id));
  deps.audit.log({
    action: "user.sessions.revoked_all",
    userId: actorUserId,
    orgId,
    targetId: userId,
    targetType: "user",
  });
  return { success: true };
}

export async function getPreferences(
  deps: UserAccountRecordDeps,
  orgId: string,
  userId: string,
) {
  await deps.assertMember(orgId, userId);
  const prefs = await deps.db.query.userPreferences.findFirst({
    where: eq(userPreferences.userId, userId),
  });
  if (!prefs) {
    return {
      userId,
      theme: "system",
      language: "en",
      timezone: "Asia/Kolkata",
      dateFormat: "DD/MM/YYYY",
      timeFormat: "12h",
      notificationPreferences: {},
      dashboardPreferences: {},
    };
  }
  return prefs;
}

export async function updatePreferences(
  deps: UserAccountRecordDeps,
  orgId: string,
  userId: string,
  data: UpdatePreferencesInput,
) {
  await deps.assertMember(orgId, userId);

  const updateData: Record<string, unknown> = {};
  if (data.theme !== undefined) updateData.theme = data.theme;
  if (data.language !== undefined) updateData.language = data.language;
  if (data.timezone !== undefined) updateData.timezone = data.timezone;
  if (data.dateFormat !== undefined) updateData.dateFormat = data.dateFormat;
  if (data.timeFormat !== undefined) updateData.timeFormat = data.timeFormat;
  if (data.numberFormat !== undefined)
    updateData.numberFormat = data.numberFormat;
  if (data.weekStartDay !== undefined)
    updateData.weekStartDay = data.weekStartDay;
  if (data.notificationPreferences !== undefined)
    updateData.notificationPreferences = data.notificationPreferences;
  if (data.dashboardPreferences !== undefined)
    updateData.dashboardPreferences = data.dashboardPreferences;

  // An empty patch is a no-op, not an INSERT of defaults or an `UPDATE … SET` with
  // nothing to set — drizzle throws on the latter, which turned a blank save into a 500.
  if (Object.keys(updateData).length === 0) return { success: true };

  const existing = await deps.db.query.userPreferences.findFirst({
    columns: { userId: true },
    where: eq(userPreferences.userId, userId),
  });

  if (existing) {
    await deps.db
      .update(userPreferences)
      .set(updateData)
      .where(eq(userPreferences.userId, userId));
  } else {
    await deps.db.insert(userPreferences).values({
      userId,
      theme: data.theme ?? "system",
      language: data.language ?? "en",
      timezone: data.timezone ?? "Asia/Kolkata",
      dateFormat: data.dateFormat ?? "DD/MM/YYYY",
      timeFormat: data.timeFormat ?? "12h",
      notificationPreferences:
        data.notificationPreferences ?? ({} as Record<string, boolean>),
      dashboardPreferences:
        data.dashboardPreferences ?? ({} as Record<string, unknown>),
    });
  }

  return { success: true };
}

export async function getLoginHistory(
  deps: UserAccountRecordDeps,
  orgId: string,
  userId: string,
  params: ListLoginHistoryInput,
) {
  await deps.assertMember(orgId, userId);

  const { cursor, limit, success: successFilter } = params;

  const conditions = [eq(loginHistory.userId, userId)];
  if (successFilter !== undefined) {
    conditions.push(eq(loginHistory.success, successFilter));
  }

  const position = decodeCursor(cursor);
  if (position) {
    conditions.push(keysetBefore(loginHistory.createdAt, loginHistory.id, position));
  }

  const rows = await deps.db
    .select()
    .from(loginHistory)
    .where(and(...conditions))
    .orderBy(desc(loginHistory.createdAt), desc(loginHistory.id))
    .limit(limit + 1);
  const page = buildCursorPage(rows, limit, (row) => ({
    sortValue: row.createdAt.toISOString(),
    id: row.id,
  }));

  return { ...page, data: page.data.map(withClientInfo) };
}
