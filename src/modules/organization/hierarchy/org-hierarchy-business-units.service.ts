import { Injectable } from "@nestjs/common";
import { orgUnits } from "../../../db/schema";
import type {
  CreateBusinessUnitInput,
  ListQueryInput,
  UpdateBusinessUnitInput,
} from "./dto/org-hierarchy.schemas";
import {
  OrgUnitCrudService,
  type OrgUnitCrudAdapter,
} from "./org-unit-crud";

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

const BUSINESS_UNIT_ADAPTER: OrgUnitCrudAdapter<
  CreateBusinessUnitInput,
  UpdateBusinessUnitInput,
  OrgBusinessUnitRow,
  OrgBusinessUnitRow,
  ReturnType<typeof toOrgBusinessUnit>
> = {
  kind: "BUSINESS_UNIT",
  label: "Business unit",
  auditName: "org.businessUnit",
  code: {
    create: (input) => input.code,
    update: (input) => input.code,
    current: (row) => row.code,
  },
  parent: {
    rule: "absent",
    kind: "BUSINESS_UNIT",
    label: "business unit",
    current: (row) => row.parentId,
  },
  listRows: async (db, plan) =>
    db
      .select(ORG_BU_COLUMNS)
      .from(orgUnits)
      .where(plan.where)
      .orderBy(...plan.orderBy)
      .limit(plan.limit),
  readRow: async (db, where) => {
    const [row] = await db
      .select(ORG_BU_COLUMNS)
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
  toOutput: toOrgBusinessUnit,
  toListOutput: toOrgBusinessUnit,
  toWriteOutput: toOrgBusinessUnit,
};

@Injectable()
export class OrgHierarchyBusinessUnitsService {
  constructor(private readonly crud: OrgUnitCrudService) {}

  listBusinessUnits(orgId: string, query: ListQueryInput) {
    return this.crud.list(BUSINESS_UNIT_ADAPTER, orgId, query);
  }

  getBusinessUnit(orgId: string, id: string) {
    return this.crud.get(BUSINESS_UNIT_ADAPTER, orgId, id);
  }

  createBusinessUnit(
    orgId: string,
    userId: string,
    body: CreateBusinessUnitInput,
  ) {
    return this.crud.create(BUSINESS_UNIT_ADAPTER, orgId, userId, body);
  }

  updateBusinessUnit(
    orgId: string,
    userId: string,
    id: string,
    body: UpdateBusinessUnitInput,
  ) {
    return this.crud.update(BUSINESS_UNIT_ADAPTER, orgId, userId, id, body);
  }
}
