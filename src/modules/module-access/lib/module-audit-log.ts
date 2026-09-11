import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { auditLogs, organizationMembers, roles, users } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { keysetBeforeId } from "../../../common/pagination/keyset";
import type { AuditLogQuery } from "../dto/module-access.schemas";
import { systemActorLabel } from "../../../common/audit/audit.service";

/**
 * A module's access-change history, as the module's own Access screen shows it.
 *
 * Every other method on `ModuleAccessService` reads or writes the role model —
 * `roles`, `role_permission_grants`, the caller's resolved permissions. This one
 * never touches it. It reads `audit_logs`, filtered to rows whose metadata names
 * the module, and then resolves the user and role ids those rows point at into
 * names. That is a different table, a different pagination scheme (keyset on
 * `(created_at, id)`, where the role list is a capped single page) and a
 * different failure mode, which is why it lives on its own.
 *
 * The gate travels with it. `deps.assertModuleAccess` is the service's own
 * module-access check, bound, and it is the first thing `listModuleAuditLog`
 * does — so this function cannot be called without somebody supplying a gate,
 * and the history of who was granted what inside a module is never readable by
 * a caller who could not open that module's Access screen.
 *
 * Tenant scope is asserted twice and both matter: the history read filters on
 * `audit_logs.org_id`, and the name lookups for its targets each re-assert
 * `org_id` too, so a row that names a user or role id from another tenant
 * resolves to no name rather than to theirs.
 */

export interface ModuleAuditLogEntry {
  id: number;
  action: string;
  /** Null when no user acted; `actorName` then carries the system's label. */
  actorUserId: string | null;
  actorName: string;
  actorEmail: string;
  targetId: string | null;
  targetType: string | null;
  targetName: string | null;
  metadata: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: string;
}

export interface ModuleAuditLogPage {
  data: ModuleAuditLogEntry[];
  pagination: {
    limit: number;
    nextCursor: string | null;
    hasMore: boolean;
  };
}

export interface ModuleAuditLogDeps {
  readonly db: Db;
  /** `ModuleAccessService.assertModuleAccess`, bound. Resolves, or throws the refusal. */
  readonly assertModuleAccess: (
    actor: CurrentUserContext,
    moduleKey: string,
    action: "view" | "manage",
  ) => Promise<void>;
}

export async function listModuleAuditLog(
  deps: ModuleAuditLogDeps,
  actor: CurrentUserContext,
  moduleKey: string,
  { limit: rawLimit, cursor: cursorStr }: AuditLogQuery,
): Promise<ModuleAuditLogPage> {
  await deps.assertModuleAccess(actor, moduleKey, "view");

  const limit = Math.min(rawLimit, 100);
  const position = decodeCursor(cursorStr);

  const cursorFilter = position
    ? keysetBeforeId(auditLogs.createdAt, auditLogs.id, position)
    : undefined;

  const where = and(
    eq(auditLogs.orgId, actor.orgId),
    sql`${auditLogs.metadata}->>'moduleKey' = ${moduleKey}`,
    cursorFilter,
  );

  const rows = await deps.db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      actorUserId: auditLogs.userId,
      actorName: users.name,
      actorEmail: users.email,
      targetId: auditLogs.targetId,
      targetType: auditLogs.targetType,
      metadata: auditLogs.metadata,
      ipAddress: auditLogs.ipAddress,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .leftJoin(users, eq(auditLogs.userId, users.id))
    .where(where)
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(limit + 1);

  const cursorPage = buildCursorPage(rows, limit, (r) => ({
    sortValue: r.createdAt.toISOString(),
    id: String(r.id),
  }));

  const targetUserIds = cursorPage.data.flatMap((row) =>
    row.targetType === "user" && row.targetId ? [row.targetId] : [],
  );
  const targetRoleIds = cursorPage.data.flatMap((row) => {
    if (row.targetType !== "role" || !row.targetId) return [];
    const roleId = Number(row.targetId);
    return Number.isInteger(roleId) ? [roleId] : [];
  });
  const [targetUsers, targetRoles] = await Promise.all([
    targetUserIds.length
      ? deps.db
          .select({ id: users.id, name: users.name, email: users.email })
          .from(organizationMembers)
          .innerJoin(users, eq(users.id, organizationMembers.userId))
          .where(
            and(
              eq(organizationMembers.orgId, actor.orgId),
              inArray(organizationMembers.userId, targetUserIds),
            ),
          )
      : [],
    targetRoleIds.length
      ? deps.db
          .select({ id: roles.id, name: roles.name })
          .from(roles)
          .where(
            and(
              eq(roles.orgId, actor.orgId),
              inArray(roles.id, targetRoleIds),
            ),
          )
      : [],
  ]);
  const userNames = new Map(
    targetUsers.map((user) => [user.id, user.name ?? user.email]),
  );
  const roleNames = new Map(targetRoles.map((role) => [role.id, role.name]));

  const data = cursorPage.data.map((r) => ({
    id: r.id,
    action: r.action,
    actorUserId: r.actorUserId,
    actorName:
      r.actorName ??
      r.actorEmail ??
      r.actorUserId ??
      systemActorLabel(r.metadata) ??
      "The system",
    actorEmail: r.actorEmail ?? "",
    targetId: r.targetId,
    targetType: r.targetType,
    targetName:
      r.targetType === "user" && r.targetId
        ? (userNames.get(r.targetId) ?? null)
        : r.targetType === "role" && r.targetId
          ? (roleNames.get(Number(r.targetId)) ?? null)
          : null,
    metadata: r.metadata,
    ipAddress: r.ipAddress,
    createdAt: r.createdAt.toISOString(),
  }));

  return { data, pagination: cursorPage.pagination };
}
