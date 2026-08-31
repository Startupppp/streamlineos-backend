import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { randomUUID } from "node:crypto";
import { organizationMembers, orgUnits, type OrgUnitMetadata } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { AuditService } from "../../../common/audit/audit.service";
import type {
  CreateOrgBranchInput,
  UpdateOrgBranchInput,
  ListQueryInput,
} from "./dto/org-hierarchy.schemas";
import {
  getOrgUnitCursorFilter,
  getOrgUnitStatusFilter,
  orgUnitNormalizedName,
  toOrgUnitCursorPage,
} from "./org-hierarchy-list-filters";

const ORG_BRANCH_COLUMNS = {
  id: orgUnits.id,
  orgId: orgUnits.orgId,
  name: orgUnits.name,
  code: orgUnits.code,
  status: orgUnits.status,
  parentId: orgUnits.parentId,
  headUserId: orgUnits.headUserId,
  metadata: orgUnits.metadata,
  createdAt: orgUnits.createdAt,
  updatedAt: orgUnits.updatedAt,
  deletedAt: orgUnits.deletedAt,
};

const branchBusinessUnits = alias(orgUnits, "branch_business_units");
const ORG_BRANCH_LIST_COLUMNS = {
  ...ORG_BRANCH_COLUMNS,
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
  | "headUserId"
  | "metadata"
  | "createdAt"
  | "updatedAt"
  | "deletedAt"
>;

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
    private readonly cache: CacheService,
    private readonly audit: AuditService,
  ) {}

  async listOrgBranches(orgId: string, query: ListQueryInput) {
    const { cursor, limit, search, status } = query;
    const statusFilter = getOrgUnitStatusFilter(status);
    const cursorFilter = getOrgUnitCursorFilter(cursor);
    const filters = and(
      eq(orgUnits.orgId, orgId),
      eq(orgUnits.kind, "BRANCH"),
      isNull(orgUnits.deletedAt),
      ...(search
        ? [
            or(
              ilike(orgUnits.name, `%${search}%`),
              ilike(orgUnits.code, `%${search}%`),
              sql<boolean>`coalesce(${orgUnits.metadata}->>'email', '') ilike ${`%${search}%`}`,
            ),
          ]
        : []),
      ...(statusFilter ? [statusFilter] : []),
      ...(cursorFilter ? [cursorFilter] : []),
    );
    const rows = await this.db
      .select(ORG_BRANCH_LIST_COLUMNS)
      .from(orgUnits)
      .leftJoin(
        branchBusinessUnits,
        and(
          eq(branchBusinessUnits.id, orgUnits.parentId),
          eq(branchBusinessUnits.orgId, orgUnits.orgId),
          eq(branchBusinessUnits.kind, "BUSINESS_UNIT"),
        ),
      )
      .where(filters)
      .orderBy(asc(orgUnitNormalizedName), asc(orgUnits.id))
      .limit(limit + 1);
    return toOrgUnitCursorPage(rows, limit, toOrgBranchList);
  }

  private async getOrgBranchRow(
    orgId: string,
    id: string,
  ): Promise<OrgBranchRow | null> {
    const [row] = await this.db
      .select(ORG_BRANCH_COLUMNS)
      .from(orgUnits)
      .where(
        and(
          eq(orgUnits.id, id),
          eq(orgUnits.orgId, orgId),
          eq(orgUnits.kind, "BRANCH"),
          isNull(orgUnits.deletedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async getOrgBranch(orgId: string, id: string) {
    const row = await this.getOrgBranchRow(orgId, id);
    return row ? toOrgBranch(row) : null;
  }

  async createOrgBranch(orgId: string, userId: string, body: CreateOrgBranchInput) {
    const conflict = await this.db.query.orgUnits.findFirst({
      where: and(
        eq(orgUnits.orgId, orgId),
        eq(orgUnits.kind, "BRANCH"),
        eq(orgUnits.code, body.code.toUpperCase()),
        isNull(orgUnits.deletedAt),
      ),
    });
    if (conflict) throw new ConflictException("Branch code already exists");

    const { address, city, state, country, postalCode, phone, email, businessUnitId, managerUserId, ...rest } = body;

    const managerMembershipId = managerUserId
      ? await this.db
          .select({ id: organizationMembers.id })
          .from(organizationMembers)
          .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, managerUserId)))
          .limit(1)
          .then((rows) => rows[0]?.id ?? null)
      : null;

    const [row] = await this.db
      .insert(orgUnits)
      .values({
        id: randomUUID(),
        orgId,
        kind: "BRANCH",
        ...rest,
        code: body.code.toUpperCase(),
        headUserId: managerUserId ?? undefined,
        headMembershipId: managerMembershipId,
        parentId: businessUnitId ?? undefined,
        metadata: {
          ...(address !== undefined ? { address: address ?? undefined } : {}),
          ...(city !== undefined ? { city: city ?? undefined } : {}),
          ...(state !== undefined ? { state: state ?? undefined } : {}),
          ...(country !== undefined ? { country: country ?? undefined } : {}),
          ...(postalCode !== undefined ? { postalCode: postalCode ?? undefined } : {}),
          ...(phone !== undefined ? { phone: phone ?? undefined } : {}),
          ...(email !== undefined ? { email: email || undefined } : {}),
        },
      })
      .returning(ORG_BRANCH_COLUMNS);

    if (!row) throw new Error("Failed to create branch");

    await this.cache.invalidateForOrg(orgId, "org:units:BRANCH");
    await this.cache.invalidateForOrg(orgId, "branches:list");
    await this.audit.logCritical({ action: "org.branch.created", userId, orgId, targetId: row.id, targetType: "org_unit" });

    return toOrgBranch(row);
  }

  async updateOrgBranch(orgId: string, userId: string, id: string, body: UpdateOrgBranchInput) {
    const existing = await this.getOrgBranchRow(orgId, id);
    if (!existing) throw new NotFoundException("Branch not found");

    if (body.code && body.code !== existing.code) {
      const conflict = await this.db.query.orgUnits.findFirst({
        where: and(
          eq(orgUnits.orgId, orgId),
          eq(orgUnits.kind, "BRANCH"),
          eq(orgUnits.code, body.code.toUpperCase()),
          isNull(orgUnits.deletedAt),
        ),
      });
      if (conflict) throw new ConflictException("Branch code already exists");
    }

    const { address, city, state, country, postalCode, phone, email, businessUnitId, managerUserId, status, name, code } = body;

    const existingMeta: OrgUnitMetadata = { ...(existing.metadata ?? {}) };

    let managerMembershipId: number | null | undefined = undefined;
    if (managerUserId !== undefined) {
      if (managerUserId) {
        const [member] = await this.db
          .select({ id: organizationMembers.id })
          .from(organizationMembers)
          .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, managerUserId)))
          .limit(1);
        managerMembershipId = member?.id ?? null;
      } else {
        managerMembershipId = null;
      }
    }

    const [row] = await this.db
      .update(orgUnits)
      .set({
        ...(name !== undefined && { name }),
        ...(code !== undefined && { code: code.toUpperCase() }),
        ...(status !== undefined && { status }),
        ...(managerUserId !== undefined && { headUserId: managerUserId, headMembershipId: managerMembershipId }),
        ...(businessUnitId !== undefined && { parentId: businessUnitId }),
        metadata: {
          ...existingMeta,
          ...(address !== undefined ? { address: address ?? undefined } : {}),
          ...(city !== undefined ? { city: city ?? undefined } : {}),
          ...(state !== undefined ? { state: state ?? undefined } : {}),
          ...(country !== undefined ? { country: country ?? undefined } : {}),
          ...(postalCode !== undefined ? { postalCode: postalCode ?? undefined } : {}),
          ...(phone !== undefined ? { phone: phone ?? undefined } : {}),
          ...(email !== undefined ? { email: email || undefined } : {}),
        },
      })
      .where(and(eq(orgUnits.id, id), eq(orgUnits.orgId, orgId), eq(orgUnits.kind, "BRANCH")))
      .returning(ORG_BRANCH_COLUMNS);

    if (!row) throw new NotFoundException("Branch not found");

    await this.cache.invalidateForOrg(orgId, "org:units:BRANCH");
    await this.cache.invalidateForOrg(orgId, "branches:list");
    await this.audit.logCritical({ action: "org.branch.updated", userId, orgId, targetId: id, targetType: "org_unit" });

    return toOrgBranch(row);
  }

  async deleteOrgBranch(orgId: string, userId: string, id: string) {
    const existing = await this.getOrgBranch(orgId, id);
    if (!existing) throw new NotFoundException("Branch not found");

    await this.db
      .update(orgUnits)
      .set({ deletedAt: new Date() })
      .where(and(eq(orgUnits.id, id), eq(orgUnits.orgId, orgId), eq(orgUnits.kind, "BRANCH")));

    await this.cache.invalidateForOrg(orgId, "org:units:BRANCH");
    await this.cache.invalidateForOrg(orgId, "branches:list");
    await this.audit.logCritical({ action: "org.branch.deleted", userId, orgId, targetId: id, targetType: "org_unit" });
  }

  async moveBranch(orgId: string, branchId: string, newBusinessUnitId: string | null) {
    const branch = await this.db.query.orgUnits.findFirst({
      where: and(
        eq(orgUnits.id, branchId),
        eq(orgUnits.orgId, orgId),
        eq(orgUnits.kind, "BRANCH"),
        isNull(orgUnits.deletedAt),
      ),
    });
    if (!branch) throw new NotFoundException("Branch not found");
    if (newBusinessUnitId !== null && newBusinessUnitId === branchId) {
      throw new BadRequestException("A unit cannot be its own parent");
    }

    await this.db
      .update(orgUnits)
      .set({ parentId: newBusinessUnitId, updatedAt: new Date() })
      .where(and(eq(orgUnits.id, branchId), eq(orgUnits.orgId, orgId)));

    return { success: true };
  }
}
