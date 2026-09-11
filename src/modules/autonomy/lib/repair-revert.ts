/**
 * Taking repairs back: one value, a whole decision's worth, and the count the
 * reversal planner reads.
 *
 * `restore` is not exported, as it was private to the class. Every undo goes
 * through `revertOneRepair` or `revertRepairBatch`, which is where the
 * not-found, already-reverted and findings-reopened halves of the contract
 * live; `restore` alone would put values back and leave the queue believing
 * they were still fixed.
 */
import { ConflictException, NotFoundException } from "@nestjs/common";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.types";
import { autonomyRepairs } from "../../../db/schema";
import { updatePartyWithMirror } from "../../party/party-legacy-writer";
import type { RepairDeps } from "../autonomy-repair.types";
import { currentPartyFieldValue, fieldPatch } from "./repair-party-field";

type RevertDeps = Pick<RepairDeps, "db" | "queue">;

export async function revertOneRepair(
  deps: RevertDeps,
  organizationId: string,
  userId: string,
  repairId: string,
  reason: string | null,
) {
  const [repair] = await deps.db
    .select()
    .from(autonomyRepairs)
    .where(
      and(
        eq(autonomyRepairs.organizationId, organizationId),
        eq(autonomyRepairs.autonomyRepairId, repairId),
      ),
    )
    .limit(1);

  // Another organisation's identifier reads as absent; a 403 would confirm it.
  if (!repair) throw new NotFoundException("Repair not found");
  if (repair.revertedAt) throw new ConflictException("This repair was already taken back.");

  const reverted = await restore(deps.db, organizationId, userId, repair, reason);
  if (!reverted)
    throw new ConflictException(
      "That value has changed since the repair, so putting it back would undo somebody else's edit rather than the system's.",
    );

  await deps.queue.reopenAfterRepairReverted(
    organizationId,
    repair.findingId ? [repair.findingId] : [],
  );

  return { reverted: true, partyId: repair.partyId, field: repair.field };
}

export async function revertRepairBatch(
  deps: RevertDeps,
  organizationId: string,
  userId: string,
  autonomousDecisionId: string,
  reason: string | null,
): Promise<{ reverted: number; skipped: number }> {
  const repairs = await deps.db
    .select()
    .from(autonomyRepairs)
    .where(
      and(
        eq(autonomyRepairs.organizationId, organizationId),
        eq(autonomyRepairs.autonomousDecisionId, autonomousDecisionId),
        isNull(autonomyRepairs.revertedAt),
      ),
    )
    .orderBy(desc(autonomyRepairs.appliedAt))
    .limit(1000);

  const restored: string[] = [];
  let skipped = 0;

  for (const repair of repairs) {
    const ok = await restore(deps.db, organizationId, userId, repair, reason);
    if (ok && repair.findingId) restored.push(repair.findingId);
    if (!ok) skipped += 1;
  }

  await deps.queue.reopenAfterRepairReverted(organizationId, restored);

  return { reverted: repairs.length - skipped, skipped };
}

export async function countUnrevertedRepairs(
  db: Db,
  organizationId: string,
  autonomousDecisionId: string,
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(autonomyRepairs)
    .where(
      and(
        eq(autonomyRepairs.organizationId, organizationId),
        eq(autonomyRepairs.autonomousDecisionId, autonomousDecisionId),
        isNull(autonomyRepairs.revertedAt),
      ),
    );

  return Number(row?.n ?? 0);
}

/**
 * One value, put back, if it is still the value the system wrote.
 *
 * `repaired_value` in the predicate is what makes the undo safe: somebody who
 * has edited the field since owns it now, and restoring over them would be a
 * reversal of their judgement rather than the system's.
 */
async function restore(
  db: Db,
  organizationId: string,
  userId: string,
  repair: typeof autonomyRepairs.$inferSelect,
  reason: string | null,
): Promise<boolean> {
  const claimed = await db
    .update(autonomyRepairs)
    .set({ revertedAt: new Date(), revertedByUserId: userId, revertedReason: reason })
    .where(
      and(
        eq(autonomyRepairs.organizationId, organizationId),
        eq(autonomyRepairs.autonomyRepairId, repair.autonomyRepairId),
        isNull(autonomyRepairs.revertedAt),
      ),
    )
    .returning({ id: autonomyRepairs.autonomyRepairId });

  // Somebody else took this one back a moment ago; theirs stands.
  if (claimed.length === 0) return false;

  const current = await currentPartyFieldValue(
    db,
    organizationId,
    repair.partyId,
    repair.field === "email" ? "email" : "phone",
  );

  if (current !== repair.repairedValue) {
    await db
      .update(autonomyRepairs)
      .set({ revertedAt: null, revertedByUserId: null, revertedReason: null })
      .where(
        and(
          eq(autonomyRepairs.organizationId, organizationId),
          eq(autonomyRepairs.autonomyRepairId, repair.autonomyRepairId),
        ),
      );
    return false;
  }

  await updatePartyWithMirror(
    db,
    organizationId,
    repair.partyId,
    fieldPatch(repair.field === "email" ? "email" : "phone", repair.previousValue),
  );

  return true;
}
