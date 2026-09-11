import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { HrAnalyticsPlusService } from "src/modules/hr/analytics-plus/hr-analytics-plus.service";
import { HrCommandCenterAnalyticsService } from "src/modules/hr/analytics-plus/hr-command-center-analytics.service";
import type { CacheService } from "src/common/cache/cache.service";
import type { Db } from "src/db/drizzle.module";

/**
 * `PATCH /hr/analytics-plus/workforce/plans/:planId` — found by the live cross-tenant sweep.
 *
 * The UPDATE is tenant-bound, so nothing ever crossed. What it did was return the unchecked row of
 * a statement that matched nothing: 200 with an empty body, identically for another organization's
 * plan id and for an id belonging to no organization. Measured control 200 / cross-tenant 200 /
 * absent 200. A write verb that answers the same whether or not it wrote is the shape
 * `cross-tenant-404-contract.md` already repaired 23 times, and it leaves a retry or idempotency
 * layer unable to tell a landed write from a no-op.
 */

const CALLER_ORG = "org-b-caller";
const FOREIGN_PLAN_ID = 9911;

/** Every value bound into a Drizzle SQL fragment, however deeply nested. */
function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

function serviceMatching(rows: Array<Record<string, unknown>>): {
  service: HrAnalyticsPlusService;
  updateWhere: unknown[];
} {
  const updateWhere: unknown[] = [];
  const db = {
    update: jest.fn().mockImplementation(() => {
      const chain = {
        set: () => chain,
        where: (w: unknown) => {
          updateWhere.push(w);
          return chain;
        },
        returning: () => Promise.resolve(rows),
      };
      return chain;
    }),
  } as unknown as Db;
  const cache = { cachedVersioned: jest.fn(), invalidateNamespace: jest.fn() } as unknown as CacheService;
  /**
   * `41cdc386` ("split hr-analytics-plus.service by responsibility") moved the command-centre roll-up
   * into its own collaborator and gave `HrAnalyticsPlusService` a third constructor argument. This
   * spec still passed two, so `this.commandCenter` was `undefined` at runtime — harmless only because
   * `updateHeadcountPlan` never reaches it, and invisible because `test/` was in no typecheck.
   * Building the REAL collaborator over the same database double keeps that honest: if this path ever
   * grows a command-centre read, it hits a double that implements nothing but `update` and throws,
   * rather than silently working against an `undefined` that was never wired.
   */
  const commandCenter = new HrCommandCenterAnalyticsService(db, cache);
  return { service: new HrAnalyticsPlusService(db, cache, commandCenter), updateWhere };
}

describe("BOLA probe — PATCH /hr/analytics-plus/workforce/plans/:planId", () => {
  it("CROSS-TENANT-MISS: another organization's plan id is refused", async () => {
    const { service } = serviceMatching([]);
    await expect(
      service.updateHeadcountPlan(CALLER_ORG, FOREIGN_PLAN_ID, { budgetedHeadcount: 3 }),
    ).rejects.toThrow(NotFoundException);
  });

  it("EXISTENCE-ORACLE-GUARD: the refusal is NotFound, never Forbidden", async () => {
    const { service } = serviceMatching([]);
    const thrown = await service
      .updateHeadcountPlan(CALLER_ORG, FOREIGN_PLAN_ID, { budgetedHeadcount: 3 })
      .catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(NotFoundException);
    expect(thrown).not.toBeInstanceOf(ForbiddenException);
  });

  it("PREDICATE-SCOPE: the update binds the CALLER's org and the plan id", async () => {
    const { service, updateWhere } = serviceMatching([]);
    await service
      .updateHeadcountPlan(CALLER_ORG, FOREIGN_PLAN_ID, { budgetedHeadcount: 3 })
      .catch(() => undefined);
    expect(updateWhere).toHaveLength(1);
    const bound = sqlValues(updateWhere[0]);
    expect(bound).toContain(CALLER_ORG);
    expect(bound).toContain(FOREIGN_PLAN_ID);
  });

  it("SAME-TENANT: a plan the caller's org holds still updates, so this is not a blanket denial", async () => {
    const { service } = serviceMatching([{ id: FOREIGN_PLAN_ID, budgetedHeadcount: 3 }]);
    await expect(
      service.updateHeadcountPlan(CALLER_ORG, FOREIGN_PLAN_ID, { budgetedHeadcount: 3 }),
    ).resolves.toMatchObject({ id: FOREIGN_PLAN_ID });
  });
});
