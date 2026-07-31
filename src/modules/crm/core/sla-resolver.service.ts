import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { crmSla } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { SlaConditions } from "../../../db/schema/crm/analytics";

interface ResolveInput {
  source?: string;
  priorityKey?: string;
  score?: number;
  territoryId?: number;
  segment?: string;
  appliesTo: "lead" | "deal";
}

interface PolicyRow {
  id: number;
  name: string;
  conditions: SlaConditions;
  targetMinutes: number | null;
  firstResponseHours: number;
  businessHours: boolean;
  appliesToText: string | null;
  priorityText: string | null;
}

@Injectable()
export class SlaResolverService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async resolve(orgId: string, input: ResolveInput): Promise<PolicyRow | null> {
    const rows = await this.db
      .select({
        id: crmSla.id,
        name: crmSla.name,
        conditions: crmSla.conditions,
        targetMinutes: crmSla.targetMinutes,
        firstResponseHours: crmSla.firstResponseHours,
        businessHours: crmSla.businessHours,
        appliesToText: crmSla.appliesToText,
        priorityText: crmSla.priorityText,
      })
      .from(crmSla)
      .where(eq(crmSla.orgId, orgId))
      .limit(200);

    let best: PolicyRow | null = null;
    let bestScore = -1;

    for (const row of rows) {
      const score = this.scoreMatch(row.conditions, input);
      if (score >= 0 && score > bestScore) {
        bestScore = score;
        best = row;
      }
    }

    return best;
  }

  private scoreMatch(conditions: SlaConditions, input: ResolveInput): number {
    let score = 0;

    if (conditions.sourceKeys && conditions.sourceKeys.length > 0) {
      if (!input.source || !conditions.sourceKeys.includes(input.source)) return -1;
      score++;
    }

    if (conditions.priorityKeys && conditions.priorityKeys.length > 0) {
      if (!input.priorityKey || !conditions.priorityKeys.includes(input.priorityKey)) return -1;
      score++;
    }

    if (conditions.scoreMin !== undefined) {
      if (input.score === undefined || input.score < conditions.scoreMin) return -1;
      score++;
    }

    if (conditions.scoreMax !== undefined) {
      if (input.score === undefined || input.score > conditions.scoreMax) return -1;
      score++;
    }

    if (conditions.territoryIds && conditions.territoryIds.length > 0) {
      if (!input.territoryId || !conditions.territoryIds.includes(input.territoryId)) return -1;
      score++;
    }

    if (conditions.segment) {
      if (!input.segment || input.segment !== conditions.segment) return -1;
      score++;
    }

    if (conditions.appliesToText) {
      if (conditions.appliesToText !== input.appliesTo && conditions.appliesToText !== "both") return -1;
      score++;
    }

    return score;
  }
}
