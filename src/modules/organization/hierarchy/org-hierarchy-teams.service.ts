import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq, ilike, isNull, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { randomUUID } from "node:crypto";
import { organizationMembers, orgUnits } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { AuditService } from "../../../common/audit/audit.service";
import type {
  CreateOrgTeamInput,
  UpdateOrgTeamInput,
  ListQueryInput,
} from "./dto/org-hierarchy.schemas";
import {
  getOrgUnitCursorFilter,
  getOrgUnitStatusFilter,
  orgUnitNormalizedName,
  toOrgUnitCursorPage,
} from "./org-hierarchy-list-filters";

const ORG_TEAM_COLUMNS = {
  id: orgUnits.id,
  orgId: orgUnits.orgId,
  name: orgUnits.name,
  code: orgUnits.code,
  description: orgUnits.description,
  status: orgUnits.status,
  parentId: orgUnits.parentId,
  headUserId: orgUnits.headUserId,
  metadata: orgUnits.metadata,
  createdAt: orgUnits.createdAt,
  updatedAt: orgUnits.updatedAt,
  deletedAt: orgUnits.deletedAt,
};

const teamDepartments = alias(orgUnits, "team_departments");
const ORG_TEAM_LIST_COLUMNS = {
  ...ORG_TEAM_COLUMNS,
  departmentName: teamDepartments.name,
};

type OrgTeamRow = Pick<
  typeof orgUnits.$inferSelect,
  | "id"
  | "orgId"
  | "name"
  | "code"
  | "description"
  | "status"
  | "parentId"
  | "headUserId"
  | "metadata"
  | "createdAt"
  | "updatedAt"
  | "deletedAt"
>;

