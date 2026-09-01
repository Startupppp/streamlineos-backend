import { and, asc, eq, gt } from "drizzle-orm";
import {
  auditLogs,
  organizationMembers,
  users,
} from "../../db/schema";
import type { Db } from "../../db/drizzle.module";
import { BATCH_SIZE } from "./gdpr-export-types";

export async function fetchSubject(db: Db, subjectUserId: string) {
  const [subject] = await db
    .select({ userId: users.id, email: users.email, name: users.name })
    .from(users)
    .where(eq(users.id, subjectUserId))
    .limit(1);
  if (!subject) throw new Error("GDPR export subject not found");
  return {
    userId: subject.userId,
    email: subject.email,
    name: subject.name ?? null,
  };
}

export async function fetchMemberships(
  db: Db,
  orgId: string,
  subjectUserId: string,
  afterId: number | undefined,
) {
  const conditions = [
    eq(organizationMembers.userId, subjectUserId),
    eq(organizationMembers.orgId, orgId),
  ];
  if (afterId !== undefined)
    conditions.push(gt(organizationMembers.id, afterId));
  return db
    .select({
      id: organizationMembers.id,
      orgId: organizationMembers.orgId,
      role: organizationMembers.role,
      status: organizationMembers.status,
      joinedAt: organizationMembers.joinedAt,
    })
    .from(organizationMembers)
    .where(and(...conditions))
    .orderBy(asc(organizationMembers.id))
    .limit(BATCH_SIZE);
}

export async function fetchAuditEntries(
  db: Db,
  orgId: string,
  subjectUserId: string,
  afterId: number | undefined,
) {
  const conditions = [
    eq(auditLogs.userId, subjectUserId),
    eq(auditLogs.orgId, orgId),
  ];
  if (afterId !== undefined) conditions.push(gt(auditLogs.id, afterId));
  return db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      targetId: auditLogs.targetId,
      targetType: auditLogs.targetType,
      actorUserId: auditLogs.actorUserId,
      resourceType: auditLogs.resourceType,
      resourceId: auditLogs.resourceId,
      metadata: auditLogs.metadata,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .where(and(...conditions))
    .orderBy(asc(auditLogs.id))
    .limit(BATCH_SIZE);
}
