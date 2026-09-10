import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { asc } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { orgUnits } from "../../../db/schema/common/organization";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import type {
  CreateCostCenterInput,
  ListQueryInput,
  UpdateCostCenterInput,
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
} from "./org-unit-crud";

const KIND = "COST_CENTER";
const LABEL = "Cost center";

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
    private readonly audit: AuditService,
  ) {}

  async listCostCenters(orgId: string, query: ListQueryInput) {
    const rows = await this.db
      .select(ORG_COST_CENTER_COLUMNS)
      .from(orgUnits)
      .where(getOrgUnitListFilter({ orgId, kind: KIND, query }))
      .orderBy(asc(orgUnitNormalizedName), asc(orgUnits.id))
      .limit(query.limit + 1);
    return toOrgUnitCursorPage(rows, query.limit, toOrgCostCenter);
  }

  async getCostCenter(orgId: string, id: string) {
    const [row] = await this.db
      .select(ORG_COST_CENTER_COLUMNS)
      .from(orgUnits)
      .where(getOrgUnitRowFilter(orgId, KIND, id))
      .limit(1);
    return row ? toOrgCostCenter(row) : null;
  }

  async createCostCenter(orgId: string, userId: string, body: CreateCostCenterInput) {
    const code = body.code.toUpperCase();
    await assertOrgUnitCodeAvailable({
      db: this.db,
      orgId,
      kind: KIND,
      code,
      label: LABEL,
      includeDeleted: true,
    });

    const [row] = await this.db
      .insert(orgUnits)
      .values({
        id: randomUUID(),
        orgId,
        kind: KIND,
        code,
        name: body.name,
        description: body.description,
      })
      .returning(ORG_COST_CENTER_COLUMNS);

    if (!row) throw new Error("Failed to create cost center");

    await recordOrgUnitAudit(this.audit, {
      action: "org.costCenter.created",
      userId,
      orgId,
      targetId: row.id,
    });

    return toOrgCostCenter(row);
  }

  async updateCostCenter(orgId: string, userId: string, id: string, body: UpdateCostCenterInput) {
    const existing = await this.getCostCenter(orgId, id);
    if (!existing) throw new NotFoundException("Cost center not found");

    if (body.code && body.code !== existing.code) {
      await assertOrgUnitCodeAvailable({
        db: this.db,
        orgId,
        kind: KIND,
        code: body.code.toUpperCase(),
        label: LABEL,
        includeDeleted: true,
      });
    }

    const [row] = await this.db
      .update(orgUnits)
      .set({ ...body, ...(body.code !== undefined && { code: body.code.toUpperCase() }) })
      .where(getOrgUnitWriteFilter(orgId, KIND, id))
      .returning(ORG_COST_CENTER_COLUMNS);

    if (!row) throw new NotFoundException("Cost center not found");

    await recordOrgUnitAudit(this.audit, {
      action: "org.costCenter.updated",
      userId,
      orgId,
      targetId: id,
    });

    return toOrgCostCenter(row);
  }
}
