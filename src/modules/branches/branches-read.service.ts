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
import { CACHE_TTL } from "../../common/cache/cache-keys";
import {
  livePersonOfUser,
  primaryEmploymentOfPerson,
} from "../directory/employment-query";

export function readBranchMeta(raw: OrgUnitMetadata | null | undefined): OrgUnitMetadata {
  if (!raw) return {};
  return raw;
}

@Injectable()
export class BranchesReadService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  list(orgId: string) {
    return this.cache.cachedForOrg(
      orgId,
      "branches:list",
      async () => {
        const rows = await this.db.query.orgUnits.findMany({
          limit: 200,
          where: and(
            eq(orgUnits.orgId, orgId),
            eq(orgUnits.kind, "BRANCH"),
            isNull(orgUnits.deletedAt),
          ),
          with: {
            headMember: {
              with: { user: { columns: { id: true, name: true, image: true } } },
            },
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
                .limit(hrContactIds.length)
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
            branchManager: branchRow.headMember?.user ?? null,
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
        headMember: {
          with: { user: { columns: { id: true, name: true, image: true, email: true } } },
        },
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
      .where(eq(hrEmployments.locationId, branchId))
      .limit(500);

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
      branchManager: branch.headMember?.user ?? null,
      branchHr: hrUser,
      employees,
    };
  }
}
