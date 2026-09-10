import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { asc } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { orgUnits } from "../../../db/schema/common/organization";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import type {
  CreateBusinessUnitInput,
  UpdateBusinessUnitInput,
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
} from "./org-unit-crud";

const KIND = "BUSINESS_UNIT";
const LABEL = "Business unit";

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
    private readonly audit: AuditService,
  ) {}

  async listBusinessUnits(orgId: string, query: ListQueryInput) {
    const rows = await this.db
      .select(ORG_BU_COLUMNS)
      .from(orgUnits)
      .where(getOrgUnitListFilter({ orgId, kind: KIND, query }))
      .orderBy(asc(orgUnitNormalizedName), asc(orgUnits.id))
      .limit(query.limit + 1);
    return toOrgUnitCursorPage(rows, query.limit, toOrgBusinessUnit);
  }

  async getBusinessUnit(orgId: string, id: string) {
    const [row] = await this.db
      .select(ORG_BU_COLUMNS)
      .from(orgUnits)
      .where(getOrgUnitRowFilter(orgId, KIND, id))
      .limit(1);
    return row ? toOrgBusinessUnit(row) : null;
  }

  async createBusinessUnit(orgId: string, userId: string, body: CreateBusinessUnitInput) {
    const code = body.code.toUpperCase();
    await assertOrgUnitCodeAvailable({
      db: this.db,
      orgId,
      kind: KIND,
      code,
      label: LABEL,
    });

    const [row] = await this.db
      .insert(orgUnits)
      .values({
        id: randomUUID(),
        orgId,
        kind: KIND,
        name: body.name,
        code,
        description: body.description,
      })
      .returning(ORG_BU_COLUMNS);

    if (!row) throw new Error("Failed to create business unit");

    await recordOrgUnitAudit(this.audit, {
      action: "org.businessUnit.created",
      userId,
      orgId,
      targetId: row.id,
    });

    return toOrgBusinessUnit(row);
  }

  async updateBusinessUnit(orgId: string, userId: string, id: string, body: UpdateBusinessUnitInput) {
    const existing = await this.getBusinessUnit(orgId, id);
    if (!existing) throw new NotFoundException("Business unit not found");

    if (body.code && body.code !== existing.code) {
      await assertOrgUnitCodeAvailable({
        db: this.db,
        orgId,
        kind: KIND,
        code: body.code.toUpperCase(),
        label: LABEL,
      });
    }

    const [row] = await this.db
      .update(orgUnits)
      .set({ ...body, ...(body.code !== undefined && { code: body.code.toUpperCase() }) })
      .where(getOrgUnitWriteFilter(orgId, KIND, id))
      .returning(ORG_BU_COLUMNS);

    if (!row) throw new NotFoundException("Business unit not found");

    await recordOrgUnitAudit(this.audit, {
      action: "org.businessUnit.updated",
      userId,
      orgId,
      targetId: id,
    });

    return toOrgBusinessUnit(row);
  }
}
