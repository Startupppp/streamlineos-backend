import { Injectable } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  organizationMembers,
  orgUnits,
  type OrgUnitMetadata,
} from "../../../db/schema";
import type {
  BranchOptionsQueryInput,
  CreateOrgBranchInput,
  ListQueryInput,
  UpdateOrgBranchInput,
} from "./dto/org-hierarchy.schemas";
import {
  OrgUnitCrudService,
  type OrgUnitCrudAdapter,
} from "./org-unit-crud";

const ORG_BRANCH_COLUMNS = {
  id: orgUnits.id,
  orgId: orgUnits.orgId,
  name: orgUnits.name,
  code: orgUnits.code,
  status: orgUnits.status,
  parentId: orgUnits.parentId,
  metadata: orgUnits.metadata,
  createdAt: orgUnits.createdAt,
  updatedAt: orgUnits.updatedAt,
  deletedAt: orgUnits.deletedAt,
};

const headMember = alias(organizationMembers, "head_member");
const branchBusinessUnits = alias(orgUnits, "branch_business_units");

const ORG_BRANCH_READ_COLUMNS = {
  ...ORG_BRANCH_COLUMNS,
  headUserId: headMember.userId,
};

const ORG_BRANCH_LIST_COLUMNS = {
  ...ORG_BRANCH_READ_COLUMNS,
  businessUnitName: branchBusinessUnits.name,
};

type OrgBranchRow = Pick<
  typeof orgUnits.$inferSelect,
  | "id"
  | "orgId"
  | "name"
  | "code"
  | "status"
  | "parentId"
  | "metadata"
  | "createdAt"
  | "updatedAt"
  | "deletedAt"
> & { headUserId: string | null };

type OrgBranchListRow = OrgBranchRow & { businessUnitName: string | null };

type BranchAddressPatch = Pick<
  UpdateOrgBranchInput,
  "address" | "city" | "state" | "country" | "postalCode" | "phone" | "email"
>;

function toBranchMetadata(patch: BranchAddressPatch): OrgUnitMetadata {
  const { address, city, state, country, postalCode, phone, email } = patch;
  return {
    ...(address !== undefined ? { address: address ?? undefined } : {}),
    ...(city !== undefined ? { city: city ?? undefined } : {}),
    ...(state !== undefined ? { state: state ?? undefined } : {}),
    ...(country !== undefined ? { country: country ?? undefined } : {}),
    ...(postalCode !== undefined ? { postalCode: postalCode ?? undefined } : {}),
    ...(phone !== undefined ? { phone: phone ?? undefined } : {}),
    ...(email !== undefined ? { email: email || undefined } : {}),
  };
}

export function toOrgBranch(row: OrgBranchRow) {
  return {
    id: row.id,
    orgId: row.orgId,
    businessUnitId: row.parentId,
    managerUserId: row.headUserId,
    name: row.name,
    code: row.code,
    address: row.metadata?.address ?? null,
    city: row.metadata?.city ?? null,
    state: row.metadata?.state ?? null,
    country: row.metadata?.country ?? null,
    postalCode: row.metadata?.postalCode ?? null,
    phone: row.metadata?.phone ?? null,
    email: row.metadata?.email ?? null,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

function toOrgBranchList(row: OrgBranchListRow) {
  return {
    ...toOrgBranch(row),
    businessUnitName: row.businessUnitName,
  };
}

const BRANCH_ADAPTER: OrgUnitCrudAdapter<
  CreateOrgBranchInput,
  UpdateOrgBranchInput,
  OrgBranchRow,
  OrgBranchListRow,
  ReturnType<typeof toOrgBranch>,
  ReturnType<typeof toOrgBranchList>
> = {
  kind: "BRANCH",
  label: "Branch",
  auditName: "org.branch",
  searchExtension: (pattern) =>
    sql<boolean>`coalesce(${orgUnits.metadata}->>'email', '') ilike ${pattern}`,
  code: {
    create: (input) => input.code,
    update: (input) => input.code,
    current: (row) => row.code,
  },
  parent: {
    rule: "optional",
    kind: "BUSINESS_UNIT",
    label: "business unit",
    create: (input) => input.businessUnitId,
    update: (input) => input.businessUnitId,
    current: (row) => row.parentId,
  },
  head: {
    create: (input) => input.managerUserId,
    update: (input) => input.managerUserId,
    current: (row) => row.headUserId,
  },
  listRows: async (db, plan) =>
    db
      .select(ORG_BRANCH_LIST_COLUMNS)
      .from(orgUnits)
      .leftJoin(headMember, eq(headMember.id, orgUnits.headMembershipId))
      .leftJoin(
        branchBusinessUnits,
        and(
          eq(branchBusinessUnits.id, orgUnits.parentId),
          eq(branchBusinessUnits.orgId, orgUnits.orgId),
          eq(branchBusinessUnits.kind, "BUSINESS_UNIT"),
          isNull(branchBusinessUnits.deletedAt),
        ),
      )
      .where(plan.where)
      .orderBy(...plan.orderBy)
      .limit(plan.limit),
  readRow: async (db, where) => {
    const [row] = await db
      .select(ORG_BRANCH_READ_COLUMNS)
      .from(orgUnits)
      .leftJoin(headMember, eq(headMember.id, orgUnits.headMembershipId))
      .where(where)
      .limit(1);
    return row ?? null;
  },
  createValues: (input) => ({
    name: input.name,
    metadata: toBranchMetadata(input),
  }),
  updateValues: (input, existing) => ({
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    metadata: { ...(existing.metadata ?? {}), ...toBranchMetadata(input) },
  }),
  toOutput: toOrgBranch,
  toListOutput: toOrgBranchList,
  toWriteOutput: toOrgBranch,
};

@Injectable()
export class OrgHierarchyBranchesService {
  constructor(private readonly crud: OrgUnitCrudService) {}

  listOrgBranches(orgId: string, query: ListQueryInput) {
    return this.crud.list(BRANCH_ADAPTER, orgId, query);
  }

  listOrgBranchOptions(orgId: string, query: BranchOptionsQueryInput) {
    return this.listOrgBranches(orgId, { ...query, status: "ACTIVE" });
  }

  getOrgBranch(orgId: string, id: string) {
    return this.crud.get(BRANCH_ADAPTER, orgId, id);
  }

  createOrgBranch(orgId: string, userId: string, body: CreateOrgBranchInput) {
    return this.crud.create(BRANCH_ADAPTER, orgId, userId, body);
  }

  updateOrgBranch(
    orgId: string,
    userId: string,
    id: string,
    body: UpdateOrgBranchInput,
  ) {
    return this.crud.update(BRANCH_ADAPTER, orgId, userId, id, body);
  }
}
