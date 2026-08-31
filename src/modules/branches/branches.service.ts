import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  orgUnits,
  organizationMembers,
} from "../../db/schema";

const branchHeadMember = alias(organizationMembers, "branch_head_member");
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { OrgHierarchyCacheService } from "../../common/cache/org-hierarchy-cache.service";
import { syncOrgUnitPlacement } from "../../common/org/sync-org-unit-placement";
import { BranchesReadService, readBranchMeta } from "./branches-read.service";
import type {
  CreateBranchInput,
  UpdateBranchInput,
} from "./dto/branches.schemas";

@Injectable()
export class BranchesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly hierarchyCache: OrgHierarchyCacheService,
    private readonly reader: BranchesReadService,
  ) {}

  list(orgId: string) {
    return this.reader.list(orgId);
  }

  getOne(orgId: string, branchId: string) {
    return this.reader.getOne(orgId, branchId);
  }

  async create(orgId: string, input: CreateBranchInput) {
    const meta = {
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
      const managerMembershipId = input.branchManagerId
        ? await tx
            .select({ id: organizationMembers.id })
            .from(organizationMembers)
            .where(
              and(
                eq(organizationMembers.orgId, orgId),
                eq(organizationMembers.userId, input.branchManagerId),
              ),
            )
            .limit(1)
            .then((rows) => rows[0]?.id ?? null)
        : null;

      const [created] = await tx
        .insert(orgUnits)
        .values({
          orgId,
          kind: "BRANCH",
          name: input.name,
          code: input.code.toUpperCase(),
          headMembershipId: managerMembershipId,
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
      .select({ metadata: orgUnits.metadata, currentManagerId: branchHeadMember.userId })
      .from(orgUnits)
      .leftJoin(branchHeadMember, eq(branchHeadMember.id, orgUnits.headMembershipId))
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
    const currentManagerId = input.branchManagerId !== undefined ? (input.branchManagerId ?? null) : (current.currentManagerId ?? null);

    const patchedMeta = {
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
      let managerMembershipId: number | null | undefined = undefined;
      if (input.branchManagerId !== undefined) {
        if (input.branchManagerId) {
          const [member] = await tx
            .select({ id: organizationMembers.id })
            .from(organizationMembers)
            .where(
              and(
                eq(organizationMembers.orgId, orgId),
                eq(organizationMembers.userId, input.branchManagerId),
              ),
            )
            .limit(1);
          managerMembershipId = member?.id ?? null;
        } else {
          managerMembershipId = null;
        }
      }

      const [updatedBranch] = await tx
        .update(orgUnits)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.code !== undefined ? { code: input.code.toUpperCase() } : {}),
          ...(input.branchManagerId !== undefined
            ? { headMembershipId: managerMembershipId }
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
          oldHrId !== currentManagerId
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
      .select({ headUserId: branchHeadMember.userId, metadata: orgUnits.metadata })
      .from(orgUnits)
      .leftJoin(branchHeadMember, eq(branchHeadMember.id, orgUnits.headMembershipId))
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
