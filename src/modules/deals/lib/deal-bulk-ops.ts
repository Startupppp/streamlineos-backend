import { BadRequestException } from "@nestjs/common";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { deals, dealStageTransitions, organizationMembers } from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { AuditService } from "../../../common/audit/audit.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { toTransitionRow } from "../deal-stage-ledger";
import type { DealBulkDeleteInput, DealBulkUpdateInput } from "../dto/deals.schemas";

/**
 * Changing many deals at once.
 *
 * Split from the one-at-a-time surface because the bulk paths are the only ones
 * that can move a SET of deals across stages, and a stage move writes to the
 * transition ledger — so they carry arithmetic (`toMinorUnits`,
 * `toTransitionRow`) that the single-deal create and delete never touch.
 * `invalidateDealCaches` moves with them because it exists for exactly this:
 * one bust after N rows rather than N busts.
 *
 * A deps bag and free functions rather than a second `@Injectable`, the
 * `so-ship.ts` shape: the DI graph and every caller stay unchanged.
 */
export interface DealBulkDeps {
  readonly db: Db;
  readonly cache: CacheService;
  readonly audit: AuditService;
}

/**
 * One batched UPDATE rather than N single writes: the whole selection either
 * moves or it does not, and the row count comes from `.returning()` so a
 * caller passing another tenant's ids is told 0, not "success".
 */
export async function bulkUpdate(
  deps: DealBulkDeps,
  orgId: string,
  userId: string,
  input: DealBulkUpdateInput,
) {
  const setData: Partial<typeof deals.$inferInsert> = { updatedAt: new Date() };
  if (input.update.stage !== undefined) setData.stage = input.update.stage;

  if (input.update.assignedToId !== undefined) {
    const member = await deps.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.userId, input.update.assignedToId),
        eq(organizationMembers.orgId, orgId),
      ),
      columns: { userId: true },
    });
    if (!member) throw new BadRequestException("Assignee is not a member of this organization");
    setData.assignedToId = input.update.assignedToId;
  }

  /**
   * A bulk stage change is still a stage change.
   *
   * This path used to move any number of deals with no transition recorded at
   * all, so the pipeline's own history depended on which screen a person
   * happened to use. The prior stages are read and the ledger written inside
   * the same transaction as the update, so a rolled-back move leaves no row
   * claiming it happened.
   */
  const updated = await deps.db.transaction(async (tx) => {
    const before =
      setData.stage === undefined
        ? []
        : await (tx as Db)
            .select({ id: deals.id, stage: deals.stage, pipelineId: deals.pipelineId })
            .from(deals)
            .where(
              and(
                eq(deals.orgId, orgId),
                inArray(deals.id, input.dealIds),
                isNull(deals.deletedAt),
              ),
            );

    const rows = await (tx as Db)
      .update(deals)
      .set(setData)
      .where(
        and(
          eq(deals.orgId, orgId),
          inArray(deals.id, input.dealIds),
          isNull(deals.deletedAt),
        ),
      )
      .returning({ id: deals.id });

    const toStage = setData.stage;
    if (toStage !== undefined) {
      const moved = before.filter((deal) => deal.stage !== toStage);
      if (moved.length > 0)
        await (tx as Db).insert(dealStageTransitions).values(
          moved.map((deal) =>
            toTransitionRow({
              organizationId: orgId,
              dealId: deal.id,
              pipelineId: deal.pipelineId ?? null,
              fromStage: deal.stage ?? null,
              toStage,
              actor: { kind: "human", userId },
              reason: "Bulk stage change",
            }),
          ),
        );
    }

    return rows;
  });

  await invalidateDealCaches(deps, orgId);
  deps.audit.log({
    action: "deal.bulk_updated",
    userId,
    orgId,
    targetType: "deal",
    metadata: { requested: input.dealIds.length, updated: updated.length, update: input.update },
  });

  return { updated: updated.length, requested: input.dealIds.length };
}

export async function bulkDelete(
  deps: DealBulkDeps,
  orgId: string,
  userId: string,
  input: DealBulkDeleteInput,
) {
  const deleted = await deps.db
    .update(deals)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(deals.orgId, orgId),
        inArray(deals.id, input.dealIds),
        isNull(deals.deletedAt),
      ),
    )
    .returning({ id: deals.id });

  await invalidateDealCaches(deps, orgId);
  deps.audit.log({
    action: "deal.bulk_deleted",
    userId,
    orgId,
    targetType: "deal",
    metadata: { requested: input.dealIds.length, deleted: deleted.length },
  });

  return { deleted: deleted.length, requested: input.dealIds.length };
}

export async function invalidateDealCaches(
  deps: DealBulkDeps,
  orgId: string,
): Promise<void> {
  await Promise.all([
    deps.cache.invalidateNamespace(`deals:list:${orgId}`),
    deps.cache.invalidate(CACHE_KEYS.dealsForecast(orgId)),
    deps.cache.invalidate(CACHE_KEYS.salesDashboard(orgId)),
  ]);
}
