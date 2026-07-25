import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { candidates, talentPoolMembers, talentPools } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { AddPoolMemberInput, CreateTalentPoolInput, UpdateTalentPoolInput } from "./dto/talent-pools.schemas";

@Injectable()
export class RecruitmentTalentPoolsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(orgId: string) {
    const pools = await this.db
      .select({
        id: talentPools.id,
        name: talentPools.name,
        description: talentPools.description,
        createdAt: talentPools.createdAt,
        memberCount: sql<number>`count(${talentPoolMembers.id})::int`,
      })
      .from(talentPools)
      .leftJoin(talentPoolMembers, eq(talentPoolMembers.poolId, talentPools.id))
      .where(eq(talentPools.orgId, orgId))
      .groupBy(talentPools.id)
      .orderBy(desc(talentPools.createdAt));
    return pools;
  }

  async create(orgId: string, userId: string, input: CreateTalentPoolInput) {
    const [pool] = await this.db
      .insert(talentPools)
      .values({ orgId, name: input.name, description: input.description, createdBy: userId })
      .returning();
    return pool;
  }

  async update(orgId: string, poolId: number, input: UpdateTalentPoolInput) {
    const [pool] = await this.db
      .update(talentPools)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(talentPools.id, poolId), eq(talentPools.orgId, orgId)))
      .returning();
    if (!pool) throw new NotFoundException("Talent pool not found");
    return pool;
  }

  async remove(orgId: string, poolId: number) {
    const [pool] = await this.db
      .delete(talentPools)
      .where(and(eq(talentPools.id, poolId), eq(talentPools.orgId, orgId)))
      .returning({ id: talentPools.id });
    if (!pool) throw new NotFoundException("Talent pool not found");
    return { success: true };
  }

  async listMembers(orgId: string, poolId: number) {
    await this.ensurePool(orgId, poolId);
    return this.db
      .select({
        membershipId: talentPoolMembers.id,
        notes: talentPoolMembers.notes,
        addedAt: talentPoolMembers.addedAt,
        candidateId: candidates.id,
        firstName: candidates.firstName,
        lastName: candidates.lastName,
        email: candidates.email,
        currentCompany: candidates.currentCompany,
        currentRole: candidates.currentRole,
        status: candidates.status,
      })
      .from(talentPoolMembers)
      .innerJoin(candidates, eq(candidates.id, talentPoolMembers.candidateId))
      .where(eq(talentPoolMembers.poolId, poolId))
      .orderBy(desc(talentPoolMembers.addedAt))
      .limit(500);
  }

  async addMember(orgId: string, userId: string, poolId: number, input: AddPoolMemberInput) {
    await this.ensurePool(orgId, poolId);
    const candidate = await this.db.query.candidates.findFirst({
      where: and(eq(candidates.id, input.candidateId), eq(candidates.orgId, orgId)),
      columns: { id: true },
    });
    if (!candidate) throw new NotFoundException("Candidate not found");

    const existing = await this.db.query.talentPoolMembers.findFirst({
      where: and(eq(talentPoolMembers.poolId, poolId), eq(talentPoolMembers.candidateId, input.candidateId)),
      columns: { id: true },
    });
    if (existing) throw new ConflictException("Candidate is already in this pool");

    const [member] = await this.db
      .insert(talentPoolMembers)
      .values({ poolId, candidateId: input.candidateId, orgId, notes: input.notes, addedBy: userId })
      .returning();
    return member;
  }

  async removeMember(orgId: string, poolId: number, candidateId: number) {
    await this.ensurePool(orgId, poolId);
    await this.db
      .delete(talentPoolMembers)
      .where(and(eq(talentPoolMembers.poolId, poolId), eq(talentPoolMembers.candidateId, candidateId)));
    return { success: true };
  }

  private async ensurePool(orgId: string, poolId: number) {
    const pool = await this.db.query.talentPools.findFirst({
      where: and(eq(talentPools.id, poolId), eq(talentPools.orgId, orgId)),
      columns: { id: true },
    });
    if (!pool) throw new NotFoundException("Talent pool not found");
  }
}
