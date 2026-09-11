import { Injectable } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { organizationMembers, orgUnits } from "../../../db/schema";
import type {
  CreateOrgDepartmentInput,
  ListQueryInput,
  UpdateOrgDepartmentInput,
} from "./dto/org-hierarchy.schemas";
import {
  OrgUnitCrudService,
  type OrgUnitCrudAdapter,
} from "./org-unit-crud";

const headMember = alias(organizationMembers, "head_member");
const departmentBranches = alias(orgUnits, "department_branches");

const ORG_DEPARTMENT_COLUMNS = {
  id: orgUnits.id,
  orgId: orgUnits.orgId,
  name: orgUnits.name,
  code: orgUnits.code,
  description: orgUnits.description,
  status: orgUnits.status,
  parentId: orgUnits.parentId,
  createdAt: orgUnits.createdAt,
  updatedAt: orgUnits.updatedAt,
  deletedAt: orgUnits.deletedAt,
};

const ORG_DEPARTMENT_READ_COLUMNS = {
  ...ORG_DEPARTMENT_COLUMNS,
  headUserId: headMember.userId,
};

const ORG_DEPARTMENT_LIST_COLUMNS = {
  ...ORG_DEPARTMENT_READ_COLUMNS,
  branchName: departmentBranches.name,
};

type OrgDepartmentRow = Pick<
  typeof orgUnits.$inferSelect,
  | "id"
  | "orgId"
  | "name"
  | "code"
  | "description"
  | "status"
  | "parentId"
  | "createdAt"
  | "updatedAt"
  | "deletedAt"
> & { headUserId: string | null };

type OrgDepartmentListRow = OrgDepartmentRow & { branchName: string | null };

export function toOrgDepartment(row: OrgDepartmentRow) {
  return {
    id: row.id,
    orgId: row.orgId,
    branchId: row.parentId,
    headUserId: row.headUserId,
    name: row.name,
    code: row.code,
    description: row.description,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

function toOrgDepartmentList(row: OrgDepartmentListRow) {
  return {
    ...toOrgDepartment(row),
    branchName: row.branchName,
  };
}

const DEPARTMENT_ADAPTER: OrgUnitCrudAdapter<
  CreateOrgDepartmentInput,
  UpdateOrgDepartmentInput,
  OrgDepartmentRow,
  OrgDepartmentListRow,
  ReturnType<typeof toOrgDepartment>,
  ReturnType<typeof toOrgDepartmentList>
> = {
  kind: "DEPARTMENT",
  label: "Department",
  auditName: "org.department",
  code: {
    create: (input) => input.code,
    update: (input) => input.code,
    current: (row) => row.code,
  },
  parent: {
    rule: "optional",
    kind: "BRANCH",
    label: "branch",
    create: (input) => input.branchId,
    update: (input) => input.branchId,
    current: (row) => row.parentId,
  },
  head: {
    create: (input) => input.headUserId,
    update: (input) => input.headUserId,
    current: (row) => row.headUserId,
  },
  listRows: async (db, plan) =>
    db
      .select(ORG_DEPARTMENT_LIST_COLUMNS)
      .from(orgUnits)
      .leftJoin(headMember, eq(headMember.id, orgUnits.headMembershipId))
      .leftJoin(
        departmentBranches,
        and(
          eq(departmentBranches.id, orgUnits.parentId),
          eq(departmentBranches.orgId, orgUnits.orgId),
          eq(departmentBranches.kind, "BRANCH"),
          isNull(departmentBranches.deletedAt),
        ),
      )
      .where(plan.where)
      .orderBy(...plan.orderBy)
      .limit(plan.limit),
  readRow: async (db, where) => {
    const [row] = await db
      .select(ORG_DEPARTMENT_READ_COLUMNS)
      .from(orgUnits)
      .leftJoin(headMember, eq(headMember.id, orgUnits.headMembershipId))
      .where(where)
      .limit(1);
    return row ?? null;
  },
  createValues: (input) => ({
    name: input.name,
    description: input.description,
  }),
  updateValues: (input) => ({
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined
      ? { description: input.description }
      : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
  }),
  toOutput: toOrgDepartment,
  toListOutput: toOrgDepartmentList,
  toWriteOutput: toOrgDepartment,
};

@Injectable()
export class OrgHierarchyDepartmentsService {
  constructor(private readonly crud: OrgUnitCrudService) {}

  listDepartments(orgId: string, query: ListQueryInput) {
    return this.crud.list(DEPARTMENT_ADAPTER, orgId, query);
  }

  getDepartment(orgId: string, id: string) {
    return this.crud.get(DEPARTMENT_ADAPTER, orgId, id);
  }

  createDepartment(
    orgId: string,
    userId: string,
    body: CreateOrgDepartmentInput,
  ) {
    return this.crud.create(DEPARTMENT_ADAPTER, orgId, userId, body);
  }

  updateDepartment(
    orgId: string,
    userId: string,
    id: string,
    body: UpdateOrgDepartmentInput,
  ) {
    return this.crud.update(DEPARTMENT_ADAPTER, orgId, userId, id, body);
  }
}
