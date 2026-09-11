import { Injectable } from "@nestjs/common";
import { orgUnits } from "../../../db/schema";
import type {
  CreateCostCenterInput,
  ListQueryInput,
  UpdateCostCenterInput,
} from "./dto/org-hierarchy.schemas";
import {
  OrgUnitCrudService,
  type OrgUnitCrudAdapter,
} from "./org-unit-crud";

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

const COST_CENTER_ADAPTER: OrgUnitCrudAdapter<
  CreateCostCenterInput,
  UpdateCostCenterInput,
  OrgCostCenterRow,
  OrgCostCenterRow,
  ReturnType<typeof toOrgCostCenter>
> = {
  kind: "COST_CENTER",
  label: "Cost center",
  auditName: "org.costCenter",
  code: {
    create: (input) => input.code,
    update: (input) => input.code,
    current: (row) => row.code,
    includeDeleted: true,
  },
  listRows: async (db, plan) =>
    db
      .select(ORG_COST_CENTER_COLUMNS)
      .from(orgUnits)
      .where(plan.where)
      .orderBy(...plan.orderBy)
      .limit(plan.limit),
  readRow: async (db, where) => {
    const [row] = await db
      .select(ORG_COST_CENTER_COLUMNS)
      .from(orgUnits)
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
  toOutput: toOrgCostCenter,
  toListOutput: toOrgCostCenter,
  toWriteOutput: toOrgCostCenter,
};

@Injectable()
export class OrgHierarchyCostCentersService {
  constructor(private readonly crud: OrgUnitCrudService) {}

  listCostCenters(orgId: string, query: ListQueryInput) {
    return this.crud.list(COST_CENTER_ADAPTER, orgId, query);
  }

  getCostCenter(orgId: string, id: string) {
    return this.crud.get(COST_CENTER_ADAPTER, orgId, id);
  }

  createCostCenter(
    orgId: string,
    userId: string,
    body: CreateCostCenterInput,
  ) {
    return this.crud.create(COST_CENTER_ADAPTER, orgId, userId, body);
  }

  updateCostCenter(
    orgId: string,
    userId: string,
    id: string,
    body: UpdateCostCenterInput,
  ) {
    return this.crud.update(COST_CENTER_ADAPTER, orgId, userId, id, body);
  }
}
