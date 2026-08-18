import { BadRequestException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { orgUnitMembers, orgUnits, type OrgUnitKind } from "../../db/schema";
import type { DbOrTx } from "../rbac/access-invalidate";

export type PlacementUpdate = Partial<Record<OrgUnitKind, string | null | undefined>>;

export async function assertActiveOrgUnit(
  tx: DbOrTx,
  orgId: string,
  unitId: string,
  kind: OrgUnitKind,
): Promise<void> {
  const [unit] = await tx
    .select({ id: orgUnits.id })
    .from(orgUnits)
    .where(
      and(
        eq(orgUnits.id, unitId),
        eq(orgUnits.orgId, orgId),
        eq(orgUnits.kind, kind),
        eq(orgUnits.status, "ACTIVE"),
        isNull(orgUnits.deletedAt),
      ),
    )
    .limit(1);

  if (!unit) throw new BadRequestException(`Invalid ${kind.toLowerCase()} selection.`);
}

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
    if (unitId !== null) await assertActiveOrgUnit(tx, orgId, unitId, kind);

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
