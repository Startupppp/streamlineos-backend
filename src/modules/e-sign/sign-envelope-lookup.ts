import { NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { organizationMembers, signEnvelopes } from "../../db/schema";
import { type Db } from "../../db/drizzle.module";

/**
 * The tenant-scoped envelope read both the dispatch and sweep paths make.
 *
 * `orgId` is part of the predicate rather than left to RLS so a cross-tenant id
 * resolves to nothing here and surfaces as 404, never as a 403 that would
 * confirm the row exists.
 */
export async function findEnvelopeOrThrow(db: Db, orgId: string, envelopeId: number) {
  const row = await db.query.signEnvelopes.findFirst({
    where: and(eq(signEnvelopes.id, envelopeId), eq(signEnvelopes.orgId, orgId)),
  });
  if (!row) throw new NotFoundException("Envelope not found");
  return row;
}

export async function resolveSenderName(
  db: Db,
  orgId: string,
  membershipId: number | null | undefined,
): Promise<string> {
  if (membershipId == null) return "A StreamlineOS user";
  const member = await db.query.organizationMembers.findFirst({
    where: and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.id, membershipId)),
    with: { user: { columns: { name: true } } },
  });
  return member?.user?.name ?? "A StreamlineOS user";
}
