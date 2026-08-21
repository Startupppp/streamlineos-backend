import { Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq, isNull, lt, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { leads, deals, dealActivities, crmPipelineStages } from "../../../db/schema";

const OFFENDER_LIMIT = 10;
const PHONE_BASIC_RE = /^[+\d\s\-().]{7,20}$/;

function thirtyDaysAgo(): Date {
  return new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
}

interface DataQualityOffender {
  id: number | string;
  name: string;
  detail?: string;
}

interface DataQualityAggregate {
  count: number;
  offenders: DataQualityOffender[];
}

export interface DataQualityReport {
  leadsWithoutEmail: DataQualityAggregate;
  leadsWithInvalidPhone: DataQualityAggregate;
  duplicateLeads: DataQualityAggregate;
  duplicateCompanies: DataQualityAggregate;
  staleDeals: DataQualityAggregate;
  dealsWithNoNextActivity: DataQualityAggregate;
  leadsWithNoOwner: DataQualityAggregate;
  dealsMissingStageFields: DataQualityAggregate;
}

@Injectable()
export class CrmDataQualityService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getReport(orgId: string): Promise<DataQualityReport> {
    const [
      leadsWithoutEmail,
      leadsWithInvalidPhone,
      duplicateLeads,
      duplicateCompanies,
      staleDeals,
      dealsWithNoNextActivity,
      leadsWithNoOwner,
      dealsMissingStageFields,
    ] = await Promise.all([
      this.leadsWithoutEmail(orgId),
      this.leadsWithInvalidPhone(orgId),
      this.duplicateLeads(orgId),
      this.duplicateCompanies(orgId),
      this.staleDeals(orgId),
      this.dealsWithNoNextActivity(orgId),
      this.leadsWithNoOwner(orgId),
      this.dealsMissingStageFields(orgId),
    ]);
    return {
      leadsWithoutEmail,
      leadsWithInvalidPhone,
      duplicateLeads,
      duplicateCompanies,
      staleDeals,
      dealsWithNoNextActivity,
      leadsWithNoOwner,
      dealsMissingStageFields,
    };
  }

  private async leadsWithoutEmail(orgId: string): Promise<DataQualityAggregate> {
    const [countRow] = await this.db
      .select({ n: count() })
      .from(leads)
      .where(and(eq(leads.orgId, orgId), isNull(leads.deletedAt), isNull(leads.email)));
    const offenderRows = await this.db
      .select({ id: leads.id, name: leads.name })
      .from(leads)
      .where(and(eq(leads.orgId, orgId), isNull(leads.deletedAt), isNull(leads.email)))
      .orderBy(desc(leads.createdAt))
      .limit(OFFENDER_LIMIT);
    return {
      count: Number(countRow?.n ?? 0),
      offenders: offenderRows.map((r) => ({ id: r.id, name: r.name })),
    };
  }

  private async leadsWithInvalidPhone(orgId: string): Promise<DataQualityAggregate> {
    const rows = await this.db
      .select({ id: leads.id, name: leads.name, phone: leads.phone })
      .from(leads)
      .where(and(eq(leads.orgId, orgId), isNull(leads.deletedAt)))
      .orderBy(desc(leads.createdAt));
    const invalid = rows.filter(
      (r) => r.phone !== null && r.phone !== undefined && r.phone !== "" && !PHONE_BASIC_RE.test(r.phone),
    );
    return {
      count: invalid.length,
      offenders: invalid.slice(0, OFFENDER_LIMIT).map((r) => ({ id: r.id, name: r.name, detail: r.phone ?? undefined })),
    };
  }

  private async duplicateLeads(orgId: string): Promise<DataQualityAggregate> {
    const emailDups = await this.db.execute(
      sql`
        SELECT email,
               string_agg(id::text, ',') AS ids,
               string_agg(name, ' | ') AS names
        FROM leads
        WHERE org_id = ${orgId}
          AND deleted_at IS NULL
          AND email IS NOT NULL
          AND email != ''
        GROUP BY email
        HAVING count(*) > 1
        LIMIT ${OFFENDER_LIMIT}
      `,
    );
    const phoneDups = await this.db.execute(
      sql`
        SELECT phone,
               string_agg(id::text, ',') AS ids,
               string_agg(name, ' | ') AS names
        FROM leads
        WHERE org_id = ${orgId}
          AND deleted_at IS NULL
          AND phone IS NOT NULL
          AND phone != ''
        GROUP BY phone
        HAVING count(*) > 1
        LIMIT ${OFFENDER_LIMIT}
      `,
    );
    const emailOffenders = (emailDups as Array<Record<string, unknown>>).map((r) => ({
      id: String(r["ids"] ?? ""),
      name: String(r["names"] ?? ""),
      detail: `Duplicate email: ${String(r["email"] ?? "")}`,
    }));
    const phoneOffenders = (phoneDups as Array<Record<string, unknown>>).map((r) => ({
      id: String(r["ids"] ?? ""),
      name: String(r["names"] ?? ""),
      detail: `Duplicate phone: ${String(r["phone"] ?? "")}`,
    }));
    const offenders = [...emailOffenders, ...phoneOffenders].slice(0, OFFENDER_LIMIT);
    return { count: emailOffenders.length + phoneOffenders.length, offenders };
  }

  private async duplicateCompanies(orgId: string): Promise<DataQualityAggregate> {
    const dups = await this.db.execute(
      sql`
        SELECT lower(trim(name)) AS norm_name,
               string_agg(id::text, ',') AS ids,
               string_agg(name, ' | ') AS names
        FROM crm_organizations
        WHERE org_id = ${orgId}
          AND deleted_at IS NULL
        GROUP BY lower(trim(name))
        HAVING count(*) > 1
        LIMIT ${OFFENDER_LIMIT}
      `,
    );
    const offenders = (dups as Array<Record<string, unknown>>).map((r) => ({
      id: String(r["ids"] ?? ""),
      name: String(r["names"] ?? ""),
      detail: `Normalized: ${String(r["norm_name"] ?? "")}`,
    }));
    return { count: offenders.length, offenders };
  }

  private async staleDeals(orgId: string): Promise<DataQualityAggregate> {
    const terminalStages = await this.db
      .select({ key: crmPipelineStages.key })
      .from(crmPipelineStages)
      .where(and(eq(crmPipelineStages.orgId, orgId), eq(crmPipelineStages.isTerminal, true), eq(crmPipelineStages.isActive, true)));
    const terminalKeys = terminalStages.map((s) => s.key);
    const cutoff = thirtyDaysAgo();
    const baseWhere = and(eq(deals.orgId, orgId), isNull(deals.deletedAt), lt(deals.updatedAt, cutoff));
    const whereClause = terminalKeys.length > 0
      ? and(baseWhere, sql`${deals.stage} NOT IN (${sql.join(terminalKeys.map((k) => sql`${k}`), sql`, `)})`)
      : baseWhere;
    const [countRow] = await this.db.select({ n: count() }).from(deals).where(whereClause);
    const offenderRows = await this.db
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

  private async dealsWithNoNextActivity(orgId: string): Promise<DataQualityAggregate> {
    const terminalStages = await this.db
      .select({ key: crmPipelineStages.key })
      .from(crmPipelineStages)
      .where(and(eq(crmPipelineStages.orgId, orgId), eq(crmPipelineStages.isTerminal, true), eq(crmPipelineStages.isActive, true)));
    const terminalKeys = terminalStages.map((s) => s.key);
    const cutoff = thirtyDaysAgo();
    const recentActivityDealIds = await this.db
      .selectDistinct({ dealId: dealActivities.dealId })
      .from(dealActivities)
      .where(and(eq(dealActivities.orgId, orgId), sql`${dealActivities.createdAt} >= ${cutoff.toISOString()}`));
    const activeIds = new Set(recentActivityDealIds.map((r) => r.dealId));
    const openDeals = await this.db
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

  private async leadsWithNoOwner(orgId: string): Promise<DataQualityAggregate> {
    const [countRow] = await this.db
      .select({ n: count() })
      .from(leads)
      .where(and(eq(leads.orgId, orgId), isNull(leads.deletedAt), isNull(leads.assignedToId)));
    const offenderRows = await this.db
      .select({ id: leads.id, name: leads.name })
      .from(leads)
      .where(and(eq(leads.orgId, orgId), isNull(leads.deletedAt), isNull(leads.assignedToId)))
      .orderBy(desc(leads.createdAt))
      .limit(OFFENDER_LIMIT);
    return {
      count: Number(countRow?.n ?? 0),
      offenders: offenderRows.map((r) => ({ id: r.id, name: r.name })),
    };
  }

  private async dealsMissingStageFields(orgId: string): Promise<DataQualityAggregate> {
    const stagesWithReqs = await this.db
      .select({ key: crmPipelineStages.key, requiredFields: crmPipelineStages.requiredFields })
      .from(crmPipelineStages)
      .where(and(eq(crmPipelineStages.orgId, orgId), eq(crmPipelineStages.isActive, true)));
    const reqMap = new Map<string, string[]>();
    for (const s of stagesWithReqs) {
      const fields = (s.requiredFields as string[] | null) ?? [];
      if (fields.length > 0) reqMap.set(s.key, fields);
    }
    if (reqMap.size === 0) return { count: 0, offenders: [] };
    const openDeals = await this.db
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
}
