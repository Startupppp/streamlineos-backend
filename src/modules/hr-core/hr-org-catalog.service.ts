import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  hrJobRoles,
  hrJobLevels,
  hrLocations,
  hrTeams,
} from "../../db/schema/hr/core-org";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";

type CatalogInput = {
  name: string;
  code?: string;
  description?: string;
};

type LocationInput = CatalogInput & {
  type?: string;
  address?: {
    line1?: string;
    line2?: string;
    city?: string;
    state?: string;
    country?: string;
    postalCode?: string;
    timezone?: string;
  };
};

@Injectable()
export class HrOrgCatalogService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  listLocations(orgId: string) {
    return this.db.query.hrLocations.findMany({
      where: and(eq(hrLocations.orgId, orgId), isNull(hrLocations.deletedAt)),
      orderBy: hrLocations.name,
    });
  }

  async createLocation(orgId: string, input: LocationInput) {
    try {
      const [row] = await this.db
        .insert(hrLocations)
        .values({
          orgId,
          name: input.name,
          code: input.code ?? null,
          type: input.type ?? "OFFICE",
          address: (input.address as never) ?? null,
        })
        .returning();
      return row;
    } catch (err: unknown) {
      if (typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "23505") {
        throw new ConflictException("A location with this name already exists");
      }
      throw err;
    }
  }

  async updateLocation(orgId: string, id: number, input: Partial<LocationInput>) {
    const [row] = await this.db
      .update(hrLocations)
      .set({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.type !== undefined && { type: input.type }),
        ...(input.address !== undefined && { address: input.address as never }),
      })
      .where(and(eq(hrLocations.id, id), eq(hrLocations.orgId, orgId), isNull(hrLocations.deletedAt)))
      .returning();
    if (!row) throw new NotFoundException("Location not found");
    return row;
  }

  async deleteLocation(orgId: string, id: number) {
    const [row] = await this.db
      .update(hrLocations)
      .set({ deletedAt: sql`now()` })
      .where(and(eq(hrLocations.id, id), eq(hrLocations.orgId, orgId)))
      .returning({ id: hrLocations.id });
    if (!row) throw new NotFoundException("Location not found");
    return { success: true };
  }

  listJobRoles(orgId: string) {
    return this.db.query.hrJobRoles.findMany({
      where: and(eq(hrJobRoles.orgId, orgId), eq(hrJobRoles.isActive, true)),
      orderBy: hrJobRoles.name,
    });
  }

  async createJobRole(orgId: string, input: CatalogInput) {
    try {
      const [row] = await this.db
        .insert(hrJobRoles)
        .values({ orgId, name: input.name, code: input.code ?? null, description: input.description ?? null })
        .returning();
      return row;
    } catch (err: unknown) {
      if (typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "23505") {
        throw new ConflictException("A job role with this name already exists");
      }
      throw err;
    }
  }

  async updateJobRole(orgId: string, id: number, input: Partial<CatalogInput>) {
    const [row] = await this.db
      .update(hrJobRoles)
      .set({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.code !== undefined && { code: input.code }),
        ...(input.description !== undefined && { description: input.description }),
      })
      .where(and(eq(hrJobRoles.id, id), eq(hrJobRoles.orgId, orgId)))
      .returning();
    if (!row) throw new NotFoundException("Job role not found");
    return row;
  }

  listJobLevels(orgId: string) {
    return this.db.query.hrJobLevels.findMany({
      where: and(eq(hrJobLevels.orgId, orgId), eq(hrJobLevels.isActive, true)),
      orderBy: hrJobLevels.rank,
    });
  }

  async createJobLevel(orgId: string, input: CatalogInput) {
    try {
      const [row] = await this.db
        .insert(hrJobLevels)
        .values({ orgId, name: input.name, code: input.code ?? null, description: input.description ?? null })
        .returning();
      return row;
    } catch (err: unknown) {
      if (typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "23505") {
        throw new ConflictException("A job level with this name already exists");
      }
      throw err;
    }
  }

  async updateJobLevel(orgId: string, id: number, input: Partial<CatalogInput>) {
    const [row] = await this.db
      .update(hrJobLevels)
      .set({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.code !== undefined && { code: input.code }),
        ...(input.description !== undefined && { description: input.description }),
      })
      .where(and(eq(hrJobLevels.id, id), eq(hrJobLevels.orgId, orgId)))
      .returning();
    if (!row) throw new NotFoundException("Job level not found");
    return row;
  }

  listTeams(orgId: string) {
    return this.db.query.hrTeams.findMany({
      where: and(eq(hrTeams.orgId, orgId), isNull(hrTeams.deletedAt), eq(hrTeams.isActive, true)),
      orderBy: hrTeams.name,
    });
  }

  async createTeam(orgId: string, input: CatalogInput) {
    try {
      const [row] = await this.db
        .insert(hrTeams)
        .values({ orgId, name: input.name, code: input.code ?? null, description: input.description ?? null })
        .returning();
      return row;
    } catch (err: unknown) {
      if (typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "23505") {
        throw new ConflictException("A team with this name already exists");
      }
      throw err;
    }
  }
}
