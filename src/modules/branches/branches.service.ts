import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { branches, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import type { UpdateBranchInput } from "./dto/branches.schemas";

@Injectable()
export class BranchesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  list(orgId: string) {
    return this.cache.cached(
      CACHE_KEYS.branchesList(orgId),
      () =>
        this.db.query.branches.findMany({
          where: eq(branches.orgId, orgId),
          orderBy: [desc(branches.createdAt)],
          with: {
            branchManager: { columns: { id: true, name: true, image: true } },
            branchHr: { columns: { id: true, name: true, image: true } },
          },
        }),
      CACHE_TTL.MEDIUM,
    );
  }

  async getOne(orgId: string, id: number) {
    const branch = await this.db.query.branches.findFirst({
      where: and(eq(branches.id, id), eq(branches.orgId, orgId)),
      with: {
        branchManager: { columns: { id: true, name: true, image: true, email: true } },
        branchHr: { columns: { id: true, name: true, image: true, email: true } },
      },
    });
    if (!branch) return null;

    const employees = await this.db.query.users.findMany({
      where: eq(users.branchId, id),
      columns: { id: true, name: true, image: true, role: true, isActive: true },
    });

    return { ...branch, employees };
  }

  async update(orgId: string, id: number, input: UpdateBranchInput) {
    const [updated] = await this.db
      .update(branches)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(branches.id, id), eq(branches.orgId, orgId)))
      .returning();
    if (!updated) return null;
    await this.cache.invalidate(CACHE_KEYS.branchesList(orgId));
    return updated;
  }

  async remove(orgId: string, id: number) {
    const [deleted] = await this.db
      .delete(branches)
      .where(and(eq(branches.id, id), eq(branches.orgId, orgId)))
      .returning();
    if (!deleted) return null;
    await this.cache.invalidate(CACHE_KEYS.branchesList(orgId));
    return { success: true };
  }
}
