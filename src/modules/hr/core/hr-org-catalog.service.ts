import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, eq, isNull, or } from "drizzle-orm";
import {
  hrJobRoles,
  hrJobLevels,
} from "../../../db/schema/hr/core-org";
import { orgUnits } from "../../../db/schema/common/organization";
import { hrEmployments } from "../../../db/schema/hr/core-people";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { OrgHierarchyService } from "../../organization/hierarchy/org-hierarchy.service";
import type {
  CreateOrgLocationInput,
  CreateOrgTeamInput,
  UpdateOrgLocationInput,
  UpdateOrgTeamInput,
} from "../../organization/hierarchy/dto/org-hierarchy.schemas";
import { isUniqueViolation } from "../../../common/db/postgres-error";

type CatalogInput = {
  name: string;
  code?: string;
  description?: string;
};

@Injectable()
export class HrOrgCatalogService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly hierarchy: OrgHierarchyService,
  ) {}

  async listLocations(orgId: string) {
    const result = await this.hierarchy.listLocations(orgId, {
      limit: 100,
      status: "CURRENT",
    });
    return result.data;
  }

  createLocation(orgId: string, userId: string, input: CreateOrgLocationInput) {
    return this.hierarchy.createLocation(orgId, userId, input);
  }

  updateLocation(
    orgId: string,
    userId: string,
    locationId: string,
    input: UpdateOrgLocationInput,
  ) {
    return this.hierarchy.updateLocation(orgId, userId, locationId, input);
  }

  listJobRoles(orgId: string) {
    return this.db.query.hrJobRoles.findMany({
      where: and(eq(hrJobRoles.orgId, orgId), eq(hrJobRoles.isActive, true)),
      orderBy: hrJobRoles.name,
      limit: 500,
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
      if (isUniqueViolation(err)) {
        throw new ConflictException("A job role with this name already exists");
      }
      throw err;
    }
  }

  async updateJobRole(orgId: string, jobRoleId: number, input: Partial<CatalogInput>) {
    const [jobRole] = await this.db
      .update(hrJobRoles)
      .set({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.code !== undefined && { code: input.code }),
        ...(input.description !== undefined && { description: input.description }),
        updatedAt: new Date(),
      })
      .where(and(eq(hrJobRoles.id, jobRoleId), eq(hrJobRoles.orgId, orgId)))
      .returning();
    if (!jobRole) throw new NotFoundException("Job role not found");
    return jobRole;
  }

  listJobLevels(orgId: string) {
    return this.db.query.hrJobLevels.findMany({
      where: and(eq(hrJobLevels.orgId, orgId), eq(hrJobLevels.isActive, true)),
      orderBy: hrJobLevels.rank,
      limit: 500,
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
      if (isUniqueViolation(err)) {
        throw new ConflictException("A job level with this name already exists");
      }
      throw err;
    }
  }

  async updateJobLevel(orgId: string, jobLevelId: number, input: Partial<CatalogInput>) {
    const [jobLevel] = await this.db
      .update(hrJobLevels)
      .set({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.code !== undefined && { code: input.code }),
        ...(input.description !== undefined && { description: input.description }),
        updatedAt: new Date(),
      })
      .where(and(eq(hrJobLevels.id, jobLevelId), eq(hrJobLevels.orgId, orgId)))
      .returning();
    if (!jobLevel) throw new NotFoundException("Job level not found");
    return jobLevel;
  }

  async listTeams(orgId: string) {
    const result = await this.hierarchy.listTeams(orgId, {
      limit: 100,
      status: "CURRENT",
    });
    return result.data;
  }

  createTeam(orgId: string, userId: string, input: CreateOrgTeamInput) {
    return this.hierarchy.createTeam(orgId, userId, input);
  }

  async deleteJobRole(orgId: string, jobRoleId: number) {
    const [jobRole] = await this.db
      .update(hrJobRoles)
      .set({ isActive: false })
      .where(and(eq(hrJobRoles.id, jobRoleId), eq(hrJobRoles.orgId, orgId)))
      .returning({ id: hrJobRoles.id });
    if (!jobRole) throw new NotFoundException("Job role not found");
    return { success: true };
  }

  async deleteJobLevel(orgId: string, jobLevelId: number) {
    const [jobLevel] = await this.db
      .update(hrJobLevels)
      .set({ isActive: false })
      .where(and(eq(hrJobLevels.id, jobLevelId), eq(hrJobLevels.orgId, orgId)))
      .returning({ id: hrJobLevels.id });
    if (!jobLevel) throw new NotFoundException("Job level not found");
    return { success: true };
  }

  updateTeam(
    orgId: string,
    userId: string,
    teamId: string,
    input: UpdateOrgTeamInput,
  ) {
    return this.hierarchy.updateTeam(orgId, userId, teamId, input);
  }

  async getHeadcount(orgId: string, groupBy: string) {
    const activeStatusFilter = or(
      eq(hrEmployments.lifecycleStatus, "ACTIVE"),
      eq(hrEmployments.lifecycleStatus, "PROBATION"),
      eq(hrEmployments.lifecycleStatus, "CONFIRMED"),
      eq(hrEmployments.lifecycleStatus, "NOTICE"),
    );

    if (groupBy === "department") {
      const rows = await this.db
        .select({
          groupId: hrEmployments.departmentId,
          groupName: orgUnits.name,
          headcount: count(hrEmployments.id),
        })
        .from(hrEmployments)
        .leftJoin(orgUnits, eq(hrEmployments.departmentId, orgUnits.id))
        .where(
          and(
            eq(hrEmployments.orgId, orgId),
            activeStatusFilter,
            isNull(hrEmployments.deletedAt),
          ),
        )
        .groupBy(hrEmployments.departmentId, orgUnits.name);
      return rows;
    }

    if (groupBy === "location") {
      const rows = await this.db
        .select({
          groupId: hrEmployments.locationId,
          groupName: orgUnits.name,
          headcount: count(hrEmployments.id),
        })
        .from(hrEmployments)
        .leftJoin(orgUnits, eq(hrEmployments.locationId, orgUnits.id))
        .where(
          and(
            eq(hrEmployments.orgId, orgId),
            activeStatusFilter,
            isNull(hrEmployments.deletedAt),
          ),
        )
        .groupBy(hrEmployments.locationId, orgUnits.name);
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
            activeStatusFilter,
            isNull(hrEmployments.deletedAt),
          ),
        )
        .groupBy(hrEmployments.jobRoleId, hrJobRoles.name);
      return rows;
    }

    throw new BadRequestException("groupBy must be one of: department, location, role");
  }
}
