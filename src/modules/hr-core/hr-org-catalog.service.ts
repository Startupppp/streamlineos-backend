import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  hrJobRoles,
  hrJobLevels,
  hrLocations,
  hrTeams,
} from "../../db/schema/hr/core-org";
import { hrEmployments } from "../../db/schema/hr/core-people";
import { departments } from "../../db/schema/hr/employees";
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

  async deleteJobRole(orgId: string, id: number) {
    const [row] = await this.db
      .update(hrJobRoles)
      .set({ isActive: false })
      .where(and(eq(hrJobRoles.id, id), eq(hrJobRoles.orgId, orgId)))
      .returning({ id: hrJobRoles.id });
    if (!row) throw new NotFoundException("Job role not found");
    return { success: true };
  }

  async deleteJobLevel(orgId: string, id: number) {
    const [row] = await this.db
      .update(hrJobLevels)
      .set({ isActive: false })
      .where(and(eq(hrJobLevels.id, id), eq(hrJobLevels.orgId, orgId)))
      .returning({ id: hrJobLevels.id });
    if (!row) throw new NotFoundException("Job level not found");
    return { success: true };
  }

  async updateTeam(orgId: string, id: number, input: Partial<CatalogInput>) {
    const [row] = await this.db
      .update(hrTeams)
      .set({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.code !== undefined && { code: input.code }),
        ...(input.description !== undefined && { description: input.description }),
      })
      .where(and(eq(hrTeams.id, id), eq(hrTeams.orgId, orgId), isNull(hrTeams.deletedAt)))
      .returning();
    if (!row) throw new NotFoundException("Team not found");
    return row;
  }

  async deleteTeam(orgId: string, id: number) {
    const [row] = await this.db
      .update(hrTeams)
      .set({ deletedAt: sql`now()`, isActive: false })
      .where(and(eq(hrTeams.id, id), eq(hrTeams.orgId, orgId)))
      .returning({ id: hrTeams.id });
    if (!row) throw new NotFoundException("Team not found");
    return { success: true };
  }

  async getHeadcount(orgId: string, groupBy: string) {
    const activeStatuses = ["ACTIVE", "PROBATION", "CONFIRMED", "NOTICE"] as const;

    if (groupBy === "department") {
      const rows = await this.db
        .select({
          groupId: hrEmployments.departmentId,
          groupName: departments.name,
          headcount: count(hrEmployments.id),
        })
        .from(hrEmployments)
        .leftJoin(departments, eq(hrEmployments.departmentId, departments.id))
        .where(
          and(
            eq(hrEmployments.orgId, orgId),
            inArray(hrEmployments.lifecycleStatus, activeStatuses),
            isNull(hrEmployments.deletedAt),
          ),
        )
        .groupBy(hrEmployments.departmentId, departments.name);
      return rows;
    }

    if (groupBy === "location") {
      const rows = await this.db
        .select({
          groupId: hrEmployments.locationId,
          groupName: hrLocations.name,
          headcount: count(hrEmployments.id),
        })
        .from(hrEmployments)
        .leftJoin(hrLocations, eq(hrEmployments.locationId, hrLocations.id))
        .where(
          and(
            eq(hrEmployments.orgId, orgId),
            inArray(hrEmployments.lifecycleStatus, activeStatuses),
            isNull(hrEmployments.deletedAt),
          ),
        )
        .groupBy(hrEmployments.locationId, hrLocations.name);
      return rows;
    }

    if (groupBy === "role") {
      const rows = await this.db
        .select({
          groupId: hrEmployments.jobRoleId,
          groupName: hrJobRoles.name,
          headcount: count(hrEmployments.id),
        })
        .from(hrEmployments)
        .leftJoin(hrJobRoles, eq(hrEmployments.jobRoleId, hrJobRoles.id))
        .where(
          and(
            eq(hrEmployments.orgId, orgId),
            inArray(hrEmployments.lifecycleStatus, activeStatuses),
            isNull(hrEmployments.deletedAt),
          ),
        )
        .groupBy(hrEmployments.jobRoleId, hrJobRoles.name);
      return rows;
    }

    throw new BadRequestException("groupBy must be one of: department, location, role");
  }
}