export function toOrgTeam(row: OrgTeamRow) {
  return {
    id: row.id,
    orgId: row.orgId,
    name: row.name,
    code: row.code,
    description: row.description,
    status: row.status,
    departmentId: row.parentId,
    leadUserId: row.headUserId,
    capacity: row.metadata?.capacity ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

function toOrgTeamList(
  row: OrgTeamRow & { departmentName: string | null },
) {
  return {
    ...toOrgTeam(row),
    departmentName: row.departmentName,
  };
}

@Injectable()
export class OrgHierarchyTeamsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
  ) {}

  async listTeams(orgId: string, query: ListQueryInput) {
    const { cursor, limit, search, status } = query;
    const statusFilter = getOrgUnitStatusFilter(status);
    const cursorFilter = getOrgUnitCursorFilter(cursor);
    const filters = and(
      eq(orgUnits.orgId, orgId),
      eq(orgUnits.kind, "TEAM"),
      isNull(orgUnits.deletedAt),
      ...(search
        ? [
            or(
              ilike(orgUnits.name, `%${search}%`),
              ilike(orgUnits.code, `%${search}%`),
            ),
          ]
        : []),
      ...(statusFilter ? [statusFilter] : []),
      ...(cursorFilter ? [cursorFilter] : []),
    );
    const rows = await this.db
      .select(ORG_TEAM_LIST_COLUMNS)
      .from(orgUnits)
      .leftJoin(
        teamDepartments,
        and(
          eq(teamDepartments.id, orgUnits.parentId),
          eq(teamDepartments.orgId, orgUnits.orgId),
          eq(teamDepartments.kind, "DEPARTMENT"),
        ),
      )
      .where(filters)
      .orderBy(asc(orgUnitNormalizedName), asc(orgUnits.id))
      .limit(limit + 1);
    return toOrgUnitCursorPage(rows, limit, toOrgTeamList);
  }

  private async getTeamRow(
    orgId: string,
    id: string,
  ): Promise<OrgTeamRow | null> {
    const [row] = await this.db
      .select(ORG_TEAM_COLUMNS)
      .from(orgUnits)
      .where(
        and(
          eq(orgUnits.id, id),
          eq(orgUnits.orgId, orgId),
          eq(orgUnits.kind, "TEAM"),
          isNull(orgUnits.deletedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async getTeam(orgId: string, id: string) {
    const row = await this.getTeamRow(orgId, id);
    return row ? toOrgTeam(row) : null;
  }

  private async assertDepartment(orgId: string, departmentId?: string | null) {
    if (!departmentId) return;
    const department = await this.db.query.orgUnits.findFirst({
      where: and(
        eq(orgUnits.id, departmentId),
        eq(orgUnits.orgId, orgId),
        eq(orgUnits.kind, "DEPARTMENT"),
        isNull(orgUnits.deletedAt),
      ),
      columns: { id: true },
    });
    if (!department) {
      throw new BadRequestException(
        "Select a valid department from this organization",
      );
    }
  }

  private async assertActiveLead(orgId: string, leadUserId?: string | null) {
    if (!leadUserId) return;
    const [membership] = await this.db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.userId, leadUserId),
          eq(organizationMembers.status, "ACTIVE"),
        ),
      )
      .limit(1);
    if (!membership) {
      throw new BadRequestException(
        "Select an active member of this organization as team lead",
      );
    }
  }

  async createTeam(orgId: string, userId: string, body: CreateOrgTeamInput) {
    await Promise.all([
      this.assertDepartment(orgId, body.departmentId),
      this.assertActiveLead(orgId, body.leadUserId),
    ]);
    const conflict = await this.db.query.orgUnits.findFirst({
      where: and(
        eq(orgUnits.orgId, orgId),
        eq(orgUnits.kind, "TEAM"),
        eq(orgUnits.code, body.code.toUpperCase()),
        isNull(orgUnits.deletedAt),
      ),
    });
    if (conflict) throw new ConflictException("Team code already exists");

    const [row] = await this.db
      .insert(orgUnits)
      .values({
        id: randomUUID(),
        orgId,
        kind: "TEAM",
        name: body.name,
        code: body.code.toUpperCase(),
        description: body.description,
        headUserId: body.leadUserId ?? undefined,
        parentId: body.departmentId ?? undefined,
        metadata:
          body.capacity !== undefined ? { capacity: body.capacity } : undefined,
      })
      .returning(ORG_TEAM_COLUMNS);

    if (!row) throw new Error("Failed to create team");

    await this.cache.invalidate(CACHE_KEYS.orgUnits(orgId, "TEAM"));
    await this.audit.logCritical({
      action: "org.team.created",
      userId,
      orgId,
      targetId: row.id,
      targetType: "org_unit",
    });

    return toOrgTeam(row);
  }

  async updateTeam(
    orgId: string,
    userId: string,
    id: string,
    body: UpdateOrgTeamInput,
  ) {
    const existing = await this.getTeamRow(orgId, id);
    if (!existing) throw new NotFoundException("Team not found");
    if (body.departmentId !== undefined) {
      await this.assertDepartment(orgId, body.departmentId);
    }
    if (body.leadUserId !== undefined) {
      await this.assertActiveLead(orgId, body.leadUserId);
    }

    if (body.code && body.code !== existing.code) {
      const conflict = await this.db.query.orgUnits.findFirst({
        where: and(
          eq(orgUnits.orgId, orgId),
          eq(orgUnits.kind, "TEAM"),
          eq(orgUnits.code, body.code.toUpperCase()),
          isNull(orgUnits.deletedAt),
        ),
      });
      if (conflict) throw new ConflictException("Team code already exists");
    }

    const { departmentId, leadUserId, capacity, code, ...rest } = body;
    const existingMeta = existing.metadata ?? {};
    const [row] = await this.db
      .update(orgUnits)
      .set({
        ...rest,
        ...(code !== undefined && { code: code.toUpperCase() }),
        ...(leadUserId !== undefined && { headUserId: leadUserId }),
        ...(departmentId !== undefined && { parentId: departmentId }),
        ...(capacity !== undefined && {
          metadata: { ...existingMeta, capacity: capacity ?? undefined },
        }),
      })
      .where(
        and(
          eq(orgUnits.id, id),
          eq(orgUnits.orgId, orgId),
          eq(orgUnits.kind, "TEAM"),
        ),
      )
      .returning(ORG_TEAM_COLUMNS);

    if (!row) throw new NotFoundException("Team not found");

    await this.cache.invalidate(CACHE_KEYS.orgUnits(orgId, "TEAM"));
    await this.audit.logCritical({
      action: "org.team.updated",
      userId,
      orgId,
      targetId: id,
      targetType: "org_unit",
    });

    return toOrgTeam(row);
  }

  async deleteTeam(orgId: string, userId: string, id: string) {
    const existing = await this.getTeam(orgId, id);
    if (!existing) throw new NotFoundException("Team not found");

    await this.db
      .update(orgUnits)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(orgUnits.id, id),
          eq(orgUnits.orgId, orgId),
          eq(orgUnits.kind, "TEAM"),
        ),
      );

    await this.cache.invalidate(CACHE_KEYS.orgUnits(orgId, "TEAM"));
    await this.audit.logCritical({
      action: "org.team.deleted",
      userId,
      orgId,
      targetId: id,
      targetType: "org_unit",
    });
  }

  async moveTeam(orgId: string, teamId: string, newDepartmentId: string) {
    const team = await this.db.query.orgUnits.findFirst({
      where: and(
        eq(orgUnits.id, teamId),
        eq(orgUnits.orgId, orgId),
        eq(orgUnits.kind, "TEAM"),
      ),
    });
    if (!team) throw new NotFoundException("Team not found");
    if (newDepartmentId === teamId) {
      throw new BadRequestException("A unit cannot be its own parent");
    }
    await this.assertDepartment(orgId, newDepartmentId);

    await this.db
      .update(orgUnits)
      .set({ parentId: newDepartmentId, updatedAt: new Date() })
      .where(and(eq(orgUnits.id, teamId), eq(orgUnits.orgId, orgId)));

    return { success: true };
  }
}
