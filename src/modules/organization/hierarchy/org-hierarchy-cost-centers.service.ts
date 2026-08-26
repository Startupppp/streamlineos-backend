import {
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
  CreateCostCenterInput,
  ListQueryInput,
  UpdateCostCenterInput,
} from "./dto/org-hierarchy.schemas";
import {
  getOrgUnitCursorFilter,
  getOrgUnitStatusFilter,
  orgUnitNormalizedName,
  toOrgUnitCursorPage,
} from "./org-hierarchy-list-filters";

const ORG_COST_CENTER_COLUMNS = {
  id: orgUnits.id,
  orgId: orgUnits.orgId,
  name: orgUnits.name,
  code: orgUnits.code,
  description: orgUnits.description,
  status: orgUnits.status,
  createdAt: orgUnits.createdAt,
  updatedAt: orgUnits.updatedAt,
  deletedAt: orgUnits.deletedAt,
};

type OrgCostCenterRow = Pick<
  typeof orgUnits.$inferSelect,
  | "id"
  | "orgId"
  | "name"
  | "code"
  | "description"
  | "status"
  | "createdAt"
  | "updatedAt"
  | "deletedAt"
>;

export function toOrgCostCenter(row: OrgCostCenterRow) {
  return {
    id: row.id,
    orgId: row.orgId,
    code: row.code,
    name: row.name,
    description: row.description,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

@Injectable()
export class OrgHierarchyCostCentersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
  ) {}

  async listCostCenters(orgId: string, query: ListQueryInput) {
    const { cursor, limit, search, status } = query;
    const statusFilter = getOrgUnitStatusFilter(status);
    const cursorFilter = getOrgUnitCursorFilter(cursor);
    const filters = and(
      eq(orgUnits.orgId, orgId),
      eq(orgUnits.kind, "COST_CENTER"),
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
      .select(ORG_COST_CENTER_COLUMNS)
      .from(orgUnits)
      .where(filters)
      .orderBy(asc(orgUnitNormalizedName), asc(orgUnits.id))
      .limit(limit + 1);
    return toOrgUnitCursorPage(rows, limit, toOrgCostCenter);
  }

  async getCostCenter(orgId: string, id: string) {
    const [row] = await this.db
      .select(ORG_COST_CENTER_COLUMNS)
      .from(orgUnits)
      .where(
        and(
          eq(orgUnits.id, id),
          eq(orgUnits.orgId, orgId),
          eq(orgUnits.kind, "COST_CENTER"),
          isNull(orgUnits.deletedAt),
        ),
      )
      .limit(1);
    return row ? toOrgCostCenter(row) : null;
  }

  async createCostCenter(orgId: string, userId: string, body: CreateCostCenterInput) {
    const conflict = await this.db.query.orgUnits.findFirst({
      where: and(
        eq(orgUnits.orgId, orgId),
        eq(orgUnits.kind, "COST_CENTER"),
        eq(orgUnits.code, body.code.toUpperCase()),
      ),
    });
    if (conflict) throw new ConflictException("Cost center code already exists");

    const [row] = await this.db
      .insert(orgUnits)
      .values({
        id: randomUUID(),
        orgId,
        kind: "COST_CENTER",
        code: body.code.toUpperCase(),
        name: body.name,
        description: body.description,
      })
      .returning(ORG_COST_CENTER_COLUMNS);

    if (!row) throw new Error("Failed to create cost center");

    await this.cache.invalidateForOrg(orgId, "org:units:COST_CENTER");
    await this.audit.logCritical({ action: "org.costCenter.created", userId, orgId, targetId: row.id, targetType: "org_unit" });

    return toOrgCostCenter(row);
  }

  async updateCostCenter(orgId: string, userId: string, id: string, body: UpdateCostCenterInput) {
    const existing = await this.getCostCenter(orgId, id);
    if (!existing) throw new NotFoundException("Cost center not found");

    if (body.code && body.code !== existing.code) {
      const conflict = await this.db.query.orgUnits.findFirst({
        where: and(
          eq(orgUnits.orgId, orgId),
          eq(orgUnits.kind, "COST_CENTER"),
          eq(orgUnits.code, body.code.toUpperCase()),
        ),
      });
      if (conflict) throw new ConflictException("Cost center code already exists");
    }

    const [row] = await this.db
      .update(orgUnits)
      .set({ ...body, ...(body.code !== undefined && { code: body.code.toUpperCase() }) })
      .where(and(eq(orgUnits.id, id), eq(orgUnits.orgId, orgId), eq(orgUnits.kind, "COST_CENTER")))
      .returning(ORG_COST_CENTER_COLUMNS);

    if (!row) throw new NotFoundException("Cost center not found");

    await this.cache.invalidateForOrg(orgId, "org:units:COST_CENTER");
    await this.audit.logCritical({ action: "org.costCenter.updated", userId, orgId, targetId: id, targetType: "org_unit" });

    return toOrgCostCenter(row);
  }

  async deleteCostCenter(orgId: string, userId: string, id: string) {
    const existing = await this.getCostCenter(orgId, id);
    if (!existing) throw new NotFoundException("Cost center not found");

    await this.db
      .update(orgUnits)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(orgUnits.id, id),
          eq(orgUnits.orgId, orgId),
          eq(orgUnits.kind, "COST_CENTER"),
        ),
      );

    await this.cache.invalidateForOrg(orgId, "org:units:COST_CENTER");
    await this.audit.logCritical({ action: "org.costCenter.deleted", userId, orgId, targetId: id, targetType: "org_unit" });
  }
}
