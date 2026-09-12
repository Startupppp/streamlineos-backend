import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ScopedRead, type OwnershipScope } from "../../access/scoped-read";
import { AccessService } from "../../access/access.service";
import { supportTickets } from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import { isScopable } from "../../rbac/permissions";

export const SUPPORT_TICKETS_VIEW_PERMISSION = "support:tickets:view";

export async function resolveSupportTicketsViewScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<ScopedRead> {
  if (u.isOrgOwner) return ScopedRead.of(u.orgId, u.userId, "all");
  if (!isScopable(SUPPORT_TICKETS_VIEW_PERMISSION)) return ScopedRead.of(u.orgId, u.userId, "all");
  const resolved = await access.resolveUserPermissions(u.orgId, u.userId);
  return ScopedRead.of(u.orgId, u.userId, resolved.get(SUPPORT_TICKETS_VIEW_PERMISSION) ?? "none");
}

export const SUPPORT_TICKETS_REPLY_PERMISSION = "support:tickets:reply";

export async function resolveSupportTicketsReplyScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<ScopedRead> {
  if (u.isOrgOwner) return ScopedRead.of(u.orgId, u.userId, "all");
  if (!isScopable(SUPPORT_TICKETS_REPLY_PERMISSION)) return ScopedRead.of(u.orgId, u.userId, "all");
  const resolved = await access.resolveUserPermissions(u.orgId, u.userId);
  return ScopedRead.of(u.orgId, u.userId, resolved.get(SUPPORT_TICKETS_REPLY_PERMISSION) ?? "none");
}

export const SUPPORT_TICKETS_MANAGE_PERMISSION = "support:tickets:manage";

export async function resolveSupportTicketsManageScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<ScopedRead> {
  if (u.isOrgOwner) return ScopedRead.of(u.orgId, u.userId, "all");
  if (!isScopable(SUPPORT_TICKETS_MANAGE_PERMISSION)) return ScopedRead.of(u.orgId, u.userId, "all");
  const resolved = await access.resolveUserPermissions(u.orgId, u.userId);
  return ScopedRead.of(u.orgId, u.userId, resolved.get(SUPPORT_TICKETS_MANAGE_PERMISSION) ?? "none");
}

// Ownership here is the assignee membership, not a user column, so it is a domain predicate rather than a ScopeColumns pair.
export function supportTicketScope(orgId: string, userId: string): OwnershipScope {
  return {
    own: sql`${supportTickets.assigneeMembershipId} IN (SELECT id FROM organization_members WHERE org_id = ${orgId} AND user_id = ${userId} AND status = 'ACTIVE')`,
  };
}

export async function assertTicketInScope(
  db: Db,
  read: ScopedRead,
  ticketId: number,
  subject = "Ticket",
): Promise<void> {
  if (read.denied) throw new ForbiddenException(`Not authorized to access this ${subject.toLowerCase()}`);
  const ticket = await read.read(
    {
      tenant: supportTickets.orgId,
      scope: supportTicketScope(read.orgId, read.actorId),
      and: [eq(supportTickets.id, ticketId)],
    },
    ({ sql: where }) => db.query.supportTickets.findFirst({ where, columns: { id: true } }),
    () => undefined,
  );
  if (ticket) return;
  const exists = await db.query.supportTickets.findFirst({
    where: and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, read.orgId)),
    columns: { id: true },
  });
  if (exists) throw new ForbiddenException(`Not authorized to access this ${subject.toLowerCase()}`);
  throw new NotFoundException(`${subject} not found`);
}
