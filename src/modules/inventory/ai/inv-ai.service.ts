import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { invAiInsights } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { INV_ANOMALY_DETECTORS } from "./anomalies/inv-anomaly-detectors";
import { anomalyVisibilityPredicate } from "./anomalies/inv-anomaly-visibility";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { ListInsightsInput, UpdateInsightStatusInput, InsightCandidate } from "./dto/ai-insights.schemas";
import {
  detectStockoutRisk,
  detectDeadStock,
  detectNegativeStock,
  detectExpiryRisk,
} from "./lib/insight-detectors";
import {
  detectUnusualAdjustments,
  detectVendorDelay,
} from "./lib/insight-detectors-activity";


export type OpsBriefSeverity = "high" | "medium" | "low" | "none";

export interface OpsBriefSignal {
  key: string;
  label: string;
  /** A deterministic inventory route. Never model output. */
  href: string;
  count: number;
  severity: OpsBriefSeverity;
}

export interface InventoryOpsBrief {
  generatedAt: string;
  totalSignals: number;
  signals: OpsBriefSignal[];
}

/**
 * One row per detector. A signal with no route would be a dead end -- the
 * acceptance criterion is that every figure in the brief can be opened on the
 * screen that computed it.
 *
 * F3. The label and the route now come from the detector registry rather than
 * from a second list here. Two lists is how a detector ends up described one way
 * on the brief and another way in the queue.
 */
const OPS_BRIEF_SIGNALS = [
  INV_ANOMALY_DETECTORS.stockout_risk,
  INV_ANOMALY_DETECTORS.expiry_risk,
  INV_ANOMALY_DETECTORS.negative_stock,
  INV_ANOMALY_DETECTORS.unusual_adjustments,
  INV_ANOMALY_DETECTORS.vendor_delay,
  INV_ANOMALY_DETECTORS.dead_stock,
] as const;

const SEVERITY_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

function worstSeverity(severities: readonly string[]): OpsBriefSeverity {
  let worst: OpsBriefSeverity = "none";
  let rank = 0;
  for (const severity of severities) {
    const candidate = SEVERITY_RANK[severity] ?? 0;
    if (candidate > rank) {
      rank = candidate;
      worst = severity as OpsBriefSeverity;
    }
  }
  return worst;
}

