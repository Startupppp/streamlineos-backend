import { and, count, eq, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "../../../../db/drizzle.module";
import { deals, dealActivities, crmPipelineStages } from "../../../../db/schema";
import {
  OFFENDER_LIMIT,
  thirtyDaysAgo,
  type DataQualityAggregate,
  type DataQualityOffender,
} from "./data-quality-shapes";

/**
 * The three checks that are about DEALS: gone quiet, no next step, or missing
 * a field its pipeline stage requires.
 */

export async function staleDeals(
  db: Db,
  orgId: string,
): Promise<DataQualityAggregate> {
  const terminalStages = await db
    .select({ key: crmPipelineStages.key })
    .from(crmPipelineStages)
    .where(and(eq(crmPipelineStages.orgId, orgId), eq(crmPipelineStages.isTerminal, true), eq(crmPipelineStages.isActive, true)));
  const terminalKeys = terminalStages.map((s) => s.key);
  const cutoff = thirtyDaysAgo();
  const baseWhere = and(eq(deals.orgId, orgId), isNull(deals.deletedAt), lt(deals.updatedAt, cutoff));
  const whereClause = terminalKeys.length > 0
    ? and(baseWhere, sql`${deals.stage} NOT IN (${sql.join(terminalKeys.map((k) => sql`${k}`), sql`, `)})`)
    : baseWhere;
  const [countRow] = await db.select({ n: count() }).from(deals).where(whereClause);
  const offenderRows = await db
    .select({ id: deals.id, name: deals.name, updatedAt: deals.updatedAt })
    .from(deals)
    .where(whereClause)
    .orderBy(deals.updatedAt)
    .limit(OFFENDER_LIMIT);
  return {
    count: Number(countRow?.n ?? 0),
    offenders: offenderRows.map((r) => ({
      id: r.id,
      name: r.name,
      detail: r.updatedAt ? `Last updated: ${r.updatedAt.toISOString().slice(0, 10)}` : undefined,
    })),
  };
}

export async function dealsWithNoNextActivity(
  db: Db,
  orgId: string,
): Promise<DataQualityAggregate> {
  const terminalStages = await db
    .select({ key: crmPipelineStages.key })
    .from(crmPipelineStages)
    .where(and(eq(crmPipelineStages.orgId, orgId), eq(crmPipelineStages.isTerminal, true), eq(crmPipelineStages.isActive, true)));
  const terminalKeys = terminalStages.map((s) => s.key);
  const cutoff = thirtyDaysAgo();
  const recentActivityDealIds = await db
    .selectDistinct({ dealId: dealActivities.dealId })
    .from(dealActivities)
    .where(and(eq(dealActivities.orgId, orgId), sql`${dealActivities.createdAt} >= ${cutoff.toISOString()}`));
  const activeIds = new Set(recentActivityDealIds.map((r) => r.dealId));
  const openDeals = await db
    .select({ id: deals.id, name: deals.name, stage: deals.stage })
    .from(deals)
    .where(and(eq(deals.orgId, orgId), isNull(deals.deletedAt)));
  const stale = openDeals.filter(
    (d) => !terminalKeys.includes(d.stage) && !activeIds.has(d.id),
  );
  return {
    count: stale.length,
    offenders: stale.slice(0, OFFENDER_LIMIT).map((d) => ({ id: d.id, name: d.name, detail: `Stage: ${d.stage}` })),
  };
}

export async function dealsMissingStageFields(
  db: Db,
  orgId: string,
): Promise<DataQualityAggregate> {
  const stagesWithReqs = await db
    .select({ key: crmPipelineStages.key, requiredFields: crmPipelineStages.requiredFields })
    .from(crmPipelineStages)
    .where(and(eq(crmPipelineStages.orgId, orgId), eq(crmPipelineStages.isActive, true)));
  const reqMap = new Map<string, string[]>();
  for (const s of stagesWithReqs) {
    const fields = (s.requiredFields as string[] | null) ?? [];
    if (fields.length > 0) reqMap.set(s.key, fields);
  }
  if (reqMap.size === 0) return { count: 0, offenders: [] };
  const openDeals = await db
    .select({ id: deals.id, name: deals.name, stage: deals.stage, customData: deals.customData })
    .from(deals)
    .where(and(eq(deals.orgId, orgId), isNull(deals.deletedAt)))
    .limit(200);
  const offenders: DataQualityOffender[] = [];
  for (const deal of openDeals) {
    const required = reqMap.get(deal.stage);
    if (!required) continue;
    const record: Record<string, unknown> = { ...(deal.customData ?? {}), stage: deal.stage };
    const missing = required.filter((f) => {
      const v = record[f];
      return v === null || v === undefined || v === "";
    });
    if (missing.length > 0) {
      offenders.push({ id: deal.id, name: deal.name, detail: `Missing: ${missing.join(", ")}` });
    }
  }
  return { count: offenders.length, offenders: offenders.slice(0, OFFENDER_LIMIT) };
}
