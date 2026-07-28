import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { territories, territoryReps, territoryLocations } from "../../db/schema";
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
        this.db.query.territories.findMany({
          where: eq(territories.orgId, orgId),
          with: {
            reps: { columns: { id: true, crmPersonId: true, assignedAt: true } },
            locations: { columns: { id: true, kind: true, value: true } },
          },
          orderBy: [desc(territories.priority), territories.name],
          limit,
        }),
      CACHE_TTL.MEDIUM,
    );
  }

  async create(orgId: string, userId: string, input: TerritoryCreateInput) {
    return this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(territories)
        .values({
          orgId,
          name: input.name,
          description: input.description ?? null,
          isActive: input.isActive,
          criteria: input.criteria ?? {},
          priority: input.priority ?? 0,
          createdBy: userId,
        })
        .returning();

      if (!created) throw new Error("Failed to create territory");

      if (input.states && input.states.length > 0) {
        await tx.insert(territoryLocations).values(
          input.states.map((value) => ({ orgId, territoryId: created.id, kind: "STATE", value })),
        );
      }

      if (input.cities && input.cities.length > 0) {
        await tx.insert(territoryLocations).values(
          input.cities.map((value) => ({ orgId, territoryId: created.id, kind: "CITY", value })),
        );
      }

      if (input.assignedReps && input.assignedReps.length > 0) {
        await tx.insert(territoryReps).values(
          input.assignedReps.map((crmPersonId) => ({ orgId, territoryId: created.id, crmPersonId })),
        );
      }

      await this.cache.invalidatePattern(`crm:territories:${orgId}:*`);
      return created;
    });
  }

  getOne(orgId: string, id: number) {
    return this.db.query.territories.findFirst({
      where: and(eq(territories.id, id), eq(territories.orgId, orgId)),
      with: {
        reps: { columns: { id: true, crmPersonId: true, assignedAt: true } },
        locations: { columns: { id: true, kind: true, value: true } },
      },
    }).then((row) => row ?? null);
  }

  async exists(orgId: string, id: number): Promise<boolean> {
    const [row] = await this.db
      .select({ id: territories.id })
      .from(territories)
      .where(and(eq(territories.id, id), eq(territories.orgId, orgId)));
    return Boolean(row);
  }

  async update(orgId: string, id: number, input: TerritoryUpdateInput) {
    return this.db.transaction(async (tx) => {
      const scalarUpdate: Partial<typeof territories.$inferInsert> = { updatedAt: new Date() };
      if (input.name !== undefined) scalarUpdate.name = input.name;
      if (input.description !== undefined) scalarUpdate.description = input.description ?? null;
      if (input.isActive !== undefined) scalarUpdate.isActive = input.isActive;
      if (input.criteria !== undefined) scalarUpdate.criteria = input.criteria as typeof territories.$inferInsert["criteria"];
      if (input.priority !== undefined) scalarUpdate.priority = input.priority;

      const [updated] = await tx
        .update(territories)
        .set(scalarUpdate)
        .where(and(eq(territories.id, id), eq(territories.orgId, orgId)))
        .returning();

      if (input.states !== undefined) {
        await tx
          .delete(territoryLocations)
          .where(
            and(
              eq(territoryLocations.territoryId, id),
              eq(territoryLocations.orgId, orgId),
              eq(territoryLocations.kind, "STATE"),
            ),
          );
        if (input.states.length > 0) {
          await tx.insert(territoryLocations).values(
            input.states.map((value) => ({ orgId, territoryId: id, kind: "STATE", value })),
          );
        }
      }

      if (input.cities !== undefined) {
        await tx
          .delete(territoryLocations)
          .where(
            and(
              eq(territoryLocations.territoryId, id),
              eq(territoryLocations.orgId, orgId),
              eq(territoryLocations.kind, "CITY"),
            ),
          );
        if (input.cities.length > 0) {
          await tx.insert(territoryLocations).values(
            input.cities.map((value) => ({ orgId, territoryId: id, kind: "CITY", value })),
          );
        }
      }

      if (input.assignedReps !== undefined) {
        await tx
          .delete(territoryReps)
          .where(and(eq(territoryReps.territoryId, id), eq(territoryReps.orgId, orgId)));
        if (input.assignedReps.length > 0) {
          await tx.insert(territoryReps).values(
            input.assignedReps.map((crmPersonId) => ({ orgId, territoryId: id, crmPersonId })),
          );
        }
      }

      await this.cache.invalidatePattern(`crm:territories:${orgId}:*`);
      return updated;
    });
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
