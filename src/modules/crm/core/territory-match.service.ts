import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, isNull } from "drizzle-orm";
import { territories, territoryReps } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { TerritoryCriteria } from "../../../db/schema/crm/deals-territories";

const TERRITORY_LIMIT = 200;
const TERRITORY_REP_LIMIT = 2000;

interface MatchInput {
  city?: string;
  state?: string;
  country?: string;
  industry?: string;
  companySize?: string;
  productKeys?: string[];
  accountType?: string;
}

interface MatchResult {
  territory: {
    id: number;
    name: string;
    priority: number;
    assignedReps: number[];
  };
  assignedReps: number[];
}

@Injectable()
export class TerritoryMatchService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async match(orgId: string, input: MatchInput): Promise<MatchResult | null> {
    const [rows, allReps] = await Promise.all([
      this.db
        .select({
          id: territories.id,
          name: territories.name,
          priority: territories.priority,
          criteria: territories.criteria,
        })
        .from(territories)
        .where(
          and(
            eq(territories.orgId, orgId),
            eq(territories.isActive, true),
            isNull(territories.deletedAt),
          ),
        )
        .orderBy(desc(territories.priority))
        .limit(TERRITORY_LIMIT),
      this.db
        .select({ territoryId: territoryReps.territoryId, crmPersonId: territoryReps.crmPersonId })
        .from(territoryReps)
        .where(eq(territoryReps.orgId, orgId))
        .limit(TERRITORY_REP_LIMIT),
    ]);

    const repsByTerritory = new Map<number, number[]>();
    for (const rep of allReps) {
      const existing = repsByTerritory.get(rep.territoryId);
      if (existing) {
        existing.push(rep.crmPersonId);
      } else {
        repsByTerritory.set(rep.territoryId, [rep.crmPersonId]);
      }
    }

    for (const row of rows) {
      if (this.criteriaMatches(row.criteria, input)) {
        const reps = repsByTerritory.get(row.id) ?? [];
        return {
          territory: { id: row.id, name: row.name, priority: row.priority, assignedReps: reps },
          assignedReps: reps,
        };
      }
    }

    return null;
  }

  private criteriaMatches(criteria: TerritoryCriteria, input: MatchInput): boolean {
    if (criteria.countries && criteria.countries.length > 0) {
      if (!input.country) return false;
      if (!this.includesCI(criteria.countries, input.country)) return false;
    }

    if (criteria.states && criteria.states.length > 0) {
      if (!input.state) return false;
      if (!this.includesCI(criteria.states, input.state)) return false;
    }

    if (criteria.cities && criteria.cities.length > 0) {
      if (!input.city) return false;
      if (!this.includesCI(criteria.cities, input.city)) return false;
    }

    if (criteria.industries && criteria.industries.length > 0) {
      if (!input.industry) return false;
      if (!this.includesCI(criteria.industries, input.industry)) return false;
    }

    if (criteria.companySizes && criteria.companySizes.length > 0) {
      if (!input.companySize) return false;
      if (!this.includesCI(criteria.companySizes, input.companySize)) return false;
    }

    if (criteria.accountTypes && criteria.accountTypes.length > 0) {
      if (!input.accountType) return false;
      if (!this.includesCI(criteria.accountTypes, input.accountType)) return false;
    }

    if (criteria.productKeys && criteria.productKeys.length > 0) {
      const productKeys = criteria.productKeys;
      const inputKeys = input.productKeys ?? [];
      if (inputKeys.length === 0) return false;
      const hasMatch = inputKeys.some((k) => this.includesCI(productKeys, k));
      if (!hasMatch) return false;
    }

    return true;
  }

  private includesCI(arr: string[], value: string): boolean {
    const lower = value.toLowerCase();
    return arr.some((item) => item.toLowerCase() === lower);
  }
}
