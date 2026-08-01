import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { orgUnitMembers, orgUnits, type OrgUnitKind } from "../../db/schema";
import type { DbOrTx } from "../rbac/access-invalidate";

export type PlacementUpdate = Partial<Record<OrgUnitKind, string | null | undefined>>;


export async function syncOrgUnitPlacement(
  tx: DbOrTx,
  orgId: string,
  userId: string,
  placement: PlacementUpdate,
): Promise<void> {
  for (const [kind, unitId] of Object.entries(placement) as Array<
    [OrgUnitKind, string | null | undefined]
  >) {
    if (unitId === undefined) continue;

    const existing = await tx
      .select({ id: orgUnitMembers.id })
      .from(orgUnitMembers)
      .innerJoin(orgUnits, eq(orgUnitMembers.orgUnitId, orgUnits.id))
      .where(
        and(
          eq(orgUnitMembers.userId, userId),
          eq(orgUnitMembers.orgId, orgId),
          eq(orgUnits.kind, kind),
        ),
      );

    for (const row of existing) {
      await tx.delete(orgUnitMembers).where(eq(orgUnitMembers.id, row.id));
    }

    if (unitId !== null) {
      await tx
        .insert(orgUnitMembers)
        .values({ id: randomUUID(), orgId, orgUnitId: unitId, userId, role: "member" })
        .onConflictDoNothing();
    }
  }
}
