import { BadRequestException, Injectable } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { organizationMembers, orgUnits } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import type {
  CreateOrgTeamInput,
  ListQueryInput,
  UpdateOrgTeamInput,
} from "./dto/org-hierarchy.schemas";
import {
  OrgUnitCrudService,
  type OrgUnitCrudAdapter,
} from "./org-unit-crud";

const headMember = alias(organizationMembers, "head_member");
const teamDepartments = alias(orgUnits, "team_departments");

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

type OrgTeamListRow = OrgTeamRow & { departmentName: string | null };

async function assertDepartment(db: Db, orgId: string, departmentId: string) {
  const department = await db.query.orgUnits.findFirst({
    columns: { id: true },
    where: and(
      eq(orgUnits.id, departmentId),
      eq(orgUnits.orgId, orgId),
      eq(orgUnits.kind, "DEPARTMENT"),
      eq(orgUnits.status, "ACTIVE"),
      isNull(orgUnits.deletedAt),
    ),
  });
  if (!department)
    throw new BadRequestException(
      "Select an active department from this organization",
    );
}

async function assertActiveLead(
  db: Db,
  orgId: string,
  leadUserId: string | null | undefined,
) {
  if (!leadUserId) return;
  const [membership] = await db
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
  if (!membership)
    throw new BadRequestException(
      "Select an active member of this organization as team lead",
    );
}

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

function toOrgTeamList(row: OrgTeamListRow) {
  return {
    ...toOrgTeam(row),
    departmentName: row.departmentName,
  };
}

const TEAM_ADAPTER: OrgUnitCrudAdapter<
  CreateOrgTeamInput,
  UpdateOrgTeamInput,
  OrgTeamRow,
  OrgTeamListRow,
  ReturnType<typeof toOrgTeam>,
  ReturnType<typeof toOrgTeamList>
> = {
  kind: "TEAM",
  label: "Team",
  auditName: "org.team",
  code: {
    create: (input) => input.code,
    update: (input) => input.code,
    current: (row) => row.code,
  },
  parent: {
    rule: "required",
    kind: "DEPARTMENT",
    label: "department",
    create: (input) => input.departmentId,
    update: (input) => input.departmentId,
    current: (row) => row.parentId,
    validate: assertDepartment,
  },
  head: {
    create: (input) => input.leadUserId,
    update: (input) => input.leadUserId,
    current: (row) => row.headUserId,
  },
  listRows: async (db, plan) =>
    db
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
      .where(plan.where)
      .orderBy(...plan.orderBy)
      .limit(plan.limit),
  readRow: async (db, where) => {
    const [row] = await db
      .select(ORG_TEAM_READ_COLUMNS)
      .from(orgUnits)
      .leftJoin(headMember, eq(headMember.id, orgUnits.headMembershipId))
      .where(where)
      .limit(1);
    return row ?? null;
  },
  createValues: (input) => ({
    name: input.name,
    description: input.description,
    ...(input.capacity !== undefined
      ? { metadata: { capacity: input.capacity } }
      : {}),
  }),
  updateValues: (input, existing) => ({
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined
      ? { description: input.description }
      : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.capacity !== undefined
      ? {
          metadata: {
            ...(existing.metadata ?? {}),
            capacity: input.capacity ?? undefined,
          },
        }
      : {}),
  }),
  validateCreate: (db, orgId, input) =>
    assertActiveLead(db, orgId, input.leadUserId),
  validateUpdate: (db, orgId, input) =>
    assertActiveLead(db, orgId, input.leadUserId),
  toOutput: toOrgTeam,
  toListOutput: toOrgTeamList,
  toWriteOutput: toOrgTeam,
};

@Injectable()
export class OrgHierarchyTeamsService {
  constructor(private readonly crud: OrgUnitCrudService) {}

  listTeams(orgId: string, query: ListQueryInput) {
    return this.crud.list(TEAM_ADAPTER, orgId, query);
  }

  getTeam(orgId: string, id: string) {
    return this.crud.get(TEAM_ADAPTER, orgId, id);
  }

  createTeam(orgId: string, userId: string, body: CreateOrgTeamInput) {
    return this.crud.create(TEAM_ADAPTER, orgId, userId, body);
  }

  updateTeam(
    orgId: string,
    userId: string,
    id: string,
    body: UpdateOrgTeamInput,
  ) {
    return this.crud.update(TEAM_ADAPTER, orgId, userId, id, body);
  }
}
