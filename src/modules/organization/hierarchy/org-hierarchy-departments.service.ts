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

const headMember = alias(organizationMembers, "head_member");
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { AuditService } from "../../../common/audit/audit.service";
import type {
  CreateOrgDepartmentInput,
  UpdateOrgDepartmentInput,
  ListQueryInput,
} from "./dto/org-hierarchy.schemas";
import {
  getOrgUnitCursorFilter,
  getOrgUnitStatusFilter,
  orgUnitNormalizedName,
  toOrgUnitCursorPage,
} from "./org-hierarchy-list-filters";

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
    private readonly cache: CacheService,
    private readonly audit: AuditService,
  ) {}

  async listDepartments(orgId: string, query: ListQueryInput) {
    const { cursor, limit, search, status } = query;
    const statusFilter = getOrgUnitStatusFilter(status);
    const cursorFilter = getOrgUnitCursorFilter(cursor);
    const filters = and(
      eq(orgUnits.orgId, orgId),
      eq(orgUnits.kind, "DEPARTMENT"),
      isNull(orgUnits.deletedAt),
      ...(search ? [or(ilike(orgUnits.name, `%${search}%`), ilike(orgUnits.code, `%${search}%`))] : []),
      ...(statusFilter ? [statusFilter] : []),
      ...(cursorFilter ? [cursorFilter] : []),
    );
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
      .where(filters)
      .orderBy(asc(orgUnitNormalizedName), asc(orgUnits.id))
      .limit(limit + 1);
    return toOrgUnitCursorPage(rows, limit, toOrgDepartmentList);
  }

  async getDepartment(orgId: string, id: string) {
    const [row] = await this.db
      .select(ORG_DEPT_READ_COLUMNS)
      .from(orgUnits)
      .leftJoin(headMember, eq(headMember.id, orgUnits.headMembershipId))
      .where(
        and(
          eq(orgUnits.id, id),
          eq(orgUnits.orgId, orgId),
          eq(orgUnits.kind, "DEPARTMENT"),
          isNull(orgUnits.deletedAt),
        ),
      )
      .limit(1);
    return row ? toOrgDepartment(row) : null;
  }

  async createDepartment(orgId: string, userId: string, body: CreateOrgDepartmentInput) {
    const conflict = await this.db.query.orgUnits.findFirst({
      where: and(
        eq(orgUnits.orgId, orgId),
        eq(orgUnits.kind, "DEPARTMENT"),
        eq(orgUnits.code, body.code.toUpperCase()),
        isNull(orgUnits.deletedAt),
      ),
    });
    if (conflict) throw new ConflictException("Department code already exists");

    const headMembershipId = body.headUserId
      ? await this.db
          .select({ id: organizationMembers.id })
          .from(organizationMembers)
          .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, body.headUserId)))
          .limit(1)
          .then((rows) => rows[0]?.id ?? null)
      : null;

    const [row] = await this.db
      .insert(orgUnits)
      .values({
        id: randomUUID(),
        orgId,
        kind: "DEPARTMENT",
        name: body.name,
        code: body.code.toUpperCase(),
        description: body.description,
        headMembershipId,
        parentId: body.branchId ?? undefined,
      })
      .returning(ORG_DEPT_COLUMNS);

    if (!row) throw new Error("Failed to create department");

    await this.cache.invalidateForOrg(orgId, "org:units:DEPARTMENT");
    await this.audit.logCritical({ action: "org.department.created", userId, orgId, targetId: row.id, targetType: "org_unit" });

    return toOrgDepartment({ ...row, headUserId: body.headUserId ?? null });
  }

  async updateDepartment(orgId: string, userId: string, id: string, body: UpdateOrgDepartmentInput) {
    const existing = await this.getDepartment(orgId, id);
    if (!existing) throw new NotFoundException("Department not found");

    if (body.code && body.code !== existing.code) {
      const conflict = await this.db.query.orgUnits.findFirst({
        where: and(
          eq(orgUnits.orgId, orgId),
          eq(orgUnits.kind, "DEPARTMENT"),
          eq(orgUnits.code, body.code.toUpperCase()),
          isNull(orgUnits.deletedAt),
        ),
      });
      if (conflict) throw new ConflictException("Department code already exists");
    }

    const { branchId, headUserId, code, ...rest } = body;

    let deptHeadMembershipId: number | null | undefined = undefined;
    if (headUserId !== undefined) {
      if (headUserId) {
        const [member] = await this.db
          .select({ id: organizationMembers.id })
          .from(organizationMembers)
          .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, headUserId)))
          .limit(1);
        deptHeadMembershipId = member?.id ?? null;
      } else {
        deptHeadMembershipId = null;
      }
    }

    const effectiveHeadUserId = headUserId !== undefined ? (headUserId ?? null) : (existing.headUserId ?? null);

    const [row] = await this.db
      .update(orgUnits)
      .set({
        ...rest,
        ...(code !== undefined && { code: code.toUpperCase() }),
        ...(headUserId !== undefined && { headMembershipId: deptHeadMembershipId }),
        ...(branchId !== undefined && { parentId: branchId }),
      })
      .where(and(eq(orgUnits.id, id), eq(orgUnits.orgId, orgId), eq(orgUnits.kind, "DEPARTMENT")))
      .returning(ORG_DEPT_COLUMNS);

    if (!row) throw new NotFoundException("Department not found");

    await this.cache.invalidateForOrg(orgId, "org:units:DEPARTMENT");
    await this.audit.logCritical({ action: "org.department.updated", userId, orgId, targetId: id, targetType: "org_unit" });

    return toOrgDepartment({ ...row, headUserId: effectiveHeadUserId });
  }

  async deleteDepartment(orgId: string, userId: string, id: string) {
    const existing = await this.getDepartment(orgId, id);
    if (!existing) throw new NotFoundException("Department not found");

    await this.db
      .update(orgUnits)
      .set({ deletedAt: new Date() })
      .where(and(eq(orgUnits.id, id), eq(orgUnits.orgId, orgId), eq(orgUnits.kind, "DEPARTMENT")));

    await this.cache.invalidateForOrg(orgId, "org:units:DEPARTMENT");
    await this.audit.logCritical({ action: "org.department.deleted", userId, orgId, targetId: id, targetType: "org_unit" });
  }

  async moveDepartment(orgId: string, departmentId: string, newBranchId: string | null) {
    const dept = await this.db.query.orgUnits.findFirst({
      where: and(
        eq(orgUnits.id, departmentId),
        eq(orgUnits.orgId, orgId),
        eq(orgUnits.kind, "DEPARTMENT"),
        isNull(orgUnits.deletedAt),
      ),
    });
    if (!dept) throw new NotFoundException("Department not found");
    if (newBranchId !== null && newBranchId === departmentId) {
      throw new BadRequestException("A unit cannot be its own parent");
    }

    await this.db
      .update(orgUnits)
      .set({ parentId: newBranchId, updatedAt: new Date() })
      .where(and(eq(orgUnits.id, departmentId), eq(orgUnits.orgId, orgId)));

    return { success: true };
  }
}
