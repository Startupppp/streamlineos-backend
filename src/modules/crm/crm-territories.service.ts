import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { territories } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";
import type { TerritoryCreateInput, TerritoryUpdateInput } from "./dto/territories.schemas";
import { TerritoryMatchService } from "./territory-match.service";
import type { SampleLead } from "./dto/territories.schemas";

@Injectable()
export class CrmTerritoriesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly territoryMatch: TerritoryMatchService,
  ) {}

  list(orgId: string, limit: number) {
    return this.cache.cached(
      `crm:territories:${orgId}:${limit}`,
      () =>
        this.db
          .select({
            id: territories.id,
            name: territories.name,
            states: territories.states,
            cities: territories.cities,
            assignedReps: territories.assignedReps,
            description: territories.description,
            isActive: territories.isActive,
            criteria: territories.criteria,
            priority: territories.priority,
            createdAt: territories.createdAt,
          })
          .from(territories)
          .where(eq(territories.orgId, orgId))
          .orderBy(desc(territories.priority), territories.name)
          .limit(limit),
      CACHE_TTL.MEDIUM,
    );
  }

  async create(orgId: string, userId: string, input: TerritoryCreateInput) {
    const [created] = await this.db
      .insert(territories)
      .values({
        orgId,
        name: input.name,
        states: input.states,
        cities: input.cities,
        assignedReps: input.assignedReps,
        description: input.description ?? null,
        isActive: input.isActive,
        criteria: input.criteria ?? {},
        priority: input.priority ?? 0,
        createdBy: userId,
      })
      .returning();

    await this.cache.invalidatePattern(`crm:territories:${orgId}:*`);
    return created;
  }

  getOne(orgId: string, id: number) {
    return this.db
      .select()
      .from(territories)
      .where(and(eq(territories.id, id), eq(territories.orgId, orgId)))
      .then((rows) => rows[0] ?? null);
  }

  async exists(orgId: string, id: number): Promise<boolean> {
    const [row] = await this.db
      .select({ id: territories.id })
      .from(territories)
      .where(and(eq(territories.id, id), eq(territories.orgId, orgId)));
    return Boolean(row);
  }

  async update(orgId: string, id: number, input: TerritoryUpdateInput) {
    const [updated] = await this.db
      .update(territories)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(territories.id, id), eq(territories.orgId, orgId)))
      .returning();
    await this.cache.invalidatePattern(`crm:territories:${orgId}:*`);
    return updated;
  }

  async remove(orgId: string, id: number) {
    await this.db.delete(territories).where(and(eq(territories.id, id), eq(territories.orgId, orgId)));
    await this.cache.invalidatePattern(`crm:territories:${orgId}:*`);
    return { success: true };
  }

  async preview(orgId: string, sample: SampleLead) {
    const result = await this.territoryMatch.match(orgId, sample);
    return {
      matchedTerritory: result?.territory ?? null,
      assignedReps: result?.assignedReps ?? [],
    };
  }
}
