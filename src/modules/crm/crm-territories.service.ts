import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { territories } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";
import type { TerritoryCreateInput, TerritoryUpdateInput } from "./dto/territories.schemas";

@Injectable()
export class CrmTerritoriesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
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
            createdAt: territories.createdAt,
          })
          .from(territories)
          .where(eq(territories.orgId, orgId))
          .orderBy(territories.name)
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

  update(id: number, input: TerritoryUpdateInput) {
    return this.db
      .update(territories)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(territories.id, id))
      .returning()
      .then((rows) => rows[0]);
  }

  async remove(id: number) {
    await this.db.delete(territories).where(eq(territories.id, id));
    return { success: true };
  }
}
