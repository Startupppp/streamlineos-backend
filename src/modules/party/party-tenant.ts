import { NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { businessParties } from "../../db/schema";
import type { Db } from "../../db/drizzle.module";

/**
 * The tenancy guard every party-scoped read runs before it reads anything else.
 *
 * A soft-deleted party is not in the org for this purpose: without `deleted_at IS NULL` the guard
 * passed for a party in the trash, so `PartyRolesService.listRoles` and
 * `SubjectService.listForParty` answered 200 over a deleted party instead of 404 — while every
 * other read of `business_parties` in this module (party.service, party-seam, party-merge,
 * party-roles, subject) already excludes deleted rows. Both callers are active reads; neither the
 * merge nor the divergence path routes through here, and `party-divergence.service.ts` states its
 * need for deleted rows with an explicit `isNotNull` of its own.
 */
export async function assertPartyInOrg(db: Db, organizationId: string, partyId: string): Promise<void> {
  const party = await db.query.businessParties.findFirst({
    columns: { partyId: true },
    where: and(
      eq(businessParties.partyId, partyId),
      eq(businessParties.organizationId, organizationId),
      isNull(businessParties.deletedAt),
    ),
  });
  if (!party) throw new NotFoundException("Party not found");
}
