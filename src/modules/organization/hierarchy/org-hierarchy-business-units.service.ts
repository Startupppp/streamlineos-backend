import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq, ilike, isNull, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { orgUnits } from "../../../db/schema/common/organization";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { AuditService } from "../../../common/audit/audit.service";
import type {
  CreateBusinessUnitInput,
  UpdateBusinessUnitInput,
  ListQueryInput,
} from "./dto/org-hierarchy.schemas";
import {
  getOrgUnitCursorFilter,
  getOrgUnitStatusFilter,
  orgUnitNormalizedName,
  toOrgUnitCursorPage,
} from "./org-hierarchy-list-filters";

const ORG_BU_COLUMNS = {
  id: orgUnits.id,
  orgId: orgUnits.orgId,
  parentId: orgUnits.parentId,
  name: orgUnits.name,
  code: orgUnits.code,
  description: orgUnits.description,
  status: orgUnits.status,
  createdAt: orgUnits.createdAt,
  updatedAt: orgUnits.updatedAt,
  deletedAt: orgUnits.deletedAt,
};

type OrgBusinessUnitRow = Pick<
  typeof orgUnits.$inferSelect,
  | "id"
  | "orgId"
  | "parentId"
  | "name"
  | "code"
  | "description"
  | "status"
  | "createdAt"
  | "updatedAt"
  | "deletedAt"
>;

export function toOrgBusinessUnit(row: OrgBusinessUnitRow) {
  return {
    id: row.id,
    orgId: row.orgId,
    parentId: row.parentId,
    name: row.name,
    code: row.code,
    description: row.description,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

@Injectable()
export class OrgHierarchyBusinessUnitsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
  ) {}

  async listBusinessUnits(orgId: string, query: ListQueryInput) {
    const { cursor, limit, search, status } = query;
    const statusFilter = getOrgUnitStatusFilter(status);
    const cursorFilter = getOrgUnitCursorFilter(cursor);
    const filters = and(
      eq(orgUnits.orgId, orgId),
      eq(orgUnits.kind, "BUSINESS_UNIT"),
      isNull(orgUnits.deletedAt),
      ...(search ? [or(ilike(orgUnits.name, `%${search}%`), ilike(orgUnits.code, `%${search}%`))] : []),
      ...(statusFilter ? [statusFilter] : []),
      ...(cursorFilter ? [cursorFilter] : []),
    );
    const rows = await this.db
      .select(ORG_BU_COLUMNS)
      .from(orgUnits)
      .where(filters)
      .orderBy(asc(orgUnitNormalizedName), asc(orgUnits.id))
      .limit(limit + 1);
    return toOrgUnitCursorPage(rows, limit, toOrgBusinessUnit);
  }

  async getBusinessUnit(orgId: string, id: string) {
    const [row] = await this.db
      .select(ORG_BU_COLUMNS)
      .from(orgUnits)
      .where(
        and(
          eq(orgUnits.id, id),
          eq(orgUnits.orgId, orgId),
          eq(orgUnits.kind, "BUSINESS_UNIT"),
          isNull(orgUnits.deletedAt),
        ),
      )
      .limit(1);
    return row ? toOrgBusinessUnit(row) : null;
  }

  async createBusinessUnit(orgId: string, userId: string, body: CreateBusinessUnitInput) {
    const existing = await this.db.query.orgUnits.findFirst({
      where: and(
        eq(orgUnits.orgId, orgId),
        eq(orgUnits.kind, "BUSINESS_UNIT"),
        eq(orgUnits.code, body.code.toUpperCase()),
        isNull(orgUnits.deletedAt),
      ),
    });
    if (existing) throw new ConflictException("Business unit code already exists");

    const [row] = await this.db
      .insert(orgUnits)
      .values({
        id: randomUUID(),
        orgId,
        kind: "BUSINESS_UNIT",
        name: body.name,
        code: body.code.toUpperCase(),
        description: body.description,
      })
      .returning(ORG_BU_COLUMNS);

    if (!row) throw new Error("Failed to create business unit");

    await this.cache.invalidateForOrg(orgId, "org:units:BUSINESS_UNIT");
    await this.audit.logCritical({ action: "org.businessUnit.created", userId, orgId, targetId: row.id, targetType: "org_unit" });

    return toOrgBusinessUnit(row);
  }

  async updateBusinessUnit(orgId: string, userId: string, id: string, body: UpdateBusinessUnitInput) {
    const existing = await this.getBusinessUnit(orgId, id);
    if (!existing) throw new NotFoundException("Business unit not found");

    if (body.code && body.code !== existing.code) {
      const conflict = await this.db.query.orgUnits.findFirst({
        where: and(
          eq(orgUnits.orgId, orgId),
          eq(orgUnits.kind, "BUSINESS_UNIT"),
          eq(orgUnits.code, body.code.toUpperCase()),
          isNull(orgUnits.deletedAt),
        ),
      });
      if (conflict) throw new ConflictException("Business unit code already exists");
    }

    const [row] = await this.db
      .update(orgUnits)
      .set({ ...body, ...(body.code !== undefined && { code: body.code.toUpperCase() }) })
      .where(and(eq(orgUnits.id, id), eq(orgUnits.orgId, orgId), eq(orgUnits.kind, "BUSINESS_UNIT")))
      .returning(ORG_BU_COLUMNS);

    if (!row) throw new NotFoundException("Business unit not found");

    await this.cache.invalidateForOrg(orgId, "org:units:BUSINESS_UNIT");
    await this.audit.logCritical({ action: "org.businessUnit.updated", userId, orgId, targetId: id, targetType: "org_unit" });

    return toOrgBusinessUnit(row);
  }

  async deleteBusinessUnit(orgId: string, userId: string, id: string) {
    const existing = await this.getBusinessUnit(orgId, id);
    if (!existing) throw new NotFoundException("Business unit not found");

    await this.db
      .update(orgUnits)
      .set({ deletedAt: new Date() })
      .where(and(eq(orgUnits.id, id), eq(orgUnits.orgId, orgId), eq(orgUnits.kind, "BUSINESS_UNIT")));

    await this.cache.invalidateForOrg(orgId, "org:units:BUSINESS_UNIT");
    await this.audit.logCritical({ action: "org.businessUnit.deleted", userId, orgId, targetId: id, targetType: "org_unit" });
  }

  async moveBusinessUnit(orgId: string, buId: string, newParentId: string | null) {
    const bu = await this.db.query.orgUnits.findFirst({
      where: and(
        eq(orgUnits.id, buId),
        eq(orgUnits.orgId, orgId),
        eq(orgUnits.kind, "BUSINESS_UNIT"),
      ),
    });
    if (!bu) throw new NotFoundException("Business unit not found");
    if (newParentId !== null && newParentId === buId) {
      throw new BadRequestException("A unit cannot be its own parent");
    }

    await this.db
      .update(orgUnits)
      .set({ parentId: newParentId, updatedAt: new Date() })
      .where(and(eq(orgUnits.id, buId), eq(orgUnits.orgId, orgId)));

    return { success: true };
  }
}
