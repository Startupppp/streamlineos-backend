import { and, count, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { deals } from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import type { CrmMetadataService } from "../../crm/metadata/crm-metadata.service";
import { assessForecastHistory, type ForecastReadiness } from "../forecast/forecast-cold-start";
import type { ForecastTrainingService } from "../forecast/forecast-training.service";
import type { DealsViewScope, ForecastMonth, ForecastSummary } from "../deals-forecast.types";

/**
 * Computing the forecast: the open pipeline, the closed history that decides
 * its `basis`, and the arithmetic over both.
 *
 * Split out of `deals-forecast.service.ts`, which keeps the cache in front of
 * this and the snapshot paths that store its answer. A deps bag and free
 * functions rather than a second `@Injectable`, the `deal-bulk-ops.ts` shape:
 * the DI graph and every caller stay unchanged.
 */
export interface ForecastSummaryDeps {
  readonly db: Db;
  readonly crmMetadata: CrmMetadataService;
  readonly forecastModel: ForecastTrainingService;
}

/**
 * The deals predicate for a caller, over the column the list narrows on.
 *
 * `deals.assignedToId` and nothing else — this is the owner column `listDeals`
 * and `getDeal` both use, and picking a different one here would quietly answer
 * about the wrong person. Exported for `DealsAnalyticsService`, whose other
 * `crm:deals:read` analytics narrow the same way; it imports this through
 * `deals-forecast.service.ts`, which re-exports it.
 */
export function visibleDeals(view: DealsViewScope, orgId: string) {
  return view.compose(
    {
      tenant: deals.orgId,
      scope: { columns: { ownerColumn: deals.assignedToId } },
      and: [eq(deals.orgId, orgId)],
    },
    (where) => where.sql,
    () => sql`false`,
  );
}

async function getTerminalStageKeys(
  crmMetadata: CrmMetadataService,
  orgId: string,
): Promise<{ wonKeys: string[]; lostKeys: string[] }> {
  const metadata = await crmMetadata.getAggregate(orgId);
  const wonKeys = metadata.stages
    .filter((s) => s.stageType === "won" && s.isActive)
    .map((s) => s.key);
  const lostKeys = metadata.stages
    .filter((s) => s.stageType === "lost" && s.isActive)
    .map((s) => s.key);
  return { wonKeys: wonKeys.length ? wonKeys : ["WON"], lostKeys: lostKeys.length ? lostKeys : ["LOST"] };
}

/**
 * The forecast over the deals `view` may see, uncached. Whether an answer is
 * cached is `DealsForecastService.getForecast`'s decision, not this one's.
 */
export async function buildForecast(
  deps: ForecastSummaryDeps,
  orgId: string,
  view: DealsViewScope,
): Promise<ForecastSummary> {
  const { wonKeys, lostKeys } = await getTerminalStageKeys(deps.crmMetadata, orgId);
  const metaRaw = await deps.crmMetadata.getAggregate(orgId);
  const stageProbMap = new Map<string, number>(
    metaRaw.stages
      .filter((s) => s.isActive)
      .map((s) => [s.key, s.probability]),
  );

  // The closed count is read against the SAME terminal keys that exclude those
  // deals from the open pipeline above. If getTerminalStageKeys falls back to
  // ["WON"]/["LOST"] because the tenant has no active terminal stages, the two
  // reads are wrong together rather than separately: a deal is never both
  // absent from the pipeline and absent from the history that would explain it.
  //
  // THE TWO READS TAKE DIFFERENT SCOPES ON PURPOSE. The open pipeline is the
  // caller's — every money figure in the response comes out of it, and a rep
  // granted `own` must read their forecast and not the organisation's. The
  // closed history is NOT narrowed, because the only thing it produces is
  // `basis`: whether THIS ORGANISATION has enough closed deals to have trained
  // a forecast model. That is one fact about the product's state, identical for
  // every caller, and narrowing it would tell a rep with three closed deals
  // that their organisation cannot be forecast — a wrong answer, in the service
  // of hiding a count of deals that carries no name, no value and no customer.
  const [allDeals, closedByStage] = await Promise.all([
    deps.db
      .select({
        id: deals.id,
        value: deals.value,
        stage: deals.stage,
        probability: deals.probability,
        expectedCloseDate: deals.expectedCloseDate,
        createdAt: deals.createdAt,
      })
      .from(deals)
      .where(and(eq(deals.orgId, orgId), isNull(deals.deletedAt), notInArray(deals.stage, [...wonKeys, ...lostKeys]), visibleDeals(view, orgId)))
      .limit(10000),
    deps.db
      .select({ stage: deals.stage, closed: count() })
      .from(deals)
      .where(and(eq(deals.orgId, orgId), isNull(deals.deletedAt), inArray(deals.stage, [...wonKeys, ...lostKeys])))
      .groupBy(deals.stage)
      // One row per terminal stage key, so this never approaches the bound.
      .limit(1000),
  ]);

  /**
   * The learned probabilities, where this organisation has a model that earned
   * the right to produce them.
   *
   * Read rather than computed: the nightly pass writes one row per open deal
   * with the features beside the answer, so the totals here and the
   * explanation on a deal page are the same arithmetic over the same numbers.
   * Computing them again in a cached GET would also be a write in a GET, since
   * a score that nobody stored cannot be argued with later.
   *
   * A deal with no row falls back to the weighted arithmetic below, which is
   * what it was already doing. That happens for a deal created since the last
   * pass, and for every deal in a tenant on the naive arm.
   */
  const readiness = forecastReadiness(closedByStage, wonKeys);
  const [basis, learnedProbabilities] = await Promise.all([
    deps.forecastModel.basisFor(orgId, readiness),
    deps.forecastModel.probabilitiesForOpenDeals(orgId),
  ]);

  const monthMap = new Map<string, ForecastMonth>();
  const stageMap = new Map<string, { count: number; totalValue: number; weightedValue: number; probSum: number }>();

  for (const deal of allDeals) {
    const value = Number(deal.value ?? 0);
    const learned = learnedProbabilities.get(deal.id);
    const probability =
      learned === undefined
        ? deal.probability || stageProbMap.get(deal.stage) || 20
        : learned * 100;
    const weighted = Math.round((value * probability) / 100);

    const closeDate = deal.expectedCloseDate
      ? new Date(deal.expectedCloseDate)
      : deal.createdAt
        ? new Date(new Date(deal.createdAt).getTime() + 90 * 24 * 60 * 60 * 1000)
        : new Date();

    const monthKey = `${closeDate.getFullYear()}-${String(closeDate.getMonth() + 1).padStart(2, "0")}`;
    const monthLabel = closeDate.toLocaleDateString("en-IN", { month: "short", year: "numeric" });

    const existing = monthMap.get(monthKey) ?? { month: monthKey, label: monthLabel, weighted: 0, bestCase: 0, dealCount: 0 };
    existing.weighted += weighted;
    existing.bestCase += value;
    existing.dealCount += 1;
    monthMap.set(monthKey, existing);

    const stageData = stageMap.get(deal.stage) ?? { count: 0, totalValue: 0, weightedValue: 0, probSum: 0 };
    stageData.count += 1;
    stageData.totalValue += value;
    stageData.weightedValue += weighted;
    stageData.probSum += probability;
    stageMap.set(deal.stage, stageData);
  }

  const byMonth = [...monthMap.values()].sort((a, b) => a.month.localeCompare(b.month));
  const byStage = [...stageMap.entries()].map(([stage, data]) => ({
    stage,
    count: data.count,
    totalValue: data.totalValue,
    weightedValue: data.weightedValue,
    avgProbability: data.count > 0 ? Math.round(data.probSum / data.count) : 0,
  }));

  return {
    totalWeighted: byMonth.reduce((s, m) => s + m.weighted, 0),
    totalBestCase: byMonth.reduce((s, m) => s + m.bestCase, 0),
    totalDeals: allDeals.length,
    byMonth,
    byStage,
    basis,
  };
}

/**
 * How much closed history this organisation has, against the floor a learned
 * forecast needs.
 *
 * Two readers, one arithmetic. `basisFor` turns this into the label the
 * response carries, and the standalone model endpoint counts the same rows a
 * different way to reach the same answer — which is why the counting lives
 * here and the labelling does not.
 *
 * The two naive reasons are not interchangeable. "insufficient-history" means
 * the tenant cannot yet be given better and readiness says how much is
 * missing; "not-trained-yet" means they could be and no accepted model exists,
 * which is our gap and not theirs. A surface that renders both as "not enough
 * data" is lying to the second tenant.
 *
 * Note for whoever writes that surface: the flat 20 in the loop above is a
 * default nobody typed, so copy along the lines of "the probabilities you set
 * yourself" is false for any deal left at 0 or sitting in a stage with no
 * active metadata.
 */
function forecastReadiness(
  closedByStage: Array<{ stage: string; closed: number }>,
  wonKeys: string[],
): ForecastReadiness {
  const wonKeySet = new Set(wonKeys);
  let won = 0;
  let lost = 0;
  for (const row of closedByStage) {
    // count() comes back as a number from drizzle, but a raw driver row can
    // still hand over a bigint-as-string; Number() here rather than trusting it.
    const closed = Number(row.closed ?? 0);
    if (wonKeySet.has(row.stage)) won += closed;
    else lost += closed;
  }

  return assessForecastHistory({ won, lost });
}
