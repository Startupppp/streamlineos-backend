import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, inArray, not } from "drizzle-orm";
import { finCashFlowScenarios, organizationMembers } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import type {
  CreateScenarioInput,
  UpdateScenarioInput,
} from "./dto/finance-planning.schemas";

const SEED_SCENARIOS: Array<{
  kind: "CONSERVATIVE" | "EXPECTED" | "AGGRESSIVE";
  name: string;
  assumptions: Record<string, unknown>;
}> = [
  {
    kind: "CONSERVATIVE",
    name: "Conservative",
    assumptions: {
      collectionRatePct: 60,
      payDelayDays: 30,
      revenueGrowthPct: -10,
      plannedSpend: [],
    },
  },
  {
    kind: "EXPECTED",
    name: "Expected",
    assumptions: {
      collectionRatePct: 90,
      payDelayDays: 7,
      revenueGrowthPct: 0,
      plannedSpend: [],
    },
  },
  {
    kind: "AGGRESSIVE",
    name: "Aggressive",
    assumptions: {
      collectionRatePct: 100,
      payDelayDays: 0,
      revenueGrowthPct: 15,
      plannedSpend: [],
    },
  },
];

@Injectable()
export class ScenariosService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
  ) {}

  async listScenarios(orgId: string) {
    return this.db
      .select()
      .from(finCashFlowScenarios)
      .where(eq(finCashFlowScenarios.orgId, orgId))
      .orderBy(asc(finCashFlowScenarios.createdAt))
      .limit(100);
  }

  async createScenario(
    orgId: string,
    userId: string,
    input: CreateScenarioInput,
  ) {
    if (input.isDefault) {
      await this.db
        .update(finCashFlowScenarios)
        .set({ isDefault: false })
        .where(
          and(
            eq(finCashFlowScenarios.orgId, orgId),
            eq(finCashFlowScenarios.isDefault, true),
          ),
        );
    }

    const [scenarioActor] = await this.db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)))
      .limit(1);
    const createdByMembershipId = scenarioActor?.id ?? null;

    const [created] = await this.db
      .insert(finCashFlowScenarios)
      .values({
        orgId,
        name: input.name,
        kind: input.kind ?? "CUSTOM",
        assumptions: input.assumptions ?? null,
        isDefault: input.isDefault ?? false,
        createdByMembershipId,
      })
      .returning();

    await this.cache.invalidateNamespace(CACHE_KEYS.finForecastNamespace(orgId));

    this.audit.log({
      action: "scenario.created",
      userId,
      orgId,
      resourceType: "fin_cash_flow_scenario",
      resourceId: String(created?.id ?? ""),
    });

    return created;
  }

  async updateScenario(
    orgId: string,
    scenarioId: number,
    userId: string,
    input: UpdateScenarioInput,
  ) {
    const existing = await this.db
      .select()
      .from(finCashFlowScenarios)
      .where(
        and(
          eq(finCashFlowScenarios.id, scenarioId),
          eq(finCashFlowScenarios.orgId, orgId),
        ),
      )
      .limit(1);

    if (existing.length === 0) {
      throw new NotFoundException("Scenario not found");
    }

    if (input.isDefault === true) {
      await this.db
        .update(finCashFlowScenarios)
        .set({ isDefault: false })
        .where(
          and(
            eq(finCashFlowScenarios.orgId, orgId),
            eq(finCashFlowScenarios.isDefault, true),
            not(eq(finCashFlowScenarios.id, scenarioId)),
          ),
        );
    }

    const updateValues: Partial<typeof finCashFlowScenarios.$inferInsert> = {};
    if (input.name !== undefined) updateValues.name = input.name;
    if (input.isDefault !== undefined) updateValues.isDefault = input.isDefault;
    if (input.assumptions !== undefined)
      updateValues.assumptions = input.assumptions;

    const [updated] = await this.db
      .update(finCashFlowScenarios)
      .set(updateValues)
      .where(
        and(
          eq(finCashFlowScenarios.id, scenarioId),
          eq(finCashFlowScenarios.orgId, orgId),
        ),
      )
      .returning();

    await this.cache.invalidateNamespace(CACHE_KEYS.finForecastNamespace(orgId));

    this.audit.log({
      action: "scenario.updated",
      userId,
      orgId,
      resourceType: "fin_cash_flow_scenario",
      resourceId: String(scenarioId),
    });

    return updated;
  }

  async deleteScenario(
    orgId: string,
    scenarioId: number,
    userId: string,
  ): Promise<void> {
    const existing = await this.db
      .select({ id: finCashFlowScenarios.id })
      .from(finCashFlowScenarios)
      .where(
        and(
          eq(finCashFlowScenarios.id, scenarioId),
          eq(finCashFlowScenarios.orgId, orgId),
        ),
      )
      .limit(1);

    if (existing.length === 0) {
      throw new NotFoundException("Scenario not found");
    }

    await this.db
      .delete(finCashFlowScenarios)
      .where(
        and(
          eq(finCashFlowScenarios.id, scenarioId),
          eq(finCashFlowScenarios.orgId, orgId),
        ),
      );

    await this.cache.invalidateNamespace(CACHE_KEYS.finForecastNamespace(orgId));

    this.audit.log({
      action: "scenario.deleted",
      userId,
      orgId,
      resourceType: "fin_cash_flow_scenario",
      resourceId: String(scenarioId),
    });
  }

  async seedDefaults(
    orgId: string,
    userId: string,
  ): Promise<{ created: number }> {
    const existingRows = await this.db
      .select({
        kind: finCashFlowScenarios.kind,
        isDefault: finCashFlowScenarios.isDefault,
      })
      .from(finCashFlowScenarios)
      .where(
        and(
          eq(finCashFlowScenarios.orgId, orgId),
          inArray(
            finCashFlowScenarios.kind,
            ["CONSERVATIVE", "EXPECTED", "AGGRESSIVE"],
          ),
        ),
      );

    const existingKinds = new Set(existingRows.map((r) => r.kind));
    const hasDefault = existingRows.some((r) => r.isDefault);

    const toInsert = SEED_SCENARIOS.filter((s) => !existingKinds.has(s.kind));

    if (toInsert.length === 0) return { created: 0 };

    const [seedActor] = await this.db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)))
      .limit(1);
    const seededByMembershipId = seedActor?.id ?? null;

    for (const scenario of toInsert) {
      const shouldBeDefault =
        !hasDefault && scenario.kind === "EXPECTED";

      if (shouldBeDefault) {
        await this.db
          .update(finCashFlowScenarios)
          .set({ isDefault: false })
          .where(
            and(
              eq(finCashFlowScenarios.orgId, orgId),
              eq(finCashFlowScenarios.isDefault, true),
            ),
          );
      }

      await this.db.insert(finCashFlowScenarios).values({
        orgId,
        name: scenario.name,
        kind: scenario.kind,
        assumptions: scenario.assumptions,
        isDefault: shouldBeDefault,
        createdByMembershipId: seededByMembershipId,
      });
    }

    this.audit.log({
      action: "scenario.seeded",
      userId,
      orgId,
      metadata: { created: toInsert.length },
    });

    await this.cache.invalidateNamespace(CACHE_KEYS.finForecastNamespace(orgId));
    return { created: toInsert.length };
  }
}
