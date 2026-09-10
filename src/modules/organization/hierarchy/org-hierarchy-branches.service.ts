import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { randomUUID } from "node:crypto";
import {
  organizationMembers,
  orgUnits,
  type OrgUnitMetadata,
} from "../../../db/schema";

import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import type {
  BranchOptionsQueryInput,
  CreateOrgBranchInput,
  UpdateOrgBranchInput,
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

const KIND = "BRANCH";
const LABEL = "Branch";

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

const ORG_BRANCH_READ_COLUMNS = {
  ...ORG_BRANCH_COLUMNS,
  headUserId: headMember.userId,
};

const branchBusinessUnits = alias(orgUnits, "branch_business_units");
const ORG_BRANCH_LIST_COLUMNS = {
  ...ORG_BRANCH_READ_COLUMNS,
  businessUnitName: branchBusinessUnits.name,
};

const branchEmailSearch = (pattern: string) =>
  sql<boolean>`coalesce(${orgUnits.metadata}->>'email', '') ilike ${pattern}`;

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

function toOrgBranchList(
  row: OrgBranchRow & { businessUnitName: string | null },
) {
  return {
    ...toOrgBranch(row),
    businessUnitName: row.businessUnitName,
  };
}

@Injectable()
export class OrgHierarchyBranchesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async listOrgBranches(orgId: string, query: ListQueryInput) {
    const rows = await this.db
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
      .where(
        getOrgUnitListFilter({
          orgId,
          kind: KIND,
          query,
          searchExtension: branchEmailSearch,
        }),
      )
      .orderBy(asc(orgUnitNormalizedName), asc(orgUnits.id))
      .limit(query.limit + 1);
    return toOrgUnitCursorPage(rows, query.limit, toOrgBranchList);
  }

  async listOrgBranchOptions(orgId: string, query: BranchOptionsQueryInput) {
    return this.listOrgBranches(orgId, { ...query, status: "ACTIVE" });
  }

  private async getOrgBranchRow(
    orgId: string,
    id: string,
  ): Promise<OrgBranchRow | null> {
    const [row] = await this.db
      .select(ORG_BRANCH_READ_COLUMNS)
      .from(orgUnits)
      .leftJoin(headMember, eq(headMember.id, orgUnits.headMembershipId))
      .where(getOrgUnitRowFilter(orgId, KIND, id))
      .limit(1);
    return row ?? null;
  }

  async getOrgBranch(orgId: string, id: string) {
    const row = await this.getOrgBranchRow(orgId, id);
    return row ? toOrgBranch(row) : null;
  }

  async createOrgBranch(
    orgId: string,
    userId: string,
    body: CreateOrgBranchInput,
  ) {
    const code = body.code.toUpperCase();
    await assertOrgUnitCodeAvailable({
      db: this.db,
      orgId,
      kind: KIND,
      code,
      label: LABEL,
    });

    const { businessUnitId, managerUserId, name } = body;

    const managerMembershipId =
      (await resolveOrgUnitHeadMembershipId(this.db, orgId, managerUserId)) ?? null;

    const [row] = await this.db
      .insert(orgUnits)
      .values({
        id: randomUUID(),
        orgId,
        kind: KIND,
        name,
        code,
        headMembershipId: managerMembershipId,
        parentId: businessUnitId ?? undefined,
        metadata: toBranchMetadata(body),
      })
      .returning(ORG_BRANCH_COLUMNS);

    if (!row) throw new Error("Failed to create branch");

    await recordOrgUnitAudit(this.audit, {
      action: "org.branch.created",
      userId,
      orgId,
      targetId: row.id,
    });

    return toOrgBranch({ ...row, headUserId: managerUserId ?? null });
  }

  async updateOrgBranch(
    orgId: string,
    userId: string,
    id: string,
    body: UpdateOrgBranchInput,
  ) {
    const existing = await this.getOrgBranchRow(orgId, id);
    if (!existing) throw new NotFoundException("Branch not found");

    if (body.code && body.code !== existing.code) {
      await assertOrgUnitCodeAvailable({
        db: this.db,
        orgId,
        kind: KIND,
        code: body.code.toUpperCase(),
        label: LABEL,
      });
    }

    const { businessUnitId, managerUserId, status, name, code } = body;

    const existingMeta: OrgUnitMetadata = { ...(existing.metadata ?? {}) };

    const managerMembershipId = await resolveOrgUnitHeadMembershipId(
      this.db,
      orgId,
      managerUserId,
    );

    const effectiveHeadUserId =
      managerUserId !== undefined
        ? (managerUserId ?? null)
        : (existing.headUserId ?? null);

    const [row] = await this.db
      .update(orgUnits)
      .set({
        ...(name !== undefined && { name }),
        ...(code !== undefined && { code: code.toUpperCase() }),
        ...(status !== undefined && { status }),
        ...(managerUserId !== undefined && {
          headMembershipId: managerMembershipId,
        }),
        ...(businessUnitId !== undefined && { parentId: businessUnitId }),
        metadata: { ...existingMeta, ...toBranchMetadata(body) },
      })
      .where(getOrgUnitWriteFilter(orgId, KIND, id))
      .returning(ORG_BRANCH_COLUMNS);

    if (!row) throw new NotFoundException("Branch not found");

    await recordOrgUnitAudit(this.audit, {
      action: "org.branch.updated",
      userId,
      orgId,
      targetId: id,
    });

    return toOrgBranch({ ...row, headUserId: effectiveHeadUserId });
  }
}
