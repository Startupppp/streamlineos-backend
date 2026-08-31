import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  hrEmployments,
  hrPeople,
  orgUnits,
  organizationMembers,
  users,
  type OrgUnitMetadata,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { OrgHierarchyCacheService } from "../../common/cache/org-hierarchy-cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";
import { syncOrgUnitPlacement } from "../../common/org/sync-org-unit-placement";
import {
  livePersonOfUser,
  primaryEmploymentOfPerson,
} from "../directory/employment-query";
import type {
  CreateBranchInput,
  UpdateBranchInput,
} from "./dto/branches.schemas";

function readBranchMeta(raw: OrgUnitMetadata | null | undefined): OrgUnitMetadata {
  if (!raw) return {};
  return raw;
}

@Injectable()
export class BranchesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly hierarchyCache: OrgHierarchyCacheService,
  ) {}

  list(orgId: string) {
    return this.cache.cachedForOrg(
      orgId,
      "branches:list",
      async () => {
        const rows = await this.db.query.orgUnits.findMany({
          where: and(
            eq(orgUnits.orgId, orgId),
            eq(orgUnits.kind, "BRANCH"),
            isNull(orgUnits.deletedAt),
          ),
          with: {
            head: { columns: { id: true, name: true, image: true } },
          },
        });

        const hrContactIds = rows
          .map((branchRow) =>
            readBranchMeta(branchRow.metadata).hrContactUserId,
          )
          .filter((userId): userId is string => typeof userId === "string");

        const hrUsers =
          hrContactIds.length > 0
            ? await this.db
                .select({ id: users.id, name: users.name, image: users.image })
                .from(users)
                .where(inArray(users.id, hrContactIds))
            : [];
        const hrMap = new Map(
          hrUsers.map((hrUser) => [hrUser.id, hrUser]),
        );

        return rows.map((branchRow) => {
          const meta = readBranchMeta(branchRow.metadata);
          return {
            id: branchRow.id,
            orgId: branchRow.orgId,
            name: branchRow.name,
            code: branchRow.code,
            city: meta.city ?? null,
            state: meta.state ?? null,
            country: meta.country ?? null,
            pincode: meta.postalCode ?? null,
            address: meta.address ?? null,
            phone: meta.phone ?? null,
            email: meta.email ?? null,
            status:
              branchRow.status === "ACTIVE" ? "ACTIVE" : "INACTIVE",
            createdAt: branchRow.createdAt,
            updatedAt: branchRow.updatedAt,
            branchManager: branchRow.head ?? null,
            branchHr: meta.hrContactUserId
              ? (hrMap.get(meta.hrContactUserId) ?? null)
              : null,
          };
        });
      },
      CACHE_TTL.MEDIUM,
    );
  }

  async getOne(orgId: string, branchId: string) {
    const branch = await this.db.query.orgUnits.findFirst({
      where: and(
        eq(orgUnits.id, branchId),
        eq(orgUnits.orgId, orgId),
        eq(orgUnits.kind, "BRANCH"),
        isNull(orgUnits.deletedAt),
      ),
      with: {
        head: { columns: { id: true, name: true, image: true, email: true } },
      },
    });
    if (!branch) return null;

    const meta = readBranchMeta(branch.metadata);

    const hrUser = meta.hrContactUserId
      ? await this.db
          .select({
            id: users.id,
            name: users.name,
            image: users.image,
            email: users.email,
          })
          .from(users)
          .where(eq(users.id, meta.hrContactUserId))
          .limit(1)
          .then((userRows) => userRows[0] ?? null)
      : null;

    const employees = await this.db
      .select({
        id: users.id,
        name: users.name,
        image: users.image,
        role: organizationMembers.role,
        isActive: users.isActive,
      })
      .from(users)
      .innerJoin(
        organizationMembers,
        and(
          eq(organizationMembers.userId, users.id),
          eq(organizationMembers.orgId, orgId),
        ),
      )
      .leftJoin(hrPeople, livePersonOfUser(orgId, users.id))
      .leftJoin(hrEmployments, primaryEmploymentOfPerson(orgId))
      .where(eq(hrEmployments.locationId, branchId));

    return {
      id: branch.id,
      orgId: branch.orgId,
      name: branch.name,
      code: branch.code,
      city: meta.city ?? null,
      state: meta.state ?? null,
      country: meta.country ?? null,
      pincode: meta.postalCode ?? null,
      address: meta.address ?? null,
      phone: meta.phone ?? null,
      email: meta.email ?? null,
      status: branch.status === "ACTIVE" ? "ACTIVE" : "INACTIVE",
      createdAt: branch.createdAt,
      updatedAt: branch.updatedAt,
      branchManager: branch.head ?? null,
      branchHr: hrUser,
      employees,
    };
  }

  async create(orgId: string, input: CreateBranchInput) {
    const meta: OrgUnitMetadata = {
      city: input.city,
      state: input.state,
      country: input.country,
      postalCode: input.pincode,
      address: input.address,
      phone: input.phone,
      email: input.email,
      hrContactUserId: input.branchHrId,
    };

    const branch = await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(orgUnits)
        .values({
          orgId,
          kind: "BRANCH",
          name: input.name,
          code: input.code.toUpperCase(),
          headUserId: input.branchManagerId ?? null,
          metadata: meta,
        })
        .returning();
      if (!created) throw new Error("Insert returned no row");

      for (const userId of [input.branchManagerId, input.branchHrId]) {
        if (!userId) continue;
        await syncOrgUnitPlacement(tx, orgId, userId, { BRANCH: created.id });
      }
      return created;
    });

    await Promise.all([
      this.cache.invalidateForOrg(orgId, "branches:list"),
      this.cache.invalidateForOrg(orgId, "org:units:BRANCH"),
      this.hierarchyCache.invalidateAfterMutation(orgId),
    ]);
    return branch;
  }

  async update(orgId: string, branchId: string, input: UpdateBranchInput) {
    const current = await this.db
      .select({ metadata: orgUnits.metadata })
      .from(orgUnits)
      .where(
        and(
          eq(orgUnits.id, branchId),
          eq(orgUnits.orgId, orgId),
          eq(orgUnits.kind, "BRANCH"),
          isNull(orgUnits.deletedAt),
        ),
      )
      .limit(1)
      .then((branchRows) => branchRows[0] ?? null);
    if (!current) return null;

    const existingMeta = readBranchMeta(current.metadata);
    const oldHrId = existingMeta.hrContactUserId;

    const patchedMeta: OrgUnitMetadata = {
      ...existingMeta,
      ...(input.city !== undefined ? { city: input.city } : {}),
      ...(input.state !== undefined ? { state: input.state } : {}),
      ...(input.country !== undefined ? { country: input.country } : {}),
      ...(input.pincode !== undefined ? { postalCode: input.pincode } : {}),
      ...(input.address !== undefined ? { address: input.address } : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.branchHrId !== undefined ? { hrContactUserId: input.branchHrId } : {}),
    };

    const updated = await this.db.transaction(async (tx) => {
      const [updatedBranch] = await tx
        .update(orgUnits)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.code !== undefined ? { code: input.code.toUpperCase() } : {}),
          ...(input.branchManagerId !== undefined
            ? { headUserId: input.branchManagerId }
            : {}),
          ...(input.status !== undefined
            ? { status: input.status === "ACTIVE" ? "ACTIVE" : "DISABLED" }
            : {}),
          metadata: patchedMeta,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(orgUnits.id, branchId),
            eq(orgUnits.orgId, orgId),
            eq(orgUnits.kind, "BRANCH"),
            isNull(orgUnits.deletedAt),
          ),
        )
        .returning();
      if (!updatedBranch) return null;

      if (input.branchManagerId !== undefined) {
        await syncOrgUnitPlacement(tx, orgId, input.branchManagerId, {
          BRANCH: updatedBranch.id,
        });
      }

      if (input.branchHrId !== undefined) {
        if (input.branchHrId) {
          await syncOrgUnitPlacement(tx, orgId, input.branchHrId, {
            BRANCH: updatedBranch.id,
          });
        }
        if (
          oldHrId &&
          oldHrId !== input.branchHrId &&
          oldHrId !== updatedBranch.headUserId
        ) {
          await syncOrgUnitPlacement(tx, orgId, oldHrId, { BRANCH: null });
        }
      }

      return updatedBranch;
    });

    if (!updated) return null;
    await Promise.all([
      this.cache.invalidateForOrg(orgId, "branches:list"),
      this.cache.invalidateForOrg(orgId, "org:units:BRANCH"),
      this.hierarchyCache.invalidateAfterMutation(orgId),
    ]);
    return updated;
  }

  async remove(orgId: string, branchId: string) {
    const current = await this.db
      .select({ headUserId: orgUnits.headUserId, metadata: orgUnits.metadata })
      .from(orgUnits)
      .where(
        and(
          eq(orgUnits.id, branchId),
          eq(orgUnits.orgId, orgId),
          eq(orgUnits.kind, "BRANCH"),
          isNull(orgUnits.deletedAt),
        ),
      )
      .limit(1)
      .then((branchRows) => branchRows[0] ?? null);
    if (!current) return null;

    const meta = readBranchMeta(current.metadata);
    const managerId = current.headUserId;
    const hrId = meta.hrContactUserId;

    await this.db.transaction(async (tx) => {
      if (managerId) {
        await syncOrgUnitPlacement(tx, orgId, managerId, { BRANCH: null });
      }
      if (hrId && hrId !== managerId) {
        await syncOrgUnitPlacement(tx, orgId, hrId, { BRANCH: null });
      }
      await tx
        .update(orgUnits)
        .set({ deletedAt: new Date() })
        .where(
          and(
            eq(orgUnits.id, branchId),
            eq(orgUnits.orgId, orgId),
            eq(orgUnits.kind, "BRANCH"),
            isNull(orgUnits.deletedAt),
          ),
        );
    });

    await Promise.all([
      this.cache.invalidateForOrg(orgId, "branches:list"),
      this.cache.invalidateForOrg(orgId, "org:units:BRANCH"),
      this.hierarchyCache.invalidateAfterMutation(orgId),
    ]);
    return { success: true };
  }
}
