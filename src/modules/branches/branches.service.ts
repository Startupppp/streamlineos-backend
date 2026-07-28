import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  orgUnits,
  organizationMembers,
  users,
  type OrgUnitMetadata,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import type {
  CreateBranchInput,
  UpdateBranchInput,
} from "./dto/branches.schemas";

type BranchMeta = OrgUnitMetadata & { hrContactUserId?: string };

function readBranchMeta(raw: OrgUnitMetadata | null | undefined): BranchMeta {
  return (raw ?? {}) as BranchMeta;
}

@Injectable()
export class BranchesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  list(orgId: string) {
    return this.cache.cached(
      CACHE_KEYS.branchesList(orgId),
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
          .map((r) => readBranchMeta(r.metadata).hrContactUserId)
          .filter((id): id is string => typeof id === "string");

        const hrUsers =
          hrContactIds.length > 0
            ? await this.db
                .select({ id: users.id, name: users.name, image: users.image })
                .from(users)
                .where(inArray(users.id, hrContactIds))
            : [];
        const hrMap = new Map(hrUsers.map((u) => [u.id, u]));

        return rows.map((r) => {
          const meta = readBranchMeta(r.metadata);
          return {
            id: r.id,
            orgId: r.orgId,
            name: r.name,
            code: r.code,
            city: meta.city ?? null,
            state: meta.state ?? null,
            country: meta.country ?? null,
            pincode: meta.postalCode ?? null,
            address: meta.address ?? null,
            phone: meta.phone ?? null,
            email: meta.email ?? null,
            status: r.status === "ACTIVE" ? "ACTIVE" : "INACTIVE",
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
            branchManager: r.head ?? null,
            branchHr: meta.hrContactUserId
              ? (hrMap.get(meta.hrContactUserId) ?? null)
              : null,
          };
        });
      },
      CACHE_TTL.MEDIUM,
    );
  }

  async getOne(orgId: string, id: string) {
    const branch = await this.db.query.orgUnits.findFirst({
      where: and(
        eq(orgUnits.id, id),
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
          .then((r) => r[0] ?? null)
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
      .where(eq(users.branchId, id));

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
    const meta: BranchMeta = {
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

      if (input.branchManagerId) {
        await tx
          .update(users)
          .set({ branchId: created.id })
          .where(eq(users.id, input.branchManagerId));
      }
      if (input.branchHrId) {
        await tx
          .update(users)
          .set({ branchId: created.id })
          .where(eq(users.id, input.branchHrId));
      }
      return created;
    });

    await this.cache.invalidate(CACHE_KEYS.branchesList(orgId));
    return branch;
  }

  async update(orgId: string, id: string, input: UpdateBranchInput) {
    const current = await this.db
      .select({ metadata: orgUnits.metadata })
      .from(orgUnits)
      .where(
        and(
          eq(orgUnits.id, id),
          eq(orgUnits.orgId, orgId),
          eq(orgUnits.kind, "BRANCH"),
          isNull(orgUnits.deletedAt),
        ),
      )
      .limit(1)
      .then((r) => r[0] ?? null);
    if (!current) return null;

    const existingMeta = readBranchMeta(current.metadata);
    const patchedMeta: BranchMeta = {
      ...existingMeta,
      ...(input.city !== undefined ? { city: input.city } : {}),
      ...(input.state !== undefined ? { state: input.state } : {}),
      ...(input.country !== undefined ? { country: input.country } : {}),
      ...(input.pincode !== undefined ? { postalCode: input.pincode } : {}),
      ...(input.address !== undefined ? { address: input.address } : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.branchHrId !== undefined
        ? { hrContactUserId: input.branchHrId }
        : {}),
    };

    const [updated] = await this.db
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
          eq(orgUnits.id, id),
          eq(orgUnits.orgId, orgId),
          eq(orgUnits.kind, "BRANCH"),
          isNull(orgUnits.deletedAt),
        ),
      )
      .returning();
    if (!updated) return null;

    await this.cache.invalidate(CACHE_KEYS.branchesList(orgId));
    return updated;
  }

  async remove(orgId: string, id: string) {
    const [deleted] = await this.db
      .update(orgUnits)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(orgUnits.id, id),
          eq(orgUnits.orgId, orgId),
          eq(orgUnits.kind, "BRANCH"),
          isNull(orgUnits.deletedAt),
        ),
      )
      .returning({ id: orgUnits.id });
    if (!deleted) return null;
    await this.cache.invalidate(CACHE_KEYS.branchesList(orgId));
    return { success: true };
  }
}
