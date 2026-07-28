import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, eq, isNull, or } from "drizzle-orm";
import {
  hrJobRoles,
  hrJobLevels,
} from "../../db/schema/hr/core-org";
import { orgUnits, type OrgUnitMetadata } from "../../db/schema/common/organization";
import { hrEmployments } from "../../db/schema/hr/core-people";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { randomUUID } from "node:crypto";

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

type ValidLocationType = OrgUnitMetadata["locationType"];

function toLocationType(raw: string | undefined): ValidLocationType {
  const allowed: ValidLocationType[] = ["OFFICE", "WAREHOUSE", "STORE", "FACTORY", "REMOTE"];
  const upper = (raw ?? "OFFICE").toUpperCase() as ValidLocationType;
  return allowed.includes(upper) ? upper : "OFFICE";
}

function buildLocationMetadata(input: LocationInput): OrgUnitMetadata {
  return {
    locationType: toLocationType(input.type),
    address: input.address?.line1,
    city: input.address?.city,
    state: input.address?.state,
    country: input.address?.country,
    postalCode: input.address?.postalCode,
  };
}

@Injectable()
export class HrOrgCatalogService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  listLocations(orgId: string) {
    return this.db.query.orgUnits.findMany({
      where: and(
        eq(orgUnits.orgId, orgId),
        eq(orgUnits.kind, "LOCATION"),
        isNull(orgUnits.deletedAt),
      ),
      orderBy: orgUnits.name,
      limit: 500,
    });
  }

  async createLocation(orgId: string, input: LocationInput) {
    const code = input.code
      ? input.code.toUpperCase()
      : input.name
          .toUpperCase()
          .replace(/[^A-Z0-9]/g, "")
          .substring(0, 6) || "LOC";
    try {
      const [row] = await this.db
        .insert(orgUnits)
        .values({
          id: randomUUID(),
          orgId,
          kind: "LOCATION",
          name: input.name,
          code,
          description: input.description ?? null,
          metadata: buildLocationMetadata(input),
        })
        .returning();
      return row;
    } catch (err: unknown) {
      if (typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "23505") {
        throw new ConflictException("A location with this code already exists in the organization");
      }
      throw err;
    }
  }

  async updateLocation(orgId: string, id: string, input: Partial<LocationInput>) {
    const current = await this.db
      .select({ metadata: orgUnits.metadata })
      .from(orgUnits)
      .where(and(eq(orgUnits.id, id), eq(orgUnits.orgId, orgId), eq(orgUnits.kind, "LOCATION"), isNull(orgUnits.deletedAt)))
      .limit(1)
      .then((r) => r[0] ?? null);
    if (!current) throw new NotFoundException("Location not found");

    const existing = (current.metadata ?? {}) as OrgUnitMetadata;
    const updatedMeta: OrgUnitMetadata = {
      ...existing,
      ...(input.type !== undefined ? { locationType: toLocationType(input.type) } : {}),
      ...(input.address?.line1 !== undefined ? { address: input.address.line1 } : {}),
      ...(input.address?.city !== undefined ? { city: input.address.city } : {}),
      ...(input.address?.state !== undefined ? { state: input.address.state } : {}),
      ...(input.address?.country !== undefined ? { country: input.address.country } : {}),
      ...(input.address?.postalCode !== undefined ? { postalCode: input.address.postalCode } : {}),
    };

    const [row] = await this.db
      .update(orgUnits)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.code !== undefined ? { code: input.code.toUpperCase() } : {}),
        metadata: updatedMeta,
        updatedAt: new Date(),
      })
      .where(and(eq(orgUnits.id, id), eq(orgUnits.orgId, orgId), eq(orgUnits.kind, "LOCATION"), isNull(orgUnits.deletedAt)))
      .returning();
    if (!row) throw new NotFoundException("Location not found");
    return row;
  }

  async deleteLocation(orgId: string, id: string) {
    const [row] = await this.db
      .update(orgUnits)
      .set({ deletedAt: new Date() })
      .where(and(eq(orgUnits.id, id), eq(orgUnits.orgId, orgId), eq(orgUnits.kind, "LOCATION"), isNull(orgUnits.deletedAt)))
      .returning({ id: orgUnits.id });
    if (!row) throw new NotFoundException("Location not found");
    return { success: true };
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
    return this.db.query.orgUnits.findMany({
      where: and(eq(orgUnits.orgId, orgId), eq(orgUnits.kind, "TEAM"), isNull(orgUnits.deletedAt)),
      orderBy: orgUnits.name,
      limit: 500,
    });
  }

  async createTeam(orgId: string, input: CatalogInput) {
    const code = input.code ?? input.name.substring(0, 8).toUpperCase().replace(/\s/g, "");
    const existing = await this.db.query.orgUnits.findFirst({
      where: and(eq(orgUnits.orgId, orgId), eq(orgUnits.kind, "TEAM"), eq(orgUnits.name, input.name)),
    });
    if (existing) {
      throw new ConflictException("A team with this name already exists");
    }
    const [row] = await this.db
      .insert(orgUnits)
      .values({
        id: randomUUID(),
        orgId,
        kind: "TEAM",
        name: input.name,
        code,
        description: input.description ?? null,
      })
      .returning();
    return row;
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

  async updateTeam(orgId: string, id: string, input: Partial<CatalogInput>) {
    const [row] = await this.db
      .update(orgUnits)
      .set({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.code !== undefined && { code: input.code }),
        ...(input.description !== undefined && { description: input.description }),
      })
      .where(and(eq(orgUnits.id, id), eq(orgUnits.orgId, orgId), eq(orgUnits.kind, "TEAM"), isNull(orgUnits.deletedAt)))
      .returning();
    if (!row) throw new NotFoundException("Team not found");
    return row;
  }

  async deleteTeam(orgId: string, id: string) {
    const [row] = await this.db
      .update(orgUnits)
      .set({ deletedAt: new Date() })
      .where(and(eq(orgUnits.id, id), eq(orgUnits.orgId, orgId), eq(orgUnits.kind, "TEAM")))
      .returning({ id: orgUnits.id });
    if (!row) throw new NotFoundException("Team not found");
    return { success: true };
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