@Injectable()
export class InvAiService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly warehouseScope: WarehouseScopeService,
  ) {}

  /**
   * F3. The older insights list, now behind the same gate as the queue.
   *
   * These two routes and the anomaly queue read the same table. Before F3 the
   * queue was warehouse-scoped and this pair were not, which is the worst
   * possible arrangement: a gate a second route walks around only makes the
   * audit look better. Both now call `anomalyVisibilityPredicate`, so there is
   * one definition of who may see a finding and no second one to forget.
   */
  async listInsights(user: CurrentUserContext, filters: ListInsightsInput) {
    const { orgId, userId } = user;
    const { status, type, page, limit } = filters;
    const offset = (page - 1) * limit;
    const scope = await this.warehouseScope.resolve(orgId, userId);
    const conditions = [eq(invAiInsights.orgId, orgId), anomalyVisibilityPredicate(scope)];
    if (status) conditions.push(eq(invAiInsights.status, status));
    if (type) conditions.push(eq(invAiInsights.insightType, type));

    const where = and(...conditions);
    const [items, [countRow]] = await Promise.all([
      this.db.query.invAiInsights.findMany({
        where,
        orderBy: [desc(invAiInsights.createdAt)],
        limit,
        offset,
      }),
      this.db.select({ total: sql<number>`count(*)::int` }).from(invAiInsights).where(where),
    ]);

    return { items, total: countRow?.total ?? 0, page, totalPages: Math.ceil((countRow?.total ?? 0) / limit) };
  }

  async generateInsights(orgId: string) {
    const candidates = await this.collectCandidates(orgId);
    const existing = await this.db.query.invAiInsights.findMany({
      where: and(eq(invAiInsights.orgId, orgId), eq(invAiInsights.status, "NEW")),
      columns: { insightType: true, sourceRefs: true },
    });

    const existingKeys = new Set<string>(
      existing.map((e) => {
        const refs: Record<string, unknown> = e.sourceRefs ?? {};
        return `${e.insightType}:${refs["_key"] ?? ""}`;
      }),
    );

    const newCandidates = candidates.filter(
      (c) => !existingKeys.has(`${c.insightType}:${c.sourceKey}`),
    );

    if (newCandidates.length === 0) return { generated: 0 };

    await this.db.insert(invAiInsights).values(
      newCandidates.map((c) => ({
        orgId,
        insightType: c.insightType,
        severity: c.severity,
        title: c.title,
        body: c.body,
        sourceRefs: { ...c.sourceRefs, _key: c.sourceKey },
        status: "NEW" as const,
        // F3. Stored on the row, not re-derived on read: what the detector
        // meant *then* survives a threshold change made later.
        warehouseId: c.warehouseId,
        windowDays: c.windowDays,
        evidenceHash: c.evidenceHash,
      })),
    );

    await this.cache.invalidate(CACHE_KEYS.invAiInsightsList(orgId));
    return { generated: newCandidates.length };
  }

  /**
   * F3. Acknowledging or dismissing through the older route.
   *
   * Two changes, and both are about the write rather than the read. The scope
   * predicate is applied to the `UPDATE` itself, so an id learned some other way
   * — a stale tab, a link from a colleague at another site — is not a capability;
   * and the actor and time are recorded, because a status with nobody's name on
   * it is a queue nobody is accountable for.
   *
   * The pre-read is gone. It was a `findFirst` followed by an id-only update,
   * which is a check that does not gate the write it precedes; the affected-row
   * count does, and it is one statement rather than two.
   */
  async updateInsightStatus(
    user: CurrentUserContext,
    insightId: number,
    body: UpdateInsightStatusInput,
  ) {
    const { orgId, userId } = user;
    const scope = await this.warehouseScope.resolve(orgId, userId);

    const [updated] = await this.db
      .update(invAiInsights)
      .set({ status: body.status, acknowledgedBy: userId, acknowledgedAt: new Date() })
      .where(
        and(
          eq(invAiInsights.id, insightId),
          eq(invAiInsights.orgId, orgId),
          anomalyVisibilityPredicate(scope),
        ),
      )
      .returning();

    // A miss is a miss, whatever caused it — wrong tenant, wrong site, or no such
    // row. §4's existence-oracle rule: the caller learns this id is not theirs
    // to act on and nothing more.
    if (!updated) throw new NotFoundException("Not found");

    await this.cache.invalidate(CACHE_KEYS.invAiInsightsList(orgId));
    return updated;
  }

  /**
   * INV-101 — the deterministic half of the Operations Brief.
   *
   * Every figure here is computed by the six detectors that already back the
   * insight engine; no model is involved and nothing is charged. That split is
   * the point: the brief renders on page load from facts, and the narrative is
   * a separate, explicit, paid request over the same numbers. A card that
   * quietly spent credits whenever somebody opened the dashboard would be a
   * bill nobody authorised.
   *
   * Each signal carries the route that answers it, so a reader can always leave
   * the summary for the deterministic screen that produced it.
   */
  async getOpsBrief(orgId: string): Promise<InventoryOpsBrief> {
    const candidates = await this.collectCandidates(orgId);

    const signals = OPS_BRIEF_SIGNALS.map((definition) => {
      const matching = candidates.filter(
        (candidate) => candidate.insightType === definition.type,
      );
      return {
        key: definition.type,
        label: definition.label,
        href: definition.href,
        count: matching.length,
        // The worst thing present, not an average: one high-severity stockout
        // is the headline even beside forty low-severity ones.
        severity: worstSeverity(matching.map((candidate) => candidate.severity)),
      };
    });

    return {
      generatedAt: new Date().toISOString(),
      totalSignals: signals.reduce((sum, signal) => sum + signal.count, 0),
      signals,
    };
  }

  private async collectCandidates(orgId: string): Promise<InsightCandidate[]> {
    const results = await Promise.allSettled([
      detectStockoutRisk(this.db, orgId),
      detectDeadStock(this.db, orgId),
      detectVendorDelay(this.db, orgId),
      detectNegativeStock(this.db, orgId),
      detectUnusualAdjustments(this.db, orgId),
      detectExpiryRisk(this.db, orgId),
    ]);

    return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  }

}
