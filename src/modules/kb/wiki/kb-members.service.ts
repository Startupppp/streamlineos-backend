import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq, sql, isNull } from "drizzle-orm";
import { kbSpaces, kbSpaceMembers, users, organizationMembers } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { KbAccessService } from "../core/kb-access.service";
import { KbIndexingService } from "../retrieval/kb-indexing.service";
import type { AddMemberInput } from "./dto/kb-members.schemas";

type MemberRow = typeof kbSpaceMembers.$inferSelect;

type MemberListItem = MemberRow & {
  userId: string | null;
  userName: string | null;
  userEmail: string | null;
  userImage: string | null;
};

@Injectable()
export class KbMembersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: KbAccessService,
    private readonly indexing: KbIndexingService,
  ) {}

  private async assertSpaceExists(orgId: string, spaceId: number): Promise<void> {
    const space = await this.db.query.kbSpaces.findFirst({
      where: and(
        eq(kbSpaces.id, spaceId),
        eq(kbSpaces.orgId, orgId),
        isNull(kbSpaces.deletedAt),
      ),
      columns: { id: true },
    });
    if (!space) throw new NotFoundException("Space not found");
  }

  async list(orgId: string, spaceId: number): Promise<MemberListItem[]> {
    await this.assertSpaceExists(orgId, spaceId);
    return this.db
      .select({
        id: kbSpaceMembers.id,
        orgId: kbSpaceMembers.orgId,
        spaceId: kbSpaceMembers.spaceId,
        userId: organizationMembers.userId,
        membershipId: kbSpaceMembers.membershipId,
        role: kbSpaceMembers.role,
        team: kbSpaceMembers.team,
        spaceRole: kbSpaceMembers.spaceRole,
        createdAt: kbSpaceMembers.createdAt,
        userName: users.name,
        userEmail: users.email,
        userImage: users.image,
      })
      .from(kbSpaceMembers)
      .leftJoin(
        organizationMembers,
        and(
          eq(organizationMembers.orgId, kbSpaceMembers.orgId),
          eq(organizationMembers.id, kbSpaceMembers.membershipId),
        ),
      )
      .leftJoin(users, eq(organizationMembers.userId, users.id))
      .where(and(eq(kbSpaceMembers.orgId, orgId), eq(kbSpaceMembers.spaceId, spaceId)))
      .orderBy(asc(kbSpaceMembers.spaceRole), asc(kbSpaceMembers.createdAt))
      .limit(500);
  }

  async add(orgId: string, spaceId: number, input: AddMemberInput): Promise<MemberRow & { userId: string | null }> {
    await this.assertSpaceExists(orgId, spaceId);
    let membershipId: number | null = null;
    if (input.userId) {
      const membership = await this.db.query.organizationMembers.findFirst({
        where: and(
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.userId, input.userId),
          eq(organizationMembers.status, "ACTIVE"),
        ),
        columns: { id: true },
      });
      if (!membership) throw new NotFoundException("Active organization member not found");
      membershipId = membership.id;
      const existing = await this.db.query.kbSpaceMembers.findFirst({
        where: and(
          eq(kbSpaceMembers.orgId, orgId),
          eq(kbSpaceMembers.spaceId, spaceId),
          eq(kbSpaceMembers.membershipId, membershipId),
        ),
        columns: { id: true },
      });
      if (existing) throw new ConflictException("User already has access");
    }
    if (input.role) {
      const existing = await this.db.query.kbSpaceMembers.findFirst({
        where: and(
          eq(kbSpaceMembers.orgId, orgId),
          eq(kbSpaceMembers.spaceId, spaceId),
          eq(kbSpaceMembers.role, input.role),
        ),
        columns: { id: true },
      });
      if (existing) throw new ConflictException("Role already granted");
    }
    const [member] = await this.db
      .insert(kbSpaceMembers)
      .values({
        orgId,
        spaceId,
        membershipId,
        role: input.role ?? null,
        spaceRole: input.spaceRole,
      })
      .returning();
    await this.indexing.bumpSpaceAclRevision(orgId, spaceId);
    await this.access.invalidateAccessibleSpaceIds(orgId);
    return { ...member, userId: input.userId ?? null };
  }

  async remove(orgId: string, spaceId: number, memberId: number): Promise<{ success: boolean }> {
    const member = await this.db.query.kbSpaceMembers.findFirst({
      where: and(
        eq(kbSpaceMembers.id, memberId),
        eq(kbSpaceMembers.spaceId, spaceId),
        eq(kbSpaceMembers.orgId, orgId),
      ),
    });
    if (!member) throw new NotFoundException("Member not found");
    if (member.spaceRole === "admin") {
      const [{ count }] = await this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(kbSpaceMembers)
        .where(
          and(
            eq(kbSpaceMembers.orgId, orgId),
            eq(kbSpaceMembers.spaceId, spaceId),
            eq(kbSpaceMembers.spaceRole, "admin"),
          ),
        );
      if (count <= 1) throw new BadRequestException("Cannot remove the last space admin");
    }
    await this.db
      .delete(kbSpaceMembers)
      .where(
        and(
          eq(kbSpaceMembers.id, memberId),
          eq(kbSpaceMembers.spaceId, spaceId),
          eq(kbSpaceMembers.orgId, orgId),
        ),
      );
    await this.indexing.bumpSpaceAclRevision(orgId, spaceId);
    await this.access.invalidateAccessibleSpaceIds(orgId);
    return { success: true };
  }
}
