import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { randomUUID } from "node:crypto";
import { organizationMembers, orgUnits } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import type {
  CreateOrgDepartmentInput,
  UpdateOrgDepartmentInput,
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

const KIND = "DEPARTMENT";
const LABEL = "Department";

const headMember = alias(organizationMembers, "head_member");

const ORG_DEPT_COLUMNS = {
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

const ORG_DEPT_READ_COLUMNS = {
  ...ORG_DEPT_COLUMNS,
  headUserId: headMember.userId,
};

const departmentBranches = alias(orgUnits, "department_branches");
const ORG_DEPT_LIST_COLUMNS = {
  ...ORG_DEPT_READ_COLUMNS,
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

function toOrgDepartmentList(
  row: OrgDepartmentRow & { branchName: string | null },
) {
  return {
    ...toOrgDepartment(row),
    branchName: row.branchName,
  };
}

@Injectable()
export class OrgHierarchyDepartmentsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async listDepartments(orgId: string, query: ListQueryInput) {
    const rows = await this.db
      .select(ORG_DEPT_LIST_COLUMNS)
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
      .where(getOrgUnitListFilter({ orgId, kind: KIND, query }))
      .orderBy(asc(orgUnitNormalizedName), asc(orgUnits.id))
      .limit(query.limit + 1);
    return toOrgUnitCursorPage(rows, query.limit, toOrgDepartmentList);
  }

  async getDepartment(orgId: string, id: string) {
    const [row] = await this.db
      .select(ORG_DEPT_READ_COLUMNS)
      .from(orgUnits)
      .leftJoin(headMember, eq(headMember.id, orgUnits.headMembershipId))
      .where(getOrgUnitRowFilter(orgId, KIND, id))
      .limit(1);
    return row ? toOrgDepartment(row) : null;
  }

  async createDepartment(orgId: string, userId: string, body: CreateOrgDepartmentInput) {
    const code = body.code.toUpperCase();
    await assertOrgUnitCodeAvailable({
      db: this.db,
      orgId,
      kind: KIND,
      code,
      label: LABEL,
    });

    const headMembershipId =
      (await resolveOrgUnitHeadMembershipId(this.db, orgId, body.headUserId)) ?? null;

    const [row] = await this.db
      .insert(orgUnits)
      .values({
        id: randomUUID(),
        orgId,
        kind: KIND,
        name: body.name,
        code,
        description: body.description,
        headMembershipId,
        parentId: body.branchId ?? undefined,
      })
      .returning(ORG_DEPT_COLUMNS);

    if (!row) throw new Error("Failed to create department");

    await recordOrgUnitAudit(this.audit, {
      action: "org.department.created",
      userId,
      orgId,
      targetId: row.id,
    });

    return toOrgDepartment({ ...row, headUserId: body.headUserId ?? null });
  }

  async updateDepartment(orgId: string, userId: string, id: string, body: UpdateOrgDepartmentInput) {
    const existing = await this.getDepartment(orgId, id);
    if (!existing) throw new NotFoundException("Department not found");

    if (body.code && body.code !== existing.code) {
      await assertOrgUnitCodeAvailable({
        db: this.db,
        orgId,
        kind: KIND,
        code: body.code.toUpperCase(),
        label: LABEL,
      });
    }

    const { branchId, headUserId, code, ...rest } = body;

    const deptHeadMembershipId = await resolveOrgUnitHeadMembershipId(
      this.db,
      orgId,
      headUserId,
    );

    const effectiveHeadUserId =
      headUserId !== undefined ? (headUserId ?? null) : (existing.headUserId ?? null);

    const [row] = await this.db
      .update(orgUnits)
      .set({
        ...rest,
        ...(code !== undefined && { code: code.toUpperCase() }),
        ...(headUserId !== undefined && { headMembershipId: deptHeadMembershipId }),
        ...(branchId !== undefined && { parentId: branchId }),
      })
      .where(getOrgUnitWriteFilter(orgId, KIND, id))
      .returning(ORG_DEPT_COLUMNS);

    if (!row) throw new NotFoundException("Department not found");

    await recordOrgUnitAudit(this.audit, {
      action: "org.department.updated",
      userId,
      orgId,
      targetId: id,
    });

    return toOrgDepartment({ ...row, headUserId: effectiveHeadUserId });
  }
}
