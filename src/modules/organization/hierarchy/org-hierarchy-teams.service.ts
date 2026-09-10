import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { randomUUID } from "node:crypto";
import { organizationMembers, orgUnits } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import type {
  CreateOrgTeamInput,
  UpdateOrgTeamInput,
  ListQueryInput,
} from "./dto/org-hierarchy.schemas";
import {
  orgUnitNormalizedName,
  toOrgUnitCursorPage,
} from "./org-hierarchy-list-filters";
import {
  assertOrgUnitCodeAvailable,
  getOrgUnitListFilter,
  getOrgUnitRowFilter,
  getOrgUnitWriteFilter,
  recordOrgUnitAudit,
  resolveOrgUnitHeadMembershipId,
} from "./org-unit-crud";

const KIND = "TEAM";
const LABEL = "Team";

const headMember = alias(organizationMembers, "head_member");

const ORG_TEAM_COLUMNS = {
  id: orgUnits.id,
  orgId: orgUnits.orgId,
  name: orgUnits.name,
  code: orgUnits.code,
  description: orgUnits.description,
  status: orgUnits.status,
  parentId: orgUnits.parentId,
  metadata: orgUnits.metadata,
  createdAt: orgUnits.createdAt,
  updatedAt: orgUnits.updatedAt,
  deletedAt: orgUnits.deletedAt,
};

const ORG_TEAM_READ_COLUMNS = {
  ...ORG_TEAM_COLUMNS,
  headUserId: headMember.userId,
};

const teamDepartments = alias(orgUnits, "team_departments");
const ORG_TEAM_LIST_COLUMNS = {
  ...ORG_TEAM_READ_COLUMNS,
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
  | "metadata"
  | "createdAt"
  | "updatedAt"
  | "deletedAt"
> & { headUserId: string | null };

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
    private readonly audit: AuditService,
  ) {}

  async listTeams(orgId: string, query: ListQueryInput) {
    const rows = await this.db
      .select(ORG_TEAM_LIST_COLUMNS)
      .from(orgUnits)
      .leftJoin(headMember, eq(headMember.id, orgUnits.headMembershipId))
      .leftJoin(
        teamDepartments,
        and(
          eq(teamDepartments.id, orgUnits.parentId),
          eq(teamDepartments.orgId, orgUnits.orgId),
          eq(teamDepartments.kind, "DEPARTMENT"),
          isNull(teamDepartments.deletedAt),
        ),
      )
      .where(getOrgUnitListFilter({ orgId, kind: KIND, query }))
      .orderBy(asc(orgUnitNormalizedName), asc(orgUnits.id))
      .limit(query.limit + 1);
    return toOrgUnitCursorPage(rows, query.limit, toOrgTeamList);
  }

  private async getTeamRow(
    orgId: string,
    id: string,
  ): Promise<OrgTeamRow | null> {
    const [row] = await this.db
      .select(ORG_TEAM_READ_COLUMNS)
      .from(orgUnits)
      .leftJoin(headMember, eq(headMember.id, orgUnits.headMembershipId))
      .where(getOrgUnitRowFilter(orgId, KIND, id))
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
        eq(orgUnits.status, "ACTIVE"),
        isNull(orgUnits.deletedAt),
      ),
      columns: { id: true },
    });
    if (!department) {
      throw new BadRequestException(
        "Select an active department from this organization",
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
    const code = body.code.toUpperCase();
    await assertOrgUnitCodeAvailable({
      db: this.db,
      orgId,
      kind: KIND,
      code,
      label: LABEL,
    });

    const leadMembershipId =
      (await resolveOrgUnitHeadMembershipId(this.db, orgId, body.leadUserId)) ?? null;

    const [row] = await this.db
      .insert(orgUnits)
      .values({
        id: randomUUID(),
        orgId,
        kind: KIND,
        name: body.name,
        code,
        description: body.description,
        headMembershipId: leadMembershipId,
        parentId: body.departmentId ?? undefined,
        metadata:
          body.capacity !== undefined ? { capacity: body.capacity } : undefined,
      })
      .returning(ORG_TEAM_COLUMNS);

    if (!row) throw new Error("Failed to create team");

    await recordOrgUnitAudit(this.audit, {
      action: "org.team.created",
      userId,
      orgId,
      targetId: row.id,
    });

    return toOrgTeam({ ...row, headUserId: body.leadUserId ?? null });
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
      await assertOrgUnitCodeAvailable({
        db: this.db,
        orgId,
        kind: KIND,
        code: body.code.toUpperCase(),
        label: LABEL,
      });
    }

    const { departmentId, leadUserId, capacity, code, ...rest } = body;
    const existingMeta = existing.metadata ?? {};

    const teamLeadMembershipId = await resolveOrgUnitHeadMembershipId(
      this.db,
      orgId,
      leadUserId,
    );

    const effectiveHeadUserId =
      leadUserId !== undefined ? (leadUserId ?? null) : (existing.headUserId ?? null);

    const [row] = await this.db
      .update(orgUnits)
      .set({
        ...rest,
        ...(code !== undefined && { code: code.toUpperCase() }),
        ...(leadUserId !== undefined && { headMembershipId: teamLeadMembershipId }),
        ...(departmentId !== undefined && { parentId: departmentId }),
        ...(capacity !== undefined && {
          metadata: { ...existingMeta, capacity: capacity ?? undefined },
        }),
      })
      .where(getOrgUnitWriteFilter(orgId, KIND, id))
      .returning(ORG_TEAM_COLUMNS);

    if (!row) throw new NotFoundException("Team not found");

    await recordOrgUnitAudit(this.audit, {
      action: "org.team.updated",
      userId,
      orgId,
      targetId: id,
    });

    return toOrgTeam({ ...row, headUserId: effectiveHeadUserId });
  }
}
